# Real Estate Agents — Charlotte, NC

Repository of automated agents for real estate search in Charlotte, NC. Each agent runs once a day, searches the web for fresh listings, ranks them against personal criteria, and delivers a daily digest.

Context: I live in Ballantyne (south Charlotte) and work at 500 Tyvola Rd. I want to monitor the market both for my next rental (move-in September 2026) and for an eventual home purchase.

## Layout

```
agents/
  apto-clt/                  apartment-to-rent agent (1BR/studio)
    daily-prompt.md
    en-agente.md
    es-agente.md
  apto-2bed-2bath/           apartment-to-rent agent (strict 2BR/2BA, 8mi cap)
    daily-prompt.md
    en-agente.md
    es-agente.md
  casa-clt/                  house/condo-to-buy agent (skeleton)
    daily-prompt.md
    en-agente.md
shared/
  charlotte-context.md       work address, neighborhoods, commute envelope, avoid list
apps-script/
  Code.gs                    Gmail-draft -> Sheet bridge, parameterized for all agents
  README.md
data/inbox/
  apto-clt/                  per-agent local staging / debug logs
  apto-2bed-2bath/
  casa-clt/
README.md
```

## Agents

### 1. Apartment to rent — studio or 1BR — `apto-clt` (active)

Daily agent that searches for **studios or 1-bedroom** apartments to rent for the September 2026 move-in. 1BR preferred, studios accepted. 2BR is rejected — that's handled by `apto-2bed-2bath`.

- **Budget:** $1,400/month, firm
- **Area:** south Charlotte (see [`shared/charlotte-context.md`](./shared/charlotte-context.md))
- **Requirements:** studio or 1BR, in-unit laundry, hard flooring, on-site parking, unfurnished
- **Files:**
  - [`agents/apto-clt/daily-prompt.md`](./agents/apto-clt/daily-prompt.md) — operational prompt for the daily run
  - [`agents/apto-clt/en-agente.md`](./agents/apto-clt/en-agente.md) / [`agents/apto-clt/es-agente.md`](./agents/apto-clt/es-agente.md) — full criteria (English / Spanish)
