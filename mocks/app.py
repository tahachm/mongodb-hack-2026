"""Mock commerce backend shaped after the Agentic Commerce Protocol (ACP, spec 2026-04-17).

One process hosts:
  * three merchants:  /merchants/{merchant_id}/checkout_sessions[...]
  * one payment service provider (PSP):  /psp/agentic_commerce/delegate_payment

What is faithful to ACP:
  - checkout session create / update / retrieve / complete / cancel
  - Idempotency-Key required on every POST; same key + same body replays the stored
    response with `Idempotent-Replayed: true`; same key + different body -> 422 idempotency_conflict
  - delegate_payment returns a `vt_` vault token constrained by an Allowance
    (reason, max_amount, currency, checkout_session_id, merchant_id, expires_at)
  - cancel on a completed/canceled session -> 405

What is simplified: no real card data, the merchant redeems tokens in-process, and
`GET /merchants/{id}/products` stands in for ACP's product feed.

Chaos hook (for the "took effect vs. only sent" demo):
  POST /_chaos {"merchant_id": "...", "drop_next_complete_response": true}
  -> the next /complete succeeds on the merchant side but the client gets a 504.

Run:  uvicorn mocks.app:app --port 8100
"""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from mocks.catalog import CATALOGS

app = FastAPI(title="Mandate mock commerce (ACP-shaped)")

_lock = threading.Lock()
SESSIONS: dict[str, dict[str, dict]] = {m: {} for m in CATALOGS}
IDEM: dict[tuple[str, str], tuple[str, int, dict]] = {}
TOKENS: dict[str, dict] = {}
CHAOS: dict[str, dict] = {m: {"drop_next_complete_response": False} for m in CATALOGS}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(status: int, code: str, message: str, type_: str = "invalid_request", param: str | None = None):
    body = {"type": type_, "code": code, "message": message}
    if param:
        body["param"] = param
    return JSONResponse(status_code=status, content=body)


def _body_hash(body) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def _idempotent(scope: str, key: str | None, body, fn):
    """Run fn() once per (scope, key). Replays the stored response afterwards."""
    if not key:
        return _err(400, "missing_idempotency_key", "Idempotency-Key header is required on POST")
    h = _body_hash(body)
    with _lock:
        hit = IDEM.get((scope, key))
    if hit:
        stored_hash, status, payload = hit
        if stored_hash != h:
            return _err(422, "idempotency_conflict", "Idempotency-Key reused with a different request body")
        return JSONResponse(status_code=status, content=payload, headers={"Idempotent-Replayed": "true"})
    status, payload, drop = fn()
    with _lock:
        IDEM[(scope, key)] = (h, status, payload)
    if drop:
        # The work happened and is recorded, but the caller never hears about it.
        return _err(504, "upstream_timeout", "Gateway timeout while confirming order", type_="service_unavailable")
    return JSONResponse(status_code=status, content=payload, headers={"Idempotent-Replayed": "false"})


def _merchant(merchant_id: str):
    if merchant_id not in CATALOGS:
        raise HTTPException(404, f"unknown merchant {merchant_id}")
    return CATALOGS[merchant_id]


def _price_lines(merchant_id: str, items: list[dict]):
    products = {p["id"]: p for p in CATALOGS[merchant_id]["products"]}
    lines = []
    for i, it in enumerate(items):
        p = products.get(it.get("id"))
        if not p:
            return None, _err(400, "invalid_item", f"unknown item {it.get('id')}", param=f"$.items[{i}].id")
        qty = int(it.get("quantity", 1))
        if qty < 1:
            return None, _err(400, "invalid_quantity", "quantity must be >= 1", param=f"$.items[{i}].quantity")
        lines.append({
            "id": f"li_{i}",
            "item": {"id": p["id"], "quantity": qty},
            "title": p["title"],
            "category": p["category"],
            "base_amount": p["unit_amount"] * qty,
            "unit_amount": p["unit_amount"],
            "tax": 0,
            "total": p["unit_amount"] * qty,
        })
    return lines, None


