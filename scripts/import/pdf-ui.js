/**
 * PDF Import Wizard UI. Creates an accessible modal and drives extraction.
 * Mounts on #btnImportWizard click and uses modules: pdf-core, pdf-client-ocr, pdf-structure, paddle-service.
 * @file scripts/import/pdf-ui.js
 */

import { loadPdf, renderThumbnails, getPageTextItems, detectPdfKind, cropPageToImage } from './pdf-core.js';
import { ocrClient, tableFromOcr } from './pdf-client-ocr.js';
import { clusterToTable } from './pdf-structure.js';
import { mapHeaders, normalizeCellText, validateHydro, toHydrostaticsJson } from './table-map-validate.js';
import { hfHealthy, getHFBase } from './hfspace-service.js?v=lp3';
import { normalizeHydroCells } from './table-normalize.js?v=lp3';
import { parseWithLlamaParse } from './llamaparse-service.js?v=lp3';

// Keep overlay mount available but don't auto-bind to header (UX: open from Gemi Ekle)

/**
 * Mount the PDF import modal wizard and control its lifecycle.
 */
  export function mountImportWizard() {
    let state = {
      pdf: null,
      file: null,
      pageNo: 1,
      kind: 'scan',
      rois: {}, // per-page ROI: { [pageNo]: {x,y,w,h} in [0..1] }
      table: null, // legacy single table {cells,csv,bboxes,confidence}
      tables: [], // multi-table support: Array<{cells,csv?,bboxes?,confidence?}>
      activeTable: 0, // index into tables
      selectedPages: [], // multi-select support for LlamaParse (1-based)
    };
  const overlay = document.getElementById('pdf-import-overlay');
  if (!overlay) return alert('PDF sihirbazı kapsayıcı bulunamadı.');
  overlay.innerHTML = renderModalHTML();
  overlay.style.display = 'block';
  overlay.setAttribute('aria-hidden', 'false');
  // Focus trap
  const firstFocus = overlay.querySelector('input,button,select,textarea');
  if (firstFocus) firstFocus.focus();
  bindBasics();

  async function bindBasics() {
    // Close
    overlay.querySelector('#pdfwiz-close')?.addEventListener('click', onClose);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') onClose(); });
    // File input
    overlay.querySelector('#pdfwiz-file')?.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      state.file = f;
      overlay.querySelector('#pdfwiz-status').textContent = `Yükleniyor: ${f.name}`;
      const isImage = /^image\//i.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name || '');
      if (isImage) {
        // Image mode: bypass pdf.js, send blob directly
        state.pdf = null;
        state.pageNo = 1;
        state.kind = 'scan';
        // Clear thumbs
        const grid = overlay.querySelector('#pdfwiz-thumbs'); if (grid) grid.innerHTML = '';
        overlay.querySelector('#pdfwiz-kind').textContent = 'Görüntü (PNG/JPG)';
        // Go choose method and extract
        gotoStep(2);
      } else {
        // PDF mode
        state.pdf = await loadPdf(f);
        await populateThumbs();
        // ROI seçimi artık zorunlu değil; yönteme geç
        gotoStep(2);
      }
    });
    // Search
    overlay.querySelector('#pdfwiz-search')?.addEventListener('input', onSearch);
    // Method toggles
    const hint = overlay.querySelector('#lp-hint');
    const ok = await hfHealthy();
    if (hint) hint.textContent = ok ? `LlamaParse proxy: ${getHFBase()}` : 'Space ulaşılamıyor.';
    // Next buttons (ROI adımı kaldırıldı)
    overlay.querySelector('#go-method')?.addEventListener('click', ()=> gotoStep(2));
    overlay.querySelector('#go-extract')?.addEventListener('click', runExtraction);
    overlay.querySelector('#go-apply')?.addEventListener('click', applyToApp);
    overlay.querySelector('#go-download')?.addEventListener('click', downloadJson);
  }

  async function populateThumbs() {
    const grid = overlay.querySelector('#pdfwiz-thumbs');
    grid.innerHTML = '';
    const canvases = await renderThumbnails(state.pdf, grid);
    canvases.forEach(cv => {
      cv.classList.add('thumb');
      const pageNo = Number(cv.dataset.pageNo);
      // Wrap canvas to host checkbox
      const wrap = document.createElement('div');
      wrap.className = 'thumb-wrap';
      wrap.setAttribute('data-page', String(pageNo));
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'thumb-check';
      chk.setAttribute('aria-label', `Sayfa ${pageNo} seç`);
      const lbl = document.createElement('span');
      lbl.className = 'thumb-checkmark';
      wrap.appendChild(cv);
      wrap.appendChild(chk);
      wrap.appendChild(lbl);
      grid.appendChild(wrap);
      function sync() {
        const sel = state.selectedPages.includes(pageNo);
        chk.checked = sel;
        wrap.classList.toggle('selected', sel);
      }
      wrap.addEventListener('click', (e) => {
        // Toggle selection on click anywhere in the thumbnail
        if (e.target === chk) return; // checkbox handles itself
        const i = state.selectedPages.indexOf(pageNo);
        if (i >= 0) state.selectedPages.splice(i,1); else state.selectedPages.push(pageNo);
        selectPage(pageNo); // also make it active
        sync();
      });
      chk.addEventListener('change', () => {
        const i = state.selectedPages.indexOf(pageNo);
        if (chk.checked) { if (i < 0) state.selectedPages.push(pageNo); }
        else { if (i >= 0) state.selectedPages.splice(i,1); }
        selectPage(pageNo);
        sync();
      });
      sync();
    });
    selectPage(1);
  }

  async function selectPage(no) {
    state.pageNo = no;
    overlay.querySelector('#pdfwiz-pageno').textContent = String(no);
    if (state.pdf) {
      const items = await getPageTextItems(state.pdf, no);
      state.kind = detectPdfKind(items);
      overlay.querySelector('#pdfwiz-kind').textContent = state.kind === 'vector' ? 'Metin tabanlı' : 'Taranmış';
    }
    await renderRoiCanvas();
  }

  // ROI çizim tuvali: kullanıcı seçim yaparsa otomatik ROI bypass
  async function renderRoiCanvas() {
    const cv = overlay.querySelector('#pdfwiz-roi');
    if (!cv || !state.pdf) { return; }
    const page = await state.pdf.getPage(state.pageNo);
    const viewport = page.getViewport({ scale: 0.8 });
    cv.width = Math.ceil(viewport.width);
    cv.height = Math.ceil(viewport.height);
    const ctx = cv.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    // draw existing ROI if present
    const roi = state.rois[state.pageNo];
    if (roi) {
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.setLineDash([6,4]);
      ctx.strokeRect(roi.x*cv.width, roi.y*cv.height, roi.w*cv.width, roi.h*cv.height);
      ctx.restore();
    }
    bindRoiInteractions(cv);
  }

  function bindRoiInteractions(cv) {
    let dragging = false; let startX=0, startY=0; let curX=0, curY=0;
    const onDown = (e) => {
      const rect = cv.getBoundingClientRect();
      startX = (e.clientX - rect.left) / rect.width;
      startY = (e.clientY - rect.top) / rect.height;
      curX = startX; curY = startY;
      dragging = true;
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const rect = cv.getBoundingClientRect();
      curX = (e.clientX - rect.left) / rect.width;
      curY = (e.clientY - rect.top) / rect.height;
      const x = Math.min(startX, curX), y = Math.min(startY, curY);
      const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
      state.rois[state.pageNo] = { x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) };
      // redraw with ROI
      renderRoiCanvas();
      e.preventDefault();
    };
    const onUp = () => { dragging = false; };
    // Bind once per canvas render
    cv.onmousedown = onDown;
    cv.onmousemove = onMove;
    cv.onmouseup = onUp;
    cv.onmouseleave = onUp;
    // touch support
    cv.ontouchstart = (e)=>{ if (e.touches[0]) onDown(e.touches[0]); };
    cv.ontouchmove = (e)=>{ if (e.touches[0]) onMove(e.touches[0]); };
    cv.ontouchend = onUp;
    // Clear button
    const clearBtn = overlay.querySelector('#pdfwiz-roi-clear');
    if (clearBtn) clearBtn.onclick = ()=>{ delete state.rois[state.pageNo]; renderRoiCanvas(); };
  }

  function clamp01(v){ return Math.max(0, Math.min(1, v)); }

  async function runExtraction() {
    const method = overlay.querySelector('input[name="method"]:checked')?.value || 'client';
    const status = overlay.querySelector('#pdfwiz-status');
    status.textContent = 'Çıkarım çalışıyor...';
    const isImageUpload = state.file && (/^image\//i.test(state.file.type) || /\.(png|jpe?g|webp)$/i.test(state.file.name||''));
    const curRoi = state.rois[state.pageNo] || null;
    const image = isImageUpload ? state.file : await cropPageToImage(state.pdf, state.pageNo, curRoi);
    let table = null;
    try {
      if (method === 'client') {
        // If vector, try structure; else OCR
        if (state.kind === 'vector') {
          const items = await getPageTextItems(state.pdf, state.pageNo);
          table = clusterToTable(items);
        } else {
          const ocr = await ocrClient(image, { lang: 'eng+tur', psm: 6 });
          table = tableFromOcr(ocr.words, null, { useOpenCV: true });
        }
      } else if (method === 'llamaparse') {
        try {
          // If original upload was a PDF, respect selected pages and ROI. Build a new PDF:
          let toSend = state.file || image;
          const isPdf = state.file && ((state.file.type||'').includes('pdf') || /\.pdf$/i.test(state.file.name||''));
          if (isPdf && typeof window.PDFLib !== 'undefined' && state.pdf) {
            const PDFDocument = window.PDFLib.PDFDocument;
            const newDoc = await PDFDocument.create();
            const total = state.pdf.numPages;
            const pages = Array.from(new Set((state.selectedPages||[]).filter(n=> n>=1 && n<=total)));
            const usePages = pages.length ? pages : [state.pageNo];
            try {
              // If any ROI is set, rasterize all selected pages to images with ROI/no-ROI and embed as image pages
              const anyRoi = usePages.some(p => !!state.rois[p]);
              if (anyRoi) {
                for (const p of usePages) {
                  const roi = state.rois[p] || null;
                  const blob = await cropPageToImage(state.pdf, p, roi);
                  const bytes = new Uint8Array(await blob.arrayBuffer());
                  const png = await newDoc.embedPng(bytes);
                  const { width, height } = png.scale(1);
                  const page = newDoc.addPage([width, height]);
                  page.drawImage(png, { x: 0, y: 0, width, height });
                }
              } else {
                // No ROI -> copy full pages losslessly from original file bytes
                const origBytes = await state.file.arrayBuffer();
                const src = await PDFDocument.load(origBytes);
                const copied = await newDoc.copyPages(src, usePages.map(n=>n-1));
                copied.forEach(p => newDoc.addPage(p));
              }
              const outBytes = await newDoc.save();
              toSend = new Blob([outBytes], { type: 'application/pdf' });
            } catch(_) { /* fallback to original file/image */ }
          }
          const lp = await parseWithLlamaParse(toSend);
          // Normalize each detected table if possible (wide->tall)
          const tables = Array.isArray(lp.tables) && lp.tables.length ? lp.tables : [lp.cells || []];
          const normTables = tables.map(cells => {
            const norm = normalizeHydroCells(cells);
            return { cells: (norm && norm.length) ? norm : cells, csv: lp.markdown || lp.md || '' };
          });
          state.tables = normTables;
          state.table = normTables[0] || { cells: [], csv: '' };
          state.activeTable = 0;
          table = null; // handled via state.tables
        } catch (err) { status.textContent = 'LlamaParse hatası: ' + (err.message || err); return; }
      }
    } catch (err) {
      console.error(err);
      status.textContent = `Hata: ${err.message || err}`;
      return;
    }
    if (method === 'client') {
      state.table = table || { cells: [], csv: '', bboxes: [], confidence: 0 };
      state.tables = [state.table];
      state.activeTable = 0;
    }
    renderTablePreview();
    gotoStep(3);
    status.textContent = 'Bitti.';
  }

  function renderTablePreview() {
    const tables = Array.isArray(state.tables) ? state.tables : (state.table ? [state.table] : []);
    const scroller = overlay.querySelector('#pdfwiz-preview-scroller');
    const tabs = overlay.querySelector('#pdfwiz-tabs');
    if (tabs) tabs.innerHTML = '';
    if (scroller) scroller.innerHTML = '';
    if (!tables.length || !tables[0].cells || !tables[0].cells.length) {
      if (scroller) scroller.innerHTML = '<div class="info" style="padding:8px;">Tablo tespit edilemedi. Farklı yöntem deneyin.</div>';
      return;
    }
    // Tabs for multiple tables/pages
    if (tabs) {
      const frag = document.createDocumentFragment();
      tables.forEach((t, i) => {
        const b = document.createElement('button');
        b.className = 'tab small' + (i===state.activeTable ? ' active' : '');
        b.textContent = `Tablo ${i+1}`;
        b.addEventListener('click', ()=>{ state.activeTable = i; renderTablePreview(); });
        frag.appendChild(b);
      });
      tabs.appendChild(frag);
    }
    const cur = tables[state.activeTable] || tables[0];
    const cells = cur.cells;
    const meta = overlay.querySelector('#pdfwiz-preview-meta');
    if (meta) meta.textContent = `Satır: ${cells.length} • Sütun: ${Math.max(...cells.map(r=>r.length))}`;
    const tbl = document.createElement('table');
    tbl.className = 'pdf-table';
    for (let r = 0; r < Math.min(80, cells.length); r++) {
      const tr = document.createElement('tr');
      const row = cells[r];
      for (let c = 0; c < Math.min(16, row.length); c++) {
        const td = document.createElement(r===0? 'th':'td');
        td.textContent = row[c];
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    scroller.appendChild(tbl);
    // Header mapping UI from current table's first row
    const headers = cells[0] || [];
    const m = mapHeaders(headers);
    const mapBox = overlay.querySelector('#pdfwiz-map');
    mapBox.innerHTML = renderMapUI(headers, m);
    const mapAll = overlay.querySelector('#map-apply-all');
    const applyBtn = overlay.querySelector('#apply-map');
    applyBtn?.addEventListener('click', ()=> applyMapping(headers, mapAll?.checked));
  }

  function applyMapping(headers, applyToAll = true) {
    const fields = ['draft_m','lcf_m','tpc_t_per_cm','mct1cm_t_m_per_cm'];
    const col = {};
    for (const f of fields) {
      const v = overlay.querySelector(`#map-${f}`)?.value;
      col[f] = v===''? null : Number(v);
    }
    // Build rows skipping header; aggregate across tables if requested
    const rows = [];
    const tables = applyToAll ? (state.tables||[]) : [state.tables[state.activeTable]];
    for (const t of tables) {
      const grid = (t && t.cells) ? t.cells : [];
      for (let r = 1; r < grid.length; r++) {
        const row = grid[r];
        const draft = toNum(row[col.draft_m]);
        if (!isFinite(draft)) continue;
        rows.push({
          draft_m: draft,
          lcf_m: toNum(row[col.lcf_m]),
          tpc_t_per_cm: toNum(row[col.tpc_t_per_cm]),
          mct1cm_t_m_per_cm: toNum(row[col.mct1cm_t_m_per_cm]),
        });
      }
    }
    const appLBP = (window.SHIP?.LBP) || (window.SHIP_ACTIVE?.LBP) || 100;
    const rowsCompat = rows.map(r=> ({ draft_m: r.draft_m, lcf_m: r.lcf_m, tpc: r.tpc_t_per_cm, mct: r.mct1cm_t_m_per_cm }));
    const v = validateHydro(rowsCompat, { LBP: appLBP });
    const rep = overlay.querySelector('#pdfwiz-validate');
    rep.innerHTML = renderValidation(v);
    overlay.dataset.rows = JSON.stringify(rows);
  }

  function applyToApp() {
    const rows = JSON.parse(overlay.dataset.rows || '[]');
    if (!rows.length) { alert('Aktarılacak satır bulunamadı.'); return; }
    const compat = rows.map(r=> ({ draft_m: r.draft_m, lcf_m: r.lcf_m, tpc: r.tpc_t_per_cm, mct: r.mct1cm_t_m_per_cm }));
    if (typeof window.applyHydrostaticsJson === 'function') {
      window.applyHydrostaticsJson({ rows: compat });
      alert('Hydrostatik tablo uygulandı.');
      onClose();
    } else {
      alert('applyHydrostaticsJson bulunamadı. Güncelleme yapılamadı.');
    }
  }

  function downloadJson() {
    const rows = JSON.parse(overlay.dataset.rows || '[]');
    if (!rows.length) { alert('İndirilecek veri yok.'); return; }
    const hydro = toHydrostaticsJson(rows);
    const blob = new Blob([JSON.stringify(hydro, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hydrostatics_import.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function gotoStep(n) {
    overlay.querySelectorAll('.pdfwiz-step').forEach((el, i) => { el.style.display = (i === (n-1)) ? 'block' : 'none'; });
  }
  function onSearch(e) { /* future: highlight thumbs by keyword via quick OCR or text */ }
  function onClose() {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '';
  }
  }

  // UI templates
  function renderModalHTML() {
    return `
  <div class="pdfwiz-modal">
    <div class="pdfwiz-header">
      <div>PDF’ten Veri İçe Aktarma</div>
      <button id="pdfwiz-close" class="secondary" aria-label="Kapat">Kapat</button>
    </div>
    <div class="pdfwiz-body">
      <div class="pdfwiz-step" data-step="1" style="display:block;">
        <h3>1) PDF/PNG Yükle + Sayfa Seç</h3>
        <input id="pdfwiz-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/*" />
        <div id="pdfwiz-thumbs" class="thumb-grid" aria-label="Sayfa küçük resimleri"></div>
        <div class="muted">Seçili sayfa: <span id="pdfwiz-pageno">-</span> • Tür: <span id="pdfwiz-kind">-</span></div>
        <div class="muted" style="margin-top:6px;">ROI (isteğe bağlı): ilgili alanı tuval üzerinde sürükleyerek çizin.</div>
        <canvas id="pdfwiz-roi" class="roi-canvas" aria-label="ROI seçim tuvali"></canvas>
        <div class="row"><button id="pdfwiz-roi-clear" class="secondary">ROI’yi Temizle</button></div>
        <div class="row">
          <input id="pdfwiz-search" type="search" placeholder="Anahtar kelime (Hydrostatic, TPC, MCT...)" />
          <button id="go-method">Devam ➜</button>
        </div>
      </div>
      <div class="pdfwiz-step" data-step="2" style="display:none;">
        <h3>2) Çıkarım Yöntemi</h3>
        <label title="LlamaParse (SaaS)"><input type="radio" id="method-llamaparse" name="method" value="llamaparse" checked /> LlamaParse (SaaS)</label>
        <label><input type="radio" name="method" value="client" /> Hızlı Tara (Tarayıcı‑içi)</label>
        <div id="lp-hint" class="muted"></div>
        <div class="row"><button id="go-extract">Tabloyu Çıkar ➜</button></div>
      </div>
      <div class="pdfwiz-step" data-step="3" style="display:none;">
        <h3>3) Önizleme + Eşleme + Doğrulama</h3>
        <div id="pdfwiz-tabs" class="tabs-row"></div>
        <div class="step3-layout">
          <div class="preview-pane">
            <div class="preview-head"><span id="pdfwiz-preview-meta" class="muted"></span></div>
            <div id="pdfwiz-preview-scroller" class="preview-scroller"></div>
          </div>
          <div class="side-pane">
            <div id="pdfwiz-map"></div>
            <div class="muted" style="margin:6px 0; display:flex; align-items:center; gap:8px;">
              <label style="display:flex; align-items:center; gap:6px;">
                <input id="map-apply-all" type="checkbox" checked /> Tüm tablolara uygula
              </label>
            </div>
            <div id="pdfwiz-validate" style="margin-top:8px;"></div>
          </div>
        </div>
        <div class="row"><button id="go-apply">App’e Aktar</button><button id="go-download" class="secondary">JSON indir</button></div>
      </div>
      <div id="pdfwiz-status" class="muted"></div>
    </div>
  </div>`;
  }

function renderMapUI(headers, mapping) {
  const opt = (id,label)=>{
    const options = ['<option value="">-</option>'].concat(headers.map((h,i)=>`<option value="${i}" ${mapping[id]===i? 'selected':''}>${i}: ${h}</option>`));
    return `<label class="map-field">${label}<select id="map-${id}">${options.join('')}</select></label>`;
  };
  return `<div class="map-box">
    <div class="muted">Kolon Eşleme</div>
    <div class="map-grid">
      ${opt('draft_m','Draft (m)')}
      ${opt('lcf_m','LCF (m)')}
      ${opt('tpc_t_per_cm','TPC (t/cm)')}
      ${opt('mct1cm_t_m_per_cm','MCT1cm (t·m/cm)')}
    </div>
    <button id="apply-map">Eşlemeyi Uygula</button>
  </div>`;
}

/**
 * Embedded mount: renders the wizard content into a provided container inside the existing Gemi Ekle modal.
 * @param {HTMLElement} container
 */
export function mountImportWizardEmbedded(container) {
  if (!container) return;
  container.innerHTML = renderModalHTML();
  // mark as embedded for styling
  const modal = container.querySelector('.pdfwiz-modal');
  if (modal) modal.classList.add('embedded');
  // override close to simply hide container
  const close = container.querySelector('#pdfwiz-close');
  if (close) close.addEventListener('click', ()=>{ container.style.display='none'; container.innerHTML=''; });
  // rewire internal mounting by creating a fake overlay reference targeting container
  const overlay = document.getElementById('pdf-import-overlay') || document.createElement('div');
  overlay.innerHTML = container.innerHTML; // not used directly, but keep API parity
  // Reuse core by temporarily injecting a hidden overlay element and calling mountImportWizard logic on it would be heavy.
  // Instead, lightly duplicate the init logic by triggering a synthetic click on file input to drive flow when user interacts.
  // Simpler: call mountImportWizard but swap its target to container by monkey-patching getElementById for this call.
  // For maintainability, we fallback to a minimal re-init: simulate the same handlers using the same helpers.
  // Bind basic handlers from the overlay we just rendered (container is our root)
  (function bind() {
    const file = container.querySelector('#pdfwiz-file');
    const status = container.querySelector('#pdfwiz-status');
    let pdfDoc = null, pageNo = 1, kind = 'scan', tables = [], imgBlob = null, selectedPages = [], activeTable = 0;
    file?.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      status.textContent = `Yükleniyor: ${f.name}`;
      const isImage = /^image\//i.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name||'');
      if (isImage) {
        imgBlob = f; pdfDoc = null; pageNo = 1; kind = 'scan'; tables = []; activeTable = 0;
        const grid = container.querySelector('#pdfwiz-thumbs'); if (grid) grid.innerHTML='';
        container.querySelector('#pdfwiz-kind').textContent = 'Görüntü (PNG/JPG)';
      } else {
        imgBlob = null; pdfDoc = await loadPdf(f);
        const grid = container.querySelector('#pdfwiz-thumbs');
        const canvases = await renderThumbnails(pdfDoc, grid);
        canvases.forEach(cv => {
          cv.classList.add('thumb');
          const no = Number(cv.dataset.pageNo);
          const wrap = document.createElement('div');
          wrap.className = 'thumb-wrap';
          wrap.setAttribute('data-page', String(no));
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.className = 'thumb-check';
          chk.setAttribute('aria-label', `Sayfa ${no} seç`);
          const lbl = document.createElement('span');
          lbl.className = 'thumb-checkmark';
          wrap.appendChild(cv);
          wrap.appendChild(chk);
          wrap.appendChild(lbl);
          grid.appendChild(wrap);
          function sync(){ const sel = selectedPages.includes(no); chk.checked = sel; wrap.classList.toggle('selected', sel); }
          wrap.addEventListener('click', (ev)=>{ if (ev.target===chk) return; const i=selectedPages.indexOf(no); if (i>=0) selectedPages.splice(i,1); else selectedPages.push(no); selectPage(no); sync(); });
          chk.addEventListener('change', ()=>{ const i=selectedPages.indexOf(no); if (chk.checked){ if(i<0) selectedPages.push(no);} else { if(i>=0) selectedPages.splice(i,1);} selectPage(no); sync(); });
          sync();
        });
        selectPage(1);
      }
    });
    async function selectPage(no){
      pageNo = no; container.querySelector('#pdfwiz-pageno').textContent = String(no);
      if (pdfDoc) {
        const items = await getPageTextItems(pdfDoc, no); kind = detectPdfKind(items);
        container.querySelector('#pdfwiz-kind').textContent = kind==='vector'?'Metin tabanlı':'Taranmış';
        await renderRoiEmbedded();
      }
    }
    async function renderRoiEmbedded(){
      const roiCanvas = container.querySelector('#pdfwiz-roi');
      if (!roiCanvas || !pdfDoc) return;
      const page = await pdfDoc.getPage(pageNo);
      const vp = page.getViewport({ scale: 0.8 });
      roiCanvas.width = Math.ceil(vp.width);
      roiCanvas.height = Math.ceil(vp.height);
      const ctx = roiCanvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const r = rois[pageNo];
      if (r) {
        ctx.save(); ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([6,4]); ctx.lineWidth = 2;
        ctx.strokeRect(r.x*roiCanvas.width, r.y*roiCanvas.height, r.w*roiCanvas.width, r.h*roiCanvas.height);
        ctx.restore();
      }
      bindRoiEmbedded(roiCanvas);
    }
    function bindRoiEmbedded(roiCanvas){
      let dragging=false, sx=0, sy=0, cx=0, cy=0;
      const clamp = (v)=> Math.max(0, Math.min(1, v));
      const onDown = (e)=>{ const rect=roiCanvas.getBoundingClientRect(); sx=(e.clientX-rect.left)/rect.width; sy=(e.clientY-rect.top)/rect.height; cx=sx; cy=sy; dragging=true; e.preventDefault(); };
      const onMove = (e)=>{ if(!dragging) return; const rect=roiCanvas.getBoundingClientRect(); cx=(e.clientX-rect.left)/rect.width; cy=(e.clientY-rect.top)/rect.height; const x=Math.min(sx,cx), y=Math.min(sy,cy), w=Math.abs(cx-sx), h=Math.abs(cy-sy); rois[pageNo]={x:clamp(x),y:clamp(y),w:clamp(w),h:clamp(h)}; renderRoiEmbedded(); e.preventDefault(); };
      const onUp = ()=>{ dragging=false; };
      roiCanvas.onmousedown = onDown; roiCanvas.onmousemove = onMove; roiCanvas.onmouseup=onUp; roiCanvas.onmouseleave=onUp;
      // touch support
      roiCanvas.ontouchstart = (e)=>{ if (e.touches[0]) onDown(e.touches[0]); };
      roiCanvas.ontouchmove = (e)=>{ if (e.touches[0]) onMove(e.touches[0]); };
      roiCanvas.ontouchend = onUp;
      const clr = container.querySelector('#pdfwiz-roi-clear'); if (clr) clr.onclick = ()=>{ delete rois[pageNo]; renderRoiEmbedded(); };
    }
    container.querySelector('#go-method')?.addEventListener('click', ()=> goto(2));
    container.querySelector('#go-extract')?.addEventListener('click', async ()=>{
      const method = container.querySelector('input[name="method"]:checked')?.value || 'client';
      status.textContent = 'Çıkarım çalışıyor...';
      const roi = imgBlob ? null : (rois[pageNo] || null);
      const image = imgBlob ? imgBlob : await cropPageToImage(pdfDoc, pageNo, roi);
      try {
        if (method==='client') {
          if (pdfDoc && kind === 'vector') {
            const items = await getPageTextItems(pdfDoc, pageNo);
            tables = [clusterToTable(items)]; activeTable = 0;
          } else {
            const t = await tableFromClient(image); tables = [t]; activeTable = 0;
          }
        } else if (method==='llamaparse') {
          try {
            let toSend = imgBlob || (await cropPageToImage(pdfDoc, pageNo, roi));
            if (pdfDoc && !imgBlob && typeof window.PDFLib !== 'undefined') {
              const PDFDocument = window.PDFLib.PDFDocument; const newDoc = await PDFDocument.create();
              const usePages = (selectedPages&&selectedPages.length)? selectedPages : [pageNo];
              const anyRoi = usePages.some(p => !!rois[p]);
              if (anyRoi) {
                for (const p of usePages) {
                  const r = rois[p] || null;
                  const blob = await cropPageToImage(pdfDoc, p, r);
                  const bytes = new Uint8Array(await blob.arrayBuffer());
                  const png = await newDoc.embedPng(bytes);
                  const { width, height } = png.scale(1);
                  const pg = newDoc.addPage([width, height]);
                  pg.drawImage(png, { x:0, y:0, width, height });
                }
                const outBytes = await newDoc.save();
                toSend = new Blob([outBytes], { type:'application/pdf' });
              }
            }
            const out = await parseWithLlamaParse(toSend);
            const arr = Array.isArray(out.tables) && out.tables.length ? out.tables : [out.cells||[]];
            tables = arr.map(cells => {
              const norm = normalizeHydroCells(cells);
              return { cells: (norm && norm.length) ? norm : cells, csv: out.markdown || out.md || '' };
            });
            activeTable = 0;
          } catch(e) { status.textContent='LlamaParse hatası: ' + (e.message||e); return; }
        }
      } catch (e) { status.textContent = 'Hata: ' + (e.message||e); return; }
      renderPreviewEmbedded(); goto(3); status.textContent='Bitti.';
    });
    function tableFromClient(image){ return ocrClient(image,{lang:'eng+tur',psm:6}).then(ocr=> tableFromOcr(ocr.words, null, {useOpenCV:true})); }
    function renderPreviewEmbedded(){
      const tabs = container.querySelector('#pdfwiz-tabs'); if (tabs) { tabs.innerHTML=''; }
      const sc = container.querySelector('#pdfwiz-preview-scroller'); if (sc) sc.innerHTML='';
      const cur = (tables && tables.length) ? tables[activeTable] : null;
      if (!cur || !cur.cells || !cur.cells.length) {
        if (sc) sc.innerHTML = '<div class="info" style="padding:8px;">Tablo bulunamadı.</div>';
        return;
      }
      if (tabs && tables.length>1){
        const frag = document.createDocumentFragment();
        tables.forEach((_,i)=>{
          const b = document.createElement('button'); b.className='tab small'+(i===activeTable?' active':''); b.textContent = `Tablo ${i+1}`; b.addEventListener('click', ()=>{ activeTable=i; renderPreviewEmbedded(); }); frag.appendChild(b);
        });
        tabs.appendChild(frag);
      }
      const meta = container.querySelector('#pdfwiz-preview-meta');
      if (meta) meta.textContent = `Satır: ${cur.cells.length} • Sütun: ${Math.max(...cur.cells.map(r=>r.length))}`;
      const tbl = document.createElement('table'); tbl.className='pdf-table';
      for (let r=0; r<Math.min(80, cur.cells.length); r++){
        const tr=document.createElement('tr'); const row=cur.cells[r];
        for(let c=0;c<Math.min(16,row.length);c++){ const td=document.createElement(r===0?'th':'td'); td.textContent=row[c]; tr.appendChild(td);} tbl.appendChild(tr);
      }
      if (sc) sc.appendChild(tbl);
      const headers = cur.cells[0]||[]; const m=mapHeaders(headers); const mapBox = container.querySelector('#pdfwiz-map'); mapBox.innerHTML = renderMapUI(headers, m);
      const applyBtn = container.querySelector('#apply-map'); const applyAll = container.querySelector('#map-apply-all');
      applyBtn?.addEventListener('click', ()=> applyMap(headers, !!applyAll?.checked));
    }
    function applyMap(headers, applyAll=true){
      const fields = ['draft_m','lcf_m','tpc_t_per_cm','mct1cm_t_m_per_cm']; const col={};
      for(const f of fields){ const v=container.querySelector(`#map-${f}`)?.value; col[f]=v===''?null:Number(v); }
      const rows=[];
      const list = applyAll ? tables : [tables[activeTable]];
      for (const t of list){ const grid = (t&&t.cells)||[]; for(let r=1;r<grid.length;r++){ const row=grid[r]; const draft=toNum(row[col.draft_m]); if(!isFinite(draft)) continue; rows.push({ draft_m:draft, lcf_m:toNum(row[col.lcf_m]), tpc_t_per_cm:toNum(row[col.tpc_t_per_cm]), mct1cm_t_m_per_cm:toNum(row[col.mct1cm_t_m_per_cm]) }); } }
      const appLBP = (window.SHIP?.LBP) || (window.SHIP_ACTIVE?.LBP) || 100; const rowsCompat = rows.map(r=>({draft_m:r.draft_m,lcf_m:r.lcf_m,tpc:r.tpc_t_per_cm,mct:r.mct1cm_t_m_per_cm}));
      const v = validateHydro(rowsCompat, {LBP: appLBP}); container.querySelector('#pdfwiz-validate').innerHTML = renderValidation(v);
      container.dataset.rows = JSON.stringify(rows);
    }
    container.querySelector('#go-apply')?.addEventListener('click', ()=>{
      const rows = JSON.parse(container.dataset.rows||'[]'); if(!rows.length){ alert('Aktarılacak satır yok.'); return; }
      const compat = rows.map(r=>({draft_m:r.draft_m,lcf_m:r.lcf_m,tpc:r.tpc_t_per_cm,mct:r.mct1cm_t_m_per_cm}));
      if (typeof window.applyHydrostaticsJson==='function'){ window.applyHydrostaticsJson({rows: compat}); alert('Hydrostatik tablo uygulandı.'); container.style.display='none'; container.innerHTML=''; }
    });
    container.querySelector('#go-download')?.addEventListener('click', ()=>{
      const rows = JSON.parse(container.dataset.rows||'[]'); if(!rows.length){ alert('İndirilecek veri yok.'); return; }
      const hydro = toHydrostaticsJson(rows); const blob=new Blob([JSON.stringify(hydro,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hydrostatics_import.json'; a.click(); URL.revokeObjectURL(a.href);
    });
    function goto(n){ container.querySelectorAll('.pdfwiz-step').forEach((el,i)=>{ el.style.display = (i===(n-1))?'block':'none'; }); }
  })();
}

// expose for non-module callers
// eslint-disable-next-line no-undef
window.PDFImportUI = { mountOverlay: mountImportWizard, mountEmbedded: mountImportWizardEmbedded };

function renderValidation({ errors, warnings }) {
  const list = [];
  if (errors.length) list.push(`<div class="error">Hatalar: ${errors.length}</div><ul>` + errors.map(e=>`<li>${e}</li>`).join('') + '</ul>');
  if (warnings.length) list.push(`<div class="warn">Uyarılar: ${warnings.length}</div><ul>` + warnings.map(e=>`<li>${e}</li>`).join('') + '</ul>');
  if (!list.length) return '<div class="ok">Doğrulama: sorun yok</div>';
  return list.join('');
}

function toNum(s) {
  const t = normalizeCellText(String(s||'').trim());
  const n = Number(t);
  return isFinite(n) ? n : NaN;
}
