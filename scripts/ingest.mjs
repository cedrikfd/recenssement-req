#!/usr/bin/env node
/**
 * Régie Essence Québec -> Cloudflare D1 ingest.
 *
 *   1. Reads https://regieessencequebec.ca/stations.geojson.gz metadata
 *      (the public map data) to find the newest Excel file.
 *   2. Downloads and parses that .xlsx file.
 *   3. Compares it with `stations_current` and keeps only the stations whose
 *      price (or address) actually moved.
 *   4. Generates idempotent SQL and applies it to D1 through Wrangler.
 *
 * The source publishes a file every 5 minutes, so writing every file as a full
 * snapshot is not affordable on the D1 free tier. Instead each run appends the
 * changed stations to `price_changes` (history) and upserts them into
 * `stations_current` (latest values) — typically ~10 rows instead of ~2,470.
 * Every written row carries the file timestamp from the Excel file name and
 * the execution timestamp of this job.
 *
 * Usage:
 *   node scripts/ingest.mjs            # ingest into remote D1
 *   DRY_RUN=1 node scripts/ingest.mjs  # parse only, write SQL to ./out
 *   node scripts/ingest.mjs --force    # re-ingest an already seen file
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as XLSX from 'xlsx';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const SITE_URL = (process.env.SITE_URL ?? 'https://regieessencequebec.ca').replace(/\/+$/, '');
export const USER_AGENT = 'regie-essence-ingest/1.0';

/**
 * Fields compared between the new file and `stations_current`, mapped to their
 * D1 columns. Prices are compared as numbers (the raw "179.4¢" text is stored
 * but ignored for change detection, so a formatting change is not a change).
 */
const COMPARED_FIELDS = {
  name: 'name',
  brand: 'brand',
  address: 'address',
  region: 'region',
  postalCode: 'postal_code',
  latitude: 'latitude',
  longitude: 'longitude',
  regularPriceCents: 'regular_price_cents',
  superPriceCents: 'super_price_cents',
  dieselPriceCents: 'diesel_price_cents',
};

const PRICE_FIELDS = ['regularPriceCents', 'superPriceCents', 'dieselPriceCents'];
const LOCATION_FIELDS = ['name', 'brand', 'address', 'region', 'postalCode', 'latitude', 'longitude'];

/** Columns shared by price_changes and stations_current, in schema order. */
const STATION_COLUMNS = [
  'station_key',
  'row_number',
  ...Object.values(COMPARED_FIELDS),
  'regular_price_raw',
  'super_price_raw',
  'diesel_price_raw',
];

const CHANGE_COLUMNS = [...STATION_COLUMNS, 'file_url', 'file_timestamp', 'executed_at'];

const CURRENT_COLUMNS = [...CHANGE_COLUMNS, 'first_seen_at'];

/** The subset of stations_current read back to detect changes. */
const COMPARE_COLUMNS = ['station_key', ...Object.values(COMPARED_FIELDS)];

const HEADER_ALIASES = {
  name: ['nom', 'name', 'station', 'nomstation'],
  brand: ['banniere', 'banner', 'brand'],
  address: ['adresse', 'address'],
  region: ['region', 'regions'],
  postalCode: ['codepostal', 'postalcode', 'zip', 'zipcode'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'lon', 'long'],
  regular: ['prixregulier', 'regulier', 'regular'],
  super: ['prixsuper', 'super'],
  diesel: ['prixdiesel', 'diesel'],
};

/**
 * Footer lines repeated under the last station. They used to be ingested as
 * stations, and the "Données générées le …" line carries the file timestamp,
 * so it looked like a brand new station in every single file.
 */
const FOOTER_PATTERN = /^(total\s+de\s+stations\b|donn[ée]es\s+g[ée]n[ée]r[ée]es\b|source\s*:)/i;

