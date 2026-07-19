// CLT Real Estate Agents — Apps Script bridge
//
// Polls Gmail drafts created by the daily Claude agents (apto-clt for
// rentals, casa-clt for purchases) and merges new/changed rows into each
// agent's Google Sheet. One script, one trigger, one Google project — both
// agents are configured in the AGENTS array below.
//
// Robustness features (apply per agent):
// - Reads Sheet headers from row 1 on every run, so columns can be reordered
//   in the UI without breaking the script.
// - Each agent targets one tab. If `sheetName` is set on the agent, that
//   named tab is used; otherwise the first tab is used. Two agents can share
//   the same spreadsheet by pointing at different tab names.
// - Matches incoming rows against existing rows by LINK first, then by
//   normalized ADDRESS (case- and unit-insensitive). Same building is never
//   inserted twice regardless of which source surfaced it.
// - For an existing match: if PRICE changed, UPDATES the row in place
//   (price, score, source, notes with a price-change log entry, distance if
//   newer, link if newer). The original ID and DATE-found are preserved so
//   history isn't lost.
// - For a brand-new listing: appends a row, defaulting STATUS to "Missing"
//   so the tracker always shows a review state.
// - After processing a draft, sends it via GmailDraft.send() so the digest
//   lands in the recipient inbox (e.g. jpdiaz0@outlook.com).
// - Each agent runs inside its own try/catch so one agent's failure cannot
//   block the other.
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

const AGENTS = [
  {
    name: 'apto-clt',
    sheetId: '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI',
    sheetName: '1 bed',
    subjectPrefix: '🏠 APTO-CLT daily',
    dataStart: '<<<APTO-CLT-DATA-START>>>',
    dataEnd: '<<<APTO-CLT-DATA-END>>>',
  },
  {
    name: 'casa-clt',
    sheetId: '1nVwG09Y9vK3BVTd9XyvLzPILqFBA5ykZdMDgxAKTTss',
    subjectPrefix: '🏡 CASA-CLT daily',
    dataStart: '<<<CASA-CLT-DATA-START>>>',
    dataEnd: '<<<CASA-CLT-DATA-END>>>',
  },
  {
    name: 'apto-2bed-2bath',
    // Shares the apto-clt spreadsheet; rows land on the 'apto-2bed-2bath' tab.
    sheetId: '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI',
    sheetName: 'apto-2bed-2bath',
    subjectPrefix: '🛏️ APTO-2BR2BA daily',
    dataStart: '<<<APTO-2BR2BA-DATA-START>>>',
    dataEnd: '<<<APTO-2BR2BA-DATA-END>>>',
  },
];

const DEFAULT_STATUS = 'Missing';

// Fields that get refreshed on price-change updates. The rest (ID, original
// DATE, STATUS) are preserved. BEDS/BATHS intentionally absent — each tab
// is a single bed/bath spec by construction (tab name = spec), and neither
// column is part of any current agent's payload.
const REFRESH_ON_UPDATE = ['PRICE', 'SCORE', 'SOURCE', 'DISTANCE APROX', 'LINK', 'SQF'];

// ===== Cross-agent seed snapshot config =====
//
// The `apto-2bed-2bath` agent uses a filtered snapshot of the `apto-clt`
// (1BR) sheet as prior-triage seed input. STATUS values landing in these
// two sets flow through; everything else is dropped.
//
// Rationale for the mapping (edit these sets to tweak):
//   'NO - $$$ CARO'    → price rejection on solo $1,400 budget; shared
//                        $1,500 2BR budget may make the same building viable.
//   LOVE/LGTM/Need 2 Go!/Maybe → user already endorsed the building.
// Explicitly excluded (documented, not filtered against):
//   'Missing'          — un-triaged, no signal
//   'NO - FEO/UNSAFE'  — quality/safety, doesn't change with unit shape
//   'NO - Far'         — 8 mi cap already excludes; double-safety
//   'NO - Sin Laundry' — 2BR agent also requires in-unit laundry
//   ''                 — blank == un-triaged
const SEED_INCLUDE_PRICE_REJECTS = new Set(['NO - $$$ CARO']);
const SEED_INCLUDE_LIKED = new Set(['LOVE', 'LGTM', 'Need 2 Go!', 'Maybe']);

