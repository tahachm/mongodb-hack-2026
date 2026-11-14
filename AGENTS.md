# AGENTS.md

Context for anyone, human or agent, working in this repo. The repo is a mock Agentic Commerce Protocol (ACP) backend for a shopping agent: merchant mocks (`merchant/`), a payment service provider mock (`psp/`), a past-purchase vector store on MongoDB Atlas (`preferences/`), and a chat harness (`harness/`). `README.md` covers how to run each service; `plan/PLAN.md` covers the agent design.

## Worked example: one shopping request, end to end

This traces one request through the shopping agent described in `plan/prompts/agent-system-prompt.md`: the preference store, the audit log, merchant search over ACP, checkout, and the record saved afterwards. Product ids, names, prices and merchants come from `merchant/src/main/resources/catalog.json`. Record ids, event ids and order ids are made up. Each "round" is one batch of tool calls made together.

`search_preferences`, `save_preference_record` and `record_audit_event` don't exist yet; their contracts are in the prompt's header comment and section 2.

### Starting point

The user's history holds two records:

- September 2026, `purchased`: they asked for "a warm sweatshirt for evening walks" and said "M, and nothing bright". They bought a Driftwood crewneck sweatshirt in black, size M, for $23.95 from Thread Barn, and said "black goes with everything I own".
- October 2026, `rejected_all`: they asked for a light jacket and rejected a burgundy bomber jacket, a burgundy windbreaker and a camel denim jacket, saying "too flashy, I like plain dark colours".

### The conversation

**User:** I want a comfortable hoodie

Round 1, history:

```json
{
  "queries": [
    { "id": "whole", "text": "The user's preferences when buying a hoodie" },
    { "id": "category", "text": "What the user chose or rejected when shopping for sweatshirts or tops" },
    { "id": "size", "text": "The clothing size the user wears for tops and sweatshirts" },
    { "id": "comfort", "text": "What the user finds comfortable in clothing" },
    { "id": "colour", "text": "Colours the user likes or avoids in clothing" },
    { "id": "problems", "text": "Problems the user had with clothes that didn't fit, wore out or disappointed" },
    { "id": "price", "text": "How much the user has paid for sweatshirts and casual tops" }
  ]
}
```

Both records come back: `pur_3a91c0d2e4f5a6b7c8d9` (September) and `pur_7e05b1c93d48f2a6e017` (October).

Deciding whether to ask anything:

- The request is short and the user hasn't asked for help choosing, so the default is to act.
- Size has relevant data: they bought a sweatshirt in M two months ago. Not a gap.
- Colour has relevant data: two records agree on plain, dark colours. Not a gap.
- Comfort is a gap, but not important: listings don't state fabrics, so no answer could change which hoodies to show. Skip it.
- Occasion is a gap, but not important: a hoodie for home and a hoodie for going out are the same product. Skip it.
- Budget has thin data: one past price. That's enough to make an assumption, so don't ask; show a spread of prices.

No gap gets `ask`, so ask nothing.

Round 2, in parallel:

`record_audit_event`:

```json
{
  "type": "history_insights",
  "updates_event_id": null,
  "request": "A comfortable hoodie. No size, colour, budget or occasion given.",
  "insights": [
    { "facet": "size", "finding": "Wears size M in sweatshirts; said 'M' when buying one in September.", "evidence": ["pur_3a91c0d2e4f5a6b7c8d9"], "confidence": "high" },
    { "facet": "colour", "finding": "Prefers plain, dark colours and avoids bright ones. Said black goes with everything they own, and called burgundy and camel jackets too flashy.", "evidence": ["pur_3a91c0d2e4f5a6b7c8d9", "pur_7e05b1c93d48f2a6e017"], "confidence": "high" },
    { "facet": "price", "finding": "Paid $23.95 for their last sweatshirt. No stated budget.", "evidence": ["pur_3a91c0d2e4f5a6b7c8d9"], "confidence": "low" }
  ],
  "ignored_records": [],
  "gaps": [
    { "facet": "comfort", "important": false, "action": "skip", "note": "No history on what comfortable means to them, and the listings don't state materials, so an answer wouldn't change what to show." },
    { "facet": "occasion", "important": false, "action": "skip", "note": "Not given, but a hoodie for any occasion is the same product." }
  ],
  "assumptions": ["No budget limit; show a spread of prices."],
  "follow_up_question": null,
  "summary": "They want a comfortable hoodie. Their history clearly shows size M and plain, dark colours. I can't judge comfort from these listings, and I have no budget, so I'll show a range of prices."
}
```

`search_products` three times, one word each: `{ "query": "hoodie" }`, `{ "query": "hooded" }` and `{ "query": "sweatshirt" }`. The user's word, the likely label word, and a broader one. There's no colour in the queries, because the user didn't ask for one today; their colour preference is for filtering.

The insights event returns `evt_6d2e91a4c07b`. "hoodie" finds nothing. "hooded" finds 26 products, all named "... Hooded Sweatshirt, <size>, <colour>", so that's what the stores call a hoodie. "sweatshirt" finds the same 26 plus 25 crewneck sweatshirts, which aren't hooded, so they're dropped. After merging, there are 9 hooded sweatshirts in size M. The ones in plain colours closest to their history are: Statewear in black, $10.79 (Thread Barn); Urban Loom in black, $17.49 (Mall-Wart, Thread Barn); Thread Barn in heather gray, $23.49 (Mall-Wart, Thread Barn); Urban Loom in charcoal, $32.29 (Mall-Wart, Thread Barn); Alpine Knit in heather gray, $42.99 (Thread Barn). The others are royal blue, forest green, white and khaki.