def _totals(lines):
    sub = sum(l["total"] for l in lines)
    return [{"type": "subtotal", "amount": sub}, {"type": "total", "amount": sub}]


def _session_total(s) -> int:
    return next(t["amount"] for t in s["totals"] if t["type"] == "total")


# --------------------------------------------------------------------------- merchants

@app.get("/health")
def health():
    return {"ok": True, "merchants": list(CATALOGS)}


@app.get("/merchants/{merchant_id}/products")
def products(merchant_id: str, q: str = ""):
    m = _merchant(merchant_id)
    toks = [t for t in q.lower().replace('"', " ").split() if len(t) > 1]
    out = []
    for p in m["products"]:
        hay = f"{p['title']} {p['category']} {p['description']}".lower()
        score = sum(1 for t in toks if t in hay or t.rstrip("s") in hay)
        if not toks or score:
            out.append({**p, "merchant_id": merchant_id, "merchant_name": m["name"], "_score": score})
    out.sort(key=lambda p: -p["_score"])
    for p in out:
        p.pop("_score")
    return {"merchant_id": merchant_id, "products": out}


@app.post("/merchants/{merchant_id}/checkout_sessions", status_code=201)
async def create_session(merchant_id: str, request: Request, idempotency_key: str | None = Header(None)):
    _merchant(merchant_id)
    body = await request.json()

    def work():
        lines, err = _price_lines(merchant_id, body.get("items", []))
        if err:
            return err.status_code, json.loads(err.body), False
        sid = "cs_" + secrets.token_hex(8)
        s = {
            "id": sid, "merchant_id": merchant_id, "status": "ready_for_payment", "currency": "usd",
            "buyer": body.get("buyer"), "line_items": lines, "totals": _totals(lines),
            "created": _now(), "order": None, "messages": [],
        }
        with _lock:
            SESSIONS[merchant_id][sid] = s
        return 201, s, False

    return _idempotent(f"{merchant_id}:create", idempotency_key, body, work)


@app.get("/merchants/{merchant_id}/checkout_sessions/{sid}")
def get_session(merchant_id: str, sid: str):
    _merchant(merchant_id)
    s = SESSIONS[merchant_id].get(sid)
    if not s:
        return _err(404, "not_found", f"checkout session {sid} not found")
    return s


@app.post("/merchants/{merchant_id}/checkout_sessions/{sid}")
async def update_session(merchant_id: str, sid: str, request: Request, idempotency_key: str | None = Header(None)):
    _merchant(merchant_id)
    body = await request.json()

    def work():
        s = SESSIONS[merchant_id].get(sid)
        if not s:
            return 404, {"type": "invalid_request", "code": "not_found", "message": "session not found"}, False
        if s["status"] in ("completed", "canceled"):
            return 405, {"type": "invalid_request", "code": "session_closed", "message": f"session is {s['status']}"}, False
        if "items" in body:
            lines, err = _price_lines(merchant_id, body["items"])
            if err:
                return err.status_code, json.loads(err.body), False
            s["line_items"], s["totals"] = lines, _totals(lines)
        return 200, s, False

    return _idempotent(f"{merchant_id}:update:{sid}", idempotency_key, body, work)


@app.post("/merchants/{merchant_id}/checkout_sessions/{sid}/complete")
async def complete_session(merchant_id: str, sid: str, request: Request, idempotency_key: str | None = Header(None)):
    _merchant(merchant_id)
    body = await request.json()

    def work():
        s = SESSIONS[merchant_id].get(sid)
        if not s:
            return 404, {"type": "invalid_request", "code": "not_found", "message": "session not found"}, False
        if s["status"] != "ready_for_payment":
            return 405, {"type": "invalid_request", "code": "session_closed", "message": f"session is {s['status']}"}, False
        token = (body.get("payment_data") or {}).get("token")
        ok, reason = _redeem(token, merchant_id, sid, _session_total(s), s["currency"])
        if not ok:
            return 402, {"type": "invalid_request", "code": "payment_declined", "message": reason}, False
        s["status"] = "completed"
        s["order"] = {"id": "ord_" + secrets.token_hex(6), "checkout_session_id": sid,
                      "permalink_url": f"https://{merchant_id}.example.com/orders/{sid}"}
        drop = CHAOS[merchant_id]["drop_next_complete_response"]
        CHAOS[merchant_id]["drop_next_complete_response"] = False
        return 200, s, drop

    return _idempotent(f"{merchant_id}:complete:{sid}", idempotency_key, body, work)


