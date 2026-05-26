# Real Estate Agents — Charlotte, NC

Repository of automated agents for real estate search in Charlotte, NC. Each agent runs once a day, searches the web for fresh listings, ranks them against personal criteria, and delivers a daily digest.

Context: I live in Ballantyne (south Charlotte) and work at 500 Tyvola Rd. I want to monitor the market both for my next rental (move-in September 2026) and for an eventual home purchase.

## Agents

### 1. Apartment to rent — `apto-clt` (active)

Daily agent that searches for apartments to rent for the September 2026 move-in.

- **Budget:** $1,400/month, firm
- **Area:** south Charlotte (Ballantyne, Steele Creek, Pineville, Tyvola, etc.), max 12 miles / 30 min to 500 Tyvola Rd
- **Requirements:** 1BR or studio, in-unit laundry, hard flooring, on-site parking, unfurnished
- **Pipeline:**
  1. The agent searches Zillow, Apartments.com, Zumper, HotPads, Trulia, Rent.com, Realtor.com, and major property managers
  2. Ranks the top 10 with source diversity (min 4 distinct domains, max 3 per domain)
  3. Creates a Gmail draft with a human-readable digest plus a JSON block
  4. Apps Script (`apps-script/Code.gs`) runs hourly, extracts the JSON from the draft, dedupes against the Sheet, appends new rows, and sends the draft to Outlook

Files:
- [`daily-prompt.md`](./daily-prompt.md) — operational prompt for the daily agent
- [`es-agente.md`](./es-agente.md) / [`en-agente.md`](./en-agente.md) — full criteria (Spanish / English)
- [`apps-script/`](./apps-script) — Gmail → Sheet bridge
- [`data/inbox/`](./data/inbox) — pending drafts / local history

Sheet:
[apto-clt](https://docs.google.com/spreadsheets/d/1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI/edit?usp=sharing)

### 2. House to buy — `casa-clt` (planned)

Future agent to search for a house to purchase. Same architecture (search → score → Gmail draft → Sheet sync), different criteria:

- Budget, down payment, financing scenarios
- Tax + HOA + insurance estimates
- School ratings, walkability, future appreciation
- Inspection history, year built, lot size
- Sources: Zillow, Redfin, Realtor.com, MLS feeds, Compass

Pending: define criteria and deal-breakers before implementing.

## Shared architecture

```
Claude agent (sandbox)
    │
    │ create_draft (Gmail MCP)
    ▼
Gmail Drafts ──────────► Apps Script (hourly trigger)
                              │
                              │ parse JSON block
                              │ dedupe vs Sheet
                              ▼
                         Google Sheet
                              │
                              │ draft.send()
                              ▼
                         Outlook inbox
```

Why the bridge: the Claude sandbox cannot reach `script.google.com`, and the Gmail MCP does not expose `send_email`. The draft is the data transport; Apps Script finalizes it.
