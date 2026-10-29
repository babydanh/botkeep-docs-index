#!/usr/bin/env node
// Builds data/docs.sqlite from the official llms.txt / llms-full.txt / sitemap / DevDocs sources.
// Run locally: `node scripts/build-index.mjs [--only=nextjs,nestjs] [--refresh] [--out=path]`.
// Downloads are cached under the OS temp dir (bypass with --refresh).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SOURCES } from './sources.mjs';
import { splitPages, chunkPage, htmlToMarkdown, firstH1 } from '../lib/markdown.js';
import { writeDatabase } from '../lib/store.js';
import { LIBRARY_NAMES } from '../lib/libraries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const OUT_FILE = path.resolve(ROOT, typeof args.get('out') === 'string' ? args.get('out') : 'data/docs.sqlite');
const ONLY = typeof args.get('only') === 'string' ? new Set(args.get('only').split(',').map(s => s.trim())) : null;
const REFRESH = args.get('refresh') === true;
const CACHE_DIR = path.join(os.tmpdir(), 'node6-docs-index-cache');

const USER_AGENT = 'botkeep-node6-docs-index/1.0 (build; contact: local operator)';
const CONCURRENCY = 4;
const MAX_PAGES_PER_LIBRARY = 400;
const MAX_BYTES_FULL = 32 * 1024 * 1024;
const MAX_BYTES_DEVDOCS_DB = 96 * 1024 * 1024;
const MAX_BYTES_PAGE = 2 * 1024 * 1024;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const warn = (...parts) => console.warn(new Date().toISOString().slice(11, 19), 'WARN', ...parts);

// ---- HTTP -----------------------------------------------------------------------------------

async function readCapped(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Returns { status, contentType, text }. 404/410 and other 4xx are returned, not thrown.
// 429/5xx and network errors retry with backoff.
async function fetchText(url, { maxBytes = MAX_BYTES_PAGE, timeoutMs = 60_000, accept = '*/*' } = {}) {
  const cacheFile = path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.txt');
  if (!REFRESH && fs.existsSync(cacheFile)) {
    return { status: 200, contentType: 'text/cached', text: fs.readFileSync(cacheFile, 'utf8') };
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(1500 * attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, contentType: '', text: '' };
      }
      const contentType = response.headers.get('content-type') || '';
      const text = await readCapped(response, maxBytes);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, text);
      return { status: response.status, contentType, text };
    } catch (error) {
      if (/exceeds \d+ bytes/.test(error.message)) throw error;
      lastError = error;
      await sleep(1500 * attempt);
    }
  }
  throw lastError ?? new Error('fetch failed');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- page acquisition ------------------------------------------------------------------------

// Tries <url>.md first (many sites serve markdown this way), then the URL itself as HTML.
// Returns pages (usually one) or [] when nothing usable exists.
async function fetchDocPage(url, fallbackTitle) {
  const isMarkdownUrl = /\.md$/i.test(url);
  // Some sites list "<page>/index.html.md" but serve the page at "<page>/" or "<page>" as markdown.
  // Those alternates are accepted only when they are markdown (never HTML).
  const candidates = isMarkdownUrl
    ? [...new Set([url, url.replace(/index\.html\.md$/i, '/'), url.replace(/\.md$/i, '')])]
    : [`${url}.md`, url];
  for (const candidate of candidates) {
    const response = await fetchText(candidate, {
      maxBytes: MAX_BYTES_PAGE,
      timeoutMs: 30_000,
      accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8',
    });
    if (response.status !== 200) continue;
    const isHtml = /html/i.test(response.contentType) || /^\s*(<!doctype html|<html)/i.test(response.text.slice(0, 300));
    if (isHtml && candidate !== url) continue;
    const humanUrl = url.replace(/\.md$/i, '');
    const markdown = isHtml ? htmlToMarkdown(response.text) : response.text;
    return splitPages(markdown, { baseUrl: humanUrl, fallbackTitle });
  }
  return [];
}

