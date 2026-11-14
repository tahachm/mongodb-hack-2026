"""Deterministic policy gate. Runs BEFORE any money moves.

The LLM never supplies amounts or categories to this function: the gate re-reads the
checkout session from the merchant (source of truth) and checks it against the active
policy version for the principal's team. Every individual check is returned so the
ledger can show exactly why something was allowed or denied.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from .db import db


@dataclass
class Decision:
    outcome: str                      # allow | deny | needs_approval
    total_cents: int
    policy: dict | None
    checks: list[dict] = field(default_factory=list)

    @property
    def reasons(self) -> list[str]:
        return [c["detail"] for c in self.checks if not c["passed"]]


def _month_start() -> datetime:
    n = datetime.now(timezone.utc)
    return n.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def spent_this_month(team: str) -> int:
    rows = list(db().actions.aggregate([
        {"$match": {"team": team, "action": "complete_checkout", "status": {"$in": ["effective", "replayed"]},
                    "ts": {"$gte": _month_start()}}},
        {"$group": {"_id": None, "total": {"$sum": "$amount_cents"}}},
    ]))
    return int(rows[0]["total"]) if rows else 0


def active_policy(team: str) -> dict | None:
    return db().policies.find_one({"team": team, "active": True}, sort=[("version", -1)])


def evaluate(principal_id: str, merchant_id: str, session: dict, human_approved: bool = False) -> Decision:
    checks: list[dict] = []

    def check(name, passed, detail):
        checks.append({"check": name, "passed": bool(passed), "detail": detail})
        return passed

    total = next((t["amount"] for t in session.get("totals", []) if t["type"] == "total"), 0)
    who = db().identities.find_one({"_id": principal_id})
    if not check("identity_active", who and who.get("status") == "active",
                 f"principal {principal_id} is {'active' if who and who.get('status') == 'active' else 'unknown or inactive'}"):
        return Decision("deny", total, None, checks)

    pol = active_policy(who["team"])
    if not check("policy_exists", pol is not None, f"active policy for team '{who['team']}'"
                 + (f": {pol['policy_id']} v{pol['version']}" if pol else " not found")):
        return Decision("deny", total, None, checks)
    ref = {"policy_id": pol["policy_id"], "version": pol["version"], "team": pol["team"]}

    check("merchant_approved", merchant_id in pol["approved_merchants"],
          f"merchant '{merchant_id}' {'is' if merchant_id in pol['approved_merchants'] else 'is NOT'} on the approved vendor list")
    check("currency", session.get("currency") == pol["currency"], f"currency {session.get('currency')} (policy: {pol['currency']})")

    for li in session.get("line_items", []):
        cat, qty = li.get("category"), li["item"]["quantity"]
        check("category_allowed", cat in pol["allowed_categories"],
              f"{li['title']}: category '{cat}' {'allowed' if cat in pol['allowed_categories'] else 'NOT allowed'}")
        check("quantity_limit", qty <= pol["max_quantity_per_line"],
              f"{li['title']}: quantity {qty} (limit {pol['max_quantity_per_line']})")

    check("per_order_cap", total <= pol["per_order_max_cents"],
          f"order total ${total/100:,.2f} (cap ${pol['per_order_max_cents']/100:,.2f})")
    spent = spent_this_month(pol["team"])
    remaining = pol["monthly_budget_cents"] - spent
    check("monthly_budget", total <= remaining,
          f"team spent ${spent/100:,.2f} this month; ${remaining/100:,.2f} left of ${pol['monthly_budget_cents']/100:,.2f}")

    if not all(c["passed"] for c in checks):
        return Decision("deny", total, ref, checks)

    threshold = pol.get("require_approval_over_cents")
    if threshold is not None and total > threshold:
        check("human_approval", human_approved,
              f"order over ${threshold/100:,.2f} needs a team lead's approval"
              + (" -- approved" if human_approved else ""))
        if not human_approved:
            return Decision("needs_approval", total, ref, checks)
    return Decision("allow", total, ref, checks)
