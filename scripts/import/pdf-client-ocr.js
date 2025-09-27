/**
 * Browser OCR pipeline using Tesseract.js and optional OpenCV.js pre-processing.
 * @file scripts/import/pdf-client-ocr.js
 */

/**
 * Perform OCR on an image Blob. Uses a dedicated Tesseract worker.
 * Returns word-level boxes and confidences.
 * @param {Blob} imageBlob
 * @param {{lang?:string, psm?:number}} [opts]
 * @returns {Promise<{words:Array<{text:string, conf:number, bbox:{x:number,y:number,w:number,h:number}}>, lines:string[], plainText:string}>}
 */
export async function ocrClient(imageBlob, { lang = 'eng+tur', psm = 6 } = {}) {
  const { createWorker } = Tesseract;
  const worker = await createWorker(lang, 1, { workerPath: undefined });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
    const img = await blobToDataURL(imageBlob);
    const resp = await worker.recognize(img);
    const words = (resp.data.words || []).map(w => ({
      text: w.text,
      conf: (w.confidence ?? w.conf ?? 0) / 100,
      bbox: { x: w.bbox.x0, y: w.bbox.y0, w: (w.bbox.x1 - w.bbox.x0), h: (w.bbox.y1 - w.bbox.y0) },
    }));
    const lines = (resp.data.lines || []).map(l => l.text);
    const plainText = resp.data.text || lines.join('\n');
    return { words, lines, plainText };
  } finally {
    await worker.terminate();
  }
}

/**
 * Simple table builder from OCR words with optional OpenCV line enhancement.
 * Heuristic approach: grid by projecting word boxes to rows/cols via y/x clustering.
 * @param {Array<{text:string, conf:number, bbox:{x:number,y:number,w:number,h:number}}>} words
 * @param {{x:number,y:number,w:number,h:number}} [roi] optional ROI used for normalization
 * @param {{useOpenCV?:boolean}} [opts]
 * @returns {{cells:string[][], csv:string, bboxes:Array<{x:number,y:number,w:number,h:number}>, confidence:number}}
 */
export function tableFromOcr(words, roi, { useOpenCV = true } = {}) {
  // OpenCV pre-processing is handled in upstream image; here we only cluster
  const items = Array.isArray(words) ? words : [];
  if (!items.length) return { cells: [], csv: '', bboxes: [], confidence: 0 };
  const ys = items.map(w => w.bbox.y + w.bbox.h / 2).sort((a, b) => a - b);
  const yTol = percentileDiff(ys, 0.02) || 6; // px tolerance
  // Build row clusters
  const rows = [];
  for (const w of items.slice().sort((a, b) => (a.bbox.y - b.bbox.y))) {
    let placed = false;
    for (const r of rows) {
      const cy = r._cy;
      const wy = w.bbox.y + w.bbox.h / 2;
      if (Math.abs(wy - cy) <= yTol) { r.items.push(w); r._cy = (cy * r.items.length + wy) / (r.items.length + 1); placed = true; break; }
    }
    if (!placed) rows.push({ _cy: w.bbox.y + w.bbox.h / 2, items: [w] });
  }
  // For each row, cluster by x gaps
  const table = [];
  for (const r of rows) {
    const sorted = r.items.sort((a, b) => a.bbox.x - b.bbox.x);
    const xCenters = sorted.map(w => w.bbox.x + w.bbox.w / 2);
    const xGap = estimateGap(xCenters);
    const cells = [];
    let cur = '';
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      if (i > 0) {
        const prev = sorted[i - 1];
        const gap = (w.bbox.x - (prev.bbox.x + prev.bbox.w));
        if (gap > xGap * 0.8) { cells.push(cur.trim()); cur = ''; }
        else cur += ' ';
      }
      cur += w.text;
    }
    if (cur.trim().length) cells.push(cur.trim());
    table.push(cells);
  }
  // Confidence: average of word confs
  const conf = items.reduce((s, w) => s + (w.conf || 0), 0) / (items.length || 1);
  const csv = table.map(row => row.map(s => csvEscape(s)).join(',')).join('\n');
  return { cells: table, csv, bboxes: items.map(w => w.bbox), confidence: conf };
}

// Helpers
function percentileDiff(sorted, p) {
  if (!sorted || !sorted.length) return 0;
  const i = Math.max(1, Math.floor(sorted.length * p));
  return sorted[i] - sorted[0];
}
function estimateGap(xs) {
  if (!xs.length) return 24;
  const diffs = [];
  for (let i = 1; i < xs.length; i++) diffs.push(xs[i] - xs[i - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length * 0.75)] || 24;
}
function csvEscape(s) {
  if (s == null) return '';
  const t = String(s);
  if (/[",\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}
async function blobToDataURL(blob) {
  return await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

