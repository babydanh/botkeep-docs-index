'use strict';

const MAX_QUERY_CHARS = 512;
const MAX_TERMS = 16;
const MAX_TERM_CHARS = 64;
const SNIPPET_CHARS = 1200;

// Common English words that dilute the OR fallback tier. Never used for the strict tiers.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to', 'use',
  'using', 'what', 'when', 'where', 'which', 'why', 'with', 'you', 'your',
]);

// Splits free text into letter/digit terms. Everything else (quotes, operators, column
// filters, punctuation) is dropped, so the result can be quoted safely in FTS5 MATCH.
function extractTerms(text) {
  const normalized = String(text).slice(0, MAX_QUERY_CHARS).normalize('NFKC').toLowerCase();
  const terms = [];
  const seen = new Set();
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].slice(0, MAX_TERM_CHARS);
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

const quote = term => `"${term}"`;

// Ordered from strictest to loosest. The caller uses the first tier that yields rows.
//   phrase  : terms adjacent in order ("listview builder" matches ListView.builder)
//   and     : every term present anywhere in the chunk
//   and-core: every non-stopword term present
//   or-core : any non-stopword term present (bm25 ranks multi-term hits first)
function buildMatchTiers(terms) {
  if (terms.length === 0) return [];
  const core = terms.filter(term => !STOPWORDS.has(term));
  const coreTerms = core.length > 0 ? core : terms;
  const candidates = [
    terms.length > 1 ? { name: 'phrase', match: quote(terms.join(' ')) } : null,
    { name: 'and', match: terms.map(quote).join(' ') },
    { name: 'and-core', match: coreTerms.map(quote).join(' ') },
    { name: 'or-core', match: coreTerms.map(quote).join(' OR ') },
  ];
  const tiers = [];
  const seenMatch = new Set();
  for (const tier of candidates) {
    if (!tier || seenMatch.has(tier.match)) continue;
    seenMatch.add(tier.match);
    tiers.push(tier);
  }
  return tiers;
}

// Snippet = a window of at most maxChars around the first query term hit (prefix-stem fallback).
function snippetAround(body, terms, maxChars = SNIPPET_CHARS) {
  const text = String(body);
  if (text.length <= maxChars) return text.trim();
  const lower = text.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    let index = lower.indexOf(term);
    if (index < 0 && term.length > 5) index = lower.indexOf(term.slice(0, term.length - 2));
    if (index >= 0 && (hit < 0 || index < hit)) hit = index;
  }
  let start = Math.max(0, (hit < 0 ? 0 : hit) - Math.floor(maxChars / 4));
  let end = Math.min(text.length, start + maxChars);
  if (end - start < maxChars) start = Math.max(0, end - maxChars);
  if (start > 0) {
    const cut = text.slice(start, start + 60).search(/\s/);
    if (cut >= 0) start += cut + 1;
  }
  if (end < text.length) {
    const tail = text.slice(Math.max(start, end - 60), end);
    const cut = tail.search(/\s[^\s]*$/);
    if (cut >= 0) end = Math.max(start, end - 60) + cut;
  }
  return text.slice(start, end).trim();
}

module.exports = { extractTerms, buildMatchTiers, snippetAround, SNIPPET_CHARS, MAX_QUERY_CHARS, STOPWORDS };
