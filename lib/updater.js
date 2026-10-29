'use strict';

// Pulls a newer prebuilt index from a manifest URL and hot-swaps it into the running server.
// Manifest: { builtAt, url, sha256, size }. A candidate is only swapped in after it opens as a
// DocsStore, keeps at least as many libraries as the current index (minus 1) and answers a search.
// Store access is synchronous (node:sqlite), so swapping between requests never cuts a query.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DocsStore } = require('./store');

const MAX_INDEX_BYTES = 300 * 1024 * 1024;

async function fetchManifest(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const m = await res.json();
  if (typeof m.builtAt !== 'string' || typeof m.url !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256 || '')) {
    throw new Error('manifest thieu builtAt/url/sha256');
  }
  if (!(m.size > 0 && m.size <= MAX_INDEX_BYTES)) throw new Error('manifest size khong hop le');
  return m;
}

async function download(url, file, expected) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`tai index HTTP ${res.status}`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new (require('node:stream').Transform)({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_INDEX_BYTES) return cb(new Error('index qua lon'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file));
  if (bytes !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('sai kich thuoc/sha256');
}

function validate(candidate, current) {
  const libs = candidate.listLibraries();
  const minLibs = current ? current.listLibraries().length - 1 : 1;
  if (libs.length < Math.max(1, minLibs)) throw new Error(`chi co ${libs.length} thu vien`);
  const probe = libs.find(l => l.library === 'nextjs') || libs[0];
  if (candidate.overview(probe.library, 1).length === 0) throw new Error(`thu vien ${probe.library} rong`);
}

// holder: { current: DocsStore|null }. Returns true when a new index was swapped in.
async function checkForUpdate({ manifestUrl, dbFile, holder, log = console }) {
  const manifest = await fetchManifest(manifestUrl);
  const currentBuilt = holder.current ? holder.current.globalBuiltAt : null;
  if (currentBuilt && manifest.builtAt <= currentBuilt) return false;
  const tmp = `${dbFile}.download`;
  let candidate = null;
  try {
    await download(manifest.url, tmp, manifest);
    candidate = new DocsStore(tmp);
    validate(candidate, holder.current);
    candidate.close();
    candidate = null;
    fs.renameSync(tmp, dbFile);
    const next = new DocsStore(dbFile);
    const old = holder.current;
    holder.current = next;
    if (old) old.close();
    log.log(`[updater] da doi index ${currentBuilt} -> ${manifest.builtAt}`);
    return true;
  } finally {
    if (candidate) candidate.close();
    fs.rmSync(tmp, { force: true });
  }
}

function startUpdater({ manifestUrl, dbFile, holder, intervalMs, log = console }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkForUpdate({ manifestUrl, dbFile, holder, log });
    } catch (error) {
      log.error(`[updater] giu index cu: ${error.message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { checkForUpdate, startUpdater };
