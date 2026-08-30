'use strict';
/**
 * The site report, on paper.
 *
 * Hours per project is the number a contractor operation bills and audits
 * against, and until now the only way to hand it to anybody was a screenshot
 * of a dashboard or a CSV somebody else had to format. This is one plain page
 * with the site's own letterhead that prints — and therefore saves as a PDF —
 * from any browser, with nothing to reformat afterwards.
 *
 * Written as a standalone page rather than a printable view of the dashboard:
 * the admin stylesheet is built for a screen with a menu down one side, and
 * bending it into A4 with @media print is how printed pages end up with half a
 * table on one sheet and a stray heading on the next.
 *
 * Everything is inline. A report that has to fetch a stylesheet is a report
 * that comes out unstyled when somebody opens the saved file offline.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Whole hours once there are enough of them for a tenth to be noise. */
const hours = (n) => (n >= 10 ? Math.round(n) : Math.round((n || 0) * 10) / 10).toLocaleString('en-GB');

/** A plain YYYY-MM-DD read as itself, not as midnight somewhere else. */
function day(plain) {
  if (!plain) return '';
  const d = new Date(`${plain}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(plain)
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function stamp(iso, timezone) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: timezone || 'UTC'
    });
  } catch { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); }
}

const CSS = `
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.45 "Helvetica Neue", Arial, sans-serif; color: #16211c; background: #fff; }
  .sheet { max-width: 190mm; margin: 0 auto; padding: 10mm 0; }
  .letterhead { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid var(--brand);
    padding-bottom: 10px; margin-bottom: 18px; }
  .letterhead img { max-height: 52px; max-width: 180px; }
  .letterhead h1 { margin: 0; font-size: 17pt; }
  .letterhead .who { margin-left: auto; text-align: right; font-size: 9pt; color: #5b6b63; }
  h2 { font-size: 12pt; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #dde5e1; }
  .window { font-size: 10.5pt; color: #3f4f48; margin: 0 0 16px; }
  .window b { color: #16211c; }
  .figures { display: flex; gap: 10px; margin-bottom: 4px; }
  .figure { flex: 1; border: 1px solid #dde5e1; border-radius: 6px; padding: 10px 12px; }
  .figure .n { font-size: 18pt; font-weight: 700; line-height: 1.1; }
  .figure .l { font-size: 8.5pt; color: #5b6b63; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e7edea; }
  th { font-size: 9pt; text-transform: uppercase; letter-spacing: .04em; color: #5b6b63;
       border-bottom: 1px solid #c8d5cf; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-top: 1px solid #c8d5cf; border-bottom: none; }
  .empty { color: #5b6b63; font-style: italic; }
  .two { display: flex; gap: 18px; }
  .two > div { flex: 1; }
  .foot { margin-top: 26px; padding-top: 8px; border-top: 1px solid #dde5e1;
          font-size: 8.5pt; color: #5b6b63; }
  /* Never split a table row or leave a heading stranded at the foot of a page. */
  tr, .figure { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  .noprint { margin: 0 auto 10px; max-width: 190mm; }
  .noprint button { font: inherit; padding: .5rem 1.1rem; border-radius: 8px; border: 0;
    background: var(--brand); color: #fff; font-weight: 600; cursor: pointer; }
  @media print { .noprint { display: none !important; } .sheet { padding: 0; } }
`;

const rows = (list, label) => (list.length
  ? list.map((x) => `<tr><td>${esc(x.name || x.visit_type || '—')}</td><td class="n">${x.n}</td></tr>`).join('')
  : `<tr><td colspan="2" class="empty">No ${label} in this window.</td></tr>`);

/**
 * @param {object} stats  exactly what the Reports page was drawn from
 * @param {object} ctx    { org, project, by, now }
 */
function render(stats, ctx = {}) {
  const org = ctx.org || {};
  const s = stats;
  const scope = [
    ctx.project ? `Project: ${ctx.project}` : null,
    s.visit_type ? `Visitor type: ${s.visit_type}` : null
  ].filter(Boolean);

  const perDay = Math.round((s.total / Math.max(1, s.days)) * 10) / 10;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(org.name || 'Site report')} — ${esc(s.from)} to ${esc(s.to)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root { --brand: ${esc(org.primary_color || '#1f7a4d')}; }${CSS}</style>
</head><body>
<div class="noprint"><button type="button" onclick="window.print()">Print or save as PDF</button></div>
<div class="sheet">

  <header class="letterhead">
    ${org.logo_path ? `<img src="${esc(org.logo_path)}" alt="">` : ''}
    <div>
      <h1>${esc(org.name || 'Site report')}</h1>
      <div style="font-size:10pt;color:#5b6b63">Site report</div>
    </div>
    <div class="who">
      Prepared ${esc(stamp(ctx.now || new Date().toISOString(), org.timezone))}
      ${ctx.by ? `<br>by ${esc(ctx.by)}` : ''}
    </div>
  </header>

  <p class="window"><b>${esc(day(s.from))}</b> to <b>${esc(day(s.to))}</b>
    — ${s.days} day${s.days === 1 ? '' : 's'}${scope.length ? `. ${esc(scope.join('. '))}.` : '.'}</p>

  <div class="figures">
    <div class="figure"><div class="n">${s.total.toLocaleString('en-GB')}</div><div class="l">Visits</div></div>
    <div class="figure"><div class="n">${hours(s.total_hours)}</div><div class="l">Hours on site</div></div>
    <div class="figure"><div class="n">${s.avg_minutes ? Math.round(s.avg_minutes) : 0}</div>
      <div class="l">Avg minutes</div></div>
    <div class="figure"><div class="n">${perDay}</div><div class="l">Visits a day</div></div>
  </div>

  <h2>Hours on site, per project</h2>
  <table>
    <thead><tr><th>Project</th><th class="n">Visits</th><th class="n">Hours</th>
      <th class="n">Average</th><th class="n">Still on site</th></tr></thead>
    <tbody>${s.by_project.length
    ? s.by_project.map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.n}</td>
        <td class="n">${hours(p.hours)}</td>
        <td class="n">${p.n ? hours(p.hours / p.n) : 0}</td>
        <td class="n">${p.still_on_site || '—'}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No visits against a project in this window.</td></tr>'}</tbody>
    ${s.by_project.length ? `<tfoot><tr><td>Total</td>
      <td class="n">${s.by_project.reduce((n, p) => n + p.n, 0)}</td>
      <td class="n">${hours(s.total_hours)}</td><td class="n"></td>
      <td class="n">${s.by_project.reduce((n, p) => n + (p.still_on_site || 0), 0) || '—'}</td></tr></tfoot>` : ''}
  </table>
  <p class="window" style="margin:8px 0 0;font-size:9.5pt">Hours are counted between signing in and signing out.
    Anybody still on site is counted in the visits but not yet in the hours — their day is not finished.</p>

  <div class="two">
    <div>
      <h2>Busiest hosts</h2>
      <table><thead><tr><th>Staff member</th><th class="n">Visits</th></tr></thead>
        <tbody>${rows(s.by_host, 'named hosts')}</tbody></table>
    </div>
    <div>
      <h2>Companies on site</h2>
      <table><thead><tr><th>Company</th><th class="n">Visits</th></tr></thead>
        <tbody>${rows(s.by_company, 'named companies')}</tbody></table>
    </div>
  </div>

  <h2>By visitor type</h2>
  <table><thead><tr><th>Type</th><th class="n">Visits</th><th class="n">Share</th></tr></thead>
    <tbody>${s.by_type.length ? s.by_type.map((t) => `<tr><td>${esc(t.visit_type)}</td>
      <td class="n">${t.n}</td>
      <td class="n">${s.total ? Math.round((t.n / s.total) * 100) : 0}%</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">Nothing in this window.</td></tr>'}</tbody></table>

  <p class="foot">${esc(org.name || 'Smart Lobby')} — generated from the visitor records held on this site's own
    server. Covers ${esc(day(s.from))} to ${esc(day(s.to))}${ctx.project ? ` for ${esc(ctx.project)}` : ''}.</p>
</div>
</body></html>`;
}

module.exports = { render };
