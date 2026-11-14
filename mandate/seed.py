"""Seed identities, policies and controls. `python -m mandate.ctl init`"""
from datetime import datetime, timezone

from .db import db, init_db

NOW = datetime.now(timezone.utc)

IDENTITIES = [
    {"_id": "u_maya", "kind": "human", "name": "Maya Chen", "team": "design", "role": "designer",
     "status": "active", "can_approve": False},
    {"_id": "u_omar", "kind": "human", "name": "Omar Haddad", "team": "design", "role": "design lead",
     "status": "active", "can_approve": True},
    {"_id": "u_lee", "kind": "human", "name": "Lee Park", "team": "design", "role": "contractor",
     "status": "suspended", "can_approve": False},
    {"_id": "u_sam", "kind": "human", "name": "Sam Okafor", "team": "finance", "role": "analyst",
     "status": "active", "can_approve": False},
    {"_id": "procurement-agent", "kind": "agent", "name": "Procurement Agent", "status": "active",
     "scopes": ["search", "checkout", "purchase"], "owner": "it-ops"},
]

POLICIES = [
    {"policy_id": "design-purchasing", "version": 1, "team": "design", "active": False,
     "approved_merchants": ["northdesk"], "allowed_categories": ["monitors", "peripherals"],
     "currency": "usd", "max_quantity_per_line": 3, "per_order_max_cents": 100000,
     "monthly_budget_cents": 200000, "require_approval_over_cents": 60000,
     "created": NOW, "created_by": "u_omar", "note": "superseded by v2"},
    {"policy_id": "design-purchasing", "version": 2, "team": "design", "active": True,
     "approved_merchants": ["northdesk", "pixelmart"],
     "allowed_categories": ["monitors", "peripherals", "furniture"],
     "currency": "usd", "max_quantity_per_line": 5, "per_order_max_cents": 200000,
     "monthly_budget_cents": 300000, "require_approval_over_cents": 120000,
     "created": NOW, "created_by": "u_omar", "note": "Q4 refresh: added PixelMart and furniture"},
    {"policy_id": "finance-purchasing", "version": 1, "team": "finance", "active": True,
     "approved_merchants": ["northdesk"], "allowed_categories": ["peripherals"],
     "currency": "usd", "max_quantity_per_line": 2, "per_order_max_cents": 50000,
     "monthly_budget_cents": 100000, "require_approval_over_cents": None,
     "created": NOW, "created_by": "u_sam"},
]


def seed(drop: bool = True) -> list[str]:
    notes = init_db(drop=drop)
    d = db()
    for i in IDENTITIES:
        d.identities.replace_one({"_id": i["_id"]}, i, upsert=True)
    for p in POLICIES:
        d.policies.replace_one({"policy_id": p["policy_id"], "version": p["version"]}, p, upsert=True)
    d.controls.replace_one({"_id": "global"}, {"_id": "global", "halted": False, "by": "seed", "at": NOW},
                           upsert=True)
    notes.append(f"seeded {len(IDENTITIES)} identities, {len(POLICIES)} policy versions, global kill switch OFF")
    return notes
