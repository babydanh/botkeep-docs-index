'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { extractTerms, buildMatchTiers, snippetAround } = require('./query');

const SCHEMA_VERSION = 1;
const OVERVIEW_LIMIT_MAX = 10;

const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE libraries (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  doc_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  source_urls TEXT NOT NULL,
  built_at TEXT NOT NULL
);
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  library TEXT NOT NULL,
  seq INTEGER NOT NULL,
  intro INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX chunks_library_overview ON chunks(library, intro DESC, seq);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  library, title, body,
  content='chunks', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
`;

// Column weights: library (0, filter only), title (10), body (1).
const BM25_WEIGHTS = '0.0, 10.0, 1.0';

function assertFts5(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x)');
    db.exec('DROP TABLE temp.fts5_probe');
  } catch (error) {
    throw new Error(`SQLite FTS5 is unavailable in node:sqlite: ${error.message}`);
  }
}

// Writes a complete index file. Used by scripts/build-index.mjs and by tests (fixture DB).
// libraries: [{ slug, name, version, sourceUrls, docCount, builtAt, chunks: [{ title, url, body, intro }] }]
function writeDatabase(file, libraries, { builtAt = new Date().toISOString() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp`;
  fs.rmSync(tmpFile, { force: true });
  const db = new DatabaseSync(tmpFile);
  try {
    assertFts5(db);
    db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('built_at', builtAt);

    const insertLibrary = db.prepare(
      'INSERT INTO libraries (slug, name, version, doc_count, chunk_count, source_urls, built_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertChunk = db.prepare(
      'INSERT INTO chunks (library, seq, intro, title, url, body) VALUES (?, ?, ?, ?, ?, ?)'
    );

    db.exec('BEGIN');
    try {
      for (const lib of libraries) {
        insertLibrary.run(
          lib.slug,
          lib.name,
          lib.version ?? null,
          lib.docCount ?? 0,
          lib.chunks.length,
          JSON.stringify(lib.sourceUrls ?? []),
          lib.builtAt ?? builtAt
        );
        lib.chunks.forEach((chunk, seq) => {
          insertChunk.run(lib.slug, seq, chunk.intro ? 1 : 0, chunk.title, chunk.url, chunk.body);
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild')");
    db.exec("INSERT INTO chunks_fts (chunks_fts, rank) VALUES ('integrity-check', 1)");
    db.exec("INSERT INTO chunks_fts (chunks_fts) VALUES ('optimize')");
    db.exec('ANALYZE');
    db.exec('VACUUM');
  } finally {
    db.close();
  }
  fs.rmSync(file, { force: true });
  fs.renameSync(tmpFile, file);
  return file;
}

// Read-only handle over a built index. All statements are prepared once.
class DocsStore {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file, { readOnly: true });
    this.db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192;');
    try {
      this.db.prepare('SELECT rowid FROM chunks_fts LIMIT 0').all();
    } catch (error) {
      this.db.close();
      throw new Error(`Index ${file} is not queryable (FTS5 missing or table absent): ${error.message}`);
    }
    const schema = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!schema || Number(schema.value) !== SCHEMA_VERSION) {
      throw new Error(`Index schema mismatch in ${file}`);
    }
    const builtAt = this.db.prepare("SELECT value FROM meta WHERE key = 'built_at'").get();
    this.globalBuiltAt = builtAt ? builtAt.value : null;

    this.statements = {
      library: this.db.prepare(
        'SELECT slug, name, version, doc_count AS docCount, chunk_count AS chunkCount, source_urls AS sourceUrls, built_at AS builtAt FROM libraries WHERE slug = ?'
      ),
      libraries: this.db.prepare(
        'SELECT slug, name, version, doc_count AS docCount, chunk_count AS chunkCount, source_urls AS sourceUrls, built_at AS builtAt FROM libraries ORDER BY slug'
      ),
      overview: this.db.prepare(
        'SELECT title, url, body FROM chunks WHERE library = ? ORDER BY intro DESC, seq ASC LIMIT ?'
      ),
    };
    this.matchStatements = new Map();
  }

  getLibrary(slug) {
    const row = this.statements.library.get(slug);
    return row ? normalizeLibraryRow(row) : null;
  }

  listLibraries() {
    return this.statements.libraries.all().map(normalizeLibraryRow);
  }

  // Overview for a library without a query: intro/getting-started chunks first, then document order.
  overview(slug, limit) {
    return this.statements.overview
      .all(slug, clampLimit(limit))
      .map(row => ({ title: row.title, url: row.url, snippet: snippetAround(row.body, []), score: 0 }));
  }

  // Tiered FTS5 search restricted to one library. Returns { tier, results } where tier is null
  // when no tier matched. Query text never reaches MATCH unquoted.
  search(slug, query, limit) {
    const terms = extractTerms(query);
    const tiers = buildMatchTiers(terms);
    const max = clampLimit(limit);
    for (const tier of tiers) {
      const rows = this.runMatch(`library:"${slug}" AND (${tier.match})`, max);
      if (rows.length > 0) {
        return {
          tier: tier.name,
          results: rows.map(row => ({
            title: row.title,
            url: row.url,
            snippet: snippetAround(row.body, terms),
            score: Math.round(row.score * 1000) / 1000,
          })),
        };
      }
    }
    return { tier: null, results: [] };
  }

  runMatch(matchExpression, limit) {
    let statement = this.matchStatements.get(matchExpression);
    if (!statement) {
      statement = this.db.prepare(`
        SELECT c.title AS title, c.url AS url, c.body AS body, -bm25(chunks_fts, ${BM25_WEIGHTS}) AS score
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts, ${BM25_WEIGHTS}) ASC
        LIMIT ?
      `);
      // Bounded cache: distinct MATCH strings are bounded by the tier set and library count.
      if (this.matchStatements.size < 256) this.matchStatements.set(matchExpression, statement);
    }
    return statement.all(matchExpression, limit);
  }

  close() {
    this.db.close();
  }
}

function clampLimit(limit) {
  return Math.min(OVERVIEW_LIMIT_MAX, Math.max(1, Math.trunc(Number(limit)) || 1));
}

function normalizeLibraryRow(row) {
  let sourceUrls = [];
  try {
    sourceUrls = JSON.parse(row.sourceUrls);
  } catch {
    sourceUrls = [];
  }
  return {
    library: row.slug,
    name: row.name,
    version: row.version ?? null,
    docCount: row.docCount,
    chunkCount: row.chunkCount,
    sourceUrls,
    builtAt: row.builtAt,
  };
}

module.exports = { DocsStore, writeDatabase, SCHEMA_VERSION, SCHEMA_SQL, clampLimit };
