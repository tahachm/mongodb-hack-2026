"""MongoDB Atlas is the identity, policy and audit layer.

Collections
  identities  people and agents, with team, role, scopes, approval rights
  policies    versioned purchasing policies (one active version per team)
  actions     append-only, hash-chained audit ledger; $jsonSchema-validated
  runs        one doc per agent run (request, principal, status, seq counter)
  approvals   human-in-the-loop approval requests
  controls    kill switches: {_id: "global"} and {_id: <run_id>}, watched via change streams
"""
from __future__ import annotations

from pymongo import ASCENDING, DESCENDING, MongoClient

from . import config

_client = None

ACTIONS = ["run_start", "search", "create_checkout", "authorize", "request_approval", "approval",
           "delegate_payment", "complete_checkout", "verify", "cancel_checkout", "halt", "run_end", "note"]
STATUSES = ["intent", "allowed", "denied", "pending_approval", "approved", "rejected", "sent",
            "effective", "replayed", "failed", "halted", "cancelled", "info"]

# Every ledger entry must say who acted, for whom, what, and chain to the previous entry.
# An `authorize` entry is rejected by the database unless it cites a policy id + version.
ACTION_SCHEMA = {
    "bsonType": "object",
    "required": ["run_id", "seq", "ts", "ts_iso", "actor", "principal", "action", "status", "prev_hash", "hash"],
    "properties": {
        "run_id": {"bsonType": "string"},
        "seq": {"bsonType": ["int", "long"], "minimum": 1},
        "ts": {"bsonType": "date"},
        "ts_iso": {"bsonType": "string"},
        "actor": {"bsonType": "string"},
        "principal": {"bsonType": "string"},
        "action": {"enum": ACTIONS},
        "status": {"enum": STATUSES},
        "prev_hash": {"bsonType": "string", "minLength": 64, "maxLength": 64},
        "hash": {"bsonType": "string", "minLength": 64, "maxLength": 64},
        "amount_cents": {"bsonType": ["int", "long"], "minimum": 0},
    },
    "anyOf": [
        {"properties": {"action": {"not": {"enum": ["authorize"]}}}},
        {"required": ["policy"],
         "properties": {"policy": {"bsonType": "object", "required": ["policy_id", "version"]}}},
    ],
}


def client():
    global _client
    if _client is None:
        if config.MONGODB_URI.startswith("mongomock://"):
            import mongomock  # local tests only
            _client = mongomock.MongoClient()
        else:
            _client = MongoClient(config.MONGODB_URI, appname="mandate-agent")
    return _client


def db():
    return client()[config.DB_NAME]


def supports_change_streams() -> bool:
    return not config.MONGODB_URI.startswith("mongomock://")


def init_db(drop: bool = False) -> list[str]:
    d = db()
    notes = []
    if drop:
        for c in ["identities", "policies", "actions", "runs", "approvals", "controls"]:
            d.drop_collection(c)
    existing = set(d.list_collection_names())
    validator = {"$jsonSchema": ACTION_SCHEMA}
    try:
        if "actions" not in existing:
            d.create_collection("actions", validator=validator, validationLevel="strict", validationAction="error")
        else:
            d.command("collMod", "actions", validator=validator, validationLevel="strict", validationAction="error")
        notes.append("actions: $jsonSchema validation ON (strict/error)")
    except Exception as e:  # mongomock has no validators
        if "actions" not in d.list_collection_names():
            d.create_collection("actions")
        notes.append(f"actions: schema validation unavailable on this backend ({type(e).__name__})")

    d.actions.create_index([("run_id", ASCENDING), ("seq", ASCENDING)], unique=True)
    d.actions.create_index([("principal", ASCENDING), ("ts", DESCENDING)])
    d.actions.create_index([("team", ASCENDING), ("action", ASCENDING), ("status", ASCENDING), ("ts", DESCENDING)])
    d.policies.create_index([("policy_id", ASCENDING), ("version", DESCENDING)], unique=True)
    d.approvals.create_index([("status", ASCENDING), ("created", DESCENDING)])
    d.runs.create_index([("started", DESCENDING)])
    return notes
