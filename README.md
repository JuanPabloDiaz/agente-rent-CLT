# Real Estate Agents — Charlotte, NC

Repository of automated agents for real estate search in Charlotte, NC. Each agent runs once a day, searches the web for fresh listings, ranks them against personal criteria, and delivers a daily digest.

Context: I live in Ballantyne (south Charlotte) and work at 500 Tyvola Rd. I want to monitor the market both for my next rental (move-in September 2026) and for an eventual home purchase.

## Layout

```
agents/
  apto-clt/                  apartment-to-rent agent
    daily-prompt.md
    en-agente.md
    es-agente.md
  casa-clt/                  house/condo-to-buy agent (skeleton)
    daily-prompt.md
    en-agente.md
shared/
  charlotte-context.md       work address, neighborhoods, commute envelope, avoid list
apps-script/
  Code.gs                    Gmail-draft -> Sheet bridge, parameterized for both agents
  README.md
data/inbox/
  apto-clt/                  per-agent local staging / debug logs
  casa-clt/
README.md
```

## Agents

### 1. Apartment to rent — `apto-clt` (active)

Daily agent that searches for apartments to rent for the September 2026 move-in.

- **Budget:** $1,400/month, firm
- **Area:** south Charlotte (see [`shared/charlotte-context.md`](./shared/charlotte-context.md))
- **Requirements:** 1BR or studio, in-unit laundry, hard flooring, on-site parking, unfurnished
- **Files:**
  - [`agents/apto-clt/daily-prompt.md`](./agents/apto-clt/daily-prompt.md) — operational prompt for the daily run
  - [`agents/apto-clt/en-agente.md`](./agents/apto-clt/en-agente.md) / [`agents/apto-clt/es-agente.md`](./agents/apto-clt/es-agente.md) — full criteria (English / Spanish)
- **Sheet:** [apto-clt](https://docs.google.com/spreadsheets/d/1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI/edit?usp=sharing)
- **Subject prefix:** `🏠 APTO-CLT daily —`
- **Data markers:** `<<<APTO-CLT-DATA-START>>>` / `<<<APTO-CLT-DATA-END>>>`

### 2. House to buy — `casa-clt` (skeleton — criteria TODO)

Daily agent that searches for houses, townhouses, and condos to buy in Charlotte and surroundings. Same architecture (search → score → Gmail draft → Sheet sync), buyer-specific criteria.

- **Real ceiling:** PITI envelope, not list price
- **Files:**
  - [`agents/casa-clt/daily-prompt.md`](./agents/casa-clt/daily-prompt.md) — operational prompt
  - [`agents/casa-clt/en-agente.md`](./agents/casa-clt/en-agente.md) — full criteria, contains `TODO:` placeholders for budget, down payment, PITI cap, year-built floor, HOA ceiling, property type ranking
- **Sheet:** TODO — create the Sheet, paste headers (see daily-prompt.md "Sheet column schema"), then paste the Sheet ID into `apps-script/Code.gs` `AGENTS[1].sheetId`
- **Subject prefix:** `🏡 CASA-CLT daily —`
- **Data markers:** `<<<CASA-CLT-DATA-START>>>` / `<<<CASA-CLT-DATA-END>>>`

**Before this agent produces useful output, the user must:**
1. Fill in every `TODO:` marker in `agents/casa-clt/en-agente.md` (purchase budget, down payment, max PITI, min beds/baths/sqft, year-built floor, HOA ceiling, property type ranking)
2. Create the casa-clt Google Sheet with the proposed column headers
3. Paste the Sheet ID into `AGENTS[1].sheetId` in `apps-script/Code.gs`
4. Paste the Sheet URL into the body template in `agents/casa-clt/daily-prompt.md`

Until step 3 is done, the Apps Script bridge skips casa-clt and logs a "sheetId is TODO" warning. apto-clt is unaffected.

## Shared architecture

```
Claude agent (sandbox)
    │
    │ create_draft (Gmail MCP)
    ▼
Gmail Drafts ──────────► Apps Script (hourly trigger)
                              │  loops AGENTS, per-agent try/catch
                              │  parse JSON block (per agent's markers)
                              │  dedupe vs that agent's Sheet
                              ▼
                         Google Sheet (per agent)
                              │
                              │ draft.send()
                              ▼
                         Outlook inbox
```

Why the bridge: the Claude sandbox cannot reach `script.google.com`, and the Gmail MCP does not expose `send_email`. The draft is the data transport; Apps Script finalizes it.

## Adding a third agent

1. Create `agents/<name>/daily-prompt.md` and `agents/<name>/en-agente.md` (start from one of the existing agents as a template). Pick a unique subject prefix and unique data markers.
2. Create a Google Sheet for the new agent with a `LINK` column in row 1 (required for dedup) plus whatever columns the agent's row payload includes.
3. Add a new object to the `AGENTS` array in `apps-script/Code.gs` with that agent's `sheetId`, `subjectPrefix`, `dataStart`, `dataEnd`.
4. Save Code.gs. The existing hourly trigger automatically picks up the new agent on the next tick.
5. Add `data/inbox/<name>/.gitkeep` for local staging.
