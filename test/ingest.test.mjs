import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

import {
  buildChangeInserts,
  buildSql,
  discoverLatest,
  parseFileTimestamp,
  parsePriceCents,
  parseWorkbook,
  planIngest,
  sqlString,
  stationKey,
} from '../scripts/ingest.mjs';

const FILE_URL = 'https://regieessencequebec.ca/data/stations-20261117104000.xlsx';
const FILE_TIMESTAMP = '2026-11-17T10:40:00Z';
const EXECUTED_AT = '2026-11-17T11:00:00.000Z';

function makeStation(overrides = {}) {
  return {
    rowNumber: 2,
    name: 'Station 1',
    brand: 'Shell',
    address: '1 rue X',
    region: 'Montréal',
    postalCode: 'H1A 1A1',
    latitude: 45.5,
    longitude: -73.6,
    regularPriceCents: 179.4,
    superPriceCents: 190.9,
    dieselPriceCents: null,
    regularPriceRaw: '179.4¢',
    superPriceRaw: '190.9¢',
    dieselPriceRaw: 'N/D',
    ...overrides,
  };
}

/** Shape the rows the way `SELECT … FROM stations_current` returns them. */
function asCurrent(rows) {
  return rows.map((row) => ({
    station_key: stationKey(row),
    name: row.name,
    brand: row.brand,
    address: row.address,
    region: row.region,
    postal_code: row.postalCode,
    latitude: row.latitude,
    longitude: row.longitude,
    regular_price_cents: row.regularPriceCents,
    super_price_cents: row.superPriceCents,
    diesel_price_cents: row.dieselPriceCents,
  }));
}


const HEADER = ['Nom', 'Bannière', 'Adresse', 'Région', 'Code Postal', 'Latitude', 'Longitude', 'Prix Régulier', 'Prix Super', 'Prix Diesel'];

function makeWorkbook(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Régie Essence Québec');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
}

test('parseFileTimestamp reads the timestamp from the file name', () => {
  assert.equal(
    parseFileTimestamp('https://regieessencequebec.ca/data/stations-20261117104000.xlsx'),
    '2026-11-17T10:40:00Z',
  );
  assert.equal(parseFileTimestamp('https://example.com/other.xlsx'), null);
});

test('parsePriceCents normalizes the Excel price formats', () => {
  assert.equal(parsePriceCents('179.4¢'), 179.4);
  assert.equal(parsePriceCents('179,4 ¢'), 179.4);
  assert.equal(parsePriceCents(' 179.4¢/L '), 179.4);
  assert.equal(parsePriceCents(153.9), 153.9);
  assert.equal(parsePriceCents('N/D'), null);
  assert.equal(parsePriceCents(''), null);
  assert.equal(parsePriceCents(null), null);
});


test('parseWorkbook maps headers, skips the footer and keeps raw prices', () => {
  const buffer = makeWorkbook([
    HEADER,
    ["O'Brien Pétrole", 'Shell', '1 rue Principale, Montréal', 'Montréal', 'H1A 1A1', 45.5, -73.6, '179.4¢', '204.4¢', 'N/D'],
    ['Station Test', 'Esso', '2 rue Test, Québec', 'Capitale-Nationale', 'G1A 1A1', '46,8', '-71,2', null, '190,9 ¢', '200.0¢'],
    [],
    ['Données générées le : 2026-11-17 à 11:25:00 UTC', null, null, null, null, null, null, null, null, null],
    ["Source : Régie de l'Énergie du Québec", null, null, null, null, null, null, null, null, null],
    ['Total de stations : 2', null, null, null, null, null, null, null, null, null],
  ]);

  const { rows, sheetName, headerIndex, skippedRows } = parseWorkbook(buffer);

  assert.equal(sheetName, 'Régie Essence Québec');
  assert.equal(headerIndex, 0);
  assert.equal(rows.length, 2);
  // The blank row plus the three footer/metadata lines.
  assert.equal(skippedRows, 4);

  assert.deepEqual(rows[0], {
    rowNumber: 2,
    name: "O'Brien Pétrole",
    brand: 'Shell',
    address: '1 rue Principale, Montréal',
    region: 'Montréal',
    postalCode: 'H1A 1A1',
    latitude: 45.5,
    longitude: -73.6,
    regularPriceCents: 179.4,
    superPriceCents: 204.4,
    dieselPriceCents: null,
    regularPriceRaw: '179.4¢',
    superPriceRaw: '204.4¢',
    dieselPriceRaw: 'N/D',
  });

  assert.equal(rows[1].latitude, 46.8);
  assert.equal(rows[1].longitude, -71.2);
  assert.equal(rows[1].regularPriceCents, null);
  assert.equal(rows[1].superPriceCents, 190.9);
});

