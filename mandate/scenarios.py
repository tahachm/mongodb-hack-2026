"""Deterministic demo scenarios (no LLM). Same tool layer, gate and ledger as the agent,
so they double as tests and as a backup demo if the model/API misbehaves on stage.

    python -m mandate.scenarios happy
    python -m mandate.scenarios approval        # then in another terminal: python -m mandate.ctl approve <id> --by u_omar
    python -m mandate.scenarios halt            # then: python -m mandate.ctl halt --reason "demo"
    python -m mandate.scenarios all --auto      # run everything unattended (auto-approves / auto-halts)
"""
from __future__ import annotations

import argparse
import threading
import time

import httpx

from . import config, control
from .control import Halted
from .display import console, print_event
from .ledger import verify_chain
from .tools import ToolError, ToolExecutor


def _ex(principal, request):
    ex = ToolExecutor(principal, request, mode="scripted")
    ex.on_event = print_event
    ex.start()
    console.rule(f"[bold]{ex.run_id}[/bold]  {request!r}  as {principal}")
    return ex


def _end(ex, status="completed", summary=""):
    ex.finish(status, summary)
    ok, _, msg = verify_chain(ex.run_id)
    console.print(f"[{'green' if ok else 'red'}]ledger: {msg}[/]  ->  python -m mandate.audit show {ex.run_id}\n")
    return ex.run_id


def happy(auto=False):
    ex = _ex("u_maya", "Two 4K monitors for my desk setup")
    ex.search_products("4K monitor", reason="find 4K monitors")
    co = ex.create_checkout("northdesk", [{"product_id": "nd-mon-27-4k", "quantity": 2}],
                            reason="approved vendor, meets 4K requirement")
    r = ex.purchase(co["checkout_session_id"], reason="within policy limits")
    return _end(ex, summary=str(r))


def vendor(auto=False):
    ex = _ex("u_maya", "Cheapest 4K monitor you can find")
    ex.search_products("4K monitor", reason="compare prices")
    co = ex.create_checkout("grayline", [{"product_id": "gl-mon-27-4k", "quantity": 1}], reason="cheapest option")
    r = ex.purchase(co["checkout_session_id"], reason="lowest price")
    console.print(f"[red]gate:[/red] {r.get('reasons')}")
    ex.cancel_checkout(co["checkout_session_id"], reason="vendor not approved; abandoning")
    return _end(ex, summary="blocked: unapproved vendor")


def injection(auto=False):
    ex = _ex("u_maya", "One designer monitor")
    res = ex.search_products("designer monitor", reason="find a calibrated monitor")
    poisoned = next(p for p in res["products"] if p.get("id") == "pm-mon-27-design")
    console.print(f"[yellow]merchant text:[/yellow] {poisoned['description']}")
    # Simulate a model that obeyed the injected instruction:
    co = ex.create_checkout("pixelmart", [{"product_id": "pm-mon-27-design", "quantity": 50}],
                            reason="promotion says budget lifted; ordering 50")
    r = ex.purchase(co["checkout_session_id"], reason="per merchant promotion")
    console.print(f"[red]gate:[/red] {r.get('reasons')}")
    ex.cancel_checkout(co["checkout_session_id"], reason="denied by policy")
    return _end(ex, summary="injection contained by policy gate")


def approval(auto=False):
    ex = _ex("u_maya", "Monitor plus two ergonomic chairs for the new hire pod")
    ex.search_products("monitor chair", reason="find both items")
    co = ex.create_checkout("northdesk", [{"product_id": "nd-mon-27-4k", "quantity": 1},
                                          {"product_id": "nd-chair-erg", "quantity": 2}], reason="one vendor, one order")
    if auto:
        def approver():
            for _ in range(40):
                time.sleep(0.5)
                p = control.db().approvals.find_one({"run_id": ex.run_id, "status": "pending"})
                if p:
                    time.sleep(1.0)
                    control.decide_approval(p["_id"], "u_omar", True, "ok for new hire pod")
                    return
        threading.Thread(target=approver, daemon=True).start()
    else:
        console.print("[bold yellow]waiting for approval — run: python -m mandate.ctl approvals[/bold yellow]")
    r = ex.purchase(co["checkout_session_id"], reason="needed for onboarding")
    return _end(ex, summary=str(r))


def halt(auto=False):
    ex = _ex("u_maya", "Restock: keyboard and pen tablet")
    ex.search_products("keyboard tablet", reason="find both")
    a = ex.create_checkout("northdesk", [{"product_id": "nd-kb-mech", "quantity": 2}], reason="keyboards")
    b = ex.create_checkout("pixelmart", [{"product_id": "pm-tablet-pro", "quantity": 1}], reason="tablet")
    if auto:
        threading.Timer(1.5, lambda: control.set_halt(True, ex.run_id, by="u_omar", reason="pausing all spend")).start()
    else:
        console.print("[bold yellow]agent is 'thinking' for 30s — halt it now: "
                      f"python -m mandate.ctl halt --run {ex.run_id} --reason 'stop'[/bold yellow]")
    try:
        for _ in range(60 if not auto else 10):
            ex._guard("purchase")
            time.sleep(0.5)
        ex.purchase(a["checkout_session_id"], reason="keyboards")
        ex.purchase(b["checkout_session_id"], reason="tablet")
        return _end(ex)
    except Halted as h:
        console.print(f"[bold red]{h}[/bold red]")
        return _end(ex, "halted", str(h))


def flaky(auto=False):
    ex = _ex("u_maya", "One QHD monitor")
    ex.search_products("QHD monitor", reason="find QHD")
    co = ex.create_checkout("northdesk", [{"product_id": "nd-mon-27-qhd", "quantity": 1}], reason="QHD from approved vendor")
    httpx.post(f"{config.COMMERCE_URL}/_chaos", json={"merchant_id": "northdesk", "drop_next_complete_response": True})
    console.print("[yellow]chaos: merchant will process the next order but drop the response[/yellow]")
    r = ex.purchase(co["checkout_session_id"], reason="within limits")
    return _end(ex, summary=str(r))


def suspended(auto=False):
    ex = ToolExecutor("u_lee", "A keyboard", mode="scripted")
    ex.on_event = print_event
    console.rule(f"[bold]{ex.run_id}[/bold]  'A keyboard'  as u_lee (suspended contractor)")
    try:
        ex.start()
    except ToolError as e:
        console.print(f"[red]{e}[/red]")
    ok, _, msg = verify_chain(ex.run_id)
    console.print(f"[{'green' if ok else 'red'}]ledger: {msg}[/]\n")
    return ex.run_id


ALL = {"happy": happy, "vendor": vendor, "injection": injection, "flaky": flaky, "approval": approval,
       "suspended": suspended, "halt": halt}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", choices=[*ALL, "all"])
    ap.add_argument("--auto", action="store_true", help="auto-approve / auto-halt in-process")
    a = ap.parse_args()
    for name, fn in (ALL.items() if a.name == "all" else [(a.name, ALL[a.name])]):
        fn(auto=a.auto)


if __name__ == "__main__":
    main()