// Source config for the snapshot (mirrors the apto-clt entry in AGENTS[]).
const SEED_SOURCE = {
  name: 'apto-clt',
  sheetId: '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI',
  sheetName: '1 bed',
};

// Gmail delivery for the seed snapshot.
const SEED_RECIPIENT = 'jpdiaz0@outlook.com';
const SEED_SUBJECT_PREFIX = '🔗 APTO-CLT-SEEDS weekly';
const SEED_DATA_START = '<<<APTO-CLT-SEEDS-START>>>';
const SEED_DATA_END = '<<<APTO-CLT-SEEDS-END>>>';

// ===== Time-driven entry point =====

function pollGmailDrafts() {
  migrateLegacyProcessedDrafts();

  const drafts = GmailApp.getDrafts();
  if (drafts.length === 0) {
    console.log('pollGmailDrafts: no drafts in mailbox');
    return;
  }

  for (const agent of AGENTS) {
    try {
      processAgent(agent, drafts);
    } catch (e) {
      console.error('[' + agent.name + '] failed: ' + (e && e.stack ? e.stack : e));
    }
  }
}

function processAgent(agent, drafts) {
  if (!agent.sheetId || agent.sheetId.indexOf('<TODO') === 0) {
    console.log('[' + agent.name + '] skipped: sheetId is TODO');
    return;
  }

  const propKey = 'processed_drafts_' + agent.name;
  const props = PropertiesService.getScriptProperties();
  const processed = JSON.parse(props.getProperty(propKey) || '{}');

  const sheet = openAgentSheet(agent);
  const headerMap = readHeaderMap(sheet);
  if (headerMap['LINK'] === undefined) {
    throw new Error('Sheet missing LINK column — cannot dedupe. Add a LINK header in row 1.');
  }

  // Build an index of existing rows keyed by LINK and by normalized ADDRESS.
  // Each entry holds {rowNumber, currentValues, link, address}.
  const existingIndex = buildExistingIndex(sheet, headerMap);

  let totalAppended = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalDraftsMatched = 0;
  let totalSkippedDrafts = 0;

  for (const draft of drafts) {
    const draftId = draft.getId();
    if (processed[draftId]) continue;

    const msg = draft.getMessage();
    const subject = msg.getSubject() || '';
    if (!subject.startsWith(agent.subjectPrefix)) continue;

    totalDraftsMatched++;
    const body = msg.getPlainBody();
    const payload = extractPayload(body, agent);

    if (!payload) {
      console.warn('[' + agent.name + '] could not parse payload in draft ' + draftId + ' (subject: ' + subject + ')');
      processed[draftId] = { processedAt: new Date().toISOString(), error: 'parse_failed' };
      totalSkippedDrafts++;
      continue;
    }
    if (!Array.isArray(payload.rows)) {
      processed[draftId] = { processedAt: new Date().toISOString(), error: 'no_rows_array' };
      totalSkippedDrafts++;
      continue;
    }

    const payloadDate = payload.date || todayISO();
    const toAppend = [];
    let updatedFromThisDraft = 0;
    let unchangedFromThisDraft = 0;

    for (const row of payload.rows) {
      const link = String(row.LINK || '').toLowerCase().trim();
      const address = normalizeAddress(row.ADDRESS || '');

      const existing =
        (link && existingIndex.byLink[link]) ||
        (address && existingIndex.byAddress[address]) ||
        null;

      if (!existing) {
        toAppend.push(row);
        // pre-register so a later row in the same payload doesn't reinsert
        // the same building
        const placeholder = { rowNumber: null, values: {} };
        if (link) existingIndex.byLink[link] = placeholder;
        if (address) existingIndex.byAddress[address] = placeholder;
        continue;
      }

      const incomingPrice = parsePrice(row.PRICE);
      const existingPrice = parsePrice(existing.values.PRICE);

      if (incomingPrice !== null && existingPrice !== null && incomingPrice !== existingPrice) {
        // Price changed — update the existing row in place
        updateRowInPlace(sheet, headerMap, existing, row, payloadDate);
        updatedFromThisDraft++;
      } else {
        unchangedFromThisDraft++;
      }
    }

    if (toAppend.length > 0) {
      appendRows(sheet, headerMap, toAppend);
      totalAppended += toAppend.length;
    }
    totalUpdated += updatedFromThisDraft;
    totalUnchanged += unchangedFromThisDraft;

    // Send the draft to the inbox configured in the draft's To field.
    let sendStatus = 'sent';
    try {
      draft.send();
    } catch (sendErr) {
      console.warn('[' + agent.name + '] failed to send draft ' + draftId + ': ' + sendErr);
      sendStatus = 'send_failed: ' + String(sendErr).slice(0, 200);
    }

    processed[draftId] = {
      processedAt: new Date().toISOString(),
      appended: toAppend.length,
      updated: updatedFromThisDraft,
      unchanged: unchangedFromThisDraft,
      totalInPayload: payload.rows.length,
      date: payload.date || null,
      send: sendStatus
    };
  }

  props.setProperty(propKey, JSON.stringify(processed));
  console.log(
    '[' + agent.name + '] drafts=' + drafts.length +
    ' matched=' + totalDraftsMatched +
    ' appended=' + totalAppended +
    ' updated=' + totalUpdated +
    ' unchanged=' + totalUnchanged +
    ' skipped_drafts=' + totalSkippedDrafts
  );
}