async function fromLlmsFull(attempt) {
  const response = await fetchText(attempt.url, { maxBytes: MAX_BYTES_FULL, timeoutMs: 180_000 });
  if (response.status !== 200) {
    warn(`llms-full ${attempt.url} -> HTTP ${response.status}; skipping`);
    return null;
  }
  const origin = new URL(attempt.url).origin;
  const pages = splitPages(response.text, { baseUrl: origin });
  let version = null;
  if (attempt.versionFrom && attempt.versionPattern) {
    const header = await fetchText(attempt.versionFrom, { timeoutMs: 60_000 });
    if (header.status === 200) version = detectVersion(header.text, attempt.versionPattern);
  }
  return { pages, version, sourceUrls: [attempt.url] };
}

async function fromLlmsIndex(attempt) {
  const index = await fetchText(attempt.url, { maxBytes: MAX_BYTES_FULL, timeoutMs: 60_000 });
  if (index.status !== 200) {
    warn(`llms-index ${attempt.url} -> HTTP ${index.status}; skipping`);
    return null;
  }
  const indexHost = new URL(attempt.url).host;
  const indexPages = splitPages(index.text, { baseUrl: attempt.url });
  const links = extractIndexLinks(index.text, attempt.url)
    .filter(link => new URL(link.url).host === indexHost)
    .filter(link => !/llms(-full)?\.txt$/i.test(new URL(link.url).pathname));
  const selected = links.slice(0, MAX_PAGES_PER_LIBRARY);
  log(`  llms-index: ${links.length} same-host links, fetching ${selected.length}`);

  const fetched = await mapLimit(selected, CONCURRENCY, async link => {
    try {
      return await fetchDocPage(link.url, link.text);
    } catch (error) {
      warn(`  page ${link.url} failed: ${error.message}`);
      return [];
    }
  });
  const missing = fetched.filter(pages => pages.length === 0).length;
  if (missing) log(`  ${missing} linked pages unavailable (404/unsupported); skipped`);
  const pages = [...indexPages, ...fetched.flat()];
  const version = attempt.versionPattern ? detectVersion(index.text, attempt.versionPattern) : null;
  return { pages, version, sourceUrls: [attempt.url] };
}

async function fromSitemap(attempt) {
  const sitemap = await fetchText(attempt.url, { timeoutMs: 60_000, accept: 'application/xml, text/xml' });
  if (sitemap.status !== 200) {
    warn(`sitemap ${attempt.url} -> HTTP ${sitemap.status}; skipping`);
    return null;
  }
  const origin = new URL(attempt.url).origin;
  const urls = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(match => match[1].trim().replace(/&amp;/g, '&'))
    .filter(url => url.startsWith(origin))
    .filter(url => !attempt.include || attempt.include.test(new URL(url).pathname))
    .slice(0, MAX_PAGES_PER_LIBRARY);
  log(`  sitemap: fetching ${urls.length} pages`);
  const fetched = await mapLimit(urls, CONCURRENCY, async url => {
    try {
      return await fetchDocPage(url, decodeURIComponent(new URL(url).pathname.split('/').pop() || url));
    } catch (error) {
      warn(`  page ${url} failed: ${error.message}`);
      return [];
    }
  });
  return { pages: fetched.flat(), version: null, sourceUrls: [origin + '/'] };
}

async function fromDevdocs(attempt) {
  const base = `https://documents.devdocs.io/${attempt.devdocs}`;
  const indexResponse = await fetchText(`${base}/index.json`, { maxBytes: 16 * 1024 * 1024, timeoutMs: 120_000, accept: 'application/json' });
  const dbResponse = await fetchText(`${base}/db.json`, { maxBytes: MAX_BYTES_DEVDOCS_DB, timeoutMs: 600_000, accept: 'application/json' });
  if (indexResponse.status !== 200 || dbResponse.status !== 200) {
    warn(`devdocs ${attempt.devdocs} -> index HTTP ${indexResponse.status}, db HTTP ${dbResponse.status}; skipping`);
    return null;
  }
  const index = JSON.parse(indexResponse.text);
  const db = JSON.parse(dbResponse.text);
  const names = new Map();
  for (const entry of index.entries || []) {
    if (!entry.path.includes('#') && !names.has(entry.path)) names.set(entry.path, entry.name);
  }
  const pages = [];
  for (const [key, html] of Object.entries(db)) {
    if (typeof html !== 'string' || html.trim() === '') continue;
    const markdown = htmlToMarkdown(html);
    if (markdown === '') continue;
    pages.push({
      url: `https://devdocs.io/${attempt.devdocs}/${key}`,
      title: names.get(key) || firstH1(markdown) || key,
      markdown,
    });
  }
  return { pages, version: attempt.version ?? null, sourceUrls: [`https://devdocs.io/${attempt.devdocs}/`] };
}

