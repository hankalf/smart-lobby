'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { DATA_DIR } = require('./db');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(UPLOAD_DIR, 'public');
const PRIVATE_DIR = path.join(UPLOAD_DIR, 'private');

for (const d of [PUBLIC_DIR, PRIVATE_DIR, path.join(PUBLIC_DIR, 'slides'), path.join(PRIVATE_DIR, 'photos'),
  path.join(PRIVATE_DIR, 'signatures'), path.join(PRIVATE_DIR, 'parcels'), path.join(DATA_DIR, 'tmp')]) {
  fs.mkdirSync(d, { recursive: true });
}

const rand = (n = 8) => crypto.randomBytes(n).toString('hex');

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg'
};

/**
 * Persist a base64 data URL (camera capture / signature pad) to disk.
 * Returns a web path such as /media/private/photos/ab12.jpg, or null.
 */
function saveDataUrl(dataUrl, bucket, subdir) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error('image_too_large');
  const base = bucket === 'public' ? PUBLIC_DIR : PRIVATE_DIR;
  const dir = subdir ? path.join(base, subdir) : base;
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString(36)}-${rand(6)}${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/media/${bucket}/${subdir ? subdir + '/' : ''}${name}`;
}

function absoluteFor(webPath) {
  if (!webPath || !webPath.startsWith('/media/')) return null;
  const rel = webPath.slice('/media/'.length).split('/').filter((p) => p && p !== '..' && p !== '.');
  if (!rel.length) return null;
  const bucket = rel.shift();
  const base = bucket === 'public' ? PUBLIC_DIR : bucket === 'private' ? PRIVATE_DIR : null;
  if (!base) return null;
  return path.join(base, ...rel);
}

function removeFile(webPath) {
  const abs = absoluteFor(webPath);
  if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch { /* ignore */ } }
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

/** Write a raw buffer into a bucket. Returns the web path. */
function saveBuffer(buf, bucket, subdir, filename) {
  const base = bucket === 'public' ? PUBLIC_DIR : PRIVATE_DIR;
  const dir = subdir ? path.join(base, subdir) : base;
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(filename || `${rand(6)}.bin`).replace(/[^\w.-]+/g, '_');
  const name = `${Date.now().toString(36)}-${rand(4)}-${safe}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/media/${bucket}/${subdir ? subdir + '/' : ''}${name}`;
}

module.exports = { UPLOAD_DIR, PUBLIC_DIR, PRIVATE_DIR, saveDataUrl, saveBuffer, absoluteFor, removeFile, memoryUpload, rand };