- **Sheet:** `1 bed` tab of the [shared rentals spreadsheet](https://docs.google.com/spreadsheets/d/1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI/edit?usp=sharing)
- **Subject prefix:** `🏠 APTO-CLT daily —`
- **Data markers:** `<<<APTO-CLT-DATA-START>>>` / `<<<APTO-CLT-DATA-END>>>`

### 2. Apartment to rent — 2BR/2BA — `apto-2bed-2bath` (active)

Daily agent that searches for strict 2-bedroom / 2-bathroom apartments to rent. Sibling of `apto-clt` with a different unit shape and a tighter commute cap.

- **Budget:** $1,500/mo, firm
- **Bed/bath:** exactly 2BR AND 2BA — 1BR, studios, 2BR/1BA are rejected outright (not "almost meets criteria")
- **Commute cap:** **8 mi / 25 min** to 500 Tyvola Rd — this agent OVERRIDES the shared 12 mi / 30 min envelope in [`shared/charlotte-context.md`](./shared/charlotte-context.md). The tighter cap naturally trims Matthews and Mint Hill from the shared preferred-neighborhoods list.
- **Requirements:** in-unit laundry, hard flooring, on-site parking, unfurnished
- **Files:**
  - [`agents/apto-2bed-2bath/daily-prompt.md`](./agents/apto-2bed-2bath/daily-prompt.md) — operational prompt
  - [`agents/apto-2bed-2bath/en-agente.md`](./agents/apto-2bed-2bath/en-agente.md) / [`agents/apto-2bed-2bath/es-agente.md`](./agents/apto-2bed-2bath/es-agente.md) — full criteria (English / Spanish)
- **Sheet:** `apto-2bed-2bath` tab of the [shared rentals spreadsheet](https://docs.google.com/spreadsheets/d/1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI/edit) (same spreadsheet as `apto-clt`, different tab; the two agents are pinned to `1 bed` and `apto-2bed-2bath` respectively via `sheetName` in `Code.gs`).
- **Subject prefix:** `🛏️ APTO-2BR2BA daily —`
- **Data markers:** `<<<APTO-2BR2BA-DATA-START>>>` / `<<<APTO-2BR2BA-DATA-END>>>`

Dedup and price-change updates are per-tab, so `apto-clt` and `apto-2bed-2bath` never collide even though they live in the same spreadsheet.

### 3. House to buy — `casa-clt` (skeleton — criteria TODO)

Daily agent that searches for houses, townhouses, and condos to buy in Charlotte and surroundings. Same architecture (search → score → Gmail draft → Sheet sync), buyer-specific criteria.

- **Real ceiling:** PITI envelope, not list price
- **Files:**
  - [`agents/casa-clt/daily-prompt.md`](./agents/casa-clt/daily-prompt.md) — operational prompt
  - [`agents/casa-clt/en-agente.md`](./agents/casa-clt/en-agente.md) — full criteria, contains `TODO:` placeholders for budget, down payment, PITI cap, year-built floor, HOA ceiling, property type ranking
- **Sheet:** [casa-clt](https://docs.google.com/spreadsheets/d/1nVwG09Y9vK3BVTd9XyvLzPILqFBA5ykZdMDgxAKTTss/edit?usp=sharing) — make sure row 1 has the headers listed in `daily-prompt.md` "Sheet column schema" (at minimum, a `LINK` column is required for dedup)
- **Subject prefix:** `🏡 CASA-CLT daily —`
- **Data markers:** `<<<CASA-CLT-DATA-START>>>` / `<<<CASA-CLT-DATA-END>>>`

**Before this agent produces useful output, the user must still:**
1. Fill in every `TODO:` marker in `agents/casa-clt/en-agente.md` (purchase budget, down payment, max PITI, min beds/baths/sqft, year-built floor, HOA ceiling, property type ranking)
2. Make sure the casa-clt Google Sheet has the column headers from `daily-prompt.md` "Sheet column schema" in row 1 (the poller reads them dynamically; `LINK` is the only required column)
3. Paste the updated `apps-script/Code.gs` into the Apps Script editor and save

## Shared architecture

```
Claude agent (sandbox)
    │
    │ create_draft (Gmail MCP)
    ▼
Gmail Drafts ──────────► Apps Script (hourly trigger)
                              │  loops AGENTS, per-agent try/catch
                              │  parse JSON block (per agent's markers)
                              │  dedupe vs that agent's tab
                              ▼
                         Google Sheet tab (per agent)
                              │
                              │ draft.send()
                              ▼
                         Outlook inbox
```

Each agent targets one tab. Two agents can share a spreadsheet by pointing at different tab names via `sheetName`. Dedup and price-change updates are per-tab, so co-tenants never collide.

Why the bridge: the Claude sandbox cannot reach `script.google.com`, and the Gmail MCP does not expose `send_email`. The draft is the data transport; Apps Script finalizes it.

## Adding a new agent

1. Create `agents/<name>/daily-prompt.md` and `agents/<name>/en-agente.md` (start from one of the existing agents as a template). Pick a unique subject prefix and unique data markers.
2. Decide where the rows land:
   - **New spreadsheet:** create one, add a `LINK` column in row 1 plus whatever the payload includes. Leave `sheetName` unset in `AGENTS[]` — the poller uses the first tab.
   - **Existing spreadsheet, new tab:** create a new tab in an existing spreadsheet with those same headers, and set `sheetName: '<tab name>'` on the new agent's entry (and, for safety, on every other agent that shares that spreadsheet so first-tab drift can't break them).
3. Add a new object to the `AGENTS` array in `apps-script/Code.gs` with that agent's `sheetId`, optional `sheetName`, `subjectPrefix`, `dataStart`, `dataEnd`.
4. Save Code.gs. The existing hourly trigger automatically picks up the new agent on the next tick.
5. Add `data/inbox/<name>/.gitkeep` for local staging.
