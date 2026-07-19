# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Not a software project — a **prompt monorepo + one Google Apps Script bridge** for daily Charlotte, NC real-estate search agents. There is no build system, no package manager, no tests, no lint config. Files are Markdown (agent prompts + shared context) and a single `.gs` script pasted into the Apps Script editor by hand.

## Runtime architecture (the whole point of the repo)

```
Claude agent (sandbox, once/day)
  └─ create_draft (Gmail MCP)  ─►  Gmail Drafts
                                     │  hourly time-driven trigger
                                     ▼
                                apps-script/Code.gs  (pollGmailDrafts)
                                     │  loops AGENTS[], per-agent try/catch
                                     │  parse JSON between agent's markers
                                     │  dedupe vs that agent's Sheet
                                     │  append new / update-in-place on PRICE change
                                     │  draft.send()
                                     ▼
                                Google Sheet  +  Outlook inbox
```

Two hard sandbox constraints shape this design and are non-obvious from the code alone:
1. The Claude sandbox **cannot reach `script.google.com`** — so agents cannot call the Sheet directly.
2. The Anthropic Gmail MCP exposes only 5 tools and **does NOT include `send_email`** — so agents can only leave `create_draft` behind. Apps Script does the actual send via `draft.send()`.

The Gmail draft is therefore both the human digest **and** the data transport. Its body must contain a valid JSON block between the agent's start/end markers; the poller matches those literally.

## The agent ↔ Apps Script contract (do not break)

Each agent has four identifiers that MUST line up across three places:

| Identifier          | Defined in                                           | Read by                          |
|---------------------|------------------------------------------------------|----------------------------------|
| `subjectPrefix`     | `agents/<name>/daily-prompt.md` Step 6               | `AGENTS[]` in `apps-script/Code.gs` |
| `dataStart` / `dataEnd` markers | `agents/<name>/daily-prompt.md` Step 6   | `AGENTS[]` in `apps-script/Code.gs` |
| `sheetId`           | `AGENTS[]` in `apps-script/Code.gs` (+ README links) | Apps Script only                 |
| Column headers      | Row 1 of the Google Sheet (dynamic, any order)       | `readHeaderMap()` in `Code.gs`   |

If you change any of these in one place, change them everywhere. Symptoms of drift: drafts pile up unprocessed (subject/marker mismatch) or `Sheet missing LINK column` error (header rename).

`LINK` is the **only required header** — it's the dedup key (falls back to normalized `ADDRESS`). All other columns are optional; missing ones are simply not synced.

## Current agents

- **`apto-clt`** — active. Rental search (1BR/studio), $1,400/mo firm ceiling, Sep 2026 move-in, 12 mi shared envelope.
- **`apto-2bed-2bath`** — active in `AGENTS[]` with a `<TODO-apto-2bed-2bath-sheet-id>` sentinel (skipped by the poller until the Sheet is created and its ID pasted in). Rental search strictly limited to **2BR AND 2BA** — 1BR/studio/2BR-1BA are rejected outright, not put in an "almost meets criteria" bucket. $1,500/mo firm, **8 mi / 25 min** commute cap (overrides the shared 12 mi envelope). Payload schema adds a `BATHS` column vs `apto-clt`; ID prefix is `apt2br-YYYYMMDD-NN`.
- **`casa-clt`** — skeleton. `agents/casa-clt/en-agente.md` still contains `TODO:` markers (budget, PITI envelope, min beds/baths/sqft, year-built floor, HOA ceiling, property type ranking). The daily prompt tells the agent to surface these TODOs in the digest rather than invent numbers.

Shared location/commute facts (Ballantyne origin, 500 Tyvola Rd work address, 12 mi / 30 min envelope, ranked neighborhood list, avoid list) live in `shared/charlotte-context.md`. Change them there, not in per-agent files.

## Adding a new agent

1. `agents/<name>/daily-prompt.md` + `agents/<name>/en-agente.md` (start from an existing agent). Pick a unique subject prefix (with distinctive emoji) and unique data markers.
2. Create a Google Sheet with `LINK` in row 1 plus whatever columns the row payload includes.
3. Add an object to `AGENTS` in `apps-script/Code.gs` (`name`, `sheetId`, `subjectPrefix`, `dataStart`, `dataEnd`).
4. Paste updated `Code.gs` into the Apps Script editor (`juan.diaz.rodriguez93@gmail.com`) and save. The existing hourly trigger picks it up on the next tick.
5. `data/inbox/<name>/.gitkeep` for local staging (currently empty across the repo).

An entry with `sheetId` starting `<TODO` is skipped with a single log line — this is how a new agent can live in `AGENTS[]` before its Sheet exists.

## Apps Script — deploy + test loop

There is no CLI deployment. Workflow:

1. Edit `apps-script/Code.gs` locally.
2. Open https://script.google.com on `juan.diaz.rodriguez93@gmail.com` → paste over → save.
3. In the editor dropdown, run one of the manual utilities to test:
   - `runOnce()` — synchronous one-shot of the hourly poll.
   - `showHeaderMap()` — dump each agent's Sheet headers (catches header-rename drift).
   - `showProcessedSummary()` — list processed draft IDs per agent with metadata.
   - `resetProcessedDrafts()` — clear `processed_drafts_*` script properties; next poll re-scans every draft (safe — dedup still applies at the Sheet level).

State is per-agent script properties: `processed_drafts_<agent.name>`. A legacy single-agent key (`processed_drafts`) is auto-migrated to `processed_drafts_apto-clt` on first run.

## Update semantics (subtle)

`processAgent()` in `Code.gs` does more than append:
- Matches incoming rows to existing rows by `LINK` first, then by `normalizeAddress(ADDRESS)` (strips `unit/apt/suite/#…` and punctuation). Same building never inserted twice regardless of source.
- If `PRICE` changed on a matched row, `updateRowInPlace()` refreshes the fields in `REFRESH_ON_UPDATE` (`PRICE, SCORE, SOURCE, DISTANCE APROX, LINK, BEDS, SQF`), prepends a dated price-change line to `NOTES` (capped at 1000 chars), and **preserves** `ID`, original `DATE`, and any user-set `STATUS` other than empty.
- Empty `STATUS` on append defaults to `"Missing"`.

If you're changing the payload schema, keep `REFRESH_ON_UPDATE` in sync — silently dropped fields on price updates are the most likely bug.
