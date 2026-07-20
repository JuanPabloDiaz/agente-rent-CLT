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
    subjectPrefix: 'APTO-CLT daily',
    dataStart: '<<<APTO-CLT-DATA-START>>>',
    dataEnd: '<<<APTO-CLT-DATA-END>>>',
  },
  {
    name: 'casa-clt',
    sheetId: '1nVwG09Y9vK3BVTd9XyvLzPILqFBA5ykZdMDgxAKTTss',
    subjectPrefix: 'CASA-CLT daily',
    dataStart: '<<<CASA-CLT-DATA-START>>>',
    dataEnd: '<<<CASA-CLT-DATA-END>>>',
  },
  {
    name: 'apto-2bed-2bath',
    // Shares the apto-clt spreadsheet; rows land on the 'apto-2bed-2bath' tab.
    sheetId: '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI',
    sheetName: 'apto-2bed-2bath',
    subjectPrefix: 'APTO-2BR2BA daily',
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
// (1BR) sheet as prior-triage seed input. STATUS values in this set flow
// through; everything else is dropped.
//
// The user does the actual triage in the sheet — moving rows into any
// of the values below means "reconsider for 2BR". This filter just
// excludes the categorically rejected records.
//
// Pre-visit signals (based on listing only):
//   LOVE / LGTM / Need 2 Go! / Maybe / Missing
// Post-visit signals ("Fui" prefix = user toured in person):
//   Fui - LGTM       — visited, liked
//   Fui - LOVE       — visited, loved
//   Fui - $$$ LOVE   — visited, loved so much willing to stretch budget
// Post-visit signals are STRONGER than pre-visit ones because in-person
// tours have already validated the building. All three feed the seed
// list at flat +20 boost (same as pre-visit LOVE/LGTM in the agent's
// scoring); the differentiation is in the sheet, not in the score.
//
// Rationale for the exclusions (documented, not filtered against):
//   'NO - $$$ CARO'    — post-triage: user moved shared-budget-viable
//                        rows out of this bucket into Maybe/Missing/etc.
//                        What stays here is genuinely too expensive.
//   'NO - FEO/UNSAFE'  — quality/safety, doesn't change with unit shape
//   'NO - Far'         — 2BR agent's 8 mi cap already excludes; double-safety
//   'NO - Sin Laundry' — 2BR agent also requires in-unit laundry
//   'NO - Otro'        — misc rejection reason recorded by user
//   ''                 — blank rows have no STATUS at all — treat as noise
const SEED_INCLUDE = new Set([
  'LOVE',
  'LGTM',
  'Need 2 Go!',
  'Maybe',
  'Missing',
  'Fui - LGTM',
  'Fui - LOVE',
  'Fui - $$$ LOVE',
]);

// Source config for the snapshot (mirrors the apto-clt entry in AGENTS[]).
const SEED_SOURCE = {
  name: 'apto-clt',
  sheetId: '1fWy3rw3y524U2uzmPuuFTltzBhhX88QVNxx1NJXB2QI',
  sheetName: '1 bed',
};

// Gmail delivery for the seed snapshot.
const SEED_RECIPIENT = 'jpdiaz0@outlook.com';
const SEED_SUBJECT_PREFIX = 'APTO-CLT-SEEDS weekly';
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
    if (!subjectMatchesPrefix(subject, agent.subjectPrefix)) continue;

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

    // Enrich the draft with an HTML body (nice table + spreadsheet link)
    // before sending. Plain body stays intact — parsers and screen readers
    // still see the numbered list + JSON block. Any render failure is
    // logged and non-fatal — we fall back to sending the plain draft.
    try {
      const stats = {
        appended: toAppend.length,
        updated: updatedFromThisDraft,
        unchanged: unchangedFromThisDraft,
      };
      const htmlBody = renderDigestHtml(agent, payload.rows, stats, tabUrlFor(agent, sheet), payloadDate);
      draft.update(msg.getTo(), subject, body, { htmlBody: htmlBody });
    } catch (renderErr) {
      console.warn('[' + agent.name + '] html enrichment failed for draft ' + draftId + ': ' + renderErr);
    }

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

// Match a subject against a prefix while ignoring any leading non-ASCII
// decoration (emoji + separator whitespace). Lets us drop emoji from
// subjectPrefix values without stranding older drafts that still have
// emoji subjects. Both new and old drafts route to the right agent.
function subjectMatchesPrefix(subject, prefix) {
  const s = String(subject || '');
  if (s.indexOf(prefix) === 0) return true;
  const stripped = s.replace(/^[^\x20-\x7E]+\s*/, '');
  return stripped.indexOf(prefix) === 0;
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
// STATUS (see SEED_INCLUDE at the top of the file), and emits a Gmail
// message with a marker block that the 2BR agent parses on its daily
// run.
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
  const seeds = [];
  if (lastRow >= 2) {
    const lastCol = sheet.getLastColumn();
    const rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    rows.forEach(rowVals => {
      const status = String(rowVals[headerMap['STATUS']] || '').trim();
      if (!SEED_INCLUDE.has(status)) return;
      seeds.push(buildSeedRecord(rowVals, headerMap, status));
    });
  }

  const date = todayISO();
  const subject = SEED_SUBJECT_PREFIX + ' — ' + seeds.length + ' seeds for ' + date;
  const payload = { version: 2, date: date, seeds: seeds };
  const body = buildSeedBody(seeds.length, date, payload);
  const htmlBody = renderSeedDigestHtml(seeds, tabUrlFor(SEED_SOURCE, sheet), date);

  const draft = GmailApp.createDraft(SEED_RECIPIENT, subject, body, { htmlBody: htmlBody });
  draft.send();
  console.log('snapshotAptoCltForCrossAgent: sent ' + seeds.length + ' seeds');
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

function buildSeedBody(nSeeds, date, payload) {
  return [
    'Weekly seed snapshot of the apto-clt 1BR sheet for the apto-2bed-2bath agent.',
    '',
    nSeeds + ' buildings the user flagged for 2BR reconsideration',
    '(STATUS in {LOVE, LGTM, Need 2 Go!, Maybe, Missing}; all NO-* excluded).',
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

// ===== HTML digest rendering =====
//
// Agents write plain-text drafts (numbered list + JSON block). Before we
// send, we enrich the draft with an HTML body that renders a nice table
// with a spreadsheet link and per-row detail. The plain text is
// preserved as the alternative part, so parsers and screen readers still
// work. The JSON block stays in the plain-text side — we never strip it.

const HTML_DIGEST_COLUMNS = [
  'NAME',
  'PRICE',
  'SCORE',
  'DISTANCE APROX',
  'SQF',
  'BEDS',
  'BATHS',
  'TYPE',
  'YEAR_BUILT',
  'EST_PITI',
  'HOA',
  'DOM',
  'SOURCE',
];

const HTML_COLUMN_LABELS = {
  'DISTANCE APROX': 'DISTANCE',
  'EST_PITI': 'PITI',
  'YEAR_BUILT': 'YEAR',
};

const MONEY_COLUMNS = new Set(['PRICE', 'EST_PITI', 'HOA', 'EST_TAXES']);

const AGENT_HEADLINE = {
  'apto-clt': 'New 1BR/studio picks',
  'apto-2bed-2bath': 'New 2BR/2BA picks',
  'casa-clt': 'New houses / condos',
};

const STATUS_BADGE_COLOR = {
  'LOVE': '#0f9d58',
  'LGTM': '#0f9d58',
  'Need 2 Go!': '#1a73e8',
  'Maybe': '#f9ab00',
  'Missing': '#5f6368',
  'Fui - LGTM': '#a855f7',
  'Fui - LOVE': '#0f9d58',
  'Fui - $$$ LOVE': '#ec4899',
};

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatMoney(val) {
  const n = parsePrice(val);
  if (n === null) return escapeHtml(val);
  return '$' + n.toLocaleString('en-US');
}

function extractHostname(url) {
  if (!url) return '';
  const m = String(url).match(/^https?:\/\/([^\/?#]+)/i);
  if (!m) return '';
  return m[1].replace(/^www\./, '');
}

function tabUrlFor(agent, sheet) {
  const base = 'https://docs.google.com/spreadsheets/d/' + agent.sheetId + '/edit';
  if (sheet) {
    try { return base + '#gid=' + sheet.getSheetId(); } catch (e) {}
  }
  return base;
}

function renderDigestHtml(agent, rows, stats, tabUrl, date) {
  if (!rows || rows.length === 0) {
    return renderEmptyDigestHtml(agent, tabUrl, date);
  }

  const presentCols = HTML_DIGEST_COLUMNS.filter(function (col) {
    return rows.some(function (r) {
      return r[col] !== undefined && r[col] !== null && r[col] !== '';
    });
  });

  const thStyle = 'text-align:left;background:#f1f3f4;padding:8px 12px;' +
    'border-bottom:2px solid #dadce0;font-weight:600;font-size:11px;' +
    'letter-spacing:.04em;color:#5f6368;text-transform:uppercase;';
  const tdStyle = 'padding:10px 12px;border-bottom:1px solid #e8eaed;vertical-align:top;';

  const th = presentCols.map(function (c) {
    const label = HTML_COLUMN_LABELS[c] || c;
    return '<th style="' + thStyle + '">' + escapeHtml(label) + '</th>';
  }).join('');

  const tr = rows.map(function (row) {
    const tds = presentCols.map(function (col) {
      let val = row[col];
      if (col === 'NAME' && row.LINK) {
        return '<td style="' + tdStyle + '">' +
          '<a href="' + escapeHtml(row.LINK) + '" target="_blank" ' +
          'style="color:#1a73e8;text-decoration:none;font-weight:500;">' +
          escapeHtml(val || '(unnamed)') + '</a></td>';
      }
      if (MONEY_COLUMNS.has(col)) {
        return '<td style="' + tdStyle + 'font-variant-numeric:tabular-nums;">' + formatMoney(val) + '</td>';
      }
      if (col === 'SCORE') {
        return '<td style="' + tdStyle + 'font-variant-numeric:tabular-nums;font-weight:500;">' + escapeHtml(val) + '</td>';
      }
      return '<td style="' + tdStyle + '">' + escapeHtml(val) + '</td>';
    }).join('');

    let extra = '';
    if (row.ADDRESS) {
      extra += '<tr><td colspan="' + presentCols.length + '" ' +
        'style="padding:0 12px 6px 12px;color:#5f6368;font-size:12px;">' +
        escapeHtml(row.ADDRESS) + '</td></tr>';
    }
    if (row.NOTES) {
      extra += '<tr><td colspan="' + presentCols.length + '" ' +
        'style="padding:0 12px 12px 12px;color:#5f6368;font-size:12px;' +
        'border-bottom:1px solid #e8eaed;">' + escapeHtml(row.NOTES) + '</td></tr>';
    }
    return '<tr>' + tds + '</tr>' + extra;
  }).join('');

  const statsLine = stats
    ? '<p style="color:#5f6368;margin:4px 0 12px 0;font-size:13px;">' +
      stats.appended + ' new · ' + stats.updated + ' price-updated · ' +
      stats.unchanged + ' unchanged</p>'
    : '';

  const headline = AGENT_HEADLINE[agent.name] || agent.name;

  return '<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#202124;max-width:960px;margin:0 auto;padding:20px;background:#fff;">' +
    '<h2 style="margin:0 0 4px 0;font-weight:500;font-size:20px;">' + escapeHtml(headline) + '</h2>' +
    '<p style="color:#5f6368;margin:0 0 4px 0;font-size:13px;">' + rows.length + ' listings · ' + escapeHtml(date || '') + '</p>' +
    statsLine +
    '<p style="margin:8px 0 20px 0;"><a href="' + escapeHtml(tabUrl) +
    '" style="display:inline-block;background:#1a73e8;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:500;">Open the spreadsheet</a></p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    '<thead><tr>' + th + '</tr></thead>' +
    '<tbody>' + tr + '</tbody>' +
    '</table>' +
    '</body></html>';
}

function renderEmptyDigestHtml(agent, tabUrl, date) {
  const headline = AGENT_HEADLINE[agent.name] || agent.name;
  return '<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#202124;max-width:960px;margin:0 auto;padding:20px;background:#fff;">' +
    '<h2 style="margin:0 0 4px 0;font-weight:500;font-size:20px;">' + escapeHtml(headline) + '</h2>' +
    '<p style="color:#5f6368;margin:0 0 12px 0;font-size:13px;">No new listings today · ' + escapeHtml(date || '') + '</p>' +
    '<p style="margin:8px 0;"><a href="' + escapeHtml(tabUrl) +
    '" style="color:#1a73e8;text-decoration:none;">Open the spreadsheet →</a></p>' +
    '</body></html>';
}

function renderSeedDigestHtml(seeds, tabUrl, date) {
  const thStyle = 'text-align:left;background:#f1f3f4;padding:8px 12px;' +
    'border-bottom:2px solid #dadce0;font-weight:600;font-size:11px;' +
    'letter-spacing:.04em;color:#5f6368;text-transform:uppercase;';
  const tdStyle = 'padding:10px 12px;border-bottom:1px solid #e8eaed;vertical-align:top;';

  const tr = seeds.map(function (s) {
    const badgeColor = STATUS_BADGE_COLOR[s.prior_status] || '#5f6368';
    const badge = '<span style="background:' + badgeColor +
      ';color:#fff;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap;">' +
      escapeHtml(s.prior_status) + '</span>';
    const nameCell = s.source_link
      ? '<a href="' + escapeHtml(s.source_link) + '" target="_blank" ' +
        'style="color:#1a73e8;text-decoration:none;font-weight:500;">' +
        escapeHtml(s.name || '(unnamed)') + '</a>'
      : escapeHtml(s.name || '(unnamed)');
    const priceCell = s.prior_price
      ? formatMoney(s.prior_price) + '<span style="color:#5f6368;font-size:11px;"> /mo</span>'
      : '';

    let extra = '';
    if (s.address) {
      extra += '<tr><td colspan="4" style="padding:0 12px 6px 12px;color:#5f6368;font-size:12px;">' +
        escapeHtml(s.address) + '</td></tr>';
    }
    if (s.prior_notes) {
      extra += '<tr><td colspan="4" style="padding:0 12px 12px 12px;color:#5f6368;font-size:12px;border-bottom:1px solid #e8eaed;">' +
        escapeHtml(s.prior_notes) + '</td></tr>';
    }

    return '<tr>' +
      '<td style="' + tdStyle + '">' + nameCell + '</td>' +
      '<td style="' + tdStyle + 'font-variant-numeric:tabular-nums;">' + priceCell + '</td>' +
      '<td style="' + tdStyle + '">' + badge + '</td>' +
      '<td style="' + tdStyle + 'color:#5f6368;font-size:12px;">' + escapeHtml(extractHostname(s.source_link)) + '</td>' +
      '</tr>' + extra;
  }).join('');

  return '<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#202124;max-width:960px;margin:0 auto;padding:20px;background:#fff;">' +
    '<h2 style="margin:0 0 4px 0;font-weight:500;font-size:20px;">Seeds for the 2BR agent</h2>' +
    '<p style="color:#5f6368;margin:0 0 12px 0;font-size:13px;">' + seeds.length +
    ' buildings flagged for 2BR reconsideration · ' + escapeHtml(date) + '</p>' +
    '<p style="margin:8px 0 20px 0;"><a href="' + escapeHtml(tabUrl) +
    '" style="display:inline-block;background:#1a73e8;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:500;">Open the 1 bed tab</a></p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    '<thead><tr>' +
    '<th style="' + thStyle + '">Building</th>' +
    '<th style="' + thStyle + '">1BR price</th>' +
    '<th style="' + thStyle + '">Status</th>' +
    '<th style="' + thStyle + '">Source</th>' +
    '</tr></thead>' +
    '<tbody>' + tr + '</tbody>' +
    '</table>' +
    '</body></html>';
}

// ===== Manual utilities (run from the editor) =====

function runOnce() {
  pollGmailDrafts();
}

function runSnapshotOnce() {
  snapshotAptoCltForCrossAgent();
}

// Diagnostic: log each distinct STATUS value found in the seed source
// tab with its row count. Use this when the snapshot returns unexpected
// counts — it reveals whether the sheet actually contains the STATUS
// strings that SEED_INCLUDE filters against.
function showAptoCltStatusHistogram() {
  const sheet = openAgentSheet(SEED_SOURCE);
  const headerMap = readHeaderMap(sheet);
  if (headerMap['STATUS'] === undefined) {
    console.log('Sheet has no STATUS column.');
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { console.log('Sheet has no data rows.'); return; }
  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const counts = {};
  rows.forEach(r => {
    const raw = r[headerMap['STATUS']];
    const status = raw === null || raw === undefined ? '' : String(raw);
    const key = status === '' ? '(blank)' : JSON.stringify(status);
    counts[key] = (counts[key] || 0) + 1;
  });
  console.log('STATUS histogram for tab "' + SEED_SOURCE.sheetName + '" (' + (lastRow - 1) + ' rows):');
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('  ' + v + '\t' + k));
  console.log('');
  console.log('Currently included as seeds: ' + JSON.stringify([...SEED_INCLUDE]));
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
