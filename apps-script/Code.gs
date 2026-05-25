// APTO-CLT Tracker — Apps Script
//
// Architecture: the daily Claude agent creates a Gmail draft with both a
// human-readable digest and a machine-readable JSON block. Apps Script polls
// Gmail on a time trigger, finds matching drafts, extracts the JSON, and
// writes new rows to the Sheet.
//
// Why this design: Claude Code remote agents cannot push to GitHub (the
// Claude for GitHub app is read-only) and cannot reach script.google.com
// from WebFetch. Gmail MCP works fine in the sandbox, so Gmail is the
// transport.
//
// One-time setup:
// 1. Open Apps Script editor on the personal Gmail account that owns the
//    Sheet (juan.diaz.rodriguez93@gmail.com).
// 2. Paste this file into Code.gs. Save.
// 3. Sidebar -> Triggers (clock icon) -> Add Trigger:
//      Function: pollGmailDrafts
//      Event source: Time-driven
//      Type: Hour timer
//      Interval: Every hour
// 4. Authorize when prompted (Sheets, Gmail).

const SHEET_ID = '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI';
const SUBJECT_PREFIX = '🏠 APTO-CLT daily';
const DATA_START = '<<<APTO-CLT-DATA-START>>>';
const DATA_END = '<<<APTO-CLT-DATA-END>>>';

const HEADERS = [
  'ID', 'DATE', 'NAME', 'ADDRESS', 'PRICE', 'BEDS', 'SQF', 'LINK',
  'DISTANCE APROX', 'SCORE', 'STATUS', 'NOTES', 'SOURCE'
];

// ===== Time-driven entry point =====

function pollGmailDrafts() {
  const props = PropertiesService.getScriptProperties();
  const processed = JSON.parse(props.getProperty('processed_drafts') || '{}');

  const drafts = GmailApp.getDrafts();
  if (drafts.length === 0) return;

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const seenIds = readSeenIds(sheet);

  let totalAppended = 0;
  let totalDrafts = 0;
  let totalSkipped = 0;

  for (const draft of drafts) {
    const draftId = draft.getId();
    if (processed[draftId]) continue;

    const msg = draft.getMessage();
    const subject = msg.getSubject() || '';
    if (!subject.startsWith(SUBJECT_PREFIX)) continue;

    totalDrafts++;
    const body = msg.getPlainBody();
    const payload = extractPayload(body);

    if (!payload) {
      console.warn('Could not parse payload in draft ' + draftId + ' (subject: ' + subject + ')');
      processed[draftId] = { processedAt: new Date().toISOString(), error: 'parse_failed' };
      totalSkipped++;
      continue;
    }

    if (!Array.isArray(payload.rows)) {
      processed[draftId] = { processedAt: new Date().toISOString(), error: 'no_rows_array' };
      totalSkipped++;
      continue;
    }

    const newRows = payload.rows.filter(r => r.ID && !seenIds.has(r.ID));
    if (newRows.length > 0) {
      appendRows(sheet, newRows);
      newRows.forEach(r => seenIds.add(r.ID));
      totalAppended += newRows.length;
    }

    processed[draftId] = {
      processedAt: new Date().toISOString(),
      appended: newRows.length,
      totalInPayload: payload.rows.length,
      date: payload.date || null
    };
  }

  props.setProperty('processed_drafts', JSON.stringify(processed));
  console.log(
    'pollGmailDrafts: scanned=' + drafts.length +
    ' matched=' + totalDrafts +
    ' appended=' + totalAppended +
    ' skipped=' + totalSkipped
  );
}

// ===== Payload extraction =====

function extractPayload(body) {
  if (!body) return null;
  const startIdx = body.indexOf(DATA_START);
  const endIdx = body.indexOf(DATA_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const json = body.substring(startIdx + DATA_START.length, endIdx).trim();
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// ===== Sheet helpers =====

function readSeenIds(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  const range = sheet.getRange(2, 1, lastRow - 1, 1); // column A (ID)
  return new Set(range.getValues().map(r => String(r[0])).filter(Boolean));
}

function appendRows(sheet, rows) {
  const matrix = rows.map(r => HEADERS.map(h => (r[h] !== undefined && r[h] !== null ? r[h] : '')));
  if (matrix.length === 0) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, matrix.length, HEADERS.length).setValues(matrix);
}

// ===== Manual utilities (run from the editor) =====

function runOnce() {
  // Manual trigger of the same logic — handy after pasting a new draft for
  // testing or when you don't want to wait for the next hourly tick.
  pollGmailDrafts();
}

function resetProcessedDrafts() {
  // Clears the processed-drafts cache. Safe to run — appendRows still dedupes
  // by ID against the Sheet, so re-processing won't create duplicates.
  PropertiesService.getScriptProperties().deleteProperty('processed_drafts');
  console.log('Cleared processed_drafts. Next pollGmailDrafts will re-scan everything.');
}

function showProcessedSummary() {
  // Logs a summary of what's been processed (for debugging).
  const processed = JSON.parse(
    PropertiesService.getScriptProperties().getProperty('processed_drafts') || '{}'
  );
  console.log('Processed drafts: ' + Object.keys(processed).length);
  Object.entries(processed).forEach(([id, info]) => {
    console.log(id + ' -> ' + JSON.stringify(info));
  });
}
