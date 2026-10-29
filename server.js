'use strict';

const http = require('node:http');
const path = require('node:path');
const { DocsStore } = require('./lib/store');
const { createApp } = require('./lib/app');
const { startUpdater } = require('./lib/updater');
const { sendJson } = require('./lib/http');
const { version: APP_VERSION } = require('./package.json');

const NODE_NAME = 'node6-docs-index';
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const CLUSTER_SECRET = process.env.CLUSTER_SECRET || '';
const DB_FILE = path.resolve(process.env.DOCS_DB_FILE || path.join(__dirname, 'data', 'docs.sqlite'));
const BODY_READ_TIMEOUT_MS = boundedInteger(process.env.BODY_READ_TIMEOUT_MS, 10000, 100, 60000);
// Tự cập nhật index: URL manifest.json của bản phát hành; trống thì tắt.
const DOCS_UPDATE_URL = process.env.DOCS_UPDATE_URL || '';
const DOCS_UPDATE_HOURS = boundedInteger(process.env.DOCS_UPDATE_HOURS, 6, 1, 168);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function openStore(file) {
  try {
    return new DocsStore(file);
  } catch (error) {
    console.error(`[${NODE_NAME}] index unavailable at ${file}: ${error.message}`);
    return null;
  }
}

// options (all optional, used by tests): { store, dbFile, clusterSecret, bodyReadTimeoutMs }
// server.holder.current is the live store; the updater swaps it.
function createServer(options = {}) {
  const holder = { current: options.store !== undefined ? options.store : openStore(options.dbFile || DB_FILE) };
  const handle = createApp({
    holder,
    clusterSecret: options.clusterSecret !== undefined ? options.clusterSecret : CLUSTER_SECRET,
    nodeName: NODE_NAME,
    version: APP_VERSION,
    bodyReadTimeoutMs: options.bodyReadTimeoutMs ?? BODY_READ_TIMEOUT_MS,
  });
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch(error => {
        console.error(`[${NODE_NAME}] unhandled request failure: ${error && error.message}`);
        sendJson(res, 500, { error: 'Internal server error' });
      });
  });
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.holder = holder;
  server.on('close', () => {
    if (holder.current) holder.current.close();
  });
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[${NODE_NAME}] listening on 0.0.0.0:${server.address().port}`);
  });
  if (DOCS_UPDATE_URL) {
    startUpdater({ manifestUrl: DOCS_UPDATE_URL, dbFile: DB_FILE, holder: server.holder, intervalMs: DOCS_UPDATE_HOURS * 3600_000 });
    console.log(`[${NODE_NAME}] tu cap nhat index moi ${DOCS_UPDATE_HOURS} gio`);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { createServer, NODE_NAME };
