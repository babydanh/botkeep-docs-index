'use strict';

// Deterministic fixture index shared by the test files. Not a test file itself (not in the npm test list).

const path = require('node:path');
const { writeDatabase } = require('../lib/store');

const BUILT_AT = '2026-01-15T00:00:00.000Z';

function reactChunks() {
  return Array.from({ length: 12 }, (_, index) => ({
    title: `Hook ${index + 1}`,
    url: `https://react.dev/reference/react/hook-${index + 1}`,
    body: `Hooks let you use state and other React features in function components. Entry ${index + 1}.`,
    intro: false,
  }));
}

function buildFixtureLibraries() {
  return [
    {
      slug: 'nestjs',
      name: 'NestJS',
      version: '11.0.0',
      sourceUrls: ['https://docs.nestjs.com/llms-full.txt'],
      docCount: 4,
      builtAt: BUILT_AT,
      chunks: [
        {
          title: 'Introduction',
          url: 'https://docs.nestjs.com/',
          body: '# Introduction\n\nNest is a framework for building efficient, scalable Node.js server-side applications.',
          intro: true,
        },
        {
          title: 'Guards',
          url: 'https://docs.nestjs.com/guards',
          body: '# Guards\n\nGuards decide whether a request is handled by the route handler. Apply them with @UseGuards().',
          intro: false,
        },
        {
          title: 'Interceptors',
          url: 'https://docs.nestjs.com/interceptors',
          body: '# Interceptors\n\nInterceptors bind extra logic before and after method execution. Guards run before interceptors.',
          intro: false,
        },
        {
          title: 'Long page',
          url: 'https://docs.nestjs.com/long',
          body: `${'lorem ipsum dolor sit amet '.repeat(80)}needle marker. ${'tail text '.repeat(60)}`,
          intro: false,
        },
      ],
    },
    {
      slug: 'drizzle',
      name: 'Drizzle ORM',
      version: null,
      sourceUrls: ['https://orm.drizzle.team/llms-full.txt'],
      docCount: 2,
      builtAt: BUILT_AT,
      chunks: [
        {
          title: 'Transactions',
          url: 'https://orm.drizzle.team/docs/transactions',
          body: '# Transactions\n\nUse db.transaction(async (tx) => {}) to run queries atomically.',
          intro: false,
        },
        {
          title: 'Select',
          url: 'https://orm.drizzle.team/docs/select',
          body: '# Select\n\nSelect rows with db.select().from(users).',
          intro: false,
        },
      ],
    },
    {
      slug: 'postgresql',
      name: 'PostgreSQL',
      version: '18.6',
      sourceUrls: ['https://devdocs.io/postgresql~18/'],
      docCount: 1,
      builtAt: BUILT_AT,
      chunks: [
        {
          title: 'EXPLAIN',
          url: 'https://devdocs.io/postgresql~18/sql-explain',
          body: 'EXPLAIN ANALYZE executes the statement and shows the actual execution plan.',
          intro: false,
        },
      ],
    },
    {
      slug: 'nextjs',
      name: 'Next.js',
      version: '16.4.0',
      sourceUrls: ['https://nextjs.org/docs/llms-full.txt'],
      docCount: 1,
      builtAt: BUILT_AT,
      chunks: [
        {
          title: 'Server Actions',
          url: 'https://nextjs.org/docs/app/guides/server-actions',
          body: 'Call revalidatePath("/posts") inside a server action to purge the cache.',
          intro: false,
        },
      ],
    },
    {
      slug: 'react',
      name: 'React',
      version: null,
      sourceUrls: ['https://react.dev/llms.txt'],
      docCount: 12,
      builtAt: BUILT_AT,
      chunks: reactChunks(),
    },
  ];
}

// Writes the fixture DB into `dir` and returns its absolute path.
function buildFixtureDb(dir) {
  const file = path.join(dir, 'docs.sqlite');
  writeDatabase(file, buildFixtureLibraries(), { builtAt: BUILT_AT });
  return file;
}

module.exports = { buildFixtureDb, BUILT_AT };
