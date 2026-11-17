-- Cloudflare D1 schema for the Régie Essence Québec ingestion.
-- Apply with: npm run db:schema          (remote database)
--             npm run db:schema:local    (local dev database)

-- One row per station, per source Excel file.
-- A "snapshot" is identified by file_url / file_timestamp.
CREATE TABLE IF NOT EXISTS station_prices (
  file_url             TEXT    NOT NULL,  -- e.g. https://regieessencequebec.ca/data/stations-20261117104000.xlsx
  file_timestamp       TEXT    NOT NULL,  -- timestamp encoded in the Excel file name (ISO 8601, UTC)
  executed_at          TEXT    NOT NULL,  -- when the ingestion job ran (ISO 8601, UTC)
  row_number           INTEGER NOT NULL,  -- row number inside the worksheet (1 = header)
  name                 TEXT    NOT NULL,
  brand                TEXT,
  address              TEXT,
  region               TEXT,
  postal_code          TEXT,
  latitude             REAL,
  longitude            REAL,
  regular_price_cents  REAL,              -- cents per litre, e.g. 179.4
  super_price_cents    REAL,
  diesel_price_cents   REAL,
  regular_price_raw    TEXT,              -- raw cell value, e.g. "179.4¢"
  super_price_raw      TEXT,
  diesel_price_raw     TEXT,
  PRIMARY KEY (file_url, row_number)
);

CREATE INDEX IF NOT EXISTS idx_station_prices_file_timestamp
  ON station_prices (file_timestamp);

CREATE INDEX IF NOT EXISTS idx_station_prices_region
  ON station_prices (region);

-- Covers GET /latest (filter by snapshot, optional region, ordered by name).
CREATE INDEX IF NOT EXISTS idx_station_prices_file_region_name
  ON station_prices (file_timestamp, region, name);

-- One row per ingested Excel file (used for de-duplication and health checks).
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

-- Convenience view: the most recent complete snapshot.
CREATE VIEW IF NOT EXISTS latest_station_prices AS
SELECT *
FROM station_prices
WHERE file_timestamp = (SELECT MAX(file_timestamp) FROM station_prices);