test('parseWorkbook falls back to the documented column order', () => {
  const buffer = makeWorkbook([
    ['Une colonne inconnue', 'Autre', 'Encore'],
    ['Station Sans Entête', 'Bannière X', '3 rue X', 'Gaspésie', 'G0C 1A0', 48.1, -65.2, '180.0¢', '200.0¢', '210.0¢'],
  ]);

  const { rows } = parseWorkbook(buffer);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Station Sans Entête');
  assert.equal(rows[0].region, 'Gaspésie');
  assert.equal(rows[0].dieselPriceCents, 210);
});

test('parseWorkbook drops rows that carry no station data', () => {
  const buffer = makeWorkbook([
    HEADER,
    ['Ligne sans aucune donnée'],
    ['Station Test', 'Esso', '2 rue Test, Québec', 'Capitale-Nationale', 'G1A 1A1', 46.8, -71.2, '190.9¢', null, null],
  ]);

  const { rows, skippedRows } = parseWorkbook(buffer);

  assert.equal(rows.length, 1);
  assert.equal(skippedRows, 1);
  assert.equal(rows[0].regularPriceCents, 190.9);
});

test('sqlString escapes single quotes', () => {
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  assert.equal(sqlString(null), 'NULL');
});

test('stationKey ignores accents, case, punctuation and spacing', () => {
  const base = { name: "Dépanneur O'Neil", address: '1234 rue Principale, Montréal' };

  assert.equal(
    stationKey(base),
    stationKey({ name: 'depanneur  oneil', address: '1234 RUE PRINCIPALE MONTREAL' }),
  );
  assert.equal(stationKey(base).length, 16);
  assert.notEqual(stationKey(base), stationKey({ name: 'Station Test', address: base.address }));
  assert.notEqual(stationKey(base), stationKey({ name: base.name, address: '99 autre rue' }));
});

test('planIngest keeps only the stations whose price moved or that appeared', () => {
  const previous = asCurrent([
    makeStation(),
    makeStation({ name: 'Station 2', address: '2 rue X' }),
    makeStation({ name: 'Station 3', address: '3 rue X' }),
  ]);

  const rows = [
    makeStation(),
    makeStation({ name: 'Station 2', address: '2 rue X', regularPriceCents: 178.4, regularPriceRaw: '178.4¢' }),
    makeStation({ name: 'Station 3', address: '3 rue Y' }),
    makeStation({ name: 'Station 4', address: '4 rue X' }),
  ];

  const { changed, removed, stats } = planIngest(rows, previous);

  // The address fix on station 3 changes its key: one removal, one addition,
  // so stations_current never keeps an orphan row.
  assert.deepEqual(stats, { added: 2, priceChanged: 1, locationChanged: 0, unchanged: 1, removed: 1, duplicates: 0 });
  assert.deepEqual(changed.map((row) => row.name), ['Station 2', 'Station 3', 'Station 4']);
  assert.equal(changed[0].regularPriceCents, 178.4);
  assert.equal(changed[0].stationKey, stationKey(rows[1]));
  assert.deepEqual(removed, [stationKey({ name: 'Station 3', address: '3 rue X' })]);
});

test('planIngest flags a coordinate or banner fix as a location change', () => {
  const previous = asCurrent([makeStation()]);

  const moved = planIngest([makeStation({ latitude: 45.6 })], previous);
  assert.equal(moved.changed.length, 1);
  assert.equal(moved.stats.locationChanged, 1);
  assert.deepEqual(moved.removed, []);

  const rebranded = planIngest([makeStation({ brand: 'Esso' })], previous);
  assert.equal(rebranded.stats.locationChanged, 1);
});

test('planIngest treats an empty database as "everything is new"', () => {
  const rows = [makeStation(), makeStation({ name: 'Station 2', address: '2 rue X' })];
  const { changed, stats } = planIngest(rows, []);

  assert.equal(changed.length, 2);
  assert.equal(stats.added, 2);
  assert.equal(stats.unchanged, 0);
});

