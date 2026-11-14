"""Reviewer CLI: reconstruct what the agent did, why, and under whose authority.

    python -m mandate.audit runs
    python -m mandate.audit show <run_id>
    python -m mandate.audit why <run_id> <seq>
    python -m mandate.audit spend --team design
    python -m mandate.audit denied              # every blocked action across all runs
"""
from __future__ import annotations

import argparse
import json

from rich.table import Table

from .db import db
from .display import STATUS_STYLE, console, money, summarize
from .gate import active_policy, spent_this_month
from .ledger import verify_chain


def runs(limit=15):
    t = Table(title="Agent runs")
    for c in ["run_id", "principal", "status", "request", "actions", "chain"]:
        t.add_column(c)
    for r in db().runs.find().sort("started", -1).limit(limit):
        ok, _, _ = verify_chain(r["_id"])
        t.add_row(r["_id"], r.get("principal", ""), r.get("status", ""), (r.get("request") or "")[:48],
                  str(r.get("seq", 0)), "[green]intact[/green]" if ok else "[red]BROKEN[/red]")
    console.print(t)


def show(run_id):
    r = db().runs.find_one({"_id": run_id})
    if not r:
        console.print(f"[red]no run {run_id}[/red]")
        return
    console.print(f"[bold]{run_id}[/bold]  agent={r.get('actor')} acting for={r.get('principal')} "
                  f"team={r.get('team')} status={r.get('status')}")
    console.print(f"request: {r.get('request')!r}")
    t = Table(show_lines=False)
    for c in ["#", "time (UTC)", "action", "status", "detail", "authority"]:
        t.add_column(c, overflow="fold")
    for a in db().actions.find({"run_id": run_id}).sort("seq", 1):
        st = STATUS_STYLE.get(a["status"], "white")
        pol = a.get("policy") or {}
        t.add_row(str(a["seq"]), a["ts_iso"][11:23], a["action"], f"[{st}]{a['status']}[/{st}]",
                  summarize(a), f"{pol.get('policy_id')} v{pol.get('version')}" if pol else "")
    console.print(t)
    ok, bad, msg = verify_chain(run_id)
    console.print(f"[{'green' if ok else 'bold red'}]hash chain: {msg}[/]")


def why(run_id, seq):
    a = db().actions.find_one({"run_id": run_id, "seq": int(seq)}, {"_id": 0})
    if not a:
        console.print("[red]not found[/red]")
        return
    console.print_json(json.dumps(a, default=str))


def spend(team):
    pol = active_policy(team)
    s = spent_this_month(team)
    console.print(f"team {team}: spent {money(s)} this month of {money(pol['monthly_budget_cents'])} "
                  f"(policy {pol['policy_id']} v{pol['version']})")
    for a in db().actions.find({"team": team, "action": "complete_checkout",
                                "status": {"$in": ["effective", "replayed"]}}).sort("ts", -1):
        console.print(f"  {a['ts_iso'][:19]}  {a['principal']:<8} {money(a.get('amount_cents')):>10}  "
                      f"{a.get('merchant_id')}  order {a.get('order_id')}  run {a['run_id']}")


def denied():
    for a in db().actions.find({"action": "authorize", "status": "denied"}).sort("ts", -1).limit(30):
        fails = "; ".join(c["detail"] for c in a.get("checks", []) if not c["passed"])
        console.print(f"[red]{a['ts_iso'][:19]}[/red] {a['principal']:<8} {money(a.get('amount_cents')):>10} "
                      f"{a.get('merchant_id')}: {fails}  [dim]({a['run_id']} #{a['seq']})[/dim]")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("runs")
    s = sub.add_parser("show"); s.add_argument("run_id")
    w = sub.add_parser("why"); w.add_argument("run_id"); w.add_argument("seq")
    sp = sub.add_parser("spend"); sp.add_argument("--team", default="design")
    sub.add_parser("denied")
    a = ap.parse_args()
    {"runs": lambda: runs(), "show": lambda: show(a.run_id), "why": lambda: why(a.run_id, a.seq),
     "spend": lambda: spend(a.team), "denied": lambda: denied()}[a.cmd]()


if __name__ == "__main__":
    main()