// One-time migration: copy the old `processed_drafts` key (single-agent era)
// into `processed_drafts_apto-clt`, then delete the old key. Idempotent — if
// the new key already exists, the old key is just deleted.
function migrateLegacyProcessedDrafts() {
  const props = PropertiesService.getScriptProperties();
  const legacy = props.getProperty('processed_drafts');
  if (legacy === null) return;
  const targetKey = 'processed_drafts_apto-clt';
  if (props.getProperty(targetKey) === null) {
    props.setProperty(targetKey, legacy);
    console.log('migrateLegacyProcessedDrafts: copied legacy key to ' + targetKey);
  } else {
    console.log('migrateLegacyProcessedDrafts: ' + targetKey + ' already exists, dropping legacy key');
  }
  props.deleteProperty('processed_drafts');
}

// ===== Existing-row indexing =====

function buildExistingIndex(sheet, headerMap) {
  const byLink = {};
  const byAddress = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { byLink, byAddress };
  const lastCol = sheet.getLastColumn();
  const rng = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  rng.forEach((rowVals, i) => {
    const values = {};
    Object.entries(headerMap).forEach(([name, idx]) => { values[name] = rowVals[idx]; });
    const entry = { rowNumber: i + 2, values: values }; // sheet rows are 1-indexed; +2 to skip header
    const link = String(values.LINK || '').toLowerCase().trim();
    const address = normalizeAddress(values.ADDRESS || '');
    if (link) byLink[link] = entry;
    if (address) byAddress[address] = entry;
  });
  return { byLink, byAddress };
}

// ===== Row write helpers =====

