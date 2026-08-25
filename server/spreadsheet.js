'use strict';
/**
 * Reads .xlsx and .csv into rows of strings, with no dependency: an .xlsx is a
 * zip of XML, and the ZIP reader written for PowerPoint decks opens it too.
 */
const path = require('path');
const { readZip } = require('./unzip');

const xmlUnescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

/** "BC12" -> 54 (zero-based column index) */
function columnIndex(ref) {
  const letters = String(ref || '').replace(/\d+/g, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function parseXlsx(buffer) {
  const zip = readZip(buffer);

  // Shared strings: cells of type "s" hold an index into this table.
  const shared = [];
  const sharedXml = zip.get('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const si of sharedXml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const text = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join('');
      shared.push(text);
    }
  }

  const sheetName = [...zip.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('no_sheet_found');
  const sheet = zip.get(sheetName).toString('utf8');

  const rows = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      const at = columnIndex((/r="([A-Z]+\d+)"/.exec(attrs) || [])[1]);

      let value = '';
      if (type === 's') {
        const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]);
        value = shared[idx] != null ? shared[idx] : '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1])).join('');
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        value = v == null ? '' : xmlUnescape(v);
      }
      cells[at] = String(value).trim();
    }
    // Cells are sparse when the sheet skips empties; fill the gaps.
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  return rows;
}

/** CSV with quoted fields, embedded commas, newlines and doubled quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const pushField = () => { row.push(field.trim()); field = ''; };
  const pushRow = () => { if (row.some((c) => c !== '')) rows.push(row); row = []; };

  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') { pushField(); pushRow(); }
    else field += ch;
  }
  pushField();
  pushRow();
  return rows;
}

function parseSpreadsheet(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.csv' || ext === '.txt') return parseCsv(buffer.toString('utf8'));
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(buffer);
  if (ext === '.xls') throw new Error('old_excel_format');
  throw new Error('unsupported_file_type');
}

/**
 * Work out which column is which from the header row, accepting the wording
 * people actually use in their own spreadsheets.
 */
const HEADER_ALIASES = {
  name: ['name', 'full name', 'fullname', 'staff', 'staff name', 'employee', 'employee name', 'person'],
  first_name: ['first name', 'firstname', 'first', 'forename', 'given name', 'christian name'],
  last_name: ['last name', 'lastname', 'last', 'surname', 'family name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['phone', 'mobile', 'mobile number', 'phone number', 'telephone', 'cell', 'contact number'],
  department: ['department', 'dept', 'team', 'division', 'role', 'job title', 'title'],
  webhook_url: ['webhook', 'webhook url', 'chat webhook', 'slack', 'teams']
};

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((cell, i) => {
    const key = String(cell || '').trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(key)) map[field] = i;
    }
  });
  return map;
}

module.exports = { parseSpreadsheet, parseCsv, parseXlsx, mapHeaders };
