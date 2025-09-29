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
    const dom = new DOMParser().parseFromString(String(html||''), 'text/html');
    const table = dom.querySelector('table');
    if (!table) return [];
    const cells = [];
    table.querySelectorAll('tr').forEach(tr => {
      const row = [];
      tr.querySelectorAll('th,td').forEach(td => row.push(td.textContent.trim()));
      if (row.length) cells.push(row);
    });
    return cells;
  } catch (_) { return []; }
}

/**
 * Call Space with an image blob and optional ROI (ignored by Space).
 * Returns a Paddle-like payload.
 */
export async function ocrHFSpace(imageBlob, _roi) {
  const base = getBaseHF();
  const fd = new FormData();
  fd.append('file', imageBlob, 'page.png');
  const res = await fetch(base.replace(/\/$/,'') + '/pp/table', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('HF Space API erişilemedi');
  const js = await res.json();
  if (!js.cells || !js.cells.length) js.cells = htmlTableToCells(js.html);
  return js;
}

// Expose for UI binding
// eslint-disable-next-line no-undef
window.HFSpaceClient = { setBase: setHFBase, getBase: getHFBase, healthy: hfHealthy };