function appendRows(sheet, headerMap, rows) {
  const lastCol = sheet.getLastColumn();
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

function updateRowInPlace(sheet, headerMap, existing, incoming, todayDate) {
  const lastCol = sheet.getLastColumn();
  const rowNumber = existing.rowNumber;
  if (!rowNumber) return; // placeholder for a just-appended row, skip

  const oldPrice = parsePrice(existing.values.PRICE);
  const newPrice = parsePrice(incoming.PRICE);
  if (newPrice === null || oldPrice === null || newPrice === oldPrice) return;

  // Read the row as it currently is (in case STATUS or NOTES was edited
  // between snapshot time and now).
  const currentRow = sheet.getRange(rowNumber, 1, 1, lastCol).getValues()[0];
  const currentMap = {};
  Object.entries(headerMap).forEach(([name, idx]) => { currentMap[name] = currentRow[idx]; });

  // Refresh the configured fields with the incoming values.
  REFRESH_ON_UPDATE.forEach(field => {
    if (incoming[field] !== undefined && incoming[field] !== null && incoming[field] !== '') {
      currentMap[field] = incoming[field];
    }
  });

  // Prepend a price-change line to NOTES, then preserve any user-added
  // tail. Cap NOTES at 1000 chars to avoid runaway growth.
  const changeNote = '[' + todayDate + '] precio: $' + oldPrice + ' -> $' + newPrice + '.';
  const existingNotes = String(currentMap.NOTES || '').trim();
  const newNotes = existingNotes.startsWith(changeNote)
    ? existingNotes
    : (changeNote + (existingNotes ? ' ' + existingNotes : '')).slice(0, 1000);
  currentMap.NOTES = newNotes;

  // STATUS: if the user has already triaged it (LGTM/LOVE/Maybe/Descartado),
  // leave it. Only flip back to Missing if it was empty.
  if (currentMap.STATUS === '' || currentMap.STATUS === null || currentMap.STATUS === undefined) {
    currentMap.STATUS = DEFAULT_STATUS;
  }

  // Write the row back.
  const headersOrdered = new Array(lastCol).fill(null);
  Object.entries(headerMap).forEach(([name, idx]) => { headersOrdered[idx] = name; });
  const newRow = headersOrdered.map(h => {
    if (h === null) return currentRow[headersOrdered.indexOf(null)] || '';
    const v = currentMap[h];
    return v !== undefined && v !== null ? v : '';
  });
  sheet.getRange(rowNumber, 1, 1, lastCol).setValues([newRow]);

  // Refresh the in-memory snapshot so subsequent rows in this payload see
  // the updated price.
  existing.values = currentMap;
}

// ===== Header + column helpers =====

// Open the target tab for an agent. If agent.sheetName is set, open that
// named tab and throw if it doesn't exist (fail loud rather than silently
// writing to the wrong tab). If not set, fall back to the first tab.
function openAgentSheet(agent) {
  const ss = SpreadsheetApp.openById(agent.sheetId);
  if (agent.sheetName) {
    const sheet = ss.getSheetByName(agent.sheetName);
    if (!sheet) {
      throw new Error(
        'Tab "' + agent.sheetName + '" not found in spreadsheet ' + agent.sheetId +
        ' for agent ' + agent.name + '. Create the tab or fix the sheetName.'
      );
    }
    return sheet;
  }
  return ss.getSheets()[0];
}

function readHeaderMap(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) throw new Error('Sheet has no columns');
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    if (h !== '' && h !== null && h !== undefined) {
      map[String(h).trim()] = i;
    }
  });
  return map;
}