test('planIngest ignores raw price formatting and flags duplicate keys', () => {
  const previous = asCurrent([makeStation()]);

  const formatted = planIngest([makeStation({ regularPriceRaw: '179,4 ¢' })], previous);
  assert.equal(formatted.changed.length, 0);
  assert.equal(formatted.stats.unchanged, 1);

  const duplicated = planIngest([makeStation(), makeStation()], previous);
  assert.equal(duplicated.changed.length, 0);
  assert.equal(duplicated.stats.duplicates, 1);
});

test('buildChangeInserts chunks rows and carries both timestamps', () => {
  const changed = [1, 2, 3].map((n) => ({
    ...makeStation({ rowNumber: n + 1, name: `Station ${n}`, superPriceCents: null, dieselPriceCents: null }),
    stationKey: `key${n}`,
  }));

  const statements = buildChangeInserts(
    changed,
    { fileUrl: FILE_URL, fileTimestamp: FILE_TIMESTAMP, executedAt: EXECUTED_AT },
    2,
  );

  assert.equal(statements.length, 2);
  assert.match(statements[0], /^INSERT OR IGNORE INTO price_changes/);
  assert.match(statements[0], /'2026-11-17T10:40:00Z'/);
  assert.match(statements[0], /'2026-11-17T11:00:00\.000Z'/);
  assert.match(statements[0], /'key2'/);
  assert.doesNotMatch(statements[0], /'key3'/);
  assert.match(statements[1], /'key3'/);
});



test('buildSql upserts the current values and appends to the change log', () => {
  const changed = [{ ...makeStation({ name: "Dépanneur O'Neil" }), stationKey: 'abc123' }];
  const base = {
    changed,
    rowCount: 2471,
    fileUrl: FILE_URL,
    fileTimestamp: FILE_TIMESTAMP,
    executedAt: EXECUTED_AT,
  };

  const sql = buildSql({ ...base, removed: ['oldkey0000000000'], retentionDays: 0 });

  assert.match(sql, /INSERT INTO stations_current/);
  assert.match(sql, /ON CONFLICT\(station_key\) DO UPDATE SET/);
  assert.match(sql, /INSERT OR IGNORE INTO price_changes/);
  assert.match(sql, /DELETE FROM stations_current WHERE station_key IN \('oldkey0000000000'\);/);
  assert.doesNotMatch(sql, /INTO station_prices/);
  // Quotes in station names must be escaped.
  assert.match(sql, /'Dépanneur O''Neil'/);
  // first_seen_at is set on insert only, never overwritten by an update.
  assert.doesNotMatch(sql, /first_seen_at = excluded\.first_seen_at/);
  assert.equal(sql.match(/INSERT OR REPLACE INTO ingest_runs/g).length, 1);
  assert.match(sql, /'ok'/);
  // row_count records the rows in the file, not the rows written.
  assert.match(sql, /, 2471, 'ok', NULL\);/);
  assert.equal(sql.match(/strftime/g), null);
});

test('buildSql retention prunes the change log and the run history only', () => {
  const sql = buildSql({
    changed: [],
    rowCount: 2471,
    fileUrl: FILE_URL,
    fileTimestamp: FILE_TIMESTAMP,
    executedAt: EXECUTED_AT,
    retentionDays: 14,
  });

  assert.equal(
    sql.match(/DELETE FROM price_changes WHERE file_timestamp < strftime\('%Y-%m-%dT%H:%M:%SZ', 'now', '-14 days'\);/g)
      .length,
    1,
  );
  assert.equal(sql.match(/DELETE FROM ingest_runs WHERE file_timestamp < strftime/g).length, 1);
  // An unchanged file still records its run, so the next run can skip it.
  assert.match(sql, /INSERT OR REPLACE INTO ingest_runs/);
  assert.doesNotMatch(sql, /INSERT INTO stations_current/);
  assert.doesNotMatch(sql, /INTO station_prices/);
});

test('discoverLatest derives the newest file from the map metadata', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        metadata: {
          generated_at: '2026-11-17T10:40:00.2884823Z',
          excel_url: '/data/stations-20261117104000.xlsx',
          total_stations: 2470,
          excel_size_bytes: 197522,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  const latest = await discoverLatest({ fetchImpl });
  assert.equal(latest.excelUrl, 'https://regieessencequebec.ca/data/stations-20261117104000.xlsx');
  assert.equal(latest.fileTimestamp, '2026-11-17T10:40:00Z');
  assert.equal(latest.totalStations, 2470);
});

test('discoverLatest fails loudly when the metadata is missing', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ metadata: {} }), { status: 200 });
  await assert.rejects(() => discoverLatest({ fetchImpl }), /No metadata\.excel_url/);
});
