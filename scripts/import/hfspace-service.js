/**
 * Client for Hugging Face Space (Gradio) OCR app that accepts an image and
 * returns [html, csv, info]. Provides a Paddle-like interface for the wizard.
 */

const DEFAULT_HF_BASE = 'https://Kagantatlici-draft-calculator-ocr.hf.space';

function getBaseHF() {
  try {
    const v = localStorage.getItem('HF_SPACE_BASE');
    if (v && /^https?:\/\//i.test(v)) return v.trim().replace(/\/$/, '');
  } catch (_) {}
  return DEFAULT_HF_BASE;
}

export function setHFBase(url) {
  try { localStorage.setItem('HF_SPACE_BASE', String(url||'').trim()); } catch (_){ }
  return getBaseHF();
}
export function getHFBase() { return getBaseHF(); }

export async function hfHealthy() {
  try {
    const res = await fetch(getBaseHF() + '/', { method: 'GET' });
    return res.ok;
  } catch (_) { return false; }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
}

function htmlTableToCells(html) {
  try {
    const dom = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const table = dom.querySelector('table');
    if (!table) return [];

    const rows = [...table.querySelectorAll('tr')];
    const grid = [];
    let maxCols = 0;
    const getSpan = (el, name) => {
      const v = parseInt(el.getAttribute(name) || '1', 10);
      return Number.isFinite(v) && v > 0 ? v : 1;
    };

    for (let r = 0; r < rows.length; r++) {
      const tr = rows[r];
      if (!grid[r]) grid[r] = [];
      let c = 0;
      const cells = [...tr.querySelectorAll('th,td')];
      for (const cell of cells) {
        // advance c to next free slot (may be occupied by a previous rowSpan)
        while (grid[r][c] !== undefined) c++;
        const colSpan = getSpan(cell, 'colspan');
        const rowSpan = getSpan(cell, 'rowspan');
        const text = (cell.textContent || '').trim();

        for (let rr = 0; rr < rowSpan; rr++) {
          const row = grid[r + rr] || (grid[r + rr] = []);
          for (let cc = 0; cc < colSpan; cc++) {
            // Fill the spanned grid positions. Repeat text so header spans align with body columns.
            row[c + cc] = text;
          }
        }
        c += colSpan;
        if (grid[r].length > maxCols) maxCols = grid[r].length;
      }
      if (grid[r].length > maxCols) maxCols = grid[r].length;
    }

    // Normalize row widths and trim leading empty rows
    const isEmpty = (v) => v == null || String(v).trim() === '';
    const isEmptyRow = (row) => row.every(isEmpty);
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      for (let c = 0; c < maxCols; c++) {
        if (row[c] === undefined) row[c] = '';
      }
    }
    while (grid.length && isEmptyRow(grid[0])) grid.shift();

    return grid;
  } catch (_) {
    return [];
  }
}

/**
 * Call Space with an image blob and optional ROI (ignored by Space).
 * Returns a Paddle-like payload.
 */
export async function ocrHFSpace(imageBlob, _roi) {
  const base = getHFBase().replace(/\/$/, '');
  // Use the server's canonical REST route, now aligned with Gradio's preprocessing.
  const fd = new FormData();
  fd.append('file', imageBlob, 'page.png');
  const res = await fetch(base + '/pp/table', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('HF Space API erişilemedi');
  const js = await res.json();
  if (!js.cells || !js.cells.length) js.cells = htmlTableToCells(js.html);
  return js;
}

// Structure-first (Table Transformer) endpoint
export async function ocrHFStructure(imageBlob) {
  const base = getHFBase().replace(/\/$/, '');
  const fd = new FormData();
  fd.append('file', imageBlob, 'page.png');
  const res = await fetch(base + '/tt/table', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('HF Space Structure API erişilemedi');
  const js = await res.json();
  if (!js.cells || !js.cells.length) js.cells = htmlTableToCells(js.html);
  return js;
}

// Expose for UI binding
// eslint-disable-next-line no-undef
window.HFSpaceClient = { setBase: setHFBase, getBase: getHFBase, healthy: hfHealthy };
