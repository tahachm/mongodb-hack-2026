"""End-to-end smoke test against the mock commerce server.

    uvicorn mocks.app:app --port 8100 &
    MONGODB_URI=mongomock:// python -m tests.smoke     # in-memory, no Atlas needed
"""
from types import SimpleNamespace as NS

from mandate import scenarios
from mandate.db import db
from mandate.gate import spent_this_month
from mandate.ledger import verify_chain
from mandate.seed import seed


def tool_use(id_, name, inp):
    return NS(type="tool_use", id=id_, name=name, input=inp)


class FakeClaude:
    """Scripted stand-in for the Anthropic client to exercise the agent loop offline."""
    def __init__(self):
        self.step = 0
        self.messages = self

    def create(self, **kw):
        self.step += 1
        last = kw["messages"][-1]["content"]
        if self.step == 1:
            return NS(stop_reason="tool_use", content=[tool_use("t1", "search_products",
                                                                {"query": "4K monitor", "reason": "find monitors"})])
        if self.step == 2:
            return NS(stop_reason="tool_use", content=[tool_use("t2", "create_checkout", {
                "merchant_id": "northdesk", "items": [{"product_id": "nd-kb-mech", "quantity": 1}], "reason": "kb"})])
        if self.step == 3:
            import json
            sid = json.loads(last[0]["content"])["checkout_session_id"]
            return NS(stop_reason="tool_use", content=[tool_use("t3", "purchase",
                                                                {"checkout_session_id": sid, "reason": "buy"})])
        return NS(stop_reason="end_turn", content=[NS(type="text", text="Bought one keyboard.")])


def main():
    seed(drop=True)
    results = {name: fn(auto=True) for name, fn in scenarios.ALL.items()}
    d = db()

    def statuses(run):
        return [(a["action"], a["status"]) for a in d.actions.find({"run_id": run}).sort("seq", 1)]

    assert ("complete_checkout", "effective") in statuses(results["happy"])
    assert ("authorize", "denied") in statuses(results["vendor"])
    assert ("authorize", "denied") in statuses(results["injection"])
    assert ("complete_checkout", "replayed") in statuses(results["flaky"]), statuses(results["flaky"])
    assert ("verify", "effective") in statuses(results["flaky"])
    assert ("approval", "approved") in statuses(results["approval"])
    assert ("complete_checkout", "effective") in statuses(results["approval"])
    assert ("run_start", "denied") in statuses(results["suspended"])
    hs = statuses(results["halt"])
    assert ("halt", "halted") in hs and hs.count(("cancel_checkout", "cancelled")) == 2, hs
    assert not any(a == "complete_checkout" for a, _ in hs)

    for r in results.values():
        assert verify_chain(r)[0], r
    # 1098 (happy) + 329 (flaky, counted once) + 1449 (approval)
    assert spent_this_month("design") == 109800 + 32900 + 144900, spent_this_month("design")

    # Tamper detection
    d.actions.update_one({"run_id": results["happy"], "seq": 3}, {"$set": {"amount_cents": 1}})
    ok, bad, msg = verify_chain(results["happy"])
    assert not ok and bad == 3, msg

    # Approval rules
    from mandate import control
    aid = control.request_approval("x", "u_maya", "northdesk", "cs_x", 1, {"policy_id": "p", "version": 1}, "t")
    for who in ["u_maya", "u_sam"]:
        try:
            control.decide_approval(aid, who, True)
            raise AssertionError(f"{who} should not approve")
        except PermissionError:
            pass

    # Agent loop with a fake model
    from mandate.agent import run_agent
    rid = run_agent("u_maya", "a keyboard", client=FakeClaude())
    st = statuses(rid)  # budget is nearly used up by now, so the gate must deny
    assert ("authorize", "denied") in st and ("cancel_checkout", "cancelled") in st, st
    assert verify_chain(rid)[0]
    print("\nSMOKE TEST PASSED")


if __name__ == "__main__":
    main()