Round 3, `record_audit_event`:

```json
{
  "type": "recommendation_plan",
  "insights_event_id": "evt_6d2e91a4c07b",
  "searches": ["hoodie", "hooded", "sweatshirt"],
  "options": [
    { "option_number": 1, "product_id": "clothing-03469", "merchant_ids": ["threadbarn"], "price_cents": 1079,
      "why": "Black, which they said goes with everything they own; size M; the lowest price.",
      "insights_used": ["colour", "size"], "unknowns": ["material"], "tradeoff": "Same colour as the black crewneck they already have." },
    { "option_number": 2, "product_id": "clothing-03491", "merchant_ids": ["mall-wart", "threadbarn"], "price_cents": 2349,
      "why": "A plain neutral in size M, if they'd like something different from black.",
      "insights_used": ["colour", "size"], "unknowns": ["material"], "tradeoff": "Lighter than the dark colours they've mostly chosen." },
    { "option_number": 3, "product_id": "clothing-03476", "merchant_ids": ["mall-wart", "threadbarn"], "price_cents": 3229,
      "why": "Dark like black but a different shade; size M.",
      "insights_used": ["colour", "size"], "unknowns": ["material"], "tradeoff": "The most expensive of the three." }
  ],
  "highlighted_product_id": "clothing-03469",
  "highlight_reason": "Matches both settled preferences, size M and black, at the lowest price.",
  "not_shown": [
    { "product_id": "clothing-03360", "reason": "Black like option 1 but $6.70 more." },
    { "product_id": "clothing-03422", "reason": "Heather gray like option 2 but $19.50 more." },
    { "product_id": "clothing-03432", "reason": "Royal blue: a bright colour, which they avoid." },
    { "product_id": "clothing-03480", "reason": "Forest green: closer to the coloured jackets they called too flashy than to the neutrals they've bought." },
    { "product_id": "clothing-03387", "reason": "White: not one of the dark colours they said they like." },
    { "product_id": "clothing-03355", "reason": "Khaki: light, and the most expensive at $46.79." }
  ],
  "assumptions_relied_on": ["No budget limit; show a spread of prices."],
  "no_fit_explanation": null,
  "summary": "Three plain-coloured hooded sweatshirts in size M at three price points, led by the cheapest black one."
}
```

**Assistant:**

> Here are three in size M, all in plain, muted colours like the ones you've gone for before. My pick is the first:
>
> 1. **Statewear Hooded Sweatshirt, Black**, $10.79 at Thread Barn. You said black goes with everything you own, and it's the lowest price. Trade-off: it's the same colour as the crewneck you already have.
> 2. **Thread Barn Hooded Sweatshirt, Heather Gray**, $23.49 at Thread Barn or Mall-Wart. A plain neutral, if you'd like something different from black. Trade-off: lighter than the dark colours you usually pick.
> 3. **Urban Loom Hooded Sweatshirt, Charcoal**, $32.29 at Thread Barn or Mall-Wart. Dark like black, but a different shade. Trade-off: the priciest.
>
> I went with size M, as you bought last time. None of the listings say what they're made of, so I can't tell you which is softest. Pick one and I'll show you the total before ordering, or I can look for something else.

**User:** the gray one

Round 1: `create_checkout_session` with `{ "merchant_id": "threadbarn", "items": [{ "id": "clothing-03491", "quantity": 1 }] }`. Thread Barn is where they bought before. The total is 2349.

**Assistant:**

> Good pick. That's **1 × Thread Barn Hooded Sweatshirt, M, Heather Gray** from Thread Barn, **$23.49** in total. Shall I place the order?
>
> And what made the gray one win over the black? Fine to skip.

**User:** yes. the black ones look too much like the one I already have

Round 1: `pay_for_checkout_session` returns `completed` with order `ord_4b21c9e07a3f`.

Round 2: `save_preference_record`:

```json
{
  "kind": "purchased",
  "request": "The user asked: 'I want a comfortable hoodie'. They didn't give a size, colour, budget or occasion.",
  "comparison": "The assistant showed three hooded sweatshirts in size M: a Statewear in black for $10.79 from Thread Barn, highlighted because the user had said black goes with everything they own and it was the cheapest; a Thread Barn in heather gray for $23.49 from Thread Barn or Mall-Wart; and an Urban Loom in charcoal for $32.29 from Thread Barn or Mall-Wart. The assistant assumed size M from the user's earlier sweatshirt purchase. None of the listings stated a material, so comfort couldn't be compared.",
  "decision": "The user chose and bought the Thread Barn hooded sweatshirt in heather gray, size M, for $23.49 from Thread Barn, over the black Statewear and the charcoal Urban Loom. They said the black ones look too much like the one they already have.",
  "merchant_id": "threadbarn",
  "product": {
    "id": "clothing-03491", "name": "Thread Barn Hooded Sweatshirt, M, Heather Gray", "brand": "Thread Barn",
    "category": "clothing", "subcategory": "mens-tops", "price_cents": 2349, "currency": "USD",
    "attributes": { "size": "M", "color": "Heather Gray" }
  },
  "options_shown": [
    { "merchant_id": "threadbarn", "product_id": "clothing-03469" },
    { "merchant_id": "threadbarn", "product_id": "clothing-03491" },
    { "merchant_id": "threadbarn", "product_id": "clothing-03476" }
  ]
}
```

**Assistant:**

> Done. Your heather gray hoodie is ordered from Thread Barn (order ord_4b21c9e07a3f), $23.49. I'll remember you wanted something different from the black one you already have.
