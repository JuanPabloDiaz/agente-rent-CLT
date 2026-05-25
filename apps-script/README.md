# Apps Script Web App — Setup

This bridges the agent to the Google Sheet because the official Google Drive MCP cannot edit existing Sheets (only read + create new files).

## One-time install

1. Open https://docs.google.com/spreadsheets/d/1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI/edit
2. **Extensions → Apps Script**
3. Replace whatever is in `Code.gs` with the contents of [`Code.gs`](./Code.gs) in this folder
4. **Save** (Ctrl/Cmd+S)
5. **Deploy → New deployment**
   - **Type:** Web app
   - **Execute as:** Me (juan@talentoparati.com)
   - **Who has access:** Anyone
6. Click **Deploy**, authorize when prompted
7. Copy the **Web app URL** — looks like `https://script.google.com/macros/s/AKfycb.../exec`
8. Paste that URL into `daily-prompt.md` (replace `WEB_APP_URL_HERE`)
9. Commit + push

## Test from terminal

```bash
URL="https://script.google.com/macros/s/AKfycb.../exec"
TOKEN="06f0aa5104481efa508031e699b67a77d94f7448d621a432a90e74f936acba46"

# Read
curl -sL "$URL?action=read&token=$TOKEN"

# Write (test row)
curl -sL -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$TOKEN\",\"rows\":[{\"ID\":\"test-001\",\"DATE\":\"2026-05-25\",\"NAME\":\"Test Building\",\"PRICE\":1200,\"STATUS\":\"Maybe\"}]}"
```

If the test row appears in row 2 of your sheet, you're good.

## Security note

The token is in `SECRET_TOKEN` in `Code.gs`. If you ever rotate it, update both:
- `apps-script/Code.gs`
- `daily-prompt.md` (the `APPS_SCRIPT_TOKEN` value)

Anyone with the URL + token can append to your sheet. Don't post the URL+token publicly.

## Why this exists

Google Drive MCP available tools (May 2026):
- Read-only: `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `read_file_content`, `search_files`
- Write/delete: `copy_file`, `create_file`

Notably absent: `append_row`, `update_cell`, `update_sheet`. Without those, the agent could only create a new Sheet each day (which it did, hence this fix).

Apps Script Web App gives us full Sheets API access via HTTP, callable from `WebFetch` in any agent.
