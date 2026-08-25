'use strict';
/**
 * Minimal ZIP reader (store + deflate) built on zlib, so PPTX/DOCX files can be
 * opened without adding a dependency. Enough for Office Open XML packages.
 */
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Returns a Map of entryName -> Buffer for every file in the archive. */
function readZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not_a_zip');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(localOffset) !== LOC_SIG) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    try {
      if (method === 0) entries.set(name, Buffer.from(raw));
      else if (method === 8) entries.set(name, zlib.inflateRawSync(raw));
    } catch {
      // Skip entries we cannot decompress rather than failing the whole file.
    }
  }
  return entries;
}

module.exports = { readZip };
