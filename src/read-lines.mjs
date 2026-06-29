// Synchronous chunked line reader. Reads a file in fixed-size byte windows and
// yields it line-by-line, so we never materialize the whole file as one JS string.
// This (a) avoids the ~3.4x RSS blow-up of readFileSync(utf8)+split on big JSONL,
// and (b) sidesteps the V8 max-string-length ceiling that makes near-512MB files
// throw RangeError (and get silently dropped) when slurped whole.
//
// The API stays synchronous on purpose: loadSessions() and every downstream
// consumer parse synchronously, so we use openSync/readSync, not async streams.

import { openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { constants as bufferConstants } from "node:buffer";

const CHUNK_BYTES = 1024 * 1024; // 1MB read window

// Hard parse-layer ceiling. Must stay strictly below V8's max string length so a
// single line we hand to JSON.parse can never overflow it, and so total bytes read
// from any one file are capped — a pathological session can't OOM the process.
export const PARSE_MAX_BYTES = 256 * 1024 * 1024;

// Invariant (locked by test/parse.test.mjs): the parse budget must never reach what
// a JS string can hold. The old 512MB discovery cap violated this by 24 bytes.
if (PARSE_MAX_BYTES >= bufferConstants.MAX_STRING_LENGTH) {
  throw new Error("PARSE_MAX_BYTES must be < buffer.constants.MAX_STRING_LENGTH");
}

/**
 * Yield a file's lines without slurping it whole. Splits on "\n"; a trailing "\r"
 * is left on the line — every engine .trim()s, so this matches text.split(/\r?\n/)
 * once empty lines are skipped. Stops once maxBytes have been read and, when it
 * does, sets opts.state.truncated = true so callers can flag a partial parse.
 *
 * @param {string} path
 * @param {{ maxBytes?: number, chunkBytes?: number, state?: { truncated: boolean } }} [opts]
 * @returns {Generator<string>}
 */
export function* readLines(path, opts = {}) {
  const maxBytes = opts.maxBytes ?? PARSE_MAX_BYTES;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const state = opts.state;
  const fd = openSync(path, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let carry = "";
  let total = 0;
  try {
    for (;;) {
      const want = Math.min(chunkBytes, maxBytes - total);
      if (want <= 0) {
        if (state) state.truncated = true;
        break;
      }
      const bytes = readSync(fd, buffer, 0, want, null);
      if (bytes === 0) break; // EOF
      total += bytes;
      // decoder.write holds back any trailing partial multi-byte UTF-8 sequence, so
      // a code point split across a chunk boundary is never corrupted.
      carry += decoder.write(buffer.subarray(0, bytes));
      let nl;
      while ((nl = carry.indexOf("\n")) !== -1) {
        yield carry.slice(0, nl);
        carry = carry.slice(nl + 1);
      }
    }
    carry += decoder.end();
    if (carry.length) yield carry; // final line without a trailing newline
  } finally {
    closeSync(fd);
  }
}