const FALLBACK_ORDER = [
  'name',
  'brand',
  'address',
  'region',
  'postalCode',
  'latitude',
  'longitude',
  'regular',
  'super',
  'diesel',
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

export async function fetchWithRetry(url, { attempts = 3, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      // Retry transient server errors and rate limiting, never other 4xx.
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract the timestamp encoded in the Excel file name:
 *   stations-20261117104000.xlsx -> 2026-11-17T10:40:00Z
 */
export function parseFileTimestamp(url) {
  const match = /stations-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.xlsx/i.exec(String(url));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Ask the public map for its metadata. `stations.geojson.gz` is generated
 * together with the Excel file and exposes `metadata.excel_url`.
 */
export async function discoverLatest({ fetchImpl = fetch } = {}) {
  const metadataUrl = `${SITE_URL}/stations.geojson.gz`;
  const response = await fetchWithRetry(metadataUrl, { fetchImpl });
  if (!response.ok) {
    throw new Error(`Could not read ${metadataUrl} (HTTP ${response.status})`);
  }
  const payload = await response.json();
  const metadata = payload?.metadata ?? {};
  if (!metadata.excel_url) {
    throw new Error(`No metadata.excel_url in ${metadataUrl}`);
  }

  const excelUrl = new URL(metadata.excel_url, `${SITE_URL}/`).href;
  const fileTimestamp =
    parseFileTimestamp(excelUrl) ??
    (metadata.generated_at && !Number.isNaN(Date.parse(metadata.generated_at))
      ? new Date(metadata.generated_at).toISOString()
      : null);

  if (!fileTimestamp) {
    throw new Error(`Could not determine the file timestamp for ${excelUrl}`);
  }

  return {
    excelUrl,
    fileTimestamp,
    generatedAt: metadata.generated_at ?? null,
    totalStations: metadata.total_stations ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s/g, '').replace(',', '.');
  if (text === '') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** "179.4¢" -> 179.4 ; "179,4 ¢" -> 179.4 ; "N/D" -> null */
export function parsePriceCents(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/\s/g, '')
    .replace(/[¢$]/g, '')
    .replace(/\/l/i, '')
    .replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function detectHeader(matrix) {
  let best = { index: -1, matches: 0, map: null };

  for (let index = 0; index < Math.min(matrix.length, 10); index++) {
    const row = matrix[index] ?? [];
    const map = {};
    for (let column = 0; column < row.length; column++) {
      const key = normalizeKey(row[column]);
      if (!key) continue;
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        if (!(field in map) && aliases.includes(key)) map[field] = column;
      }
    }
    const matches = Object.keys(map).length;
    if (matches > best.matches) best = { index, matches, map };
  }

  if (best.matches >= 3) return { index: best.index, map: best.map };

  const map = {};
  FALLBACK_ORDER.forEach((field, column) => {
    map[field] = column;
  });
  return { index: 0, map };
}

/**
 * Convert an .xlsx buffer into station rows.
 * Returns { rows, sheetName, headerIndex, skippedRows }.
 */
export function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, raw: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheet');
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });

  const { index: headerIndex, map } = detectHeader(matrix);
  const rows = [];
  let skippedRows = 0;

  for (let index = headerIndex + 1; index < matrix.length; index++) {
    const row = matrix[index] ?? [];
    const name = cleanText(row[map.name]);
    if (!name) {
      skippedRows++;
      continue;
    }

    const address = cleanText(row[map.address]);
    const postalCode = cleanText(row[map.postalCode]);
    const regularPriceCents = parsePriceCents(row[map.regular]);
    const superPriceCents = parsePriceCents(row[map.super]);
    const dieselPriceCents = parsePriceCents(row[map.diesel]);

    // Footer/metadata lines ("Total de stations : 2470", "Données générées
    // le : …", "Source : …") carry no station data.
    if (FOOTER_PATTERN.test(name)) {
      skippedRows++;
      continue;
    }
    if (
      !address &&
      !postalCode &&
      regularPriceCents === null &&
      superPriceCents === null &&
      dieselPriceCents === null
    ) {
      skippedRows++;
      continue;
    }

    const priceRaw = (field) => cleanText(row[map[field]]);

    rows.push({
      rowNumber: index + 1,
      name,
      brand: cleanText(row[map.brand]),
      address,
      region: cleanText(row[map.region]),
      postalCode,
      latitude: toNumber(row[map.latitude]),
      longitude: toNumber(row[map.longitude]),
      regularPriceCents,
      superPriceCents,
      dieselPriceCents,
      regularPriceRaw: priceRaw('regular'),
      superPriceRaw: priceRaw('super'),
      dieselPriceRaw: priceRaw('diesel'),
    });
  }

  return { rows, sheetName, headerIndex, skippedRows };
}

/* ------------------------------------------------------------------ */
/* Change detection                                                    */
/* ------------------------------------------------------------------ */

/**
 * Stable identity of a station across files. The source workbook has no
 * station id and rows are re-sorted, so the key is a hash of the normalized
 * name + address: accents, case, punctuation and spacing are irrelevant
 * ("Dépanneur  O'Neil" and "depanneur o neil" hash the same).
 */
export function stationKey(row) {
  const text = `${row.name ?? ''}|${row.address ?? ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, '')
    .replace(/\|+/g, '|');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function sameValue(next, previous) {
  const nextEmpty = next === null || next === undefined;
  const previousEmpty = previous === null || previous === undefined;
  if (nextEmpty || previousEmpty) return nextEmpty && previousEmpty;
  return next === previous;
}

/**
 * Compare a freshly parsed file with the current state of the database and
 * return only the rows that must be written.
 *
 * A row is kept when the station is new, when any price moved, or when a
 * location field changed. Everything else is left untouched in D1.
 *
 * Stations that disappeared from the file are returned in `removed`: they are
 * deleted from `stations_current` (their history in `price_changes` stays), so
 * `GET /latest` keeps mirroring the newest file. Because the key is derived
 * from name + address, a corrected address shows up as one removal plus one
 * addition — which is also the right outcome: no duplicate, no orphan.
 */
export function planIngest(rows, currentRows = []) {
  const current = new Map();
  for (const row of currentRows) {
    const key = row.station_key ?? row.stationKey;
    if (key) current.set(key, row);
  }

  const changed = [];
  const stats = { added: 0, priceChanged: 0, locationChanged: 0, unchanged: 0, removed: 0, duplicates: 0 };
  const seen = new Set();

  for (const row of rows) {
    const key = stationKey(row);
    if (seen.has(key)) stats.duplicates++;
    seen.add(key);

    const previous = current.get(key);
    if (!previous) {
      stats.added++;
      changed.push({ ...row, stationKey: key });
      continue;
    }

    const priceChanged = PRICE_FIELDS.some((field) => !sameValue(row[field], previous[COMPARED_FIELDS[field]]));
    const locationChanged = LOCATION_FIELDS.some(
      (field) => !sameValue(row[field], previous[COMPARED_FIELDS[field]]),
    );

    if (priceChanged) stats.priceChanged++;
    else if (locationChanged) stats.locationChanged++;
    else {
      stats.unchanged++;
      continue;
    }

    changed.push({ ...row, stationKey: key });
  }

  const removed = [...current.keys()].filter((key) => !seen.has(key));
  stats.removed = removed.length;

  return { changed, removed, stats };
}

/* ------------------------------------------------------------------ */
/* SQL generation                                                      */
/* ------------------------------------------------------------------ */

export function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function sqlNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'NULL';
}

const ROW_EXPRESSION = {
  station_key: (row) => sqlString(row.stationKey),
  row_number: (row) => sqlNumber(row.rowNumber),
  name: (row) => sqlString(row.name),
  brand: (row) => sqlString(row.brand),
  address: (row) => sqlString(row.address),
  region: (row) => sqlString(row.region),
  postal_code: (row) => sqlString(row.postalCode),
  latitude: (row) => sqlNumber(row.latitude),
  longitude: (row) => sqlNumber(row.longitude),
  regular_price_cents: (row) => sqlNumber(row.regularPriceCents),
  super_price_cents: (row) => sqlNumber(row.superPriceCents),
  diesel_price_cents: (row) => sqlNumber(row.dieselPriceCents),
  regular_price_raw: (row) => sqlString(row.regularPriceRaw),
  super_price_raw: (row) => sqlString(row.superPriceRaw),
  diesel_price_raw: (row) => sqlString(row.dieselPriceRaw),
};

function columnExpression(column, row, { fileUrl, fileTimestamp, executedAt }) {
  switch (column) {
    case 'file_url':
      return sqlString(fileUrl);
    case 'file_timestamp':
      return sqlString(fileTimestamp);
    case 'executed_at':
    case 'first_seen_at':
      return sqlString(executedAt);
    default: {
      const expression = ROW_EXPRESSION[column];
      if (!expression) throw new Error(`Unknown column: ${column}`);
      return expression(row);
    }
  }
}

function chunk(rows, size) {
  const chunks = [];
  for (let start = 0; start < rows.length; start += size) chunks.push(rows.slice(start, start + size));
  return chunks;
}

function valuesSql(columns, rows, meta) {
  return rows
    .map((row) => `  (${columns.map((column) => columnExpression(column, row, meta)).join(', ')})`)
    .join(',\n');
}

/** History: one row per changed station, per file timestamp. */
export function buildChangeInserts(changed, meta, rowsPerStatement = 100) {
  return chunk(changed, rowsPerStatement).map(
    (rows) =>
      `INSERT OR IGNORE INTO price_changes (${CHANGE_COLUMNS.join(', ')})\nVALUES\n${valuesSql(CHANGE_COLUMNS, rows, meta)};`,
  );
}

/** Latest values: upsert, preserving the original first_seen_at. */
export function buildCurrentUpserts(changed, meta, rowsPerStatement = 100) {
  const updates = CURRENT_COLUMNS.filter((column) => column !== 'station_key' && column !== 'first_seen_at')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  return chunk(changed, rowsPerStatement).map(
    (rows) =>
      `INSERT INTO stations_current (${CURRENT_COLUMNS.join(', ')})\nVALUES\n${valuesSql(CURRENT_COLUMNS, rows, meta)}\nON CONFLICT(station_key) DO UPDATE SET ${updates};`,
  );
}

/**
 * Complete, idempotent SQL script for one file.
 * `price_changes` is UNIQUE(station_key, file_timestamp) and `stations_current`
 * is upserted, so retrying after a partial failure cannot duplicate anything.
 * An unchanged file still records its ingest_runs row (that is what makes the
 * "already ingested" check work) but writes no station rows at all.
 */
export function buildSql({
  changed,
  removed = [],
  rowCount = changed.length,
  fileUrl,
  fileTimestamp,
  executedAt,
  retentionDays = 0,
  rowsPerStatement = 100,
}) {
  const meta = { fileUrl, fileTimestamp, executedAt };
  const statements = [];
  const days = Math.trunc(retentionDays);

  if (days > 0) {
    statements.push(
      `DELETE FROM price_changes WHERE file_timestamp < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${days} days');`,
    );
    statements.push(
      `DELETE FROM ingest_runs WHERE file_timestamp < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${days} days');`,
    );
  }

  // Stations that vanished from the newest file (closed or renamed): drop the
  // current row, keep the history.
  for (const batch of chunk(removed, rowsPerStatement)) {
    statements.push(
      `DELETE FROM stations_current WHERE station_key IN (${batch.map((key) => sqlString(key)).join(', ')});`,
    );
  }

  statements.push(...buildCurrentUpserts(changed, meta, rowsPerStatement));
  statements.push(...buildChangeInserts(changed, meta, rowsPerStatement));
  statements.push(
    `INSERT OR REPLACE INTO ingest_runs (file_url, file_timestamp, executed_at, row_count, status, error) VALUES (${[
      sqlString(fileUrl),
      sqlString(fileTimestamp),
      sqlString(executedAt),
      sqlNumber(rowCount),
      sqlString('ok'),
      'NULL',
    ].join(', ')});`,
  );

  return `${statements.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* D1 (through Wrangler)                                               */
/* ------------------------------------------------------------------ */

function wranglerBin() {
  const local = join(ROOT, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? local : 'npx';
}

async function runWrangler(args, { timeout = 600_000 } = {}) {
  const bin = wranglerBin();
  const finalArgs = bin === 'npx' ? ['--no-install', 'wrangler', ...args] : args;
  const { stdout, stderr } = await execFileAsync(bin, finalArgs, {
    cwd: ROOT,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  if (stderr && /error/i.test(stderr)) log('wrangler stderr:', stderr.trim().slice(0, 2000));
  return stdout;
}

export async function d1Query(sql, { databaseName }) {
  const stdout = await runWrangler(['d1', 'execute', databaseName, '--remote', '--json', '--command', sql]);
  const start = stdout.indexOf('[');
  const parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  return batches.flatMap((batch) => batch?.results ?? []);
}

/** Latest known values of every station, used for change detection. */
export async function fetchCurrentStations({ databaseName }) {
  return d1Query(`SELECT ${COMPARE_COLUMNS.join(', ')} FROM stations_current;`, { databaseName });
}

async function d1ApplyFile(sql, { databaseName }) {
  const dir = await mkdtemp(join(tmpdir(), 'regie-essence-'));
  const file = join(dir, 'ingest.sql');
  try {
    await writeFile(file, sql, 'utf8');
    await runWrangler(['d1', 'execute', databaseName, '--remote', '--file', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function looksLikeZip(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const databaseName = process.env.D1_DATABASE_NAME ?? 'regie-essence';
  const retentionDays = Number(process.env.RETENTION_DAYS ?? 14);
  const rowsPerStatement = Number(process.env.ROWS_PER_STATEMENT ?? 100);
  const executedAt = new Date().toISOString();

  const latest = await discoverLatest();
  log(`Latest file: ${latest.excelUrl}`);
  log(`File timestamp: ${latest.fileTimestamp} (generated_at: ${latest.generatedAt ?? 'n/a'})`);

  if (!dryRun && !force) {
    const existing = await d1Query(
      `SELECT file_url FROM ingest_runs WHERE file_url = ${sqlString(latest.excelUrl)} AND status = 'ok' LIMIT 1;`,
      { databaseName },
    );
    if (existing.length > 0) {
      log('This file has already been ingested. Nothing to do (use --force to re-ingest).');
      return;
    }
  }

  const response = await fetchWithRetry(latest.excelUrl, { timeoutMs: 120_000 });
  if (!response.ok) throw new Error(`Could not download ${latest.excelUrl} (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  if (!looksLikeZip(buffer)) {
    throw new Error(`Downloaded file is not an .xlsx archive (${buffer.byteLength} bytes)`);
  }
  log(`Downloaded ${buffer.byteLength} bytes`);

  const { rows, sheetName, headerIndex, skippedRows } = parseWorkbook(buffer);
  if (rows.length === 0) throw new Error('No station rows were parsed from the workbook');
  log(`Parsed ${rows.length} rows from "${sheetName}" (header row ${headerIndex + 1}, skipped ${skippedRows})`);

  // Only the stations whose price moved are written to D1.
  if (dryRun) log('DRY RUN: stations_current is not read, every parsed row is treated as changed');
  const currentRows = dryRun ? [] : await fetchCurrentStations({ databaseName });
  const plan = planIngest(rows, currentRows);
  log(
    `Change plan: ${plan.changed.length} row(s) to write, ${plan.stats.removed} to remove — ` +
      `${plan.stats.added} new, ${plan.stats.priceChanged} price change(s), ` +
      `${plan.stats.locationChanged} location change(s), ${plan.stats.unchanged} unchanged`,
  );
  if (plan.stats.duplicates > 0) {
    log(`Warning: ${plan.stats.duplicates} duplicate station key(s) in the workbook (one row per key is kept)`);
  }

  const sql = buildSql({
    changed: plan.changed,
    removed: plan.removed,
    rowCount: rows.length,
    fileUrl: latest.excelUrl,
    fileTimestamp: latest.fileTimestamp,
    executedAt,
    retentionDays,
    rowsPerStatement,
  });
  log(`Generated ${(sql.length / 1024).toFixed(1)} KiB of SQL (retention: ${retentionDays} days)`);

  if (dryRun) {
    const dir = join(ROOT, 'out');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `ingest-${latest.fileTimestamp.replace(/:/g, '')}.sql`);
    await writeFile(file, sql, 'utf8');
    log(`DRY RUN: SQL written to ${file}`);
    return;
  }

  await d1ApplyFile(sql, { databaseName });
  log(
    `Wrote ${plan.changed.length} of ${rows.length} station rows into D1 database "${databaseName}" at ${executedAt}`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(new Date().toISOString(), 'INGEST FAILED:', error?.stack ?? error);
    process.exitCode = 1;
  });
}
