// APTO-CLT Tracker — Apps Script Web App
// Deploy: Extensions → Apps Script → paste this → Deploy → New deployment → Type: Web app
// Execute as: Me (juan@talentoparati.com)
// Who has access: Anyone
// Copy the deployment URL — pass it to the daily-prompt agent

// IMPORTANT: change SECRET_TOKEN to a random string. Add the same string to the agent prompt.
const SECRET_TOKEN = '06f0aa5104481efa508031e699b67a77d94f7448d621a432a90e74f936acba46';
const SHEET_ID = '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI';

const HEADERS = [
  'ID', 'DATE', 'NAME', 'ADDRESS', 'PRICE', 'BEDS', 'SQF', 'LINK',
  'DISTANCE APROX', 'SCORE', 'STATUS', 'NOTES', 'SOURCE'
];

function doGet(e) {
  try {
    const action = (e.parameter.action || 'read').toLowerCase();
    const token = e.parameter.token;

    if (token !== SECRET_TOKEN) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    if (action === 'read') {
      return jsonResponse(readAllRows());
    }

    return jsonResponse({ error: 'unknown action' }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.token !== SECRET_TOKEN) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    if (!Array.isArray(body.rows)) {
      return jsonResponse({ error: 'rows must be an array' }, 400);
    }

    const appended = appendRows(body.rows);
    return jsonResponse({ appended_count: appended, total_rows: getRowCount() });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
}

function readAllRows() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { headers: HEADERS, rows: [] };
  }
  const range = sheet.getRange(2, 1, lastRow - 1, HEADERS.length);
  const values = range.getValues();
  const rows = values.map(row => {
    const obj = {};
    HEADERS.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
  return { headers: HEADERS, rows: rows };
}

function appendRows(rows) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const matrix = rows.map(r => HEADERS.map(h => (r[h] !== undefined ? r[h] : '')));
  if (matrix.length === 0) return 0;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, matrix.length, HEADERS.length).setValues(matrix);
  return matrix.length;
}

function getRowCount() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  return Math.max(0, sheet.getLastRow() - 1);
}

function jsonResponse(obj, statusCode) {
  // Apps Script Web Apps always return 200; embed status in body for client to check.
  const payload = { status: statusCode || 200, body: obj };
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
