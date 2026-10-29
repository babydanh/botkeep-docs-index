// Build-time source registry. Each library lists attempts in priority order; the first attempt
// that yields content wins. Verified against live endpoints on 2026-10-14.
//
// kinds:
//   llms-full  one large text file with all pages (Next.js, NestJS, Drizzle)
//   llms-index link index; the index plus every same-host link (fetched as <url>.md, else HTML)
//   sitemap    sitemap.xml; same-host URLs matching `include` (Riverpod, HTML only)
//   devdocs    DevDocs snapshot: documents.devdocs.io/<slug>/{index,db}.json (db = path -> HTML)
export const SOURCES = [
  {
    slug: 'nextjs',
    attempts: [
      { kind: 'llms-full', url: 'https://nextjs.org/docs/llms-full.txt', versionFrom: 'https://nextjs.org/docs/llms.txt', versionPattern: /Next\.js (\d+(?:\.\d+)+)/ },
      { kind: 'llms-index', url: 'https://nextjs.org/docs/llms.txt', versionPattern: /Next\.js (\d+(?:\.\d+)+)/ },
    ],
  },
  {
    slug: 'nestjs',
    attempts: [
      { kind: 'llms-full', url: 'https://docs.nestjs.com/llms-full.txt' },
      { kind: 'llms-index', url: 'https://docs.nestjs.com/llms.txt' },
    ],
  },
  {
    slug: 'drizzle',
    attempts: [
      { kind: 'llms-full', url: 'https://orm.drizzle.team/llms-full.txt' },
      { kind: 'llms-index', url: 'https://orm.drizzle.team/llms.txt' },
    ],
  },
  {
    slug: 'redis',
    attempts: [{ kind: 'llms-index', url: 'https://redis.io/llms.txt' }],
  },
  {
    slug: 'flutter',
    attempts: [{ kind: 'llms-index', url: 'https://docs.flutter.dev/llms.txt' }],
  },
  {
    slug: 'react',
    attempts: [{ kind: 'llms-index', url: 'https://react.dev/llms.txt' }],
  },
  {
    slug: 'riverpod',
    attempts: [{ kind: 'sitemap', url: 'https://riverpod.dev/sitemap.xml', include: /^\/docs\// }],
  },
  {
    slug: 'dart',
    attempts: [{ kind: 'devdocs', devdocs: 'dart~3', version: '3.13.2' }],
  },
  {
    slug: 'postgresql',
    attempts: [{ kind: 'devdocs', devdocs: 'postgresql~18', version: '18.6' }],
  },
  {
    slug: 'typescript',
    attempts: [{ kind: 'devdocs', devdocs: 'typescript', version: '7.0.2' }],
  },
  {
    slug: 'node',
    attempts: [{ kind: 'devdocs', devdocs: 'node~24_lts', version: '24.14.0' }],
  },
  {
    slug: 'socketio',
    attempts: [{ kind: 'devdocs', devdocs: 'socketio~4', version: '4.5.2' }],
  },
  {
    slug: 'playwright',
    attempts: [{ kind: 'devdocs', devdocs: 'playwright', version: '1.63.0' }],
  },
  {
    slug: 'tailwindcss',
    attempts: [{ kind: 'devdocs', devdocs: 'tailwindcss', version: '4.1.11' }],
  },
];
