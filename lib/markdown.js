'use strict';

// Build-time text processing: split source documents into pages, convert HTML to markdown,
// and chunk pages by heading. Used by scripts/build-index.mjs and by tests.

const MAX_CHUNK_CHARS = 1800;
const MIN_SPLIT_CHARS = 400;
const INTRO_TITLE = /getting[ -]started|introduction|\boverview\b|quick[ -]?start|\bintro\b|what is|installation|\binstall\b/i;

// llms-full.txt sources concatenate many pages. Two markers are understood:
//   1. YAML-ish frontmatter block with title/url (Next.js)
//   2. a "Source: <url>" line per page (NestJS, Drizzle). The page's "# Title" line sits just
//      before that marker and is carried into the new page.
// Plain single-page markdown falls through as one page.
function splitPages(text, { baseUrl, fallbackTitle = null } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const pages = [];
  let current = { url: null, title: null, lines: [] };

  const pushCurrent = () => {
    const markdown = current.lines.join('\n');
    if (markdown.trim() !== '') pages.push({ url: current.url, title: current.title, markdown });
  };

  for (let i = 0; i < lines.length; i++) {
    const frontmatter = readFrontmatter(lines, i);
    if (frontmatter) {
      pushCurrent();
      current = { url: frontmatter.meta.url || null, title: frontmatter.meta.title || null, lines: [] };
      i = frontmatter.end;
      continue;
    }

    const source = /^Source:\s*(https?:\/\/\S+)\s*$/.exec(lines[i]);
    if (source) {
      const carried = [];
      let end = current.lines.length;
      while (end > 0 && current.lines[end - 1].trim() === '') end--;
      if (end > 0 && /^# \S/.test(current.lines[end - 1])) {
        carried.push(current.lines[end - 1]);
        current.lines.length = end - 1;
      }
      pushCurrent();
      current = { url: source[1], title: null, lines: carried };
      continue;
    }
    current.lines.push(lines[i]);
  }
  pushCurrent();

  return pages.map(page => ({
    url: page.url || baseUrl || '',
    title: cleanInline(page.title || firstH1(page.markdown) || fallbackTitle || baseUrl || 'Untitled'),
    markdown: page.markdown,
  }));
}

function readFrontmatter(lines, start) {
  if (lines[start] !== '---' || !/^title:/.test(lines[start + 1] || '')) return null;
  const meta = {};
  for (let j = start + 1; j < Math.min(lines.length, start + 40); j++) {
    if (lines[j] === '---') return { end: j, meta };
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[j]);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function firstH1(markdown) {
  let fence = null;
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^# (.+)$/.exec(line);
    if (heading) return cleanInline(heading[1]);
  }
  return null;
}

// Removes markdown link syntax and HTML-ish noise from a title-like string.
function cleanInline(value) {
  return String(value)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Splits markdown into blocks. Fenced code stays whole. MDX import/export lines and
// standalone component tags (<Callout>, </Npm>) are dropped outside code fences.
function toBlocks(markdown) {
  const blocks = [];
  let paragraph = [];
  let fence = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: 'text', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (const line of markdown.split('\n')) {
    if (fence) {
      fence.lines.push(line);
      if (closesFence(line, fence.marker)) {
        blocks.push({ type: 'code', text: fence.lines.join('\n') });
        fence = null;
      }
      continue;
    }

    // "``` */}" closes a commented-out MDX example; it must not open a real code fence.
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (opener && !/\*\/\}\s*$/.test(line)) {
      flushParagraph();
      fence = { marker: opener[1], lines: [line] };
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim(), raw: line.trim() });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    if (isMdxNoise(line)) continue;
    paragraph.push(line);
  }

  if (fence) blocks.push({ type: 'code', text: fence.lines.join('\n') });
  flushParagraph();
  return blocks;
}

function closesFence(line, marker) {
  const closer = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
  return closer.test(line);
}

function isMdxNoise(line) {
  if (/^import\s[^]*?from\s+['"][^'"]+['"];?\s*$/.test(line)) return true;
  if (/^import\s+['"][^'"]+['"];?\s*$/.test(line)) return true;
  if (/^export\s+(const|default|function)\b/.test(line)) return true;
  if (/^\s*<\/?[A-Z][\w.]*(\s[^<>]*)?\/?>\s*$/.test(line)) return true;
  if (/^\s*<!--.*-->\s*$/.test(line)) return true;
  return false;
}

function breadcrumb(pageTitle, stack) {
  const parts = [pageTitle];
  for (const entry of stack) {
    if (entry.text !== pageTitle) parts.push(entry.text);
  }
  const joined = parts.join(' > ');
  return joined.length > 240 ? `${joined.slice(0, 239)}…` : joined;
}

