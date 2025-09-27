/**
 * PDF Import Wizard UI. Creates an accessible modal and drives extraction.
 * Mounts on #btnImportWizard click and uses modules: pdf-core, pdf-client-ocr, pdf-structure, paddle-service.
 * @file scripts/import/pdf-ui.js
 */

import { loadPdf, renderThumbnails, getPageTextItems, detectPdfKind, cropPageToImage } from './pdf-core.js';
import { ocrClient, tableFromOcr } from './pdf-client-ocr.js';
import { clusterToTable } from './pdf-structure.js';
import { mapHeaders, normalizeCellText, validateHydro, toHydrostaticsJson } from './table-map-validate.js';
import { ocrPaddle, serverHealthy, __PADDLE_BASE__ } from './paddle-service.js';

// Auto-bind button if present
const btn = document.getElementById('btnImportWizard');
if (btn) btn.addEventListener('click', mountImportWizard);

/**
 * Mount the PDF import modal wizard and control its lifecycle.
 */
export function mountImportWizard() {
  let state = {
    pdf: null,
    file: null,
    pageNo: 1,
    kind: 'scan',
    roi: null, // {x,y,w,h} in normalized [0..1]
    table: null, // {cells,csv,bboxes,confidence}
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
      state.pdf = await loadPdf(f);
      await populateThumbs();
      overlay.querySelector('[data-step="1"]').scrollIntoView({ behavior: 'smooth' });
    });
    // Search
    overlay.querySelector('#pdfwiz-search')?.addEventListener('input', onSearch);
    // Method toggles
    const paddleOk = await serverHealthy();
    const paddleToggle = overlay.querySelector('#method-paddle');
    if (paddleToggle) {
      paddleToggle.disabled = !paddleOk;
      const hint = overlay.querySelector('#paddle-hint');
      hint.textContent = paddleOk ? `Sunucu hazır: ${__PADDLE_BASE__}` : 'Sunucu yok → tarayıcı-içi OCR’a düş';
    }
    // Cloud OCR toggle static info
    overlay.querySelector('#cloud-ocr')?.setAttribute('disabled','disabled');
    // Next buttons
    overlay.querySelector('#go-roi')?.addEventListener('click', ()=> gotoStep(2));
    overlay.querySelector('#go-method')?.addEventListener('click', ()=> gotoStep(3));
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
      cv.setAttribute('tabindex', '0');
      cv.setAttribute('role', 'button');
      cv.setAttribute('aria-label', `Sayfa ${cv.dataset.pageNo}`);
      cv.addEventListener('click', () => selectPage(Number(cv.dataset.pageNo)));
      cv.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') selectPage(Number(cv.dataset.pageNo)); });
    });
    selectPage(1);
  }

  async function selectPage(no) {
    state.pageNo = no;
    overlay.querySelector('#pdfwiz-pageno').textContent = String(no);
    const items = await getPageTextItems(state.pdf, no);
    state.kind = detectPdfKind(items);
    overlay.querySelector('#pdfwiz-kind').textContent = state.kind === 'vector' ? 'Metin tabanlı' : 'Taranmış';
    // ROI canvas preview
    await renderRoiCanvas();
  }

  async function renderRoiCanvas() {
    const page = await state.pdf.getPage(state.pageNo);
    const viewport = page.getViewport({ scale: 0.9 });
    const canvas = overlay.querySelector('#pdfwiz-roi');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    // Attach ROI draw
    let dragging = false; let start = null; let rect = null;
    canvas.onmousedown = (e) => { dragging = true; start = getPos(e); };
    canvas.onmousemove = (e) => { if (!dragging) return; rect = mkRect(start, getPos(e)); drawOverlay(); };
    canvas.onmouseup = (e) => { if (!dragging) return; dragging = false; rect = mkRect(start, getPos(e)); state.roi = normRect(rect, canvas); drawOverlay(); };
    canvas.onmouseleave = () => { dragging = false; };
    function getPos(ev){ const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
    function mkRect(a,b){ return { x: Math.min(a.x,b.x), y: Math.min(a.y,b.y), w: Math.abs(a.x-b.x), h: Math.abs(a.y-b.y) }; }
    function normRect(rc, cv){ return { x: rc.x/cv.width, y: rc.y/cv.height, w: rc.w/cv.width, h: rc.h/cv.height }; }
    function drawOverlay(){
      ctx.save();
      ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 2; ctx.setLineDash([6,3]);
      // redraw page for clarity
      // Not re-rendering PDF for perf; draw rect only
      ctx.clearRect(0,0,canvas.width,canvas.height);
      page.render({ canvasContext: ctx, viewport });
      if (rect) ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }
  }

  async function runExtraction() {
    const method = overlay.querySelector('input[name="method"]:checked')?.value || 'client';
    const status = overlay.querySelector('#pdfwiz-status');
    status.textContent = 'Çıkarım çalışıyor...';
    const image = await cropPageToImage(state.pdf, state.pageNo, state.roi);
    let table = null;
    try {
      if (method === 'client') {
        // If vector, try structure; else OCR
        if (state.kind === 'vector') {
          const items = await getPageTextItems(state.pdf, state.pageNo);
          table = clusterToTable(items);
        } else {
          const ocr = await ocrClient(image, { lang: 'eng+tur', psm: 6 });
          table = tableFromOcr(ocr.words, state.roi, { useOpenCV: true });
        }
      } else if (method === 'paddle') {
        table = await ocrPaddle(image, state.roi);
      }
    } catch (err) {
      console.error(err);
      status.textContent = `Hata: ${err.message || err}`;
      return;
    }
    state.table = table || { cells: [], csv: '', bboxes: [], confidence: 0 };
    renderTablePreview();
    gotoStep(4);
    status.textContent = 'Bitti.';
  }

  function renderTablePreview() {
    const wrap = overlay.querySelector('#pdfwiz-preview');
    wrap.innerHTML = '';
    if (!state.table || !state.table.cells || !state.table.cells.length) {
      wrap.innerHTML = '<div class="info">Tablo tespit edilemedi. ROI alanını ayarlayın veya farklı yöntem deneyin.</div>';
      return;
    }
    const tbl = document.createElement('table');
    tbl.className = 'grid';
    const cells = state.table.cells;
    for (let r = 0; r < Math.min(40, cells.length); r++) {
      const tr = document.createElement('tr');
      const row = cells[r];
      for (let c = 0; c < Math.min(12, row.length); c++) {
        const td = document.createElement(r===0? 'th':'td');
        td.textContent = row[c];
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    wrap.appendChild(tbl);
    // Header mapping UI from first row
    const headers = cells[0] || [];
    const m = mapHeaders(headers);
    const mapBox = overlay.querySelector('#pdfwiz-map');
    mapBox.innerHTML = renderMapUI(headers, m);
    mapBox.querySelector('#apply-map')?.addEventListener('click', ()=> applyMapping(headers));
  }

  function applyMapping(headers) {
    const fields = ['draft_m','lcf_m','tpc_t_per_cm','mct1cm_t_m_per_cm'];
    const col = {};
    for (const f of fields) {
      const v = overlay.querySelector(`#map-${f}`)?.value;
      col[f] = v===''? null : Number(v);
    }
    // Build rows skipping header
    const rows = [];
    for (let r = 1; r < state.table.cells.length; r++) {
      const row = state.table.cells[r];
      const draft = toNum(row[col.draft_m]);
      if (!isFinite(draft)) continue;
      rows.push({
        draft_m: draft,
        lcf_m: toNum(row[col.lcf_m]),
        tpc_t_per_cm: toNum(row[col.tpc_t_per_cm]),
        mct1cm_t_m_per_cm: toNum(row[col.mct1cm_t_m_per_cm]),
      });
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
        <h3>1) PDF Yükle + Sayfa Seç</h3>
        <input id="pdfwiz-file" type="file" accept="application/pdf" />
        <div id="pdfwiz-thumbs" class="thumb-grid" aria-label="Sayfa küçük resimleri"></div>
        <div class="muted">Seçili sayfa: <span id="pdfwiz-pageno">-</span> • Tür: <span id="pdfwiz-kind">-</span></div>
        <div class="row">
          <input id="pdfwiz-search" type="search" placeholder="Anahtar kelime (Hydrostatic, TPC, MCT...)" />
          <button id="go-roi">Devam ➜</button>
        </div>
      </div>
      <div class="pdfwiz-step" data-step="2" style="display:none;">
        <h3>2) Bölge Seç (Tablo ROI)</h3>
        <canvas id="pdfwiz-roi" class="roi-canvas" aria-label="Tablo bölge seçimi"></canvas>
        <div class="row">
          <button id="go-method">Devam ➜</button>
        </div>
      </div>
      <div class="pdfwiz-step" data-step="3" style="display:none;">
        <h3>3) Çıkarım Yöntemi</h3>
        <label><input type="radio" name="method" value="client" checked /> Hızlı Tara (Tarayıcı-içi)</label>
        <label title="Yerel PaddleOCR"><input type="radio" id="method-paddle" name="method" value="paddle" /> Zor Dosya (PaddleOCR)</label>
        <div id="paddle-hint" class="muted"></div>
        <label title="Bulut OCR"><input id="cloud-ocr" type="checkbox" disabled /> Bulut OCR (opsiyonel)</label>
        <div class="info">Bulut OCR varsayılan kapalıdır. Açmak için README’deki talimatları izleyin.</div>
        <div class="row"><button id="go-extract">Tabloyu Çıkar ➜</button></div>
      </div>
      <div class="pdfwiz-step" data-step="4" style="display:none;">
        <h3>4) Önizleme + Eşleme + Doğrulama</h3>
        <div id="pdfwiz-preview"></div>
        <div id="pdfwiz-map"></div>
        <div id="pdfwiz-validate"></div>
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

