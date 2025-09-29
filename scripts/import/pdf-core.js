/**
 * PDF core helpers using pdf.js and pdf-lib.
 * Relies on global `pdfjsLib` (loaded from CDN in index.html).
 * All functions are side-effect free and return Promises.
 * @file scripts/import/pdf-core.js
 */

/**
 * @typedef {import('pdfjs-dist').PDFDocumentProxy} PDFDocumentProxy
 */

/**
 * Load a PDF from a File, Blob, ArrayBuffer or URL into a pdf.js document.
 * @param {File|Blob|ArrayBuffer|string} fileOrUrl
 * @returns {Promise<PDFDocumentProxy>}
 */
export async function loadPdf(fileOrUrl) {
  let data = fileOrUrl;
  if (typeof fileOrUrl === 'string') {
    // url
    return await pdfjsLib.getDocument({ url: fileOrUrl }).promise;
  }
  if (fileOrUrl instanceof Blob || fileOrUrl instanceof File) {
    data = await fileOrUrl.arrayBuffer();
  }
  return await pdfjsLib.getDocument({ data }).promise;
}

/**
 * Render page thumbnails into a container.
 * @param {PDFDocumentProxy} pdf
 * @param {HTMLElement} containerEl
 * @returns {Promise<HTMLCanvasElement[]>}
 */
export async function renderThumbnails(pdf, containerEl) {
  containerEl.innerHTML = '';
  const canvases = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 0.2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.dataset.pageNo = String(i);
    const ctx = canvas.getContext('2d');
    // eslint-disable-next-line no-await-in-loop
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
    containerEl.appendChild(canvas);
  }
  return canvases;
}

/**
 * Get text items for a page using pdf.js textContent API.
 * @param {PDFDocumentProxy} pdf
 * @param {number} pageNo 1-based
 * @returns {Promise<Array<{str:string, transform:number[], width:number, height?:number}>>}
 */
export async function getPageTextItems(pdf, pageNo) {
  const page = await pdf.getPage(pageNo);
  const tc = await page.getTextContent();
  return tc.items.map(it => ({ str: it.str, transform: it.transform, width: it.width, height: it.height }));
}

/**
 * Detect PDF kind by text density. Heuristic: if text items > 200 or text width coverage > threshold, call it vector.
 * @param {Array<{str:string, transform:number[], width:number}>} textItems
 * @returns {'vector'|'scan'}
 */
export function detectPdfKind(textItems) {
  if (!Array.isArray(textItems) || textItems.length === 0) return 'scan';
  const count = textItems.length;
  const totalChars = textItems.reduce((s, it) => s + (it.str ? it.str.length : 0), 0);
  if (count > 150 || totalChars > 600) return 'vector';
  // Else likely scanned
  return 'scan';
}

/**
 * Render a page to image and optionally crop to ROI.
 * @param {PDFDocumentProxy} pdf
 * @param {number} pageNo 1-based
 * @param {{x:number,y:number,w:number,h:number}|null} bbox canvas-space normalized [0..1] if negative treated as null
 * @param {number} [scale] default 2.0 for better OCR
 * @returns {Promise<Blob>} PNG blob
 */
export async function cropPageToImage(pdf, pageNo, bbox, scale = undefined) {
  const page = await pdf.getPage(pageNo);
  // Determine an OCR-friendly scale if not provided: aim for a high-DPI raster
  // so that small text and thin grid lines survive later resampling.
  let effScale = Number(scale);
  if (!isFinite(effScale) || effScale <= 0) {
    // Allow user override via localStorage
    try {
      const s = Number(localStorage.getItem('OCR_SCALE') || '');
      if (isFinite(s) && s > 0) effScale = s;
    } catch (_) { /* ignore */ }
    if (!isFinite(effScale) || effScale <= 0) {
      // Compute scale to reach a target long edge in pixels at scale 1.0
      const vp1 = page.getViewport({ scale: 1.0 });
      const long1 = Math.max(vp1.width, vp1.height);
      let target = 3200; // default target long edge in px (~300 DPI for A4)
      try {
        const t = Number(localStorage.getItem('OCR_LONG_EDGE') || '');
        if (isFinite(t) && t > 0) target = t;
      } catch (_) { /* ignore */ }
      effScale = target / Math.max(1, long1);
      // Clamp to keep memory/latency reasonable
      effScale = Math.max(2.0, Math.min(5.0, effScale));
    }
  }
  const viewport = page.getViewport({ scale: effScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  if (!bbox || bbox.w <= 0 || bbox.h <= 0) {
    return await new Promise(res => canvas.toBlob(b => res(b), 'image/png'));
  }
  const rx = Math.max(0, Math.min(1, bbox.x));
  const ry = Math.max(0, Math.min(1, bbox.y));
  const rw = Math.max(0, Math.min(1, bbox.w));
  const rh = Math.max(0, Math.min(1, bbox.h));
  const sx = Math.floor(rx * canvas.width);
  const sy = Math.floor(ry * canvas.height);
  const sw = Math.floor(rw * canvas.width);
  const sh = Math.floor(rh * canvas.height);

  const out = document.createElement('canvas');
  out.width = Math.max(1, sw);
  out.height = Math.max(1, sh);
  const octx = out.getContext('2d');
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return await new Promise(res => out.toBlob(b => res(b), 'image/png'));
}