// Splits one oversized block into pieces of at most maxChars. Code is re-fenced per piece.
function splitOversized(block, maxChars) {
  const pieces = [];
  if (block.type === 'code') {
    const lines = block.text.split('\n');
    const opener = lines[0];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(opener)[1];
    const terminated = lines.length > 1 && new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[lines.length - 1]);
    const closer = marker;
    const body = lines.slice(1, terminated ? -1 : lines.length);
    const budget = Math.max(200, maxChars - opener.length - closer.length - 4);
    let group = [];
    let size = 0;
    const emit = () => {
      if (group.length) pieces.push(`${opener}\n${group.join('\n')}\n${closer}`);
      group = [];
      size = 0;
    };
    for (const line of body) {
      const cut = line.length > budget ? line.slice(0, budget) : line;
      if (size + cut.length + 1 > budget) emit();
      group.push(cut);
      size += cut.length + 1;
    }
    emit();
    return pieces;
  }

  let group = [];
  let size = 0;
  const emit = () => {
    if (group.length) pieces.push(group.join('\n'));
    group = [];
    size = 0;
  };
  for (const raw of block.text.split('\n')) {
    let line = raw;
    while (line.length > maxChars) {
      emit();
      let cut = line.lastIndexOf(' ', maxChars);
      if (cut < maxChars / 2) cut = maxChars;
      pieces.push(line.slice(0, cut).trim());
      line = line.slice(cut).trimStart();
    }
    if (size + line.length + 1 > maxChars) emit();
    group.push(line);
    size += line.length + 1;
  }
  emit();
  return pieces;
}

// Heading-aware chunking. A chunk starts at a heading (levels 1-3) once the current chunk has
// reached minSplit characters, or when adding a block would exceed maxChars.
// Returns [{ title (breadcrumb), url, body, intro }].
function chunkPage(page, { maxChars = MAX_CHUNK_CHARS, minSplit = MIN_SPLIT_CHARS } = {}) {
  const chunks = [];
  const stack = [];
  let buffer = null;

  const open = () => {
    buffer = { title: breadcrumb(page.title, stack), parts: [], size: 0 };
  };
  const flush = () => {
    if (!buffer) return;
    const body = buffer.parts.join('\n\n').trim();
    if (body !== '') {
      chunks.push({ title: buffer.title, url: page.url, body, intro: INTRO_TITLE.test(buffer.title) });
    }
    buffer = null;
  };
  const append = text => {
    if (!buffer) open();
    const joiner = buffer.size > 0 ? 2 : 0;
    if (buffer.size > 0 && buffer.size + joiner + text.length > maxChars) {
      flush();
      open();
    }
    buffer.parts.push(text);
    buffer.size += (buffer.size > 0 ? 2 : 0) + text.length;
  };

  for (const block of toBlocks(page.markdown)) {
    if (block.type === 'heading') {
      if (block.level <= 3 && buffer && buffer.size >= minSplit) flush();
      while (stack.length > 0 && stack[stack.length - 1].level >= block.level) stack.pop();
      stack.push({ level: block.level, text: block.text });
      append(block.raw);
      continue;
    }
    const text = block.text.trimEnd();
    if (text.length > maxChars) {
      for (const piece of splitOversized(block, maxChars)) append(piece);
    } else {
      append(text);
    }
  }
  flush();
  return chunks;
}

// HTML -> markdown for DevDocs fragments, Docusaurus pages and similar. Regex-based and
// deliberately small: headings, code, inline code, lists, tables and paragraphs survive.
function htmlToMarkdown(input) {
  let html = String(input);
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article) html = article[1];
  else {
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
    if (main) html = main[1];
  }

  html = html
    .replace(/<\?xml[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|noscript|template|head|nav|footer|button|form|iframe|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<div\b[^>]*class="[^"]*_attribution[^"]*"[\s\S]*?<\/div>/gi, '')
    .replace(/<a\b[^>]*class="[^"]*(hash-link|headerlink|anchor)[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
      const code = stripTags(inner.replace(/<br\s*\/?>/gi, '\n')).replace(/^\n+|\n+$/g, '');
      return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : '\n';
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, inner) => {
      const text = collapseSpace(stripTags(inner));
      return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n';
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
      const text = collapseSpace(stripTags(inner));
      return text ? `\`${text}\`` : '';
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|table|tbody|thead|section|header|figure|figcaption|blockquote|dl|dt|dd|tr|aside|details|summary)\b[^>]*>/gi, '\n');

  const text = decodeEntities(stripTags(html));
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, '');
}

function collapseSpace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014',
  hellip: '\u2026', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', times: '\u00d7', middot: '\u00b7', bull: '\u2022',
};

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

module.exports = {
  splitPages,
  chunkPage,
  toBlocks,
  htmlToMarkdown,
  firstH1,
  decodeEntities,
  MAX_CHUNK_CHARS,
  MIN_SPLIT_CHARS,
};
