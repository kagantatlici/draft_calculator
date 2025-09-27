/**
 * Client for local PaddleOCR PP-Structure microservice.
 * @file scripts/import/paddle-service.js
 */

const DEFAULT_BASE = 'http://127.0.0.1:5001';

function getBase() {
  // Allows overriding via window.PADDLE_OCR_BASE or localStorage
  if (typeof window !== 'undefined' && window.PADDLE_OCR_BASE) return String(window.PADDLE_OCR_BASE);
  if (typeof localStorage !== 'undefined') {
    const v = localStorage.getItem('PADDLE_BASE');
    if (v && v.trim().length) return v.trim();
  }
  return DEFAULT_BASE;
}

/** Save base URL and return it */
export function setPaddleBase(url) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('PADDLE_BASE', String(url||'').trim()); } catch (_) {}
  if (typeof window !== 'undefined') window.PADDLE_OCR_BASE = String(url||'').trim();
  return getBase();
}

export function getPaddleBase() { return getBase(); }

/**
 * Check server health.
 * @returns {Promise<boolean>}
 */
export async function serverHealthy() {
  try {
    const url = getBase().replace(/\/$/, '') + '/health';
    const res = await fetch(url, { method: 'GET', mode: 'cors' });
    return res.ok;
  } catch (err) {
    return false;
  }
}

/**
 * Call the server OCR endpoint with an image/PDF Blob and optional ROI.
 * @param {Blob} imageOrPdfBlob
 * @param {{x?:number,y?:number,w?:number,h?:number}} [roi]
 * @returns {Promise<{html?:string,cells?:string[][],csv?:string,bboxes?:Array<{x:number,y:number,w:number,h:number}>,confidence?:number}>}
 */
export async function ocrPaddle(imageOrPdfBlob, roi) {
  const healthy = await serverHealthy();
  if (!healthy) throw new Error('PaddleOCR sunucusu erişilemiyor (healthcheck başarısız).');
  const url = getBase().replace(/\/$/, '') + '/pp/table';
  const fd = new FormData();
  fd.append('file', imageOrPdfBlob, 'page.png');
  if (roi && typeof roi === 'object') fd.append('roi', JSON.stringify(roi));
  try {
    const res = await fetch(url, { method: 'POST', body: fd, mode: 'cors' });
    if (!res.ok) throw new Error(`PaddleOCR hata: ${res.status}`);
    return await res.json();
  } catch (err) {
    // Mixed content or PNA handling
    const baseNow = getBase();
    if (location.protocol === 'https:' && /^http:\/\//.test(baseNow)) {
      console.warn('HTTPS sayfadan HTTP yerel sunucuya erişim engellendi (Mixed Content).');
    }
    throw err;
  }
}

export const __PADDLE_BASE__ = getBase(); // for UI diagnostics
