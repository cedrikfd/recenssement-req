/**
 * Read API for the Régie Essence Québec price data stored in D1.
 *
 * The scheduled download/parse job runs in GitHub Actions (see
 * .github/workflows/ingest.yml) because a free-plan Worker only gets
 * 10 ms of CPU per invocation, which is not enough to parse the workbook.
 * This Worker only runs small, indexed reads.
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

const PRICE_COLUMNS = `
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
  executed_at
`;

async function getHealth(env) {
  const [totals, latestRun] = await Promise.all([
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM station_prices) AS total_rows,
         (SELECT COUNT(DISTINCT file_url) FROM station_prices) AS stored_files,
         (SELECT MAX(file_timestamp) FROM station_prices) AS latest_file_timestamp`,
    ).first(),
    env.DB.prepare(
      `SELECT file_url, file_timestamp, executed_at, row_count, status
       FROM ingest_runs
       ORDER BY file_timestamp DESC
       LIMIT 1`,
    ).first(),
  ]);

  return {
    ok: true,
    ...totals,
    latest_run: latestRun ?? null,
  };
}

async function getSnapshots(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT file_url, file_timestamp, executed_at, row_count, status, error
     FROM ingest_runs
     ORDER BY file_timestamp DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  return { count: results.length, snapshots: results };
}

async function getLatest(env, { limit, offset, region }) {
  const filters = ['file_timestamp = (SELECT MAX(file_timestamp) FROM station_prices)'];
  const params = [];
  if (region) {
    filters.push('region = ?');
    params.push(region);
  }
  const where = filters.join(' AND ');

  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM station_prices WHERE ${where}`)
      .bind(...params)
      .first(),
    env.DB.prepare(
      `SELECT ${PRICE_COLUMNS}
       FROM station_prices
       WHERE ${where}
       ORDER BY name
       LIMIT ? OFFSET ?`,
    )
      .bind(...params, limit, offset)
      .all(),
  ]);

  return {
    file_timestamp: rows.results[0]?.file_timestamp ?? null,
    executed_at: rows.results[0]?.executed_at ?? null,
    total: countRow?.total ?? 0,
    limit,
    offset,
    region: region ?? null,
    stations: rows.results,
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
              '/health': 'Database totals and the most recent ingest run',
              '/snapshots?limit=20': 'Ingest history (one entry per Excel file)',
              '/latest?limit=50&offset=0&region=Abitibi-Témiscamingue': 'Stations from the newest snapshot',
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

        default:
          return json({ error: 'Not found' }, 404, 0);
      }
    } catch (error) {
      console.error('Request failed', error);
      return json({ error: 'Internal error', message: String(error?.message ?? error) }, 500, 0);
    }
  },
};
