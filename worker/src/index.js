/**
 * Read API for the Régie Essence Québec price data stored in D1.
 *
 * The scheduled download/parse job runs in GitHub Actions (see
 * .github/workflows/ingest.yml) because a free-plan Worker only gets
 * 10 ms of CPU per invocation, which is not enough to parse the workbook.
 * This Worker only runs small, indexed reads.
 *
 * Data model (see schema.sql): `stations_current` holds one row per station
 * with its latest known prices, and `price_changes` keeps one row per station
 * per moment its price moved. A station's `file_timestamp` is therefore the
 * moment its price last changed, not the moment the newest file came out.
 */

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(data, status = 200, cacheSeconds = 60) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${cacheSeconds}`,
      ...CORS_HEADERS,
    },
  });
}

function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Normalize a `since` parameter to the timestamp format stored in D1. */
function normalizeSince(value) {
  const text = (value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const STATION_COLUMNS = `
  station_key,
  name,
  brand,
  address,
  region,
  postal_code,
  latitude,
  longitude,
  regular_price_cents,
  super_price_cents,
  diesel_price_cents,
  regular_price_raw,
  super_price_raw,
  diesel_price_raw,
  file_timestamp,
  executed_at,
  first_seen_at
`;

const CHANGE_COLUMNS = `
  station_key,
  name,
  brand,
  address,
  region,
  postal_code,
  latitude,
  longitude,
  regular_price_cents,
  super_price_cents,
  diesel_price_cents,
  regular_price_raw,
  super_price_raw,
  diesel_price_raw,
  file_url,
  file_timestamp,
  executed_at
`;

async function getHealth(env) {
  const [totals, latestRun] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM stations_current) AS station_count,
         (SELECT COUNT(*) FROM price_changes) AS change_count,
         (SELECT COUNT(*) FROM ingest_runs WHERE status = 'ok') AS ingested_files,
         (SELECT MAX(file_timestamp) FROM stations_current) AS last_change_at,
         (SELECT MAX(executed_at) FROM ingest_runs) AS last_ingest_at`,
    ).first(),
    env.DB.prepare(
      `SELECT file_url, file_timestamp, executed_at, row_count, status
       FROM ingest_runs
       ORDER BY file_timestamp DESC
       LIMIT 1`,
    ).first(),
  ]);

  const stationCount = totals?.station_count ?? 0;

  return {
    ok: true,
    station_count: stationCount,
    // Kept so existing clients of the snapshot schema keep working.
    total_rows: stationCount,
    change_count: totals?.change_count ?? 0,
    ingested_files: totals?.ingested_files ?? 0,
    last_change_at: totals?.last_change_at ?? null,
    last_ingest_at: totals?.last_ingest_at ?? null,
    latest_run: latestRun ?? null,
  };
}

async function getSnapshots(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT r.file_url, r.file_timestamp, r.executed_at, r.row_count, r.status, r.error,
            (SELECT COUNT(*) FROM price_changes c WHERE c.file_timestamp = r.file_timestamp) AS changed_rows
     FROM ingest_runs r
     ORDER BY r.file_timestamp DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  return { count: results.length, snapshots: results };
}


async function getLatest(env, { limit, offset, region }) {
  const filters = [];
  const params = [];
  if (region) {
    filters.push('region = ?');
    params.push(region);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const [countRow, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              (SELECT MAX(file_timestamp) FROM stations_current) AS last_change_at
       FROM stations_current ${where}`,
    )
      .bind(...params)
      .first(),
    env.DB.prepare(
      `SELECT ${STATION_COLUMNS}
       FROM stations_current
       ${where}
       ORDER BY name
       LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all(),
  ]);

  return {
    last_change_at: countRow?.last_change_at ?? null,
    total: countRow?.total ?? 0,
    limit,
    offset,
    region: region ?? null,
    stations: rows.results,
  };
}

async function getChanges(env, { limit, offset, since, region }) {
  const filters = [];
  const params = [];
  if (since) {
    filters.push('file_timestamp >= ?');
    params.push(since);
  }
  if (region) {
    filters.push('region = ?');
    params.push(region);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM price_changes ${where}`)
      .bind(...params)
      .first(),
    env.DB.prepare(
      `SELECT ${CHANGE_COLUMNS}
       FROM price_changes
       ${where}
       ORDER BY file_timestamp DESC, name
       LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all(),
  ]);

  return {
    since: since ?? null,
    region: region ?? null,
    total: countRow?.total ?? 0,
    limit,
    offset,
    changes: rows.results,
  };
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method not allowed' }, 405, 0);
    }

    try {
      switch (url.pathname.replace(/\/+$/, '') || '/') {
        case '/':
          return json({
            name: 'Régie Essence Québec API',
            source: 'https://regieessencequebec.ca/',
            endpoints: {
              '/health': 'Row counts, the newest price change and the most recent ingest run',
              '/snapshots?limit=20': 'Ingest history (one entry per Excel file, with how many rows it changed)',
              '/latest?limit=50&offset=0&region=Abitibi-Témiscamingue': 'Every station with its latest known prices',
              '/changes?since=2026-11-17T00:00:00Z&limit=100': 'Price changes since a timestamp, newest first',
            },
          });

        case '/health':
          return json(await getHealth(env));

        case '/snapshots':
          return json(await getSnapshots(env, clampInt(url.searchParams.get('limit'), { min: 1, max: 100, fallback: 20 })));

        case '/latest': {
          const limit = clampInt(url.searchParams.get('limit'), { min: 1, max: 500, fallback: 50 });
          const offset = clampInt(url.searchParams.get('offset'), { min: 0, max: 1_000_000, fallback: 0 });
          const region = (url.searchParams.get('region') ?? '').slice(0, 100).trim() || null;
          return json(await getLatest(env, { limit, offset, region }));
        }

        case '/changes': {
          const limit = clampInt(url.searchParams.get('limit'), { min: 1, max: 500, fallback: 100 });
          const offset = clampInt(url.searchParams.get('offset'), { min: 0, max: 1_000_000, fallback: 0 });
          const region = (url.searchParams.get('region') ?? '').slice(0, 100).trim() || null;
          const since = normalizeSince(url.searchParams.get('since'));
          return json(await getChanges(env, { limit, offset, since, region }));
        }

        default:
          return json({ error: 'Not found' }, 404, 0);
      }
    } catch (error) {
      console.error('Request failed', error);
      return json({ error: 'Internal error', message: String(error?.message ?? error) }, 500, 0);
    }
  },
};
