#!/usr/bin/env node
/**
 * Régie Essence Québec -> Cloudflare D1 ingest.
 *
 *   1. Reads https://regieessencequebec.ca/stations.geojson.gz metadata
 *      (the public map data) to find the newest Excel file.
 *   2. Downloads and parses that .xlsx file.
 *   3. Generates idempotent SQL and applies it to D1 through Wrangler.
 *
 * Every inserted row carries the file timestamp (from the Excel file name)
 * and the execution timestamp of this job.
 *
 * Usage:
 *   node scripts/ingest.mjs            # ingest into remote D1
 *   DRY_RUN=1 node scripts/ingest.mjs  # parse only, write SQL to ./out
 *   node scripts/ingest.mjs --force    # re-ingest an already seen file
 */

import { execFile } from 'node:child_process';
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

const COLUMNS = [
  'file_url',
  'file_timestamp',
  'executed_at',
  'row_number',
  'name',
  'brand',
  'address',
  'region',
  'postal_code',
  'latitude',
  'longitude',
  'regular_price_cents',
  'super_price_cents',
  'diesel_price_cents',
  'regular_price_raw',
  'super_price_raw',
  'diesel_price_raw',
];

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
    // Footer row, e.g. "Total de stations : 2470"
    if (/^total\s+de\s+stations\b/i.test(name)) {
      skippedRows++;
      continue;
    }

    const priceRaw = (field) => cleanText(row[map[field]]);

    rows.push({
      rowNumber: index + 1,
      name,
      brand: cleanText(row[map.brand]),
      address: cleanText(row[map.address]),
      region: cleanText(row[map.region]),
      postalCode: cleanText(row[map.postalCode]),
      latitude: toNumber(row[map.latitude]),
      longitude: toNumber(row[map.longitude]),
      regularPriceCents: parsePriceCents(row[map.regular]),
      superPriceCents: parsePriceCents(row[map.super]),
      dieselPriceCents: parsePriceCents(row[map.diesel]),
      regularPriceRaw: priceRaw('regular'),
      superPriceRaw: priceRaw('super'),
      dieselPriceRaw: priceRaw('diesel'),
    });
  }

  return { rows, sheetName, headerIndex, skippedRows };
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

export function buildInsertStatements(rows, { fileUrl, fileTimestamp, executedAt, rowsPerStatement = 100 }) {
  const statements = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const chunk = rows.slice(start, start + rowsPerStatement);
    const values = chunk
      .map(
        (row) =>
          `(${[
            sqlString(fileUrl),
            sqlString(fileTimestamp),
            sqlString(executedAt),
            sqlNumber(row.rowNumber),
            sqlString(row.name),
            sqlString(row.brand),
            sqlString(row.address),
            sqlString(row.region),
            sqlString(row.postalCode),
            sqlNumber(row.latitude),
            sqlNumber(row.longitude),
            sqlNumber(row.regularPriceCents),
            sqlNumber(row.superPriceCents),
            sqlNumber(row.dieselPriceCents),
            sqlString(row.regularPriceRaw),
            sqlString(row.superPriceRaw),
            sqlString(row.dieselPriceRaw),
          ].join(', ')})`,
      )
      .join(',\n  ');
    statements.push(`INSERT OR IGNORE INTO station_prices (${COLUMNS.join(', ')}) VALUES\n  ${values};`);
  }
  return statements;
}

/**
 * Complete, idempotent SQL script for one snapshot.
 * Deleting by file_url first makes retries after a partial failure safe.
 */
export function buildSql({ rows, fileUrl, fileTimestamp, executedAt, retentionDays = 0, rowsPerStatement = 100 }) {
  const statements = [];

  if (retentionDays > 0) {
    statements.push(
      `DELETE FROM station_prices WHERE file_timestamp < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${Math.trunc(retentionDays)} days');`,
    );
  }

  statements.push(`DELETE FROM station_prices WHERE file_url = ${sqlString(fileUrl)};`);
  statements.push(...buildInsertStatements(rows, { fileUrl, fileTimestamp, executedAt, rowsPerStatement }));
  statements.push(
    `INSERT OR REPLACE INTO ingest_runs (file_url, file_timestamp, executed_at, row_count, status, error) VALUES (${[
      sqlString(fileUrl),
      sqlString(fileTimestamp),
      sqlString(executedAt),
      sqlNumber(rows.length),
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

  const sql = buildSql({
    rows,
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
    log(JSON.stringify(rows.slice(0, 2), null, 2));
    return;
  }

  await d1ApplyFile(sql, { databaseName });
  log(`Ingested ${rows.length} rows into D1 database "${databaseName}" at ${executedAt}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(new Date().toISOString(), 'INGEST FAILED:', error?.stack ?? error);
    process.exitCode = 1;
  });
}
