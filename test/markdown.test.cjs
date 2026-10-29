'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  splitPages,
  chunkPage,
  toBlocks,
  htmlToMarkdown,
  firstH1,
  decodeEntities,
  MAX_CHUNK_CHARS,
} = require('../lib/markdown');

describe('splitPages', () => {
  test('frontmatter title and url start a new page and bound its content', () => {
    const text = [
      '---', 'title: Guards', 'url: https://docs.example.com/guards', '---', '',
      '# Guards', '', 'Body one.', '',
      '---', 'title: Pipes', 'url: https://docs.example.com/pipes', '---', '',
      'Body two.',
    ].join('\n');
    const pages = splitPages(text, { baseUrl: 'https://docs.example.com' });
    assert.equal(pages.length, 2);
    assert.equal(pages[0].title, 'Guards');
    assert.equal(pages[0].url, 'https://docs.example.com/guards');
    assert.match(pages[0].markdown, /Body one\./);
    assert.doesNotMatch(pages[0].markdown, /Body two/);
    assert.equal(pages[1].title, 'Pipes');
    assert.equal(pages[1].url, 'https://docs.example.com/pipes');
  });

  test('"Source:" marker starts a page and carries the H1 that precedes it', () => {
    const text = [
      '# Overview', '', 'Overview body.', '',
      '# Installation', 'Source: https://docs.example.com/install', '', 'Install body.',
    ].join('\n');
    const pages = splitPages(text, { baseUrl: 'https://docs.example.com' });
    assert.equal(pages.length, 2);
    assert.equal(pages[0].url, 'https://docs.example.com');
    assert.equal(pages[0].title, 'Overview');
    assert.doesNotMatch(pages[0].markdown, /Install body/);
    assert.equal(pages[1].url, 'https://docs.example.com/install');
    assert.equal(pages[1].title, 'Installation');
    assert.match(pages[1].markdown, /^# Installation/);
    assert.match(pages[1].markdown, /Install body\./);
  });

  test('plain markdown without markers is one page using baseUrl and the first H1', () => {
    const pages = splitPages('# Only page\n\ncontent', { baseUrl: 'https://x.example' });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].url, 'https://x.example');
    assert.equal(pages[0].title, 'Only page');
  });
});