@app.post("/merchants/{merchant_id}/checkout_sessions/{sid}/cancel")
async def cancel_session(merchant_id: str, sid: str, request: Request, idempotency_key: str | None = Header(None)):
    _merchant(merchant_id)
    try:
        body = await request.json()
    except Exception:
        body = {}

    def work():
        s = SESSIONS[merchant_id].get(sid)
        if not s:
            return 404, {"type": "invalid_request", "code": "not_found", "message": "session not found"}, False
        if s["status"] in ("completed", "canceled"):
            return 405, {"type": "invalid_request", "code": "session_closed", "message": f"session is {s['status']}"}, False
        s["status"] = "canceled"
        s["cancel_intent_trace"] = body.get("intent_trace")
        return 200, s, False

    return _idempotent(f"{merchant_id}:cancel:{sid}", idempotency_key, body, work)


# --------------------------------------------------------------------------- PSP

@app.post("/psp/agentic_commerce/delegate_payment", status_code=201)
async def delegate_payment(request: Request, idempotency_key: str | None = Header(None)):
    body = await request.json()

    def work():
        pm = body.get("payment_method") or {}
        al = body.get("allowance") or {}
        required = ["reason", "max_amount", "currency", "checkout_session_id", "merchant_id", "expires_at"]
        missing = [f for f in required if f not in al]
        if pm.get("type") != "card":
            return 400, {"type": "invalid_request", "code": "invalid_payment_method", "message": "only card supported",
                         "param": "$.payment_method.type"}, False
        if missing:
            return 400, {"type": "invalid_request", "code": "missing_allowance_field",
                         "message": f"allowance missing {missing}", "param": f"$.allowance.{missing[0]}"}, False
        if al["reason"] != "one_time":
            return 400, {"type": "invalid_request", "code": "invalid_allowance_reason",
                         "message": "only one_time supported", "param": "$.allowance.reason"}, False
        tid = "vt_" + secrets.token_hex(10)
        with _lock:
            TOKENS[tid] = {"allowance": al, "used": False, "created": _now(),
                           "last4": str(pm.get("number", "0000"))[-4:]}
        return 201, {"id": tid, "created": _now(), "metadata": {**(body.get("metadata") or {}), "psp": "mockpsp"}}, False

    return _idempotent("psp:delegate", idempotency_key, body, work)


def _redeem(token: str | None, merchant_id: str, sid: str, amount: int, currency: str):
    with _lock:
        t = TOKENS.get(token or "")
        if not t:
            return False, "unknown payment token"
        al = t["allowance"]
        if t["used"]:
            return False, "token already used (one_time allowance)"
        if al["merchant_id"] != merchant_id:
            return False, f"token not valid for merchant {merchant_id}"
        if al["checkout_session_id"] != sid:
            return False, "token bound to a different checkout session"
        if al["currency"] != currency:
            return False, "currency mismatch"
        if amount > int(al["max_amount"]):
            return False, f"amount {amount} exceeds allowance max_amount {al['max_amount']}"
        if datetime.fromisoformat(al["expires_at"].replace("Z", "+00:00")) < datetime.now(timezone.utc):
            return False, "allowance expired"
        t["used"] = True
        return True, "ok"


@app.post("/_chaos")
async def chaos(request: Request):
    body = await request.json()
    m = body["merchant_id"]
    CHAOS[m]["drop_next_complete_response"] = bool(body.get("drop_next_complete_response"))
    return {"merchant_id": m, **CHAOS[m]}
