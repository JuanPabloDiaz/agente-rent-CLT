// APTO-CLT Tracker — Apps Script
//
// Reads Gmail drafts created by the daily Claude agent, extracts a JSON
// payload from the body, and appends new rows to the Sheet.
//
// Robustness features:
// - Reads Sheet headers from row 1 on every run, so columns can be reordered
//   in the UI without breaking the script.
// - Dedupes by LINK first, then by normalized ADDRESS (case- and unit-
//   insensitive), so the same building never lands twice regardless of
//   which source surfaced it or which day. ID is not used for dedup.
// - Defaults STATUS to "Missing" when the agent left it blank, so the
//   tracker always shows a review state.
//
// One-time setup:
// 1. Open Apps Script editor on juan.diaz.rodriguez93@gmail.com.
// 2. Replace Code.gs with this file. Save.
// 3. Triggers (clock icon) -> Add Trigger:
//      Function: pollGmailDrafts
//      Event source: Time-driven
//      Type: Hour timer
//      Interval: Every hour
// 4. Authorize Sheets + Gmail when prompted.

const SHEET_ID = '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI';
const SUBJECT_PREFIX = '🏠 APTO-CLT daily';
const DATA_START = '<<<APTO-CLT-DATA-START>>>';
const DATA_END = '<<<APTO-CLT-DATA-END>>>';
const DEFAULT_STATUS = 'Missing';

// ===== Time-driven entry point =====

function pollGmailDrafts() {
  const props = PropertiesService.getScriptProperties();
  const processed = JSON.parse(props.getProperty('processed_drafts') || '{}');

  const drafts = GmailApp.getDrafts();
  if (drafts.length === 0) {
    console.log('pollGmailDrafts: no drafts in mailbox');
    return;
  }

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const headerMap = readHeaderMap(sheet);
  if (!headerMap['LINK'] && headerMap['LINK'] !== 0) {
    throw new Error('Sheet missing LINK column — cannot dedupe. Add a LINK header in row 1.');
  }

  const seenLinks = readColumnAsSet(sheet, headerMap['LINK'], v => String(v).toLowerCase().trim());
  const seenAddresses = readColumnAsSet(sheet, headerMap['ADDRESS'], normalizeAddress);

  let totalAppended = 0;
  let totalDraftsMatched = 0;
  let totalSkippedDrafts = 0;
  let totalDupesInPayloads = 0;

  for (const draft of drafts) {
    const draftId = draft.getId();
    if (processed[draftId]) continue;

    const msg = draft.getMessage();
    const subject = msg.getSubject() || '';
    if (!subject.startsWith(SUBJECT_PREFIX)) continue;

    totalDraftsMatched++;
    const body = msg.getPlainBody();
    const payload = extractPayload(body);

    if (!payload) {
      console.warn('Could not parse payload in draft ' + draftId + ' (subject: ' + subject + ')');
      processed[draftId] = { processedAt: new Date().toISOString(), error: 'parse_failed' };
      totalSkippedDrafts++;
      continue;
    }
    if (!Array.isArray(payload.rows)) {
      processed[draftId] = { processedAt: new Date().toISOString(), error: 'no_rows_array' };
      totalSkippedDrafts++;
      continue;
    }

    const newRows = [];
    for (const row of payload.rows) {
      const link = String(row.LINK || '').toLowerCase().trim();
      const address = normalizeAddress(row.ADDRESS || '');

      if (link && seenLinks.has(link)) { totalDupesInPayloads++; continue; }
      if (address && seenAddresses.has(address)) { totalDupesInPayloads++; continue; }

      newRows.push(row);
      if (link) seenLinks.add(link);
      if (address) seenAddresses.add(address);
    }

    if (newRows.length > 0) {
      appendRows(sheet, headerMap, newRows);
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
    'pollGmailDrafts: drafts=' + drafts.length +
    ' matched=' + totalDraftsMatched +
    ' appended=' + totalAppended +
    ' skipped_drafts=' + totalSkippedDrafts +
    ' dupes_in_payload=' + totalDupesInPayloads
  );
}

// ===== Header + column helpers =====

function readHeaderMap(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) throw new Error('Sheet has no columns');
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    if (h !== '' && h !== null && h !== undefined) {
      map[String(h).trim()] = i; // 0-based column index
    }
  });
  return map;
}

function readColumnAsSet(sheet, colIndex0, normalizer) {
  if (colIndex0 === undefined || colIndex0 === null) return new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  const values = sheet.getRange(2, colIndex0 + 1, lastRow - 1, 1).getValues().map(r => r[0]);
  const set = new Set();
  values.forEach(v => {
    if (v === '' || v === null || v === undefined) return;
    const normalized = normalizer ? normalizer(v) : String(v).toLowerCase();
    if (normalized) set.add(normalized);
  });
  return set;
}

function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr)
    .toLowerCase()
    .replace(/\b(unit|apt|apartment|suite|ste|#)\s*[\w-]+\b/gi, '') // strip unit indicators
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function appendRows(sheet, headerMap, rows) {
  const lastCol = sheet.getLastColumn();
  // Build an ordered list of header names by column position (some columns
  // may be unlabeled — fill with null and write blank for those).
  const headersOrdered = new Array(lastCol).fill(null);
  Object.entries(headerMap).forEach(([name, idx]) => { headersOrdered[idx] = name; });

  const matrix = rows.map(row => {
    return headersOrdered.map((header) => {
      if (header === null) return '';
      let val = row[header];
      if (header === 'STATUS' && (val === '' || val === null || val === undefined)) {
        val = DEFAULT_STATUS;
      }
      return val !== undefined && val !== null ? val : '';
    });
  });

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, matrix.length, lastCol).setValues(matrix);
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

// ===== Manual utilities (run from the editor) =====

function runOnce() {
  pollGmailDrafts();
}

function resetProcessedDrafts() {
  PropertiesService.getScriptProperties().deleteProperty('processed_drafts');
  console.log('Cleared processed_drafts. Next pollGmailDrafts will re-scan all drafts.');
}

function showProcessedSummary() {
  const processed = JSON.parse(
    PropertiesService.getScriptProperties().getProperty('processed_drafts') || '{}'
  );
  console.log('Processed drafts: ' + Object.keys(processed).length);
  Object.entries(processed).forEach(([id, info]) => {
    console.log(id + ' -> ' + JSON.stringify(info));
  });
}

function showHeaderMap() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  console.log(JSON.stringify(readHeaderMap(sheet), null, 2));
}
