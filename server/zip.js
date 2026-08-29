'use strict';
/**
 * Minimal ZIP writer, the counterpart to unzip.js.
 *
 * A backup has to be one file somebody can put on a memory stick and open by
 * double-clicking it, on any machine, years from now, without this application
 * anywhere in sight. That rules out a private format, and ZIP is the one every
 * desktop opens unaided.
 *
 * Entries are written one at a time straight to a file descriptor, so the peak
 * memory is the largest single file rather than the whole archive — a lobby
 * with a few thousand visitor photos would otherwise be built entirely in RAM.
 */
const fs = require('fs');
const zlib = require('zlib');

const LOC_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/* CRC-32, which ZIP requires per entry and zlib does not expose. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/*
 * The DOS date/time ZIP stores. Anything before 1980 cannot be represented,
 * so it is clamped rather than written as a nonsense date.
 */
function dosTime(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  };
}

/** Names are stored with forward slashes and no leading slash, on every platform. */
const normalise = (name) => String(name).replace(/\\/g, '/').replace(/^\/+/, '');

/**
 * @param {string} target where to write the archive
 * @returns a writer: add(name, buffer|path), then finish()
 */
function create(target) {
  const fd = fs.openSync(target, 'w');
  const entries = [];
  let offset = 0;

  const write = (buf) => {
    fs.writeSync(fd, buf, 0, buf.length);
    offset += buf.length;
  };

  /**
   * @param {string} name entry name inside the archive
   * @param {Buffer|string} source the bytes, or a path to read them from
   * @param {{store?: boolean}} opts store leaves the bytes alone — the right
   *        choice for JPEG and PNG, which do not compress twice
   */
  function add(name, source, { store = false } = {}) {
    const raw = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    const body = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
    // Compression that made it bigger is worse than none.
    const deflated = !store && body.length < raw.length;
    const data = deflated ? body : raw;
    const nameBuf = Buffer.from(normalise(name), 'utf8');
    const { time, date } = dosTime(new Date());
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);                       // version needed
    local.writeUInt16LE(0, 6);                        // flags
    local.writeUInt16LE(deflated ? 8 : 0, 8);         // method
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                       // extra length

    entries.push({ nameBuf, crc, compressed: data.length, size: raw.length, offset, deflated, time, date });
    write(local);
    write(nameBuf);
    write(data);
    return raw.length;
  }

  /** Writes the central directory and closes the file. */
  function finish() {
    const start = offset;
    for (const e of entries) {
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(CEN_SIG, 0);
      cen.writeUInt16LE(20, 4);                       // version made by
      cen.writeUInt16LE(20, 6);                       // version needed
      cen.writeUInt16LE(0, 8);
      cen.writeUInt16LE(e.deflated ? 8 : 0, 10);
      cen.writeUInt16LE(e.time, 12);
      cen.writeUInt16LE(e.date, 14);
      cen.writeUInt32LE(e.crc, 16);
      cen.writeUInt32LE(e.compressed, 20);
      cen.writeUInt32LE(e.size, 24);
      cen.writeUInt16LE(e.nameBuf.length, 28);
      cen.writeUInt16LE(0, 30);                       // extra
      cen.writeUInt16LE(0, 32);                       // comment
      cen.writeUInt16LE(0, 34);                       // disk
      cen.writeUInt16LE(0, 36);                       // internal attrs
      cen.writeUInt32LE(0, 38);                       // external attrs
      cen.writeUInt32LE(e.offset, 42);
      write(cen);
      write(e.nameBuf);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(offset - start, 12);
    eocd.writeUInt32LE(start, 16);
    eocd.writeUInt16LE(0, 20);
    write(eocd);
    fs.closeSync(fd);
    return { entries: entries.length, bytes: offset };
  }

  return { add, finish, get count() { return entries.length; } };
}

module.exports = { create, crc32 };
