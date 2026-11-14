from rich.console import Console

console = Console()

STATUS_STYLE = {
    "effective": "green", "allowed": "bold green", "approved": "bold green", "replayed": "yellow",
    "denied": "bold red", "rejected": "bold red", "failed": "red", "halted": "bold white on red",
    "cancelled": "magenta", "pending_approval": "bold yellow", "sent": "cyan", "intent": "cyan", "info": "dim",
}


def money(c) -> str:
    return f"${(c or 0) / 100:,.2f}"


def summarize(rec: dict) -> str:
    a = rec["action"]
    if a == "run_start":
        return f"request: {rec.get('request')!r} (team {rec.get('team')}, kill switch via {rec.get('kill_switch')})"
    if a == "search":
        return f"query {rec.get('query')!r} -> {rec.get('result_count')} products"
    if a == "create_checkout" and rec["status"] == "effective":
        lines = ", ".join(f"{l['qty']}x {l['title']}" for l in rec.get("lines", []))
        return f"{rec.get('merchant_id')}: {lines} = {money(rec.get('amount_cents'))}"
    if a == "authorize":
        p = rec.get("policy") or {}
        failed = [c["detail"] for c in rec.get("checks", []) if not c["passed"]]
        tail = ("; ".join(failed)) if failed else f"{len(rec.get('checks', []))} checks passed"
        return f"{money(rec.get('amount_cents'))} under {p.get('policy_id')} v{p.get('version')}: {tail}"
    if a == "delegate_payment" and rec.get("allowance"):
        al = rec["allowance"]
        return f"allowance max {money(al['max_amount'])} @ {al['merchant_id']} for {al['checkout_session_id']}"
    if a == "complete_checkout" and rec["status"] in ("effective", "replayed"):
        return f"order {rec.get('order_id')} {money(rec.get('amount_cents'))}" + (
            f" — {rec['detail']}" if rec.get("detail") else "")
    for k in ("detail", "reason", "summary", "outcome"):
        if rec.get(k):
            return str(rec[k])
    return rec.get("checkout_session_id") or ""


def print_event(rec: dict):
    style = STATUS_STYLE.get(rec["status"], "white")
    console.print(f"[dim]#{rec['seq']:>3}[/dim] [bold]{rec['action']:<18}[/bold] "
                  f"[{style}]{rec['status']:<16}[/{style}] {summarize(rec)}", highlight=False)
