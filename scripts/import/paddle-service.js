/**
 * Client for local PaddleOCR PP-Structure microservice.
 * @file scripts/import/paddle-service.js
 */

const DEFAULT_BASE = 'http://127.0.0.1:5001';
const BASE = (typeof localStorage !== 'undefined' && localStorage.getItem('PADDLE_BASE')) || DEFAULT_BASE;

/**
 * Check server health.
 * @returns {Promise<boolean>}
 */
export async function serverHealthy() {
  try {
    const url = BASE.replace(/\/$/, '') + '/health';
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
  const url = BASE.replace(/\/$/, '') + '/pp/table';
  const fd = new FormData();
  fd.append('file', imageOrPdfBlob, 'page.png');
  if (roi && typeof roi === 'object') fd.append('roi', JSON.stringify(roi));
  try {
    const res = await fetch(url, { method: 'POST', body: fd, mode: 'cors' });
    if (!res.ok) throw new Error(`PaddleOCR hata: ${res.status}`);
    return await res.json();
  } catch (err) {
    // Mixed content or PNA handling
    if (location.protocol === 'https:' && /^http:\/\//.test(BASE)) {
      console.warn('HTTPS sayfadan HTTP yerel sunucuya erişim engellendi (Mixed Content).');
    }
    throw err;
  }
}

export const __PADDLE_BASE__ = BASE; // for UI diagnostics

