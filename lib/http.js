'use strict';

const crypto = require('node:crypto');

// Reads a JSON object body with a byte cap and a wall-clock deadline for the whole body.
// Rejects with { statusCode: 400 | 408 | 413 } so the caller can map it to a JSON error.
function readJsonObject(req, { limitBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(httpError(413, `Request body exceeds ${limitBytes} bytes`));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      fn(value);
    };

    const deadline = setTimeout(() => {
      req.pause();
      finish(reject, httpError(408, 'Request body read timeout'));
    }, timeoutMs);
    deadline.unref();

    const onData = chunk => {
      size += chunk.length;
      if (size > limitBytes) {
        req.pause();
        finish(reject, httpError(413, `Request body exceeds ${limitBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(reject, httpError(400, 'Request body must be valid JSON'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(reject, httpError(400, 'Request body must be a JSON object'));
        return;
      }
      finish(resolve, parsed);
    };
    const onError = () => finish(reject, httpError(400, 'Request body could not be read'));

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(res, statusCode, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// Constant-time comparison of two secrets; digests normalize length so length is not leaked.
function secretsMatch(candidate, expected) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { readJsonObject, sendJson, secretsMatch, httpError };
