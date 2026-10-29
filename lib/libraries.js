'use strict';

// Registry of canonical library slugs. Aliases are compared after normalizeKey(), so
// "next.js", "Next-JS" and "next_js" all collapse to the same key as "nextjs".
const LIBRARIES = Object.freeze([
  { slug: 'nextjs', name: 'Next.js', aliases: ['next'] },
  { slug: 'nestjs', name: 'NestJS', aliases: ['nest'] },
  { slug: 'drizzle', name: 'Drizzle ORM', aliases: ['drizzle-orm'] },
  { slug: 'flutter', name: 'Flutter', aliases: ['flutter-sdk'] },
  { slug: 'riverpod', name: 'Riverpod', aliases: ['flutter_riverpod', 'hooks_riverpod', 'riverpod_generator'] },
  { slug: 'dart', name: 'Dart', aliases: ['dart-lang', 'dartlang', 'dart-sdk'] },
  { slug: 'postgresql', name: 'PostgreSQL', aliases: ['postgres', 'pg', 'pgsql'] },
  { slug: 'redis', name: 'Redis', aliases: ['redis-stack'] },
  { slug: 'react', name: 'React', aliases: ['reactjs', 'react-dom'] },
  { slug: 'playwright', name: 'Playwright', aliases: ['playwright-test', '@playwright/test'] },
  { slug: 'tailwindcss', name: 'Tailwind CSS', aliases: ['tailwind'] },
  { slug: 'typescript', name: 'TypeScript', aliases: ['ts'] },
  { slug: 'node', name: 'Node.js', aliases: ['nodejs'] },
  { slug: 'socketio', name: 'Socket.IO', aliases: ['socket.io', 'socket-io', 'socket.io-client'] },
]);

function normalizeKey(value) {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/^@/, '')
    .replace(/[\s._\-/]+/g, '');
}

const ALIAS_TO_SLUG = new Map();
for (const lib of LIBRARIES) {
  for (const key of [lib.slug, ...lib.aliases]) {
    const normalized = normalizeKey(key);
    const existing = ALIAS_TO_SLUG.get(normalized);
    if (existing && existing !== lib.slug) {
      throw new Error(`Library alias "${key}" collides between "${existing}" and "${lib.slug}"`);
    }
    ALIAS_TO_SLUG.set(normalized, lib.slug);
  }
}

// Returns the canonical slug for a caller-supplied name, or null when the name is unknown.
function resolveLibrary(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  return ALIAS_TO_SLUG.get(normalizeKey(input)) || null;
}

const LIBRARY_NAMES = new Map(LIBRARIES.map(lib => [lib.slug, lib.name]));

module.exports = { LIBRARIES, LIBRARY_NAMES, normalizeKey, resolveLibrary };
