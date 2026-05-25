# Apps Script — Gmail → Sheet bridge

The daily Claude agent cannot push to GitHub (Claude for GitHub app is
read-only) and cannot reach `script.google.com` from its sandbox. Gmail MCP
*does* work in the sandbox, so the agent's daily digest doubles as the data
transport: it embeds a JSON block inside the Gmail draft body, and this Apps
Script polls Gmail to extract and sync new rows into the Sheet.

## One-time setup

1. Open Apps Script editor (https://script.google.com) on the personal Gmail
   account that owns the Sheet (`juan.diaz.rodriguez93@gmail.com`).
2. Open your project `apto-clt-bridge` (or create a new one).
3. Replace all code in `Code.gs` with the contents of [`Code.gs`](./Code.gs).
4. Save (Cmd+S).
5. Sidebar → **Triggers** (clock icon) → **Add Trigger**:
   - Function: `pollGmailDrafts`
   - Event source: **Time-driven**
   - Type: **Hour timer**
   - Interval: **Every hour**
6. Save. Authorize when prompted (Sheets + Gmail read).
7. Optional sanity check: select `runOnce` in the editor dropdown → **Run** →
   watch the Executions log.

If you set up an older trigger that runs `pollGitHub`, delete it (Triggers →
trash icon next to that row).

## How it works

- Agent runs daily, creates ONE Gmail draft addressed to
  `jpdiaz0@outlook.com` (Juan's review inbox).
- Draft subject starts with `🏠 APTO-CLT daily —`.
- Draft body contains a human-readable digest **and** a machine-readable JSON
  block delimited by:
  ```
  <<<APTO-CLT-DATA-START>>>
  { "version": 1, "date": "YYYY-MM-DD", "rows": [...] }
  <<<APTO-CLT-DATA-END>>>
  ```
- Apps Script `pollGmailDrafts()` runs hourly:
  1. Lists all current Gmail drafts via `GmailApp.getDrafts()`.
  2. Filters by subject prefix.
  3. Skips drafts it already processed (tracked in `processed_drafts` script
     property by draft ID).
  4. Extracts JSON between the markers.
  5. Dedupes by LINK first, then normalized ADDRESS, against existing
     Sheet rows.
  6. Appends remaining rows.
  7. Sends the draft via `draft.send()` — the email lands in the recipient
     inbox (Outlook). The draft disappears from Drafts.
- Sync delay: up to ~1 hour. Run `runOnce` in the editor for immediate sync.

**Why Apps Script sends instead of the agent:** the Anthropic Gmail MCP only
exposes 5 tools (`create_draft`, `get_thread`, `list_drafts`, `list_labels`,
`search_threads`) and does NOT include `send_email`. So the agent must
finalize as a draft, and this script sends it on the agent's behalf.

## Manual utilities (run from the editor)

- `runOnce()` — same as a scheduled tick, useful for testing
- `pollGmailDrafts()` — alias, run directly
- `showProcessedSummary()` — log what's been processed and when
- `resetProcessedDrafts()` — clear the processed cache; next poll re-scans
  everything (safe — `appendRows` still dedupes by ID against the Sheet)

## Security

The script runs as you (`juan.diaz.rodriguez93@gmail.com`) and reads only your
own Gmail drafts. It writes only to the Sheet you specify by `SHEET_ID`. No
external traffic is required for the polling path — `GmailApp` and
`SpreadsheetApp` are first-party Google services.

The previous Web App (HTTPS `doGet`/`doPost`) is removed because nothing
needs it now. If you want a manual emergency-write endpoint, restore the
`doPost` from `git log -- apps-script/Code.gs`.