// ---- helpers ----------------------------------------------------------------------------------

function extractIndexLinks(text, baseUrl) {
  const seen = new Map();
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    let url;
    try {
      url = new URL(match[2], baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    url.hash = '';
    const key = url.toString();
    if (!seen.has(key)) seen.set(key, { url: key, text: match[1].trim() });
  }
  return [...seen.values()];
}

function detectVersion(text, pattern) {
  const match = pattern.exec(text.slice(0, 2000));
  return match ? match[1] : null;
}

async function buildSource(source) {
  const started = Date.now();
  for (const attempt of source.attempts) {
    const label = attempt.url || attempt.devdocs;
    try {
      const handler = { 'llms-full': fromLlmsFull, 'llms-index': fromLlmsIndex, sitemap: fromSitemap, devdocs: fromDevdocs }[attempt.kind];
      const result = await handler(attempt);
      if (!result) continue;
      const chunks = [];
      let docCount = 0;
      for (const page of result.pages) {
        const pageChunks = chunkPage(page);
        if (pageChunks.length > 0) docCount++;
        chunks.push(...pageChunks);
      }
      if (chunks.length === 0) {
        warn(`${source.slug}: ${attempt.kind} ${label} produced no chunks; trying next source`);
        continue;
      }
      return {
        slug: source.slug,
        name: LIBRARY_NAMES.get(source.slug) || source.slug,
        version: result.version ?? null,
        sourceUrls: result.sourceUrls,
        docCount,
        chunks,
        elapsedMs: Date.now() - started,
        via: `${attempt.kind} ${label}`,
      };
    } catch (error) {
      warn(`${source.slug}: ${attempt.kind} ${label} failed: ${error.message}`);
    }
  }
  return null;
}

// ---- main -------------------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const libraries = [];
  for (const source of SOURCES) {
    if (ONLY && !ONLY.has(source.slug)) continue;
    log(`[${source.slug}] building`);
    const library = await buildSource(source);
    if (!library) {
      warn(`[${source.slug}] SKIPPED: no source produced content`);
      continue;
    }
    const bodyBytes = library.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.body), 0);
    log(`[${source.slug}] ok via ${library.via}: ${library.docCount} docs, ${library.chunks.length} chunks, ${(bodyBytes / 1048576).toFixed(2)} MiB text, ${(library.elapsedMs / 1000).toFixed(1)}s`);
    libraries.push(library);
  }
  if (libraries.length === 0) throw new Error('No library produced content; nothing written');

  const builtAt = new Date().toISOString();
  const libraryRows = libraries.map(library => ({ ...library, builtAt }));
  writeDatabase(OUT_FILE, libraryRows, { builtAt });

  const sizeMiB = fs.statSync(OUT_FILE).size / 1048576;
  console.log('\nlibrary        docs   chunks  text_MiB  version');
  for (const library of libraries) {
    const bodyBytes = library.chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.body), 0);
    console.log(
      `${library.slug.padEnd(14)} ${String(library.docCount).padStart(5)} ${String(library.chunks.length).padStart(8)} ${(bodyBytes / 1048576).toFixed(2).padStart(9)}  ${library.version ?? '-'}`
    );
  }
  console.log(`\nDB: ${OUT_FILE} ${sizeMiB.toFixed(2)} MiB; built ${libraries.length} libraries in ${((Date.now() - started) / 1000).toFixed(1)}s; builtAt ${builtAt}`);
}

main().catch(error => {
  console.error(`build failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
