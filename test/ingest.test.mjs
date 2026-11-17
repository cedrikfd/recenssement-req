import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

import {
  buildSql,
  buildInsertStatements,
  discoverLatest,
  parseFileTimestamp,
  parsePriceCents,
  parseWorkbook,
  sqlString,
} from '../scripts/ingest.mjs';

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
    ['Total de stations : 2', null, null, null, null, null, null, null, null, null],
  ]);

  const { rows, sheetName, headerIndex } = parseWorkbook(buffer);

  assert.equal(sheetName, 'Régie Essence Québec');
  assert.equal(headerIndex, 0);
  assert.equal(rows.length, 2);

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

test('sqlString escapes single quotes', () => {
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  assert.equal(sqlString(null), 'NULL');
});

test('buildInsertStatements chunks rows and carries both timestamps', () => {
  const rows = [1, 2, 3].map((n) => ({
    rowNumber: n + 1,
    name: `Station ${n}`,
    brand: 'Shell',
    address: '1 rue X',
    region: 'Montréal',
    postalCode: 'H1A 1A1',
    latitude: 45,
    longitude: -73,
    regularPriceCents: 179.4,
    superPriceCents: null,
    dieselPriceCents: null,
    regularPriceRaw: '179.4¢',
    superPriceRaw: null,
    dieselPriceRaw: null,
  }));

  const statements = buildInsertStatements(rows, {
    fileUrl: 'https://regieessencequebec.ca/data/stations-20261117104000.xlsx',
    fileTimestamp: '2026-11-17T10:40:00Z',
    executedAt: '2026-11-17T11:00:00.000Z',
    rowsPerStatement: 2,
  });

  assert.equal(statements.length, 2);
  assert.match(statements[0], /^INSERT OR IGNORE INTO station_prices/);
  assert.match(statements[0], /'2026-11-17T10:40:00Z'/);
  assert.match(statements[0], /'2026-11-17T11:00:00\.000Z'/);
  assert.match(statements[0], /Station 2/);
  assert.doesNotMatch(statements[0], /Station 3/);
});



test('buildSql produces an idempotent script with optional retention', () => {
  const rows = [
    {
      rowNumber: 2,
      name: 'Station 1',
      brand: null,
      address: null,
      region: null,
      postalCode: null,
      latitude: null,
      longitude: null,
      regularPriceCents: null,
      superPriceCents: null,
      dieselPriceCents: null,
      regularPriceRaw: null,
      superPriceRaw: null,
      dieselPriceRaw: null,
    },
  ];
  const base = {
    rows,
    fileUrl: 'https://regieessencequebec.ca/data/stations-20261117104000.xlsx',
    fileTimestamp: '2026-11-17T10:40:00Z',
    executedAt: '2026-11-17T11:00:00.000Z',
  };

  const withoutRetention = buildSql({ ...base, retentionDays: 0 });
  assert.doesNotMatch(withoutRetention, /strftime/);
  assert.equal(withoutRetention.match(/DELETE FROM station_prices/g).length, 1);

  const withRetention = buildSql({ ...base, retentionDays: 14 });
  assert.match(withRetention, /file_timestamp < strftime\('%Y-%m-%dT%H:%M:%SZ', 'now', '-14 days'\)/);
  assert.match(withRetention, /INSERT OR REPLACE INTO ingest_runs/);
  assert.match(withRetention, /'ok'/);
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
