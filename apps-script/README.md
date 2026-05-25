# Apps Script — GitHub → Sheet bridge

The daily Claude agent cannot reach `script.google.com` from its sandbox, so it
writes JSON files to `data/inbox/YYYY-MM-DD.json` in this repo instead. This
Apps Script polls the repo on a time trigger and syncs new rows into the Sheet.

## One-time setup

1. Open Apps Script editor (https://script.google.com) on the personal Gmail
   account that owns the Sheet (`juan.diaz.rodriguez93@gmail.com`).
2. Open your project `apto-clt-bridge` (or create a new one if starting over).
3. Replace all code in `Code.gs` with the contents of [`Code.gs`](./Code.gs).
4. Save (Cmd+S).
5. In the left sidebar click **Triggers** (clock icon) → **Add Trigger**:
   - Function: `pollGitHub`
   - Event source: **Time-driven**
   - Type: **Hour timer**
   - Interval: **Every hour**
6. Save. Authorize when prompted (Sheets + external requests).
7. Optional sanity check: from the editor select `pollGitHub` in the dropdown
   at the top and click **Run**. Watch the Executions log for "appended N rows".

## How it works

- Agent commits `data/inbox/YYYY-MM-DD.json` (array of row objects).
- Apps Script `pollGitHub()` runs hourly:
  1. Lists files in `data/inbox/` via GitHub Contents API.
  2. Skips files it already processed (tracked in `processed_files` script
     property, keyed by path + sha so edits re-process automatically).
  3. Fetches each new file's raw JSON.
  4. Filters out rows whose `ID` already exists in the Sheet.
  5. Appends remaining rows.
- Sync delay: up to ~1 hour. Run `pollGitHub` manually in the editor anytime
  for immediate sync.

## Manual utilities (from the editor)

- `pollGitHub()` — run a sync immediately
- `resetProcessedFiles()` — clear the processed-files cache; next poll
  re-scans everything (safe — `appendRows` still dedupes by ID)

## Web App (kept for completeness)

The Web App deployment is still active. It's no longer used by the daily agent
because the sandbox can't reach `script.google.com`. Endpoints:

- `GET ?action=read&token=...` — return all rows as JSON (used by the agent's
  optional learning step if the sandbox happens to reach Google scripts)
- `POST` — manual emergency writes; not in the daily flow

URL: `https://script.google.com/macros/s/AKfycbxhjQozeuhFmRLSw_nue0Nos1QFK5ZYdzk_fNA_3mQW3iXBKLxAbr2m41m3Snw4y04r/exec`

## Security

The script runs as you and accesses your Sheet by ID. The Web App URL is
public; the `SECRET_TOKEN` gates `GET ?action=read` and `POST`. The polling
flow doesn't use the token — it reads from the public GitHub repo directly.

If the repo ever goes private, `UrlFetchApp.fetch` in `listInboxFiles` will
need an `Authorization: token <PAT>` header. Add a script property
`GITHUB_PAT` and read it via `PropertiesService.getScriptProperties()`.
