# Régie Essence Québec → Cloudflare D1

Downloads the latest fuel-price Excel file published by
[regieessencequebec.ca](https://regieessencequebec.ca/), parses it, and keeps **Cloudflare D1**
in sync with it — the database follows the source within 5 minutes.

Prices are stored as a **change log**: `stations_current` always holds the latest known price of
every station, and `price_changes` appends one row per station per moment its price actually
moved. Every row keeps the **file timestamp** (taken from the Excel file name, e.g.
`stations-20261117105000.xlsx`) and the **execution timestamp** of the job that wrote it.

A small Cloudflare Worker exposes the data over HTTP.

## How it works

```
regieessencequebec.ca
 ├── stations.geojson.gz .......... metadata.excel_url + generated_at   (discovery)
 └── data/stations-YYYYMMDDhhmmss.xlsx ........... ~2,470 station rows  (source data)
                    │
                    ▼
     GitHub Actions (cron, every 5 minutes)
     1. read the map metadata to find the newest Excel file
     2. apply `schema.sql` (idempotent `CREATE ... IF NOT EXISTS`)
     3. stop if that file_url is already in `ingest_runs`
     4. download + parse the workbook (SheetJS)
     5. compare it with `stations_current` and keep only the stations whose
        price, address or coordinates moved           ← ~8 rows instead of 2,469
     6. build idempotent SQL and apply it with `wrangler d1 execute --file`
                    │
                    ▼
   Cloudflare D1  ──►  Worker read API: /health /snapshots /latest /changes
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

# 3. Ingest the current file right away (first run seeds every station)
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

Push the repository and enable the **Ingest Excel feed** workflow. It runs every 5 minutes, two
minutes after each publisher tick (`2-57/5 * * * *`), and can also be started manually with
*Run workflow* — do that once right after the first push, because GitHub can take a while to
register a new schedule (see *Cadence and quotas → The scheduler is best-effort*).


## Data model

`stations_current` — one row per station, the latest known values (what `/latest` serves):

| Column | Type | Notes |
| --- | --- | --- |
| `station_key` | TEXT | Primary key: hash of the normalized name + address |
| `row_number` | INTEGER | Worksheet row in the newest file (1 = header) |
| `name`, `brand`, `address`, `region`, `postal_code` | TEXT | Station identity |
| `latitude`, `longitude` | REAL | WGS84 |
| `regular_price_cents`, `super_price_cents`, `diesel_price_cents` | REAL | Cents per litre (`179.4¢` → `179.4`), `NULL` when not sold |
| `regular_price_raw`, `super_price_raw`, `diesel_price_raw` | TEXT | Original cell text (`179.4¢`, `N/D`, …) |
| `file_url`, `file_timestamp` | TEXT | File that produced these values, i.e. **when this station's price last changed** |
| `executed_at` | TEXT | When that change was ingested (ISO 8601 UTC) |
| `first_seen_at` | TEXT | First ingest that saw this station (never overwritten) |

`price_changes` — the history: one row per station per change, `UNIQUE(station_key, file_timestamp)`
so re-running a file cannot duplicate anything. Same columns plus an auto-increment `id`.

`ingest_runs` — one row per ingested file (`file_url` primary key, `row_count` = rows in the file,
`status`). It is used to skip files that were already ingested.

`latest_station_prices` — view over `stations_current`, kept for the previous schema.

### Station identity, updates and deletions

The workbook has no station id, so `station_key` is
`sha256(normalize(name) + '|' + normalize(address))` truncated to 16 hex characters; accents, case
and punctuation do not matter. Consequences:

- correcting an address changes the key, which the ingester sees as one removal plus one addition —
  no duplicate and no orphan row;
- a station that disappears from the newest file is deleted from `stations_current` (its history
  stays in `price_changes`), so `/latest` keeps mirroring the file;
- the two footer lines of the worksheet (`Données générées le …`, `Source : …`) are no longer
  ingested as stations. The first one contains the file timestamp, so it used to look like a brand
  new station in every single file.

Migrating an existing database: `schema.sql` creates the new tables next to the old snapshot table,
which is no longer written. Drop it once its history is no longer needed:

```bash
npx wrangler d1 execute regie-essence --remote --command "DROP TABLE IF EXISTS station_prices"
```

## API

After `npm run deploy` the Worker is available at `https://regie-essence-api.<subdomain>.workers.dev`.

```bash
curl https://regie-essence-api.<subdomain>.workers.dev/health
curl "https://regie-essence-api.<subdomain>.workers.dev/latest?limit=5"
curl "https://regie-essence-api.<subdomain>.workers.dev/latest?region=Montr%C3%A9al&limit=3"
curl "https://regie-essence-api.<subdomain>.workers.dev/changes?since=2026-11-17T11:20:00Z&limit=20"
curl "https://regie-essence-api.<subdomain>.workers.dev/snapshots?limit=5"
```

`GET /latest` returns every station with its latest known prices:

```json
{
  "last_change_at": "2026-11-17T11:25:00Z",
  "total": 2469,
  "limit": 1,
  "offset": 0,
  "region": null,
  "stations": [
    {
      "station_key": "3f8a1c0d9b7e5a42",
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
      "executed_at": "2026-11-17T10:53:24.055Z",
      "first_seen_at": "2026-11-17T09:12:31.004Z"
    }
  ]
}
```

`GET /changes` returns the change log, newest first:

```json
{
  "since": "2026-11-17T11:20:00Z",
  "region": null,
  "total": 8,
  "limit": 100,
  "offset": 0,
  "changes": [
    {
      "station_key": "…",
      "name": "Dépanneur du Quartier",
      "regular_price_cents": 160.9,
      "file_url": "https://regieessencequebec.ca/data/stations-20261117112500.xlsx",
      "file_timestamp": "2026-11-17T11:25:00Z",
      "executed_at": "2026-11-17T11:26:10.000Z"
    }
  ]
}
```

Query parameters: `/latest` → `limit` (1–500, default 50), `offset`, `region` (exact match, e.g.
`Montréal`, `Montérégie`). `/changes` → `since` (ISO 8601, inclusive), `region`, `limit` (1–500,
default 100), `offset`. `/snapshots` → `limit` (1–100). Responses are `Access-Control-Allow-Origin: *`
and cached for 60 seconds.

`GET /health` reports `station_count`, `change_count`, `ingested_files`, `last_change_at` (the
newest price change) and `last_ingest_at`.

You can also query D1 directly:

```bash
npx wrangler d1 execute regie-essence --remote --command \
  "SELECT region, COUNT(*) AS stations, ROUND(AVG(regular_price_cents), 1) AS avg_regular
   FROM latest_station_prices GROUP BY region ORDER BY avg_regular DESC;"

# what moved in the last hour
npx wrangler d1 execute regie-essence --remote --command \
  "SELECT name, regular_price_cents, file_timestamp FROM price_changes
   WHERE file_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour')
   ORDER BY file_timestamp DESC;"
```

## Cadence and quotas

The source publishes a **new file every 5 minutes** (verified: `stations-20261117110000` …
`…112500` all return 200, `…113000` was still 404, and `metadata.excel_url` always points at the
newest one). Each file holds ~2,470 stations, but **consecutive files differ by only a handful of
rows** — measured on the real `…112000` and `…112500` files: 8 price changes, 2,461 unchanged, 0
added or removed once the worksheet footer is skipped.

That is what makes 5-minute resolution affordable. The D1 free tier allows **100,000 rows written
per day** (inserts *and* deletes):

| Strategy | Rows written/day | 14-day storage |
| --- | --- | --- |
| full snapshot of every file, every 5 min (previous data model) | ~1,420,000 ✗ | — |
| full snapshot every 2 h (previous default) | ~59,300 | ~100 MB |
| **change log, every 5 min (current)** | **~8,600** | **~18 MB** |
| change log, every 5 min, `RETENTION_DAYS=0` | ~2,600 | grows ~1.2 MB/day |

A run costs ~30 written rows: ~9 upserts into `stations_current`, ~9 inserts into `price_changes`,
~9 retention deletes and the `ingest_runs` row. `RETENTION_DAYS=14` (in
`.github/workflows/ingest.yml`) only prunes the history — `stations_current` always keeps the last
known price of every station, even if it has not moved in months.

### Actions minutes

On a **public** repository scheduled runs do not consume Actions minutes, so 288 runs/day
(~96 min/day of runner time) cost nothing. It only matters if this is forked into a **private**
repository: 288 runs/day at ~20 s ≈ **2,900 min/month**, against 2,000 included with GitHub Free
(3,000 with Pro). In that case, upgrade or slow the cron down (e.g. `*/15 * * * *` ≈ 960 min/month)
if 15-minute resolution is enough.

The workflow already keeps scheduled runs as short as possible: unit tests run on pushes and manual
runs only (`if: github.event_name != 'schedule'`), and dependencies are installed from the committed
`package-lock.json` with the npm cache.

Unchanged files are skipped: the `file_url` is checked against `ingest_runs` before anything is
downloaded, so a manual re-run of the workflow costs nothing.

### The scheduler is best-effort

GitHub's scheduler is not a real-time clock: runs can be delayed by several minutes, are slower
right after the top of the hour (that is why the cron is offset to `:02`), and **a newly added
`*/5` schedule can take a surprisingly long time to start at all** — the first scheduled run may be
tens of minutes late even though the workflow shows `state: active` and the file is valid. If no
scheduled run appears:

1. start one manually (*Run workflow*) to prove the pipeline itself works;
2. check the cadence with `curl -s …/health` — `last_ingest_at` must advance every 5 minutes;
3. re-register the schedule by opening *Actions → Ingest Excel feed → ⋯ → Disable workflow*, then
   *Enable workflow* (or push any commit touching `ingest.yml`).

Scheduled workflows are also disabled after 60 days without repository activity. A late run is
harmless: the run always ingests *the newest file at that moment*, and the `ingest_runs` check skips
files that were already stored. Cron expressions are UTC, so the schedule does not follow daylight
saving time.

## Local development

```bash
npm install
npm test                  # unit tests: parser, change detection, SQL builder, discovery
DRY_RUN=1 npm run ingest  # download + parse the live file, write out/*.sql, no DB reads or writes

# try the Worker against a local D1
npm run db:schema:local
npx wrangler d1 execute regie-essence --local --file=out/ingest-<timestamp>.sql
npm run dev               # http://127.0.0.1:8787
```

`DRY_RUN=1` needs network access to regieessencequebec.ca but no Cloudflare credentials. A dry run
does not read `stations_current`, so it treats every parsed row as changed and writes the full seed
script (~1.5 MB of SQL) instead of a delta.

`npm test` runs `node --test` with no arguments, so Node discovers `test/**/*.test.mjs` itself.
Passing the bare directory (`node --test test/`) breaks on Node 24: positional arguments are
resolved as file/glob paths, so a directory is reported as `Cannot find module .../test`.

## Where the file URL comes from

The map is a Vue single-page app, so the Excel link is not present in the HTML. The site publishes a
`/stations.geojson.gz` document (the map data) with a `metadata` object:

```json
{
  "generated_at": "2026-11-17T11:25:00.2443021Z",
  "excel_url": "/data/stations-20261117112500.xlsx",
  "total_stations": 2470,
  "excel_size_bytes": 197512
}
```

`scripts/ingest.mjs` reads `metadata.excel_url`, resolves it against the site, and decodes the file
timestamp from the name (`stations-20261117112500.xlsx` → `2026-11-17T11:25:00Z`), falling back to
`generated_at`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Authentication error [code: 10000]` | `CLOUDFLARE_API_TOKEN` is missing or lacks *D1 Edit* for that account |
| `Could not read .../stations.geojson.gz (HTTP 404)` | The site moved its data — check the map's network requests |
| `No metadata.excel_url` | The `metadata` key changed on the site |
| `D1_ERROR: no such table: stations_current` | The ingest workflow applies `schema.sql` on every run; for a manual local run use `npm run db:schema` |
| Log says `2469 row(s) to write` | Expected once: `stations_current` was empty, so the run seeds every station |
| Workflow logs "already been ingested" | Expected — the source file has not changed since the last run |
| Deploy fails on `database_id` | Replace the placeholder in `wrangler.jsonc` with the id from `npx wrangler d1 create` |

## Files

```
scripts/ingest.mjs              discovery + download + parse + change detection + SQL + D1 apply
worker/src/index.js             read API (/health, /snapshots, /latest, /changes)
schema.sql                      D1 tables, indexes and the latest_station_prices view
wrangler.jsonc                  Worker + D1 binding
.github/workflows/ingest.yml    cron job that ingests the newest file every 5 minutes
.github/workflows/deploy.yml    deploys the Worker on push to main
test/ingest.test.mjs            node:test unit tests
```

Data source: Régie de l'énergie du Québec, published on regieessencequebec.ca. This project only
reads public data — keep the polling cadence polite.

