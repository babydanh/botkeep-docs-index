'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DocsStore } = require('../lib/store');
const { checkForUpdate } = require('../lib/updater');
const { buildFixtureDb, BUILT_AT } = require('./fixture.cjs');

const NEW_BUILT = '2026-12-01T00:00:00.000Z';
const silent = { log() {}, error() {} };

function serve(files) {
  const server = http.createServer((req, res) => {
    const body = files[req.url];
    if (body === undefined) { res.statusCode = 404; return res.end(); }
    res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function setup(t, { tamper = false, libraries } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n6-upd-'));
  const dbFile = buildFixtureDb(dir);
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n6-src-'));
  const newFile = path.join(srcDir, 'docs.sqlite');
  // Bản mới: cùng thư viện với fixture (hoặc ít hơn), builtAt mới hơn.
  const current = new DocsStore(dbFile);
  const libs = libraries ?? current.listLibraries().map(l => l.library);
  current.close();
  fs.copyFileSync(dbFile, newFile);
  const db = new (require('node:sqlite').DatabaseSync)(newFile);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'built_at'").run(NEW_BUILT);
  for (const row of db.prepare('SELECT slug FROM libraries').all()) {
    if (!libs.includes(row.slug)) db.prepare('DELETE FROM libraries WHERE slug = ?').run(row.slug);
  }
  db.close();
  const bytes = fs.readFileSync(newFile);
  const sha256 = crypto.createHash('sha256').update(tamper ? Buffer.from('x') : bytes).digest('hex');
  let server;
  const files = {
    '/docs.sqlite': bytes,
  };
  server = await serve(files);
  const base = `http://127.0.0.1:${server.address().port}`;
  files['/manifest.json'] = JSON.stringify({ builtAt: NEW_BUILT, url: `${base}/docs.sqlite`, sha256, size: bytes.length });
  const holder = { current: new DocsStore(dbFile) };
  t.after(() => {
    server.close();
    if (holder.current) holder.current.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  });
  return { holder, dbFile, manifestUrl: `${base}/manifest.json` };
}

test('ban moi hop le thi doi index dang chay', async t => {
  const ctx = await setup(t);
  assert.strictEqual(ctx.holder.current.globalBuiltAt, BUILT_AT);
  assert.strictEqual(await checkForUpdate({ ...ctx, log: silent }), true);
  assert.strictEqual(ctx.holder.current.globalBuiltAt, NEW_BUILT);
  assert.strictEqual(await checkForUpdate({ ...ctx, log: silent }), false, 'cung ban thi khong tai lai');
  assert.ok(!fs.existsSync(`${ctx.dbFile}.download`));
});

test('sai sha256 thi giu index cu', async t => {
  const ctx = await setup(t, { tamper: true });
  await assert.rejects(checkForUpdate({ ...ctx, log: silent }), /sha256/);
  assert.strictEqual(ctx.holder.current.globalBuiltAt, BUILT_AT);
  assert.ok(new DocsStore(ctx.dbFile).globalBuiltAt === BUILT_AT);
});

test('ban moi mat nhieu thu vien thi tu choi', async t => {
  const ctx = await setup(t, { libraries: ['react'] });
  await assert.rejects(checkForUpdate({ ...ctx, log: silent }), /thu vien/);
  assert.strictEqual(ctx.holder.current.globalBuiltAt, BUILT_AT);
});
