// APTO-CLT Tracker — Apps Script
//
// Architecture: the daily Claude agent commits JSON files to
// data/inbox/YYYY-MM-DD.json in the GitHub repo (it cannot reach
// script.google.com from its sandbox). This script polls GitHub on a
// time-driven trigger and syncs new rows into the Sheet.
//
// One-time setup:
// 1. Paste this file into Apps Script editor bound to (or running against)
//    the APTO-CLT Tracker spreadsheet.
// 2. Save.
// 3. Triggers (clock icon left sidebar) -> Add Trigger:
//      Function: pollGitHub
//      Event source: Time-driven
//      Type: Hour timer
//      Interval: Every hour
// 4. Save. Authorize when prompted.
//
// Optional: keep the Web App deployment too. The Web App's GET endpoint is
// useful for the agent to inspect current STATUS values (learning step) when
// the sandbox can reach it. POST is unused now but harmless.

const SECRET_TOKEN = '06f0aa5104481efa508031e699b67a77d94f7448d621a432a90e74f936acba46';
const SHEET_ID = '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI';
const GITHUB_OWNER = 'JuanPabloDiaz';
const GITHUB_REPO = 'agente-rent-CLT';
const GITHUB_BRANCH = 'main';
const INBOX_PATH = 'data/inbox';

const HEADERS = [
  'ID', 'DATE', 'NAME', 'ADDRESS', 'PRICE', 'BEDS', 'SQF', 'LINK',
  'DISTANCE APROX', 'SCORE', 'STATUS', 'NOTES', 'SOURCE'
];

// ===== Time-driven entry point =====

function pollGitHub() {
  const props = PropertiesService.getScriptProperties();
  const processed = JSON.parse(props.getProperty('processed_files') || '{}');

  const files = listInboxFiles();
  if (files.length === 0) return;

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const seenIds = readSeenIds(sheet);

  let totalAppended = 0;

  for (const file of files) {
    const key = file.path + '@' + file.sha;
    if (processed[key]) continue;

    const rows = fetchInboxFile(file.download_url);
    if (!Array.isArray(rows)) {
      console.warn('Skipping malformed file: ' + file.path);
      continue;
    }

    const newRows = rows.filter(r => r.ID && !seenIds.has(r.ID));
    if (newRows.length > 0) {
      appendRows(sheet, newRows);
      newRows.forEach(r => seenIds.add(r.ID));
      totalAppended += newRows.length;
    }

    processed[key] = new Date().toISOString();
  }

  props.setProperty('processed_files', JSON.stringify(processed));
  console.log('pollGitHub: appended ' + totalAppended + ' rows from ' + files.length + ' inbox files');
}

// ===== GitHub helpers =====

function listInboxFiles() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${INBOX_PATH}?ref=${GITHUB_BRANCH}`;
  const resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { 'Accept': 'application/vnd.github.v3+json' }
  });
  if (resp.getResponseCode() === 404) return []; // folder doesn't exist yet
  if (resp.getResponseCode() !== 200) {
    throw new Error('GitHub listing failed: ' + resp.getResponseCode() + ' ' + resp.getContentText());
  }
  const items = JSON.parse(resp.getContentText());
  return items.filter(i => i.type === 'file' && i.name.endsWith('.json'));
}

function fetchInboxFile(downloadUrl) {
  const resp = UrlFetchApp.fetch(downloadUrl, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    console.warn('Fetch failed for ' + downloadUrl + ': ' + resp.getResponseCode());
    return null;
  }
  try {
    return JSON.parse(resp.getContentText());
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

// ===== Web App (optional — read-only access for the agent's learning step) =====

function doGet(e) {
  try {
    const action = (e.parameter.action || 'read').toLowerCase();
    if (e.parameter.token !== SECRET_TOKEN) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    if (action === 'read') return jsonResponse(readAllRows());
    return jsonResponse({ error: 'unknown action' }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

function doPost(e) {
  // Kept for emergency manual writes. Not used by the daily agent anymore.
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SECRET_TOKEN) return jsonResponse({ error: 'unauthorized' }, 401);
    if (!Array.isArray(body.rows)) return jsonResponse({ error: 'rows must be an array' }, 400);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    const seenIds = readSeenIds(sheet);
    const newRows = body.rows.filter(r => r.ID && !seenIds.has(r.ID));
    appendRows(sheet, newRows);
    return jsonResponse({ appended_count: newRows.length, total_rows: getRowCount() });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

function readAllRows() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { headers: HEADERS, rows: [] };
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const rows = values.map(row => {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
  return { headers: HEADERS, rows: rows };
}

function getRowCount() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  return Math.max(0, sheet.getLastRow() - 1);
}

function jsonResponse(obj, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: statusCode || 200, body: obj }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== Manual utility =====

function resetProcessedFiles() {
  // Run this manually from the editor if you want to re-sync everything from
  // scratch. It clears the processed-files cache but won't create duplicates
  // because appendRows dedupes against existing IDs in the Sheet.
  PropertiesService.getScriptProperties().deleteProperty('processed_files');
  console.log('Cleared processed_files. Next pollGitHub will re-scan everything.');
}
