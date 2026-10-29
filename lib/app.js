'use strict';

const { resolveLibrary } = require('./libraries');
const { readJsonObject, sendJson, secretsMatch } = require('./http');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_LIBRARY_CHARS = 128;
const MAX_QUERY_CHARS = 512;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// Builds the request handler. `holder.current` is a DocsStore, or null when the index failed to open
// (health then reports "degraded" and data routes answer 503). The updater may replace it between
// requests; each handler reads it once and uses it synchronously.
function createApp({ holder, clusterSecret, nodeName, version, bodyReadTimeoutMs, log = console }) {
  const secret = typeof clusterSecret === 'string' ? clusterSecret : '';
  if (!secret) {
    log.error(`[${nodeName}] CLUSTER_SECRET is not configured; rejecting all protected requests (fail-closed).`);
  }

  function isAuthorized(req) {
    if (!secret) return false;
    const candidates = [req.headers['authorization'], req.headers['x-api-key']];
    for (const raw of candidates) {
      if (typeof raw !== 'string' || raw === '') continue;
      const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw.trim();
      if (secretsMatch(token, secret)) return true;
    }
    return false;
  }

  function health(res) {
    const store = holder.current;
    const payload = {
      status: store ? 'online' : 'degraded',
      node: nodeName,
      version,
      memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
    if (store) {
      payload.libraries = store.listLibraries().length;
      payload.builtAt = store.globalBuiltAt;
    }
    return sendJson(res, store ? 200 : 503, payload);
  }

  function listLibraries(res) {
    const store = holder.current;
    if (!store) return sendJson(res, 503, { error: 'Docs index unavailable' }, { 'Retry-After': '60' });
    const libraries = store.listLibraries().map(lib => ({
      library: lib.library,
      name: lib.name,
      version: lib.version,
      docCount: lib.docCount,
      chunkCount: lib.chunkCount,
      sourceUrls: lib.sourceUrls,
      builtAt: lib.builtAt,
    }));
    return sendJson(res, 200, { count: libraries.length, libraries });
  }

  async function search(req, res) {
    let body;
    try {
      body = await readJsonObject(req, { limitBytes: MAX_BODY_BYTES, timeoutMs: bodyReadTimeoutMs });
    } catch (error) {
      const status = error.statusCode || 400;
      const headers = status === 413 || status === 408 ? { Connection: 'close' } : {};
      return sendJson(res, status, { error: error.message }, headers);
    }

    const { library, q, limit } = body;
    if (typeof library !== 'string' || library.trim() === '' || library.length > MAX_LIBRARY_CHARS) {
      return sendJson(res, 400, { error: `library must be a non-empty string of at most ${MAX_LIBRARY_CHARS} characters` });
    }
    if (q !== undefined && q !== null && typeof q !== 'string') {
      return sendJson(res, 400, { error: 'q must be a string' });
    }
    const queryText = typeof q === 'string' ? q : '';
    if (queryText.length > MAX_QUERY_CHARS) {
      return sendJson(res, 400, { error: `q must be at most ${MAX_QUERY_CHARS} characters` });
    }
    const limitValue = parseLimit(limit);
    if (limitValue === null) {
      return sendJson(res, 400, { error: 'limit must be a number' });
    }

    const store = holder.current;
    if (!store) return sendJson(res, 503, { error: 'Docs index unavailable' }, { 'Retry-After': '60' });

    const slug = resolveLibrary(library);
    const lib = slug ? store.getLibrary(slug) : null;
    if (!lib) {
      return sendJson(res, 200, { library, indexed: false, results: [] });
    }

    try {
      const results = queryText.trim() === ''
        ? store.overview(lib.library, limitValue)
        : store.search(lib.library, queryText, limitValue).results;
      return sendJson(res, 200, {
        library: lib.library,
        indexed: true,
        version: lib.version,
        results,
        source: 'local-index',
        builtAt: lib.builtAt,
      });
    } catch (error) {
      log.error(`[${nodeName}] search failed for ${lib.library}: ${error.message}`);
      return sendJson(res, 500, { error: 'Search failed' });
    }
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Malformed request URL' });
    }

    if (url.pathname === '/' && req.method === 'GET') return health(res);

    if (!isAuthorized(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }

    if (url.pathname === '/search') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return search(req, res);
    }
    if (url.pathname === '/libraries') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return listLibraries(res);
    }
    return sendJson(res, 404, { error: 'Not found' });
  };
}

// undefined/null -> default; integers are clamped to [1, 10]; anything else is invalid (null).
function parseLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  let number = null;
  if (typeof value === 'number' && Number.isFinite(value)) number = value;
  else if (typeof value === 'string' && /^-?\d{1,15}$/.test(value.trim())) number = Number(value.trim());
  if (number === null) return null;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(number)));
}

module.exports = { createApp, parseLimit, MAX_QUERY_CHARS, MAX_LIMIT, DEFAULT_LIMIT };
