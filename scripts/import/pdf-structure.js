/**
 * Table reconstruction for vector PDFs using pdf.js text items.
 * Groups by y proximity into rows, then splits by x gaps for columns.
 * @file scripts/import/pdf-structure.js
 */

/**
 * Convert pdf.js textContent items to a rough table grid and CSV.
 * @param {Array<{str:string, transform:number[], width:number, height?:number}>} textItems
 * @returns {{cells:string[][], csv:string, bboxes:Array<{x:number,y:number,w:number,h:number}>}}
 */
export function clusterToTable(textItems) {
  const items = (textItems || []).map(it => toWord(it)).filter(w => w.text.trim().length);
  if (!items.length) return { cells: [], csv: '', bboxes: [] };
  // Row clustering by y center
  const rows = [];
  const yTol = estimateYtol(items);
  for (const w of items.sort((a, b) => a.y - b.y)) {
    let placed = false;
    for (const r of rows) {
      if (Math.abs(w.cy - r._cy) <= yTol) { r.items.push(w); r._cy = (r._cy * r.items.length + w.cy) / (r.items.length + 1); placed = true; break; }
    }
    if (!placed) rows.push({ _cy: w.cy, items: [w] });
  }
  // Columns per row by x gaps; then normalize number of columns by majority length
  const grid = rows.map(r => {
    const sorted = r.items.sort((a, b) => a.x - b.x);
    const xGap = estimateXgap(sorted);
    const cells = [];
    let cur = '';
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      if (i > 0) {
        const prev = sorted[i - 1];
        const gap = (w.x - (prev.x + prev.w));
        if (gap > xGap * 0.8) { cells.push(cur.trim()); cur = ''; }
        else cur += ' ';
      }
      cur += w.text;
    }
    if (cur.trim().length) cells.push(cur.trim());
    return cells;
  });
  const csv = grid.map(r => r.map(s => csvEscape(s)).join(',')).join('\n');
  return { cells: grid, csv, bboxes: items.map(w => ({ x: w.x, y: w.y, w: w.w, h: w.h })) };
}

// Helpers
function toWord(it) {
  const [a, b, c, d, e, f] = it.transform || [1, 0, 0, 1, 0, 0];
  const x = e;
  const y = f;
  const w = it.width || Math.abs(a);
  const h = it.height || Math.abs(d);
  return { text: it.str || '', x, y, w, h, cy: y + h / 2 };
}
function estimateYtol(items) {
  const ys = items.map(w => w.cy).sort((x, y) => x - y);
  if (ys.length < 4) return 4;
  const diffs = [];
  for (let i = 1; i < ys.length; i++) diffs.push(ys[i] - ys[i - 1]);
  diffs.sort((a, b) => a - b);
  return Math.max(4, diffs[Math.floor(diffs.length * 0.2)] || 4);
}
function estimateXgap(sorted) {
  if (!sorted.length) return 24;
  const diffs = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    diffs.push(cur.x - (prev.x + prev.w));
  }
  diffs.sort((a, b) => a - b);
  return Math.max(12, diffs[Math.floor(diffs.length * 0.6)] || 12);
}
function csvEscape(s) {
  if (s == null) return '';
  const t = String(s);
  if (/[",\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

