# Apps Script — Gmail → Sheet bridge

The daily Claude agents cannot push to GitHub (Claude for GitHub app is
read-only) and cannot reach `script.google.com` from their sandbox. Gmail
MCP *does* work in the sandbox, so each agent's daily digest doubles as
the data transport: the agent embeds a JSON block inside the Gmail draft
body, and this Apps Script polls Gmail to extract and sync new rows into
the matching Google Sheet.

One script, one trigger, one Google project handles all agents
(`apto-clt`, `apto-2bed-2bath`, `casa-clt`) via the `AGENTS` array at the
top of `Code.gs`. Two agents (`apto-clt` and `apto-2bed-2bath`) share a
single spreadsheet by targeting different tabs via the `sheetName` field
on their `AGENTS[]` entry; `casa-clt` uses a separate spreadsheet.

## One-time setup

1. Open Apps Script editor (https://script.google.com) on the personal
   Gmail account that owns the Sheets (`juan.diaz.rodriguez93@gmail.com`).
2. Open your project `apto-clt-bridge` (or create a new one — name doesn't
   matter; you may want to rename to `clt-agents-bridge` since it now
   handles both agents).
3. Replace all code in `Code.gs` with the contents of [`Code.gs`](./Code.gs).
4. Save (Cmd+S).
5. Sidebar → **Triggers** (clock icon) → **Add Trigger** (only if no
   trigger already exists):
   - Function: `pollGmailDrafts`
   - Event source: **Time-driven**
   - Type: **Hour timer**
   - Interval: **Every hour**
6. Save. Authorize when prompted (Sheets + Gmail read + Gmail send).
7. Optional sanity check: select `runOnce` in the editor dropdown → **Run**
   → watch the Executions log.

If you previously had a trigger that runs `pollGitHub`, delete it
(Triggers → trash icon next to that row).

## Email formatting

Every outgoing email (agent daily digests and the weekly seed snapshot)
is a multipart message:

- **HTML body** — a compact table with per-listing rows, a status
  summary (new / price-updated / unchanged), and a button linking to the
  target spreadsheet tab. Mail clients render this by default.
- **Plain-text body** — the original numbered list plus the JSON block.
  Parsers (this script for agent drafts; the 2BR agent for seed emails)
  read from the plain text, so the JSON contract is untouched.

For agent digests the HTML is added by `renderDigestHtml()` in `Code.gs`
right before `draft.send()`. For the weekly seed snapshot the HTML is
built by `renderSeedDigestHtml()` and passed as `htmlBody` in the
`GmailApp.createDraft` call. Both renderers gracefully handle missing
columns and empty payloads.

To tweak columns or styling, edit `HTML_DIGEST_COLUMNS` /
`HTML_COLUMN_LABELS` / `AGENT_HEADLINE` / `STATUS_BADGE_COLOR` near
the top of the "HTML digest rendering" section in `Code.gs`.

## How it works

- Each agent runs daily, creates ONE Gmail draft addressed to
  `jpdiaz0@outlook.com` (Juan's review inbox).
- Per-agent identifying markers (subject prefix and data markers):
  - **apto-clt**: subject starts with `🏠 APTO-CLT daily —`, payload
    delimited by `<<<APTO-CLT-DATA-START>>>` / `<<<APTO-CLT-DATA-END>>>`
  - **casa-clt**: subject starts with `🏡 CASA-CLT daily —`, payload
    delimited by `<<<CASA-CLT-DATA-START>>>` / `<<<CASA-CLT-DATA-END>>>`
- Draft body contains a human-readable digest **and** a machine-readable
  JSON block in the agent's markers:
  ```
  <<<{AGENT}-DATA-START>>>
  { "version": 1, "date": "YYYY-MM-DD", "rows": [...] }
  <<<{AGENT}-DATA-END>>>
  ```
- Apps Script `pollGmailDrafts()` runs hourly:
  1. Migrates a legacy `processed_drafts` script property to
     `processed_drafts_apto-clt` if it exists (one-time, idempotent).
  2. Lists all current Gmail drafts via `GmailApp.getDrafts()`.
  3. Loops over the `AGENTS` config. Each agent runs inside its own
     `try/catch` so one agent's failure cannot block the other.
  4. For each agent: filters drafts by that agent's subject prefix,
     skips drafts already in `processed_drafts_<agent.name>`, extracts
     JSON between that agent's markers.
  5. Opens that agent's target tab via `openAgentSheet(agent)`: the tab
     named `agent.sheetName` if set, else the spreadsheet's first tab.
     Missing named tab throws (fail-loud) rather than silently writing
     to the wrong place. Dedupes by LINK first, then normalized ADDRESS,
     against existing rows in that tab. Appends remaining rows. Updates
     rows in place when PRICE changed.
  6. Sends the draft via `draft.send()` — the email lands in the
     recipient inbox (Outlook). The draft disappears from Drafts.
- Sync delay: up to ~1 hour. Run `runOnce` in the editor for immediate sync.
- Agents whose `sheetId` starts with `<TODO` are skipped with a single
  log line (`[<name>] skipped: sheetId is TODO`). This is how `casa-clt`
  behaves until the user creates the Sheet and pastes the ID into the
  `AGENTS` array.

**Why Apps Script sends instead of the agent:** the Anthropic Gmail MCP
only exposes 5 tools (`create_draft`, `get_thread`, `list_drafts`,
`list_labels`, `search_threads`) and does NOT include `send_email`. So
each agent must finalize as a draft, and this script sends it on the
agent's behalf.

## State storage

Each agent has its own script property:

- `processed_drafts_apto-clt` — map of draft IDs → processing metadata
- `processed_drafts_casa-clt` — same, for casa-clt

The legacy `processed_drafts` key (single-agent era) is migrated to
`processed_drafts_apto-clt` on the first run that sees it, then deleted.
The migration is idempotent — re-running it after the migration completes
does nothing harmful.

## Manual utilities (run from the editor)

- `runOnce()` — same as a scheduled tick, useful for testing
- `pollGmailDrafts()` — alias, run directly
- `showProcessedSummary()` — log each agent's processed-draft count and
  metadata
- `showHeaderMap()` — log each agent's Sheet column headers (skips agents
  whose sheetId is still `<TODO>`)
- `resetProcessedDrafts()` — clear ALL agents' `processed_drafts_*` keys
  plus the legacy key; next poll re-scans every draft (safe —
  `appendRows` still dedupes by LINK/ADDRESS against the Sheet)
- `runSnapshotOnce()` — manually trigger the weekly seed snapshot (see
  next section)
- `showAptoCltStatusHistogram()` — log the count of each distinct
  STATUS value in the `1 bed` tab plus which values `SEED_INCLUDE`
  covers. Use to debug unexpected snapshot counts.

## Weekly seed snapshot (apto-clt → apto-2bed-2bath)

`snapshotAptoCltForCrossAgent()` publishes a filtered copy of the 1BR
sheet to Gmail so the 2BR agent can reuse prior human triage. This is a
one-way export: the message subject deliberately does **not** match any
agent's `subjectPrefix`, so `pollGmailDrafts` ignores it.

**Contract:**
- Reads the `1 bed` tab of the apto-clt spreadsheet (config in
  `SEED_SOURCE` at top of `Code.gs`).
- Filters rows by STATUS: only rows whose STATUS is in `SEED_INCLUDE`
  (default: `LOVE`, `LGTM`, `Need 2 Go!`, `Maybe`, `Missing`) become
  seeds. Everything else is dropped, including:
  - `NO - $$$ CARO` — user has already moved shared-budget-viable rows
    out of this bucket into `Maybe` / `Missing` / etc. during manual
    triage. Rows that remain here are genuinely too expensive.
  - `NO - FEO/UNSAFE` — quality/safety, doesn't change with unit shape
  - `NO - Far` — 2BR agent's 8 mi cap already excludes; double-safety
  - `NO - Sin Laundry` — 2BR agent also requires in-unit laundry
  - blank — no STATUS at all, treat as noise
- Sends a Gmail message to `SEED_RECIPIENT` (default `jpdiaz0@outlook.com`)
  with:
  - Subject: `🔗 APTO-CLT-SEEDS weekly — {N} seeds for {YYYY-MM-DD}`
  - Body: short human summary + a JSON block (payload version `2`,
    single `seeds` array) bracketed by `<<<APTO-CLT-SEEDS-START>>>` /
    `<<<APTO-CLT-SEEDS-END>>>` (parsed by the 2BR agent via Gmail MCP
    `search_threads` on every daily run).

Payload shape:

```json
{ "version": 2, "date": "YYYY-MM-DD", "seeds": [
  { "name": "...", "address": "...", "prior_price": 1350,
    "prior_status": "Maybe", "prior_notes": "...",
    "source_link": "https://..." }
]}
```

**One-time setup for the weekly trigger:**

1. In the Apps Script editor sidebar → **Triggers** (clock icon) →
   **Add Trigger**.
2. Function: `snapshotAptoCltForCrossAgent`
3. Event source: **Time-driven**
4. Type: **Week timer** (e.g. Sunday, 6–7 AM)
5. Save. No additional auth prompts if `pollGmailDrafts` is already
   authorized (same scopes).

**Tweaking the filter mapping:** edit `SEED_INCLUDE` at the top of
`Code.gs`. The comment block above the set documents why each STATUS
value is or isn't included.

**Testing without waiting a week:** run `runSnapshotOnce()` in the
editor. Check Gmail Sent for the subject line above; verify the JSON
block parses. Use `showAptoCltStatusHistogram()` first to sanity-check
STATUS distribution before running the snapshot.

## Adding a new agent

See the root `README.md` "Adding a new agent" section. Short version:
add a new object to `AGENTS` with `name`, `sheetId`, optional `sheetName`
(required if sharing a spreadsheet with another agent), `subjectPrefix`,
`dataStart`, `dataEnd`. The existing trigger picks it up automatically.

## Security

The script runs as you (`juan.diaz.rodriguez93@gmail.com`) and reads only
your own Gmail drafts. It writes only to the Sheets configured in
`AGENTS[*].sheetId`. No external traffic is required for the polling path
— `GmailApp` and `SpreadsheetApp` are first-party Google services.

The previous Web App (HTTPS `doGet`/`doPost`) is removed because nothing
needs it now. If you want a manual emergency-write endpoint, restore the
`doPost` from `git log -- apps-script/Code.gs`.
