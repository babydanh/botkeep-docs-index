'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('../server');
const { buildFixtureDb, BUILT_AT } = require('./fixture.cjs');

const SECRET = 'test-cluster-secret-0123456789abcdef';
const SERVER_FILE = path.join(__dirname, '..', 'server.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let dir;
let dbFile;
let server;
let base;
let port;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-server-test-'));
  dbFile = buildFixtureDb(dir);
  server = createServer({ dbFile, clusterSecret: SECRET, bodyReadTimeoutMs: 300 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

// JSON request helper. Protected by default (Bearer secret); pass auth: false to omit it.
async function call(method, pathname, { body, headers = {}, auth = true } = {}) {
  const requestHeaders = { ...headers };
  if (auth && requestHeaders.authorization === undefined && requestHeaders['x-api-key'] === undefined) {
    requestHeaders.authorization = `Bearer ${SECRET}`;
  }
  const init = { method, headers: requestHeaders };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (requestHeaders['content-type'] === undefined) requestHeaders['content-type'] = 'application/json';
  }
  const response = await fetch(`${base}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

const search = (payload, options) => call('POST', '/search', { body: payload, ...options });

// Raw HTTP helper for cases fetch cannot express (declared-length rejection, stalled bodies).
// Resolves with the status line and full text once the server closes the socket.
function rawRequest(chunks, { gapMs = 0 } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      const bodyStart = data.indexOf('\r\n\r\n');
      resolve({
        status: match ? Number(match[1]) : null,
        body: bodyStart >= 0 ? data.slice(bodyStart + 4) : '',
      });
    };
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
    (async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        if (gapMs) await sleep(gapMs);
      }
    })();
  });
}

describe('health (no auth)', () => {
  test('GET / reports online with node name, version, memory and library count', async () => {
    const response = await call('GET', '/', { auth: false });
    assert.equal(response.status, 200);
    assert.equal(response.json.status, 'online');
    assert.equal(response.json.node, 'node6-docs-index');
    assert.equal(typeof response.json.version, 'string');
    assert.equal(typeof response.json.memoryUsageMB, 'number');
    assert.equal(response.json.libraries, 5);
  });
});

describe('authentication', () => {
  test('protected routes reject missing credentials with 401 and a Bearer challenge', async () => {
    const response = await search({ library: 'nestjs', q: 'guards' }, { auth: false });
    assert.equal(response.status, 401);
    assert.equal(response.json.error, 'Unauthorized');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  });

  test('wrong secret and empty credentials are rejected', async () => {
    assert.equal((await call('GET', '/libraries', { headers: { authorization: 'Bearer wrong-secret' }, auth: false })).status, 401);
    assert.equal((await call('GET', '/libraries', { headers: { authorization: '' }, auth: false })).status, 401);
    assert.equal((await call('GET', '/libraries', { headers: { 'x-api-key': 'nope' }, auth: false })).status, 401);
  });

  test('Bearer prefix is case-insensitive; raw secret works in authorization and x-api-key', async () => {
    assert.equal((await call('GET', '/libraries', { headers: { authorization: `BEARER ${SECRET}` }, auth: false })).status, 200);
    assert.equal((await call('GET', '/libraries', { headers: { authorization: SECRET }, auth: false })).status, 200);
    assert.equal((await call('GET', '/libraries', { headers: { 'x-api-key': SECRET }, auth: false })).status, 200);
  });

  test('unknown paths are 401 without credentials and 404 JSON with them', async () => {
    assert.equal((await call('GET', '/nope', { auth: false })).status, 401);
    const response = await call('GET', '/nope');
    assert.equal(response.status, 404);
    assert.equal(response.json.error, 'Not found');
  });

  test('wrong methods answer 405 with an Allow header', async () => {
    const getSearch = await call('GET', '/search');
    assert.equal(getSearch.status, 405);
    assert.equal(getSearch.headers.get('allow'), 'POST');
    const postLibraries = await call('POST', '/libraries', { body: {} });
    assert.equal(postLibraries.status, 405);
    assert.equal(postLibraries.headers.get('allow'), 'GET');
  });
});

describe('POST /search results', () => {
  test('returns ranked, compact results with source and version metadata', async () => {
    const response = await search({ library: 'nestjs', q: 'guards' });
    assert.equal(response.status, 200);
    assert.equal(response.json.library, 'nestjs');
    assert.equal(response.json.indexed, true);
    assert.equal(response.json.version, '11.0.0');
    assert.equal(response.json.source, 'local-index');
    assert.equal(response.json.builtAt, BUILT_AT);
    const [top] = response.json.results;
    assert.equal(top.title, 'Guards');
    assert.equal(top.url, 'https://docs.nestjs.com/guards');
    assert.equal(typeof top.snippet, 'string');
    assert.equal(typeof top.score, 'number');
    assert.ok(top.score > 0);
  });

  test('a term that exists only in another library yields no results (isolation)', async () => {
    const response = await search({ library: 'drizzle', q: 'guards' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.results, []);
    assert.equal(response.json.indexed, true);
  });

  test('library aliases resolve to the canonical slug in responses', async () => {
    const next = await search({ library: 'next.js', q: 'revalidatePath' });
    assert.equal(next.json.library, 'nextjs');
    assert.equal(next.json.results[0].title, 'Server Actions');

    const nest = await search({ library: 'nest', q: 'interceptors' });
    assert.equal(nest.json.library, 'nestjs');
    assert.equal(nest.json.results[0].title, 'Interceptors');

    const drizzle = await search({ library: 'drizzle-orm', q: 'transactions' });
    assert.equal(drizzle.json.library, 'drizzle');
    assert.equal(drizzle.json.results[0].title, 'Transactions');

    const pg = await search({ library: 'pg', q: 'explain analyze' });
    assert.equal(pg.json.library, 'postgresql');
    assert.equal(pg.json.results[0].title, 'EXPLAIN');
  });

  test('a known library that is not indexed answers 200 with indexed:false', async () => {
    const response = await search({ library: 'flutter', q: 'listview' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { library: 'flutter', indexed: false, results: [] });
  });

  test('an unknown library name answers 200 with indexed:false', async () => {
    const response = await search({ library: 'no-such-library', q: 'anything' });
    assert.equal(response.status, 200);
    assert.equal(response.json.indexed, false);
    assert.deepEqual(response.json.results, []);
  });

  test('an indexed library with no matching text answers indexed:true and empty results', async () => {
    const response = await search({ library: 'nestjs', q: 'zzqqxxnomatch' });
    assert.equal(response.status, 200);
    assert.equal(response.json.indexed, true);
    assert.deepEqual(response.json.results, []);
  });

  test('omitting q returns the library overview with intro chunks first', async () => {
    const response = await search({ library: 'nestjs' });
    assert.equal(response.status, 200);
    assert.equal(response.json.results[0].title, 'Introduction');
    assert.ok(response.json.results.length <= 5);
  });

  test('snippets are capped at 1200 characters and still contain the hit', async () => {
    const response = await search({ library: 'nestjs', q: 'needle' });
    const [top] = response.json.results;
    assert.equal(top.title, 'Long page');
    assert.ok(top.snippet.length <= 1200, `snippet is ${top.snippet.length} chars`);
    assert.match(top.snippet, /needle/);
  });

  test('limit defaults to 5, clamps to 1..10, and accepts numeric strings', async () => {
    const q = { library: 'react', q: 'hooks' };
    assert.equal((await search(q)).json.results.length, 5);
    assert.equal((await search({ ...q, limit: 2 })).json.results.length, 2);
    assert.equal((await search({ ...q, limit: '3' })).json.results.length, 3);
    assert.equal((await search({ ...q, limit: 0 })).json.results.length, 1);
    assert.equal((await search({ ...q, limit: 999 })).json.results.length, 10);
    assert.equal((await search({ ...q, limit: '1000' })).json.results.length, 10);
  });

  test('hostile query text answers 200 and never breaks the index', async () => {
    const hostile = [
      '"; DROP TABLE chunks; --',
      'OR',
      'NEAR(guards pipes)',
      'title:secret',
      '*',
      '{library} :',
      'guards OR *',
      '"',
      'a"b',
      '((((',
      'guards\u0000null',
    ];
    for (const q of hostile) {
      const response = await search({ library: 'nestjs', q });
      assert.equal(response.status, 200, `query ${JSON.stringify(q)}`);
      assert.equal(response.json.indexed, true);
      assert.ok(Array.isArray(response.json.results));
    }
    const after = await search({ library: 'nestjs', q: 'guards' });
    assert.equal(after.json.results[0].title, 'Guards');
  });
});

describe('POST /search validation', () => {
  test('malformed JSON and non-object bodies are 400 JSON errors', async () => {
    const notJson = await search('not json');
    assert.equal(notJson.status, 400);
    assert.equal(notJson.json.error, 'Request body must be valid JSON');

    const array = await search([1, 2]);
    assert.equal(array.status, 400);
    assert.equal(array.json.error, 'Request body must be a JSON object');
  });

  test('library is required, non-empty and at most 128 characters', async () => {
    const missing = await search({ q: 'guards' });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /library must be a non-empty string/);

    const blank = await search({ library: '   ', q: 'guards' });
    assert.equal(blank.status, 400);

    const long = await search({ library: 'x'.repeat(129), q: 'guards' });
    assert.equal(long.status, 400);
  });

  test('q must be a string of at most 512 characters', async () => {
    const notString = await search({ library: 'nestjs', q: 42 });
    assert.equal(notString.status, 400);
    assert.equal(notString.json.error, 'q must be a string');

    const tooLong = await search({ library: 'nestjs', q: 'x'.repeat(513) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.error, 'q must be at most 512 characters');
  });

  test('limit must be a number when present', async () => {
    for (const limit of ['abc', {}, true]) {
      const response = await search({ library: 'nestjs', q: 'guards', limit });
      assert.equal(response.status, 400, `limit ${JSON.stringify(limit)}`);
      assert.equal(response.json.error, 'limit must be a number');
    }
  });

  test('a declared body over 16 KiB is rejected with 413 before reading it', async () => {
    const headers = [
      'POST /search HTTP/1.1',
      '\r\nHost: 127.0.0.1',
      `\r\nAuthorization: Bearer ${SECRET}`,
      '\r\nContent-Type: application/json',
      '\r\nContent-Length: 20000',
      '\r\nConnection: close',
      '\r\n\r\n',
    ].join('');
    const response = await rawRequest([headers]);
    assert.equal(response.status, 413);
    assert.match(JSON.parse(response.body).error, /exceeds 16384 bytes/);
  });

  test('a streamed body over 16 KiB is rejected with 413', async () => {
    const payload = 'x'.repeat(17000);
    const response = await rawRequest([
      `POST /search HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
      `${payload.length.toString(16)}\r\n${payload}\r\n`,
      '0\r\n\r\n',
    ]);
    assert.equal(response.status, 413);
    assert.match(JSON.parse(response.body).error, /exceeds 16384 bytes/);
  });

  test('a body that stalls past the read deadline is rejected with 408', async () => {
    const response = await rawRequest([
      `POST /search HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${SECRET}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n`,
      '{"library"',
    ]);
    assert.equal(response.status, 408);
    assert.equal(JSON.parse(response.body).error, 'Request body read timeout');
  });
});

