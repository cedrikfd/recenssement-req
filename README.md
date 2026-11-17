# Régie Essence Québec → Cloudflare D1

Downloads the latest fuel-price Excel file published by
[regieessencequebec.ca](https://regieessencequebec.ca/), parses it, and stores one database
row per station in **Cloudflare D1**. Every row keeps the **file timestamp** (taken from the
Excel file name, e.g. `stations-20261117105000.xlsx`) and the **execution timestamp** of the
job that wrote it.

A small Cloudflare Worker exposes the data over HTTP.

## How it works

```
regieessencequebec.ca
 ├── stations.geojson.gz .......... metadata.excel_url + generated_at   (discovery)
 └── data/stations-YYYYMMDDhhmmss.xlsx ........... ~2,470 station rows  (source data)
                    │
                    ▼
      GitHub Actions (cron, every 2 hours)
      1. read the map metadata to find the newest Excel file
      2. stop if that file_url is already in `ingest_runs`
      3. download + parse the workbook (SheetJS)
      4. build idempotent SQL and apply it with `wrangler d1 execute --file`
                    │
                    ▼
              Cloudflare D1  ──►  Worker read API: /health /snapshots /latest
```

### Why the download/parse runs in GitHub Actions and not in the Worker

The free Workers plan allows **10 ms of CPU per invocation**. Parsing this workbook with
SheetJS costs about **62 ms** of CPU on a desktop-class V8 (measured on the real 197 KB file:
`XLSX.read()` ≈ 62 ms, unzip ≈ 5.6 ms, XML scan ≈ 0.6 ms), so a free-plan Worker would be
terminated with `Exceeded CPU Limit` before it could insert anything.

GitHub Actions is free for public repositories (and included for private ones) and has no such
limit, so it does the heavy work. The Worker only runs small indexed queries, which stay far
below the CPU limit. If you are on the Workers **Paid** plan (5 min CPU), you can move the
ingest into a `scheduled()` handler — the parsing functions in `scripts/ingest.mjs` are plain
JavaScript and also run on Workers.

## Quick start

```bash
npm install

# 1. Create the database and copy its id into wrangler.jsonc (database_id)
npx wrangler login
npx wrangler d1 create regie-essence

# 2. Create the tables
npm run db:schema

# 3. Ingest the current file right away
npm run ingest

# 4. Deploy the read API
npm run deploy
```

Then add the repository secrets used by the scheduled workflow
(**Settings → Secrets and variables → Actions**):

| Secret | What it needs |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | *Account → D1 → Edit* and *Account → Workers Scripts → Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id (Workers dashboard, right sidebar) |

Push the repository and enable the **Ingest Excel feed** workflow. It runs every 2 hours and
can also be started manually with *Run workflow*.

## Data model

`station_prices` — one row per station per Excel file:

| Column | Type | Notes |
| --- | --- | --- |
| `file_url` | TEXT | Source `.xlsx` URL (part of the primary key) |
| `file_timestamp` | TEXT | Timestamp encoded in the file name, ISO 8601 UTC |
| `executed_at` | TEXT | When the ingest job ran, ISO 8601 UTC |
| `row_number` | INTEGER | Worksheet row (1 = header) |
| `name`, `brand`, `address`, `region`, `postal_code` | TEXT | Station identity |
| `latitude`, `longitude` | REAL | WGS84 |
| `regular_price_cents`, `super_price_cents`, `diesel_price_cents` | REAL | Cents per litre (`179.4¢` → `179.4`), `NULL` when not sold |
| `regular_price_raw`, `super_price_raw`, `diesel_price_raw` | TEXT | Original cell text (`179.4¢`, `N/D`, …) |

`ingest_runs` — one row per ingested file (`file_url` primary key, `row_count`, `status`).
It is used to skip files that were already ingested.

`latest_station_prices` — a view with only the newest snapshot.

## API

After `npm run deploy` the Worker is available at `https://regie-essence-api.<subdomain>.workers.dev`.

```bash
curl https://regie-essence-api.<subdomain>.workers.dev/health
curl "https://regie-essence-api.<subdomain>.workers.dev/latest?limit=5"
curl "https://regie-essence-api.<subdomain>.workers.dev/latest?region=Montr%C3%A9al&limit=3"
curl "https://regie-essence-api.<subdomain>.workers.dev/snapshots?limit=5"
```

`GET /latest` returns:

```json
{
  "file_timestamp": "2026-11-17T10:50:00Z",
  "executed_at": "2026-11-17T10:53:24.055Z",
  "total": 2471,
  "limit": 1,
  "offset": 0,
  "region": null,
  "stations": [
    {
      "name": "10740373 CANADA INC",
      "brand": "Ultramar",
      "address": "700 montée Paiement, GATINEAU",
      "region": "Outaouais",
      "postal_code": "J8R 2R1",
      "latitude": 45.502467,
      "longitude": -75.676127,
      "regular_price_cents": 145.6,
      "super_price_cents": 172.9,
      "diesel_price_cents": 272.9,
      "regular_price_raw": "145.6¢",
      "super_price_raw": "172.9¢",
      "diesel_price_raw": "272.9¢",
      "file_timestamp": "2026-11-17T10:50:00Z",
      "executed_at": "2026-11-17T10:53:24.055Z"
    }
  ]
}
```

Query parameters for `/latest`: `limit` (1–500, default 50), `offset`, `region`
(exact match, e.g. `Montréal`, `Montérégie`). Responses are `Access-Control-Allow-Origin: *`
and cached for 60 seconds.

You can also query D1 directly:

```bash
npx wrangler d1 execute regie-essence --remote --command \
  "SELECT region, COUNT(*) AS stations, ROUND(AVG(regular_price_cents), 1) AS avg_regular
   FROM latest_station_prices GROUP BY region ORDER BY avg_regular DESC;"
```

## How often should this run?

The source publishes a **new file every 10 minutes**; each file contains ~2,471 rows.
The D1 free tier allows **100,000 rows written per day** (inserts *and* deletes) and
**500 MB of storage per database**, so writing every file is not possible on the free plan:

| Cron | Files/day | Rows written/day (insert + retention delete) | 14-day storage |
| --- | --- | --- | --- |
| every 10 min | 144 | ~711,000 | too much |
| hourly | 24 | ~118,600 ✗ over quota | ~200 MB |
| **every 2 h (default)** | 12 | ~59,300 ✓ | ~100 MB |
| every 3 h | 8 | ~39,500 ✓ | ~65 MB |

The workflow uses `0 */2 * * *` and `RETENTION_DAYS=14` (both in
`.github/workflows/ingest.yml`). To change the cadence, edit the cron expression and the
`RETENTION_DAYS` value together:

- shorter cadence → lower `RETENTION_DAYS` (or `0` to disable cleanup and keep everything);
- `RETENTION_DAYS=0` never deletes; storage grows by ~1.2 MB per snapshot (measured with
  indexes on the real data, ~475 bytes per row).

Unchanged files are skipped: the `file_url` is checked against `ingest_runs` before anything
is downloaded, so a manual re-run of the workflow costs nothing.

GitHub's scheduler can delay runs by a few minutes and disables scheduled workflows after 60
days without repository activity — the run always ingests *the newest file at that moment*,
so a late run simply picks a newer file.


## Local development

```bash
npm install
npm test                  # unit tests: parser, SQL builder, discovery
DRY_RUN=1 npm run ingest  # download + parse the live file, write out/*.sql, no DB writes

# try the Worker against a local D1
npm run db:schema:local
npx wrangler d1 execute regie-essence --local --file=out/ingest-<timestamp>.sql
npm run dev               # http://127.0.0.1:8787
```

`DRY_RUN=1` needs network access to regieessencequebec.ca but no Cloudflare credentials.

## Where the file URL comes from

The map is a Vue single-page app, so the Excel link is not present in the HTML. The site
publishes a `/stations.geojson.gz` document (the map data) with a `metadata` object:

```json
{
  "generated_at": "2026-11-17T10:50:00.2443021Z",
  "excel_url": "/data/stations-20261117105000.xlsx",
  "total_stations": 2470,
  "excel_size_bytes": 197512
}
```

`scripts/ingest.mjs` reads `metadata.excel_url`, resolves it against the site, and decodes the
file timestamp from the name (`stations-20261117105000.xlsx` → `2026-11-17T10:50:00Z`), falling
back to `generated_at`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Authentication error [code: 10000]` | `CLOUDFLARE_API_TOKEN` is missing or lacks *D1 Edit* for that account |
| `Could not read .../stations.geojson.gz (HTTP 404)` | The site moved its data — check the map's network requests |
| `No metadata.excel_url` | The `metadata` key changed on the site |
| `D1_ERROR: no such table: station_prices` | `npm run db:schema` was not applied to the remote database |
| Workflow logs "already been ingested" | Expected — the source file has not changed since the last run |
| Deploy fails on `database_id` | Replace the placeholder in `wrangler.jsonc` with the id from `npx wrangler d1 create` |

## Files

```
scripts/ingest.mjs              discovery + download + parse + SQL + D1 apply
worker/src/index.js             read API (/health, /snapshots, /latest)
schema.sql                      D1 tables, indexes and latest_station_prices view
wrangler.jsonc                  Worker + D1 binding
.github/workflows/ingest.yml    cron job that ingests the newest file
.github/workflows/deploy.yml    deploys the Worker on push to main
test/ingest.test.mjs            node:test unit tests
```

Data source: Régie de l'énergie du Québec, published on regieessencequebec.ca. This project
only reads public data — keep the polling cadence polite.
