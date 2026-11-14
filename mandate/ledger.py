"""Append-only, hash-chained audit ledger.

Each entry stores sha256(canonical(entry without hash)) and the previous entry's hash,
so editing or deleting any past entry breaks verification from that point on.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from pymongo import ReturnDocument

from .db import db

GENESIS = "0" * 64
_SKIP = {"_id", "hash", "ts"}  # ts (BSON date) is mirrored in ts_iso, which is hashed


def _canon(rec: dict) -> str:
    return json.dumps({k: v for k, v in rec.items() if k not in _SKIP},
                      sort_keys=True, separators=(",", ":"), default=str)


def _hash(rec: dict) -> str:
    return hashlib.sha256(_canon(rec).encode()).hexdigest()


def _now_ms() -> datetime:
    n = datetime.now(timezone.utc)
    return n.replace(microsecond=(n.microsecond // 1000) * 1000)


class Ledger:
    def __init__(self, run_id: str, actor: str, principal: str):
        self.run_id, self.actor, self.principal = run_id, actor, principal

    def append(self, action: str, status: str, **fields) -> dict:
        d = db()
        run = d.runs.find_one_and_update({"_id": self.run_id}, {"$inc": {"seq": 1}},
                                         upsert=True, return_document=ReturnDocument.AFTER)
        seq = run["seq"]
        prev = d.actions.find_one({"run_id": self.run_id, "seq": seq - 1}, {"hash": 1})
        now = _now_ms()
        rec = {"run_id": self.run_id, "seq": seq, "ts_iso": now.isoformat(), "actor": self.actor,
               "principal": self.principal, "action": action, "status": status,
               **{k: v for k, v in fields.items() if v is not None},
               "prev_hash": prev["hash"] if prev else GENESIS}
        rec["hash"] = _hash(rec)
        rec["ts"] = now
        d.actions.insert_one(rec)
        rec.pop("_id", None)
        return rec


def verify_chain(run_id: str) -> tuple[bool, int | None, str]:
    """Returns (ok, first_bad_seq, message)."""
    prev_hash, expected_seq = GENESIS, 1
    for a in db().actions.find({"run_id": run_id}).sort("seq", 1):
        if a["seq"] != expected_seq:
            return False, expected_seq, f"gap: entry #{expected_seq} is missing"
        if a["prev_hash"] != prev_hash:
            return False, a["seq"], f"entry #{a['seq']} does not link to entry #{a['seq'] - 1}"
        if _hash(a) != a["hash"]:
            return False, a["seq"], f"entry #{a['seq']} was modified after it was written"
        prev_hash, expected_seq = a["hash"], expected_seq + 1
    return True, None, f"{expected_seq - 1} entries, chain intact"
