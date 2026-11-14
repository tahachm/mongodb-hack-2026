"""Operator CLI.

    python -m mandate.ctl init                       # create collections, validators, indexes, seed data
    python -m mandate.ctl halt [--run RUN] --reason "..." [--by u_omar]
    python -m mandate.ctl resume [--run RUN]
    python -m mandate.ctl approvals                  # list pending approvals
    python -m mandate.ctl approve APR --by u_omar [--reject]
    python -m mandate.ctl tamper RUN SEQ             # demo: edit a ledger entry, then `audit show` flags it
    python -m mandate.ctl bad-insert                 # demo: schema validation rejects an unauthorized ledger write
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from . import control
from .db import db
from .display import console, money
from .seed import seed


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    h = sub.add_parser("halt"); h.add_argument("--run"); h.add_argument("--reason", default=""); h.add_argument("--by", default="operator")
    r = sub.add_parser("resume"); r.add_argument("--run")
    sub.add_parser("approvals")
    p = sub.add_parser("approve"); p.add_argument("approval_id"); p.add_argument("--by", required=True)
    p.add_argument("--reject", action="store_true"); p.add_argument("--note", default="")
    t = sub.add_parser("tamper"); t.add_argument("run_id"); t.add_argument("seq", type=int)
    sub.add_parser("bad-insert")
    a = ap.parse_args()

    if a.cmd == "init":
        for n in seed(drop=True):
            console.print(f"[green]✓[/green] {n}")
    elif a.cmd == "halt":
        doc = control.set_halt(True, a.run, by=a.by, reason=a.reason)
        console.print(f"[bold red]HALT[/bold red] set on {doc['_id']} — agents stop before their next action")
    elif a.cmd == "resume":
        control.set_halt(False, a.run, by="operator")
        console.print(f"[green]resumed[/green] {a.run or 'global'}")
    elif a.cmd == "approvals":
        for x in db().approvals.find({"status": "pending"}).sort("created", -1):
            console.print(f"[yellow]{x['_id']}[/yellow] {x['principal']} {money(x['amount_cents'])} "
                          f"@ {x['merchant_id']}: {x['summary']}  (run {x['run_id']})")
    elif a.cmd == "approve":
        try:
            x = control.decide_approval(a.approval_id, a.by, not a.reject, a.note)
            console.print(f"{x['_id']} -> [bold]{x['status']}[/bold] by {x['approver']}")
        except (PermissionError, ValueError) as e:
            console.print(f"[bold red]refused:[/bold red] {e}")
    elif a.cmd == "tamper":
        res = db().actions.update_one({"run_id": a.run_id, "seq": a.seq}, {"$set": {"amount_cents": 1}})
        console.print(f"[red]tampered[/red] {a.run_id} #{a.seq} (matched {res.matched_count}); "
                      f"now run: python -m mandate.audit show {a.run_id}")
    elif a.cmd == "bad-insert":
        try:
            db().actions.insert_one({"run_id": "rogue", "seq": 1, "ts": datetime.now(timezone.utc),
                                     "ts_iso": "x", "actor": "rogue-script", "principal": "u_maya",
                                     "action": "authorize", "status": "allowed",
                                     "prev_hash": "0" * 64, "hash": "f" * 64})
            console.print("[yellow]insert accepted (validation not active on this backend)[/yellow]")
        except Exception as e:
            console.print(f"[green]rejected by MongoDB schema validation:[/green] {type(e).__name__}: "
                          f"{str(e)[:200]}")


if __name__ == "__main__":
    main()