describe('chunkPage', () => {
  test('long pages split into chunks that never exceed the size cap and lose no section', () => {
    const sections = Array.from({ length: 12 }, (_, n) => `## Section ${n + 1}\n\n${'word '.repeat(80)}`);
    const page = { url: 'https://docs.example.com/guide', title: 'Guide', markdown: `# Guide\n\n${sections.join('\n\n')}` };
    const chunks = chunkPage(page);
    assert.ok(chunks.length >= 3, `expected several chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.body.length <= MAX_CHUNK_CHARS, `chunk of ${chunk.body.length} chars exceeds ${MAX_CHUNK_CHARS}`);
      assert.equal(chunk.url, 'https://docs.example.com/guide');
    }
    const joined = chunks.map(chunk => chunk.body).join('\n');
    for (let n = 1; n <= 12; n++) {
      const occurrences = joined.split(`## Section ${n}\n`).length - 1;
      assert.equal(occurrences, 1, `Section ${n} should appear exactly once`);
    }
  });

  test('chunk titles are breadcrumbs of page title and enclosing headings', () => {
    const page = {
      url: 'https://docs.example.com/guide',
      title: 'Guide',
      markdown: `# Guide\n\nIntro text.\n\n## Routing\n\n${'route text '.repeat(60)}\n\n### Params\n\nParam text.`,
    };
    const titles = chunkPage(page).map(chunk => chunk.title);
    assert.ok(titles.includes('Guide'), `titles: ${titles.join(' | ')}`);
    assert.ok(titles.some(title => title === 'Guide > Routing' || title === 'Guide > Routing > Params'), `titles: ${titles.join(' | ')}`);
  });

  test('a single oversized paragraph is split and every piece respects the cap', () => {
    const page = { url: 'u', title: 'T', markdown: 'word '.repeat(1000) };
    const chunks = chunkPage(page);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) assert.ok(chunk.body.length <= MAX_CHUNK_CHARS);
  });

  test('fenced code keeps "#" lines inside the fence as code, not headings', () => {
    const page = {
      url: 'u',
      title: 'Shell',
      markdown: 'Run this:\n\n```bash\n# comment line\n## not a heading\n```\n\nDone.',
    };
    const chunks = chunkPage(page);
    const body = chunks.map(chunk => chunk.body).join('\n');
    assert.match(body, /```bash\n# comment line\n## not a heading\n```/);
    assert.ok(chunks.every(chunk => !chunk.title.endsWith('not a heading')));
  });

  test('a heading ending in "#" (C#) keeps its text', () => {
    const chunks = chunkPage({ url: 'u', title: 'x', markdown: '# C#\n\nSyntax text.' });
    assert.match(chunks[0].title, /C#$/);
  });

  test('MDX import/export and standalone component tags are dropped; tags inside fences are kept', () => {
    const markdown = [
      "import { Tabs } from 'fumadocs-ui'",
      '',
      '<Callout type="warning">',
      'Be careful with this.',
      '</Callout>',
      '',
      'Text after.',
      '',
      '```jsx',
      '<Callout>inside code</Callout>',
      '```',
    ].join('\n');
    const body = chunkPage({ url: 'u', title: 'Mdx', markdown }).map(chunk => chunk.body).join('\n');
    assert.match(body, /Be careful with this\./);
    assert.match(body, /Text after\./);
    assert.doesNotMatch(body, /import \{ Tabs \}/);
    assert.doesNotMatch(body, /<Callout type="warning">/);
    assert.match(body, /<Callout>inside code<\/Callout>/);
  });

  test('an MDX comment containing a fence does not swallow the following prose', () => {
    const markdown = '{/* ```sql\nSELECT 1;\n\n``` */}\n</Section>\n\n## Next steps\n\nFollow-up text.';
    const body = chunkPage({ url: 'u', title: 'Drizzle', markdown }).map(chunk => chunk.body).join('\n');
    assert.doesNotMatch(body, /<\/Section>/);
    assert.match(body, /## Next steps/);
    assert.match(body, /Follow-up text\./);
  });
});

describe('toBlocks', () => {
  test('recognises fenced code blocks and keeps their raw text', () => {
    const blocks = toBlocks('Intro\n\n```ts\nconst a = 1;\n```\n\nOutro');
    const code = blocks.find(block => block.type === 'code');
    assert.ok(code, 'expected a code block');
    assert.match(code.text, /^```ts\nconst a = 1;\n```$/);
  });
});

describe('htmlToMarkdown', () => {
  test('keeps article content, converts headings/code/inline code, and strips chrome and scripts', () => {
    const html = [
      '<html><body><nav>Site menu</nav>',
      '<article><h2>Install</h2>',
      '<p>Run <code>npm i</code> now &amp; enjoy.</p>',
      '<pre><code>const a = 1;</code></pre>',
      '<script>window.evil = true;</script>',
      '</article><footer>Footer links</footer></body></html>',
    ].join('');
    const markdown = htmlToMarkdown(html);
    assert.match(markdown, /^## Install$/m);
    assert.match(markdown, /Run `npm i` now & enjoy\./);
    assert.match(markdown, /```[\s\S]*const a = 1;[\s\S]*```/);
    assert.doesNotMatch(markdown, /Site menu/);
    assert.doesNotMatch(markdown, /Footer links/);
    assert.doesNotMatch(markdown, /evil/);
  });

  test('entities are decoded exactly once', () => {
    const markdown = htmlToMarkdown('<p>&amp;lt;tag&amp;gt;</p>');
    assert.match(markdown, /&lt;tag&gt;/);
    assert.doesNotMatch(markdown, /<tag>/);
  });
});

describe('small helpers', () => {
  test('firstH1 ignores headings inside fences', () => {
    assert.equal(firstH1('intro\n```\n# not this\n```\n# Real title\nbody'), 'Real title');
    assert.equal(firstH1('no heading here'), null);
  });

  test('decodeEntities decodes named and numeric references', () => {
    assert.equal(decodeEntities('&lt;x&gt; &amp; &#65; &#x42;'), '<x> & A B');
  });
});
