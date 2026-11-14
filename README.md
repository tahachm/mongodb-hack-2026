# Mandate — a purchasing agent you can audit

**Track 1: Agents You Can Audit.** Built at Agents in Context Toronto (MongoDB hackathon, Nov 14 2026).

An LLM procurement agent buys equipment for employees through the **Agentic Commerce Protocol (ACP)**.
MongoDB Atlas is its identity, policy and audit layer. Every action is:

1. **tied to an identity**: the agent's own identity and scopes, plus the human it's acting for (`identities`)
2. **checked against policy before it runs**: a deterministic gate reads the *merchant's* checkout session (not the LLM's claims) and checks it against the team's active, versioned policy (`policies`)
3. **capped at the payment layer**: the ACP `allowance.max_amount` comes from the gate's verified total, so even a hijacked model can't overspend
4. **recorded so a reviewer can reconstruct it**: an append-only, hash-chained ledger (`actions`) with `$jsonSchema` validation, so the database rejects an `authorize` entry that doesn't cite a policy id and version
5. **stoppable mid-run**: a kill switch in `controls`, watched with a **change stream**; halting cancels every open checkout (rollback)

## How it works

```
 user request ─► Claude (tool use) ─► ToolExecutor ──► mock ACP merchants (/checkout_sessions…)
                                          │    ▲   └──► mock PSP (/agentic_commerce/delegate_payment)
                       kill switch check  │    │ change stream on `controls`
                       scope check        ▼    │
                                     MongoDB Atlas
            identities · policies (versioned) · actions (hash-chained ledger) · approvals · runs
```

| Question from the brief | Answer in Mandate |
|---|---|
| Decide what the agent may do *before* the action | `gate.evaluate()`: identity active, approved merchant, allowed category, quantity limit, per-order cap, monthly budget (aggregated from the ledger), human approval over a threshold |
| Record what it did, why, under whose authority | Every ledger entry has actor, principal, policy id+version, the individual check results, the LLM's stated `reason`, idempotency key, and a hash link to the previous entry |
| Stop or roll back mid-run | `ctl halt` → change stream → agent stops before its next action → open checkout sessions are cancelled through ACP `/cancel` |
| Sent vs. took effect | `sent` is logged *before* the call, with an idempotency key derived from the run and session. Retries reuse that key, the merchant replays the result (`Idempotent-Replayed`), and the agent then re-reads the session to verify the effect |

## Setup (≈5 min)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # paste your Atlas sandbox URI + ANTHROPIC_API_KEY
uvicorn mocks.app:app --port 8100          # terminal 1: mock merchants + payment provider
python -m mandate.ctl init                 # creates collections, validator, indexes, seed data
```

## Demo script (3 minutes)

Use three terminals: **A** (agent), **B** (operator/reviewer), **C** (mock server).

| # | Show | Command |
|---|---|---|
| 1 | LLM agent buys within policy | A: `python -m mandate.agent --as u_maya "Get me two good 4K monitors"` |
| 2 | Prompt injection in a product description: the policy gate blocks it | A: `python -m mandate.agent --as u_maya "One calibrated designer monitor, check PixelMart"` (or deterministic: `python -m mandate.scenarios injection`) |
| 3 | Unapproved vendor blocked | A: `python -m mandate.scenarios vendor` |
| 4 | Human approval over $1,200 | A: `python -m mandate.scenarios approval` · B: `python -m mandate.ctl approvals` then `python -m mandate.ctl approve <id> --by u_omar` (try `--by u_maya` first: refused, since you can't approve your own purchase) |
| 5 | Kill switch + rollback | A: `python -m mandate.scenarios halt` · B: `python -m mandate.ctl halt --run <run_id> --reason "freeze spend"` |
| 6 | Response lost, order still placed: no double charge | A: `python -m mandate.scenarios flaky` |
| 7 | Reviewer reconstructs everything | B: `python -m mandate.audit runs` · `audit show <run>` · `audit why <run> <seq>` · `audit denied` · `audit spend --team design` |
| 8 | Tamper evidence | B: `python -m mandate.ctl tamper <run> 5` then `python -m mandate.audit show <run>` → chain BROKEN at #5 |
| 9 | DB rejects an authorization with no policy | B: `python -m mandate.ctl bad-insert` |

`python -m mandate.ctl resume` clears a global halt. `python -m mandate.ctl init` resets everything, including this month's spend.

Seeded people: `u_maya` (designer), `u_omar` (design lead, can approve), `u_lee` (suspended contractor), `u_sam` (finance).
Design policy v2: NorthDesk and PixelMart approved; monitors, peripherals and furniture allowed; ≤5 per line; $2,000 per order;
$3,000 a month; approval needed over $1,200.

## Tests

```bash
uvicorn mocks.app:app --port 8100 &
MONGODB_URI=mongomock:// python -m tests.smoke   # offline, in-memory; exercises every scenario + agent loop with a fake model
```

## What's mocked

The merchants and payment provider follow the shape of the ACP 2026-04-17 spec (checkout sessions, Idempotency-Key semantics,
`delegate_payment` with an Allowance, `vt_` tokens). They run locally because live ACP access goes through OpenAI and Stripe onboarding.
Swapping in a real merchant only means changing `COMMERCE_URL`.

## Production notes

- Give the agent a MongoDB user with a custom role that allows only `insert` on `actions`, so it can't edit history.
- Anchor the latest hash of each run somewhere external (e.g. a signed daily digest) to detect a rewrite of the whole chain.