describe('GET /libraries', () => {
  test('lists indexed libraries sorted by slug with counts and provenance', async () => {
    const response = await call('GET', '/libraries');
    assert.equal(response.status, 200);
    assert.equal(response.json.count, 5);
    const slugs = response.json.libraries.map(lib => lib.library);
    assert.deepEqual(slugs, ['drizzle', 'nestjs', 'nextjs', 'postgresql', 'react']);
    const nest = response.json.libraries.find(lib => lib.library === 'nestjs');
    assert.equal(nest.name, 'NestJS');
    assert.equal(nest.version, '11.0.0');
    assert.equal(nest.docCount, 4);
    assert.equal(nest.chunkCount, 4);
    assert.deepEqual(nest.sourceUrls, ['https://docs.nestjs.com/llms-full.txt']);
    assert.equal(nest.builtAt, BUILT_AT);
  });
});

describe('process entry point', () => {
  const childEnv = overrides => {
    const env = { ...process.env };
    for (const key of ['PORT', 'SERVER_PORT', 'CLUSTER_SECRET', 'DOCS_DB_FILE', 'BODY_READ_TIMEOUT_MS']) delete env[key];
    return { ...env, ...overrides };
  };

  const spawnServer = env => {
    const child = spawn(process.execPath, [SERVER_FILE], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const entry = { child, output: '' };
    child.stdout.on('data', chunk => {
      entry.output += chunk;
    });
    child.stderr.on('data', chunk => {
      entry.output += chunk;
    });
    return entry;
  };

  const waitForOutput = (entry, pattern, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const match = pattern.exec(entry.output);
        if (match) {
          clearInterval(timer);
          resolve(match);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for ${pattern}; output so far: ${entry.output}`));
        }
      }, 50);
    });

  const stop = async entry => {
    if (entry.child.exitCode !== null) return;
    const exited = new Promise(resolve => entry.child.once('exit', resolve));
    entry.child.kill();
    await exited;
  };

  const freePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });

  test('boots from env: SERVER_PORT is honoured and protected routes work', async () => {
    const listenPort = await freePort();
    const entry = spawnServer(childEnv({ SERVER_PORT: String(listenPort), CLUSTER_SECRET: SECRET, DOCS_DB_FILE: dbFile }));
    try {
      const match = await waitForOutput(entry, /listening on 0\.0\.0\.0:(\d+)/);
      assert.equal(Number(match[1]), listenPort);
      const health = await fetch(`http://127.0.0.1:${listenPort}/`);
      assert.equal(health.status, 200);
      const response = await fetch(`http://127.0.0.1:${listenPort}/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ library: 'nestjs', q: 'guards' }),
      });
      assert.equal(response.status, 200);
      const json = await response.json();
      assert.equal(json.results[0].title, 'Guards');
    } finally {
      await stop(entry);
    }
  });

  test('PORT takes precedence over SERVER_PORT', async () => {
    const preferred = await freePort();
    const fallback = await freePort();
    const entry = spawnServer(childEnv({ PORT: String(preferred), SERVER_PORT: String(fallback), CLUSTER_SECRET: SECRET, DOCS_DB_FILE: dbFile }));
    try {
      const match = await waitForOutput(entry, /listening on 0\.0\.0\.0:(\d+)/);
      assert.equal(Number(match[1]), preferred);
    } finally {
      await stop(entry);
    }
  });

  test('without CLUSTER_SECRET the service fails closed: health ok, protected routes 401', async () => {
    const listenPort = await freePort();
    const entry = spawnServer(childEnv({ PORT: String(listenPort), DOCS_DB_FILE: dbFile }));
    try {
      await waitForOutput(entry, /listening on 0\.0\.0\.0:\d+/);
      await waitForOutput(entry, /CLUSTER_SECRET is not configured/);
      const health = await fetch(`http://127.0.0.1:${listenPort}/`);
      assert.equal(health.status, 200);
      const response = await fetch(`http://127.0.0.1:${listenPort}/search`, {
        method: 'POST',
        headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
        body: JSON.stringify({ library: 'nestjs', q: 'guards' }),
      });
      assert.equal(response.status, 401);
    } finally {
      await stop(entry);
    }
  });

  test('a missing index file starts degraded: health 503, data routes 503 with a JSON error', async () => {
    const listenPort = await freePort();
    const entry = spawnServer(childEnv({
      PORT: String(listenPort),
      CLUSTER_SECRET: SECRET,
      DOCS_DB_FILE: path.join(dir, 'does-not-exist.sqlite'),
    }));
    try {
      await waitForOutput(entry, /index unavailable/);
      await waitForOutput(entry, /listening on 0\.0\.0\.0:\d+/);
      const health = await fetch(`http://127.0.0.1:${listenPort}/`);
      assert.equal(health.status, 503);
      assert.equal((await health.json()).status, 'degraded');
      const response = await fetch(`http://127.0.0.1:${listenPort}/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ library: 'nestjs', q: 'guards' }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'Docs index unavailable');
    } finally {
      await stop(entry);
    }
  });
});
