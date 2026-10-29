'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractTerms, buildMatchTiers, snippetAround, SNIPPET_CHARS } = require('../lib/query');
const { resolveLibrary } = require('../lib/libraries');
const { DocsStore } = require('../lib/store');
const { buildFixtureDb } = require('./fixture.cjs');

describe('extractTerms', () => {
  test('lowercases and keeps only letter/digit runs (unicode aware)', () => {
    assert.deepEqual(extractTerms('Server Actions, revalidatePath!'), ['server', 'actions', 'revalidatepath']);
    assert.deepEqual(extractTerms('Größe 42'), ['größe', '42']);
  });

  test('drops quotes, column filters, operators and punctuation', () => {
    const terms = extractTerms('title:secret OR "x" NEAR(a b) * {library} :');
    for (const term of terms) assert.match(term, /^[\p{L}\p{N}]+$/u, `unsafe term ${term}`);
    assert.ok(terms.includes('secret'));
    assert.ok(terms.includes('library'));
  });

  test('caps the number of terms and the length of each term', () => {
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    assert.equal(extractTerms(many).length, 16);
    assert.deepEqual(extractTerms('x'.repeat(200)), ['x'.repeat(64)]);
  });

  test('returns no terms for punctuation-only input', () => {
    assert.deepEqual(extractTerms('"*():{}^'), []);
  });
});

describe('buildMatchTiers', () => {
  test('orders tiers strictest first and quotes every term', () => {
    const tiers = buildMatchTiers(['listview', 'builder']);
    assert.deepEqual(tiers.map(tier => tier.name), ['phrase', 'and', 'or-core']);
    assert.equal(tiers[0].match, '"listview builder"');
    assert.equal(tiers[2].match, '"listview" OR "builder"');
  });

  test('stopwords are excluded from the core tiers and duplicate tiers are removed', () => {
    const tiers = buildMatchTiers(['the', 'guards']);
    assert.equal(tiers.at(-1).name, 'and-core');
    assert.equal(tiers.at(-1).match, '"guards"');
  });

  test('empty input has no tiers', () => {
    assert.deepEqual(buildMatchTiers([]), []);
  });
});

describe('snippetAround', () => {
  test('short bodies are returned trimmed and whole', () => {
    assert.equal(snippetAround('  short body  ', ['short']), 'short body');
  });

  test('long bodies are cut to the snippet cap and still contain the hit', () => {
    const body = `${'a '.repeat(1250)}needle ${'b '.repeat(500)}`;
    const snippet = snippetAround(body, ['needle']);
    assert.ok(snippet.length <= SNIPPET_CHARS, `snippet is ${snippet.length} chars`);
    assert.match(snippet, /needle/);
  });
});

describe('library aliases', () => {
  test('common spellings resolve to canonical slugs', () => {
    assert.equal(resolveLibrary('nextjs'), 'nextjs');
    assert.equal(resolveLibrary('next.js'), 'nextjs');
    assert.equal(resolveLibrary('Next-JS'), 'nextjs');
    assert.equal(resolveLibrary('nest'), 'nestjs');
    assert.equal(resolveLibrary('@nestjs'), 'nestjs');
    assert.equal(resolveLibrary('drizzle-orm'), 'drizzle');
    assert.equal(resolveLibrary('postgres'), 'postgresql');
    assert.equal(resolveLibrary('pg'), 'postgresql');
    assert.equal(resolveLibrary('flutter_riverpod'), 'riverpod');
    assert.equal(resolveLibrary('socket.io'), 'socketio');
    assert.equal(resolveLibrary('@playwright/test'), 'playwright');
  });

  test('unknown or non-string names resolve to null', () => {
    assert.equal(resolveLibrary('no-such-library'), null);
    assert.equal(resolveLibrary(''), null);
    assert.equal(resolveLibrary(undefined), null);
    assert.equal(resolveLibrary(42), null);
  });
});

describe('DocsStore on a fixture index', () => {
  let dir;
  let store;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-store-test-'));
    store = new DocsStore(buildFixtureDb(dir));
  });

  after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a title match ranks first', () => {
    const { tier, results } = store.search('nestjs', 'guards', 5);
    assert.equal(tier, 'and');
    assert.equal(results[0].title, 'Guards');
    assert.equal(results[0].url, 'https://docs.nestjs.com/guards');
  });

  test('scores are non-increasing down the result list', () => {
    const { results } = store.search('nestjs', 'guards interceptors', 5);
    for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].score >= results[i].score);
  });

  test('a multi-term query falls back to OR when no chunk contains every term', () => {
    const { tier, results } = store.search('nestjs', 'guards zebra', 5);
    assert.equal(tier, 'or-core');
    assert.ok(results.some(result => result.title === 'Guards'));
  });

  test('search never leaks across libraries', () => {
    assert.deepEqual(store.search('drizzle', 'guards', 5), { tier: null, results: [] });
  });

  test('overview lists intro chunks first', () => {
    assert.equal(store.overview('nestjs', 3)[0].title, 'Introduction');
  });

  test('hostile query text is inert and the index stays intact', () => {
    for (const hostile of ['"; DROP TABLE chunks; --', 'NEAR(guards pipes)', 'title:guards', '*', 'a"b']) {
      assert.doesNotThrow(() => store.search('nestjs', hostile, 5), hostile);
    }
    assert.equal(store.search('nestjs', 'guards', 5).results[0].title, 'Guards');
  });

  test('getLibrary and listLibraries expose metadata', () => {
    assert.equal(store.getLibrary('nestjs').version, '11.0.0');
    assert.equal(store.getLibrary('missing'), null);
    assert.deepEqual(store.listLibraries().map(lib => lib.library), ['drizzle', 'nestjs', 'nextjs', 'postgresql', 'react']);
  });

  test('opening a missing file throws instead of creating an empty index', () => {
    assert.throws(() => new DocsStore(path.join(dir, 'missing.sqlite')));
    assert.equal(fs.existsSync(path.join(dir, 'missing.sqlite')), false);
  });
});
