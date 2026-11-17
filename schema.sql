-- Cloudflare D1 schema for the Régie Essence Québec ingestion.
-- Apply with: npm run db:schema          (remote database)
--             npm run db:schema:local    (local dev database)
--
-- The source publishes a new Excel file every 5 minutes and each file holds
-- ~2,470 stations, so storing a full snapshot per file costs ~4,940 written
-- rows per run (inserts + retention deletes). The free tier allows 100,000
-- written rows/day, which a 5-minute snapshot cadence would blow through
-- 14 times over. Prices are therefore stored as a change log instead:
--
--   stations_current  one row per station, always the latest known values
--   price_changes     one row per station, per moment its price changed
--   ingest_runs       one row per ingested Excel file (de-duplication, health)
--
-- A run only writes the stations that actually moved (typically 5-40 rows,
-- measured on consecutive real files: 8 price changes per 5 minutes).

-- One row per station: the values served by GET /latest.
CREATE TABLE IF NOT EXISTS stations_current (
  station_key          TEXT PRIMARY KEY,   -- hash of the normalized name + address
  row_number           INTEGER NOT NULL,   -- position in the newest worksheet (1 = header)
  name                 TEXT    NOT NULL,
  brand                TEXT,
  address              TEXT,
  region               TEXT,
  postal_code          TEXT,
  latitude             REAL,
  longitude            REAL,
  regular_price_cents  REAL,               -- cents per litre, e.g. 179.4
  super_price_cents    REAL,
  diesel_price_cents   REAL,
  regular_price_raw    TEXT,               -- raw cell value, e.g. "179.4¢"
  super_price_raw      TEXT,
  diesel_price_raw     TEXT,
  file_url             TEXT    NOT NULL,   -- file that produced these values
  file_timestamp       TEXT    NOT NULL,   -- when this station's price last changed
  executed_at          TEXT    NOT NULL,   -- when that change was ingested
  first_seen_at        TEXT    NOT NULL    -- first ingest that saw this station
);

-- Covers GET /latest (optional region filter, ordered by name).
CREATE INDEX IF NOT EXISTS idx_stations_current_region_name
  ON stations_current (region, name);

CREATE INDEX IF NOT EXISTS idx_stations_current_file_timestamp
  ON stations_current (file_timestamp DESC);

-- One row per station, per moment its price (or location) changed.
CREATE TABLE IF NOT EXISTS price_changes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  station_key          TEXT    NOT NULL,
  row_number           INTEGER NOT NULL,
  name                 TEXT    NOT NULL,
  brand                TEXT,
  address              TEXT,
  region               TEXT,
  postal_code          TEXT,
  latitude             REAL,
  longitude            REAL,
  regular_price_cents  REAL,
  super_price_cents    REAL,
  diesel_price_cents   REAL,
  regular_price_raw    TEXT,
  super_price_raw      TEXT,
  diesel_price_raw     TEXT,
  file_url             TEXT    NOT NULL,
  file_timestamp       TEXT    NOT NULL,
  executed_at          TEXT    NOT NULL,
  -- Re-running the same file cannot duplicate a station's history.
  UNIQUE (station_key, file_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_price_changes_station_key
  ON price_changes (station_key, id DESC);

-- Covers GET /changes?since=… and the retention delete.
CREATE INDEX IF NOT EXISTS idx_price_changes_file_timestamp
  ON price_changes (file_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_price_changes_region_time
  ON price_changes (region, file_timestamp DESC);

-- One row per ingested Excel file (used for de-duplication and health checks).
-- row_count is the number of rows in the file; the number of rows actually
-- written for that file is COUNT(*) in price_changes for the same timestamp.
CREATE TABLE IF NOT EXISTS ingest_runs (
  file_url        TEXT PRIMARY KEY,
  file_timestamp  TEXT NOT NULL,
  executed_at     TEXT NOT NULL,
  row_count       INTEGER NOT NULL,
  status          TEXT NOT NULL,   -- 'ok' | 'error'
  error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingest_runs_executed_at
  ON ingest_runs (executed_at DESC);

-- Kept for compatibility with the previous snapshot-based schema: the current
-- values of every station. Re-created on every schema run so the definition
-- can evolve.
DROP VIEW IF EXISTS latest_station_prices;
CREATE VIEW latest_station_prices AS
SELECT * FROM stations_current;

-- The old snapshot table is no longer written. It can be dropped once its
-- historical snapshots are no longer needed:
--   npx wrangler d1 execute regie-essence --remote --command "DROP TABLE IF EXISTS station_prices"
