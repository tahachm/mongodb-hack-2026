"""Kill switch and human approvals.

The agent subscribes to the `controls` collection with a change stream, so flipping
{halted: true} from anywhere (CLI, Atlas UI, another service) stops the agent before
its next action. Falls back to polling when change streams are unavailable.
"""
from __future__ import annotations

import secrets
import threading
import time
from datetime import datetime, timezone

from .db import db, supports_change_streams


class Halted(Exception):
    pass


def is_halted(run_id: str) -> dict | None:
    return db().controls.find_one({"_id": {"$in": ["global", run_id]}, "halted": True})


def set_halt(halted: bool, run_id: str | None = None, by: str = "operator", reason: str = "") -> dict:
    key = run_id or "global"
    doc = {"halted": halted, "by": by, "reason": reason, "at": datetime.now(timezone.utc)}
    db().controls.update_one({"_id": key}, {"$set": doc}, upsert=True)
    return {"_id": key, **doc}


class HaltWatcher(threading.Thread):
    def __init__(self, run_id: str):
        super().__init__(daemon=True)
        self.run_id = run_id
        self.event = threading.Event()
        self.info: dict | None = None
        self.mode = "change-stream" if supports_change_streams() else "polling"
        self._stopper = threading.Event()

    def run(self):
        if self.mode == "change-stream":
            try:
                pipeline = [{"$match": {"documentKey._id": {"$in": ["global", self.run_id]}}}]
                with db().controls.watch(pipeline, full_document="updateLookup") as stream:
                    while not self._stopper.is_set():
                        ch = stream.try_next()
                        if ch and (ch.get("fullDocument") or {}).get("halted"):
                            self.info = ch["fullDocument"]
                            self.event.set()
                            return
                        if ch is None:
                            time.sleep(0.2)
                return
            except Exception:
                self.mode = "polling"
        while not self._stopper.is_set():
            hit = is_halted(self.run_id)
            if hit:
                self.info = hit
                self.event.set()
                return
            time.sleep(0.5)

    def stop(self):
        self._stopper.set()

    def check(self):
        # The watcher is the fast path; a direct read closes the race at startup.
        hit = self.info if self.event.is_set() else is_halted(self.run_id)
        if hit:
            raise Halted(f"halted by {hit.get('by')}: {hit.get('reason') or 'no reason given'}")


# ------------------------------------------------------------------ approvals

def request_approval(run_id: str, principal: str, merchant_id: str, session_id: str,
                     amount_cents: int, policy: dict, summary: str) -> str:
    aid = "apr_" + secrets.token_hex(4)
    db().approvals.insert_one({
        "_id": aid, "run_id": run_id, "principal": principal, "merchant_id": merchant_id,
        "checkout_session_id": session_id, "amount_cents": amount_cents, "policy": policy,
        "summary": summary, "status": "pending", "created": datetime.now(timezone.utc),
    })
    return aid


def decide_approval(approval_id: str, approver_id: str, approve: bool, note: str = "") -> dict:
    d = db()
    apr = d.approvals.find_one({"_id": approval_id})
    if not apr:
        raise ValueError(f"no approval {approval_id}")
    if apr["status"] != "pending":
        raise ValueError(f"approval already {apr['status']}")
    approver = d.identities.find_one({"_id": approver_id})
    principal = d.identities.find_one({"_id": apr["principal"]})
    if not approver or approver.get("status") != "active" or not approver.get("can_approve"):
        raise PermissionError(f"{approver_id} is not allowed to approve purchases")
    if approver_id == apr["principal"]:
        raise PermissionError("segregation of duties: requester cannot approve their own purchase")
    if approver.get("team") != principal.get("team"):
        raise PermissionError("approver must be on the requester's team")
    status = "approved" if approve else "rejected"
    d.approvals.update_one({"_id": approval_id, "status": "pending"},
                           {"$set": {"status": status, "approver": approver_id, "note": note,
                                     "decided": datetime.now(timezone.utc)}})
    return d.approvals.find_one({"_id": approval_id})


def wait_for_approval(approval_id: str, watcher: HaltWatcher, timeout_s: float = 180) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        watcher.check()
        apr = db().approvals.find_one({"_id": approval_id})
        if apr["status"] != "pending":
            return apr
        time.sleep(0.5)
    db().approvals.update_one({"_id": approval_id, "status": "pending"}, {"$set": {"status": "expired"}})
    return db().approvals.find_one({"_id": approval_id})