function normalizeAddress(addr) {
  if (!addr) return '';
  return String(addr)
    .toLowerCase()
    .replace(/\b(unit|apt|apartment|suite|ste|#)\s*[\w-]+\b/gi, '')
    .replace(/[,.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(String(val).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function todayISO() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ===== Payload extraction =====

function extractPayload(body, agent) {
  if (!body) return null;
  const startIdx = body.indexOf(agent.dataStart);
  const endIdx = body.indexOf(agent.dataEnd);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const json = body.substring(startIdx + agent.dataStart.length, endIdx).trim();
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// ===== Weekly seed snapshot (apto-clt → apto-2bed-2bath) =====
//
// Reads the `1 bed` tab of the apto-clt spreadsheet, filters rows by
// STATUS (see SEED_INCLUDE_* sets at the top of the file), and emits
// a Gmail message with a marker block that the 2BR agent parses on its
// daily run.
//
// The message subject deliberately does NOT match any agent's
// `subjectPrefix`, so `pollGmailDrafts` skips it — this is a one-way
// export, not a sync target.
//
// Add a weekly time-driven trigger for `snapshotAptoCltForCrossAgent`
// in the Apps Script editor (see apps-script/README.md).
function snapshotAptoCltForCrossAgent() {
  const sheet = openAgentSheet(SEED_SOURCE);
  const headerMap = readHeaderMap(sheet);
  if (headerMap['STATUS'] === undefined) {
    throw new Error('Seed source sheet missing STATUS column — cannot filter.');
  }

  const lastRow = sheet.getLastRow();
  const priceRejects = [];
  const liked = [];
  if (lastRow >= 2) {
    const lastCol = sheet.getLastColumn();
    const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    rows.forEach(rowVals => {
      const status = String(rowVals[headerMap['STATUS']] || '').trim();
      const bucket = SEED_INCLUDE_PRICE_REJECTS.has(status)
        ? priceRejects
        : (SEED_INCLUDE_LIKED.has(status) ? liked : null);
      if (!bucket) return;
      bucket.push(buildSeedRecord(rowVals, headerMap, status));
    });
  }

  const date = todayISO();
  const subject = SEED_SUBJECT_PREFIX + ' — ' + priceRejects.length +
    ' price-rejects + ' + liked.length + ' liked buildings for ' + date;
  const payload = { version: 1, date: date, price_rejects: priceRejects, liked: liked };
  const body = buildSeedBody(priceRejects.length, liked.length, date, payload);

  const draft = GmailApp.createDraft(SEED_RECIPIENT, subject, body);
  draft.send();
  console.log('snapshotAptoCltForCrossAgent: sent ' + priceRejects.length +
    ' price-rejects + ' + liked.length + ' liked seeds');
}

function buildSeedRecord(rowVals, headerMap, status) {
  const get = (name) => {
    const idx = headerMap[name];
    return idx === undefined ? '' : rowVals[idx];
  };
  const notes = String(get('NOTES') || '').slice(0, 400);
  return {
    name: String(get('NAME') || ''),
    address: String(get('ADDRESS') || ''),
    prior_price: parsePrice(get('PRICE')),
    prior_status: status,
    prior_notes: notes,
    source_link: String(get('LINK') || ''),
  };
}

function buildSeedBody(nPrice, nLiked, date, payload) {
  return [
    'Weekly seed snapshot of the apto-clt 1BR sheet for the apto-2bed-2bath agent.',
    '',
    'price_rejects (' + nPrice + '): buildings rejected against solo $1,400 budget.',
    'liked (' + nLiked + '): buildings marked LOVE / LGTM / Need 2 Go! / Maybe.',
    '',
    'The 2BR agent reads the JSON block below on every daily run to bias searches',
    'toward these buildings and score-boost matching 2BR/2BA candidates.',
    '',
    '---',
    SEED_DATA_START,
    JSON.stringify(payload, null, 2),
    SEED_DATA_END,
  ].join('\n');
}

// ===== Manual utilities (run from the editor) =====

function runOnce() {
  pollGmailDrafts();
}

function runSnapshotOnce() {
  snapshotAptoCltForCrossAgent();
}

function resetProcessedDrafts() {
  const props = PropertiesService.getScriptProperties();
  AGENTS.forEach(agent => {
    props.deleteProperty('processed_drafts_' + agent.name);
  });
  props.deleteProperty('processed_drafts'); // legacy key, just in case
  console.log('Cleared processed_drafts_* for all agents. Next pollGmailDrafts will re-scan all drafts.');
}

function showProcessedSummary() {
  const props = PropertiesService.getScriptProperties();
  AGENTS.forEach(agent => {
    const key = 'processed_drafts_' + agent.name;
    const processed = JSON.parse(props.getProperty(key) || '{}');
    console.log('[' + agent.name + '] processed drafts: ' + Object.keys(processed).length);
    Object.entries(processed).forEach(([id, info]) => {
      console.log('  ' + id + ' -> ' + JSON.stringify(info));
    });
  });
}

function showHeaderMap() {
  AGENTS.forEach(agent => {
    if (!agent.sheetId || agent.sheetId.indexOf('<TODO') === 0) {
      console.log('[' + agent.name + '] sheetId is TODO, skipping');
      return;
    }
    try {
      const sheet = openAgentSheet(agent);
      const tabLabel = agent.sheetName ? ' (tab: ' + agent.sheetName + ')' : ' (first tab)';
      console.log('[' + agent.name + ']' + tabLabel + ' ' + JSON.stringify(readHeaderMap(sheet), null, 2));
    } catch (e) {
      console.error('[' + agent.name + '] ' + (e && e.message ? e.message : e));
    }
  });
}
