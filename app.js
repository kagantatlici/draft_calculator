// Non-module usage; constants are on window.* (see constants.js)

let ACTIVE = { cargo: [], ballast: [] };
let HYDRO_ROWS = null; // active ship hydro rows
let CONS_TANKS = null; // active ship consumable tanks
let CONS_GROUPS = { fw:{cap:0, lcg:0}, fo:{cap:0, lcg:0}, oth:{cap:0, lcg:0} };
let LAST_TMEAN = null; // remember last mean draft for better iteration start
let SHIP_ACTIVE = null; // active ship constants (fallback to SHIP)
let SHIPS_INDEX = null; // available ships list
let LONG_REF_ACTIVE = 'ms_plus'; // current display/ordering datum
let WIZ_MANUAL = false; // when true, skip auto reclassification after manual edits


// Local storage keys and helpers
const LS_PREFIX = 'dc_ship_';
const LS_INDEX_KEY = 'dc_ships_index';
const LS_ACTIVE_KEY = 'dc_active_ship';

function getLocalIndex() {
  try { return JSON.parse(localStorage.getItem(LS_INDEX_KEY) || '[]'); } catch(_) { return []; }
}
function setLocalIndex(arr) {
  try { localStorage.setItem(LS_INDEX_KEY, JSON.stringify(arr||[])); } catch(_) {}
}
function saveLocalShip(profile) {
  if (!profile || !profile.ship || !profile.ship.id) return;
  const id = profile.ship.id;
  try { localStorage.setItem(LS_PREFIX + id, JSON.stringify(profile)); } catch(_) {}
  const idx = getLocalIndex();
  if (!idx.find(s=> s.id === id)) idx.push({ id, name: profile.ship.name || id });
  setLocalIndex(idx);
}
function getLocalShip(id) {
  try { const txt = localStorage.getItem(LS_PREFIX + id); return txt? JSON.parse(txt) : null; } catch(_) { return null; }
}
function setActiveShipID(id) { try { localStorage.setItem(LS_ACTIVE_KEY, id); } catch(_) {} }
function getActiveShipID() { try { return localStorage.getItem(LS_ACTIVE_KEY) || null; } catch(_) { return null; } }

function convertLongitudinalToMidship(x, lbp, ref) {
  if (!isFinite(x)) return x;
  const r = String(ref||'').toLowerCase();
  // Midship-based inputs
  if (r === 'ms_plus') return x;         // midship (+ forward) → already in program convention
  if (r === 'ms_minus') return -x;       // midship (− forward) → flip sign to (+ forward)
  // AP/FP-based inputs need LBP
  if (!isFinite(lbp) || lbp <= 0) return x;
  if (r === 'ap_plus') return x - lbp/2; // AP (+ forward) → shift origin to midship
  // FP (− aft): values measured from FP, aft is negative.
  // Convert: x_mid = x_fp + lbp/2
  if (r === 'fp_minus') return x + lbp/2;
  return x; // assume already midship-based
}

// Convert midship-based coordinate back to a given reference (for display/ordering)
function convertMidshipToRef(xMid, lbp, ref) {
  const r = String(ref||'').toLowerCase();
  if (!isFinite(xMid)) return xMid;
  if (r === 'ms_plus') return xMid;
  if (r === 'ms_minus') return -xMid;
  if (!isFinite(lbp) || lbp <= 0) return xMid;
  if (r === 'ap_plus') return xMid + lbp/2;
  if (r === 'fp_minus') return xMid - lbp/2;
  return xMid;
}

function convertProfileLongitudes(profile) {
  try {
    const lbp = Number(profile.ship && profile.ship.lbp);
    const ref = profile.ship && profile.ship.long_ref;
    // Proceed if any ref provided. AP/FP need LBP; midship refs handled without LBP.
    if (!ref) return profile;
    // Convert hydro rows
    if (profile.hydrostatics && Array.isArray(profile.hydrostatics.rows)) {
      for (const r of profile.hydrostatics.rows) {
        if (r && typeof r.lcf_m === 'number') r.lcf_m = convertLongitudinalToMidship(r.lcf_m, lbp, ref);
        if (r && typeof r.lcb_m === 'number') r.lcb_m = convertLongitudinalToMidship(r.lcb_m, lbp, ref);
      }
    }
    // Convert tank LCGs
    const cats = ['cargo','ballast','consumables'];
    if (profile.tanks) {
      for (const c of cats) {
        const arr = profile.tanks[c];
        if (Array.isArray(arr)) {
          for (const t of arr) {
            if (t && typeof t.lcg === 'number') t.lcg = convertLongitudinalToMidship(t.lcg, lbp, ref);
          }
        }
      }
    }
    // Convert light ship and constant LCGs if provided
    if (profile.ship && profile.ship.light_ship && typeof profile.ship.light_ship.lcg === 'number') {
      profile.ship.light_ship.lcg = convertLongitudinalToMidship(profile.ship.light_ship.lcg, lbp, ref);
    }
    if (profile.ship && profile.ship.constant && typeof profile.ship.constant.lcg === 'number') {
      profile.ship.constant.lcg = convertLongitudinalToMidship(profile.ship.constant.lcg, lbp, ref);
    }
  } catch(_){ /* noop */ }
  return profile;
}

async function loadTanksFromJson() {
  try {
    const res = await fetch('./data/tanks.json');
    if (!res.ok) return null;
    const data = await res.json();
    const tanks = data.tanks || [];
    const cargo = [], ballast = [];
    for (const t of tanks) {
      const entry = { id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 };
      if ((t.type||'').toLowerCase()==='cargo') cargo.push(entry);
      else if ((t.type||'').toLowerCase()==='ballast') ballast.push(entry);
    }
    return { cargo, ballast };
  } catch (_) { return null; }
}

async function loadHydroFromJson() {
  try {
    const res = await fetch('./data/hydrostatics.json');
    if (!res.ok) return null;
    const data = await res.json();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    // Basic validation for expected keys
    const ok = rows.every(r => typeof r.draft_m === 'number' && typeof r.tpc === 'number' && typeof r.mct === 'number' && typeof r.lcf_m === 'number');
    return ok ? rows.sort((a,b) => a.draft_m - b.draft_m) : null;
  } catch (_) { return null; }
}

async function loadConsumablesFromJson() {
  try {
    const res = await fetch('./data/consumables.json');
    if (!res.ok) return null;
    const data = await res.json();
    const tanks = Array.isArray(data.tanks) ? data.tanks : [];
    // accept any type; we will group anything not 'freshwater' or 'fuel' under Others
    const rows = tanks
      .map(t => ({ name: t.name, type: String(t.type||'').toLowerCase(), lcg: Number(t.lcg), cap_m3: (t.cap_m3!=null?Number(t.cap_m3):null) }))
      .filter(t => isFinite(t.lcg));
    return rows.length ? rows : null;
  } catch (_) { return null; }
}

function interpHydro(rows, T) {
  if (!rows || rows.length === 0 || !isFinite(T)) return null;
  // Clamp to range
  if (T <= rows[0].draft_m) return { LCF: rows[0].lcf_m, LCB: rows[0].lcb_m, TPC: rows[0].tpc, MCT1cm: rows[0].mct };
  if (T >= rows[rows.length-1].draft_m) {
    const r = rows[rows.length-1];
    return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct };
  }
  // Find bracketing rows
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].draft_m <= T) lo = mid; else hi = mid;
  }
  const a = rows[lo], b = rows[hi];
  const t = (T - a.draft_m) / (b.draft_m - a.draft_m);
  const lerp = (x, y) => x + (y - x) * t;
  return { LCF: lerp(a.lcf_m, b.lcf_m), LCB: lerp(a.lcb_m, b.lcb_m), TPC: lerp(a.tpc, b.tpc), MCT1cm: lerp(a.mct, b.mct) };
}

function solveDraftByDisFW(rows, target_dis_fw) {
  if (!rows || rows.length === 0 || !isFinite(target_dis_fw)) return null;
  // Use DIS(FW) if present; otherwise derive FW-equivalent from DIS(SW) using reference ρ
  const rho_ref = (SHIP_ACTIVE && isFinite(SHIP_ACTIVE.RHO_REF)) ? SHIP_ACTIVE.RHO_REF : (SHIP.RHO_REF || 1.025);
  const seq = [];
  for (const r of rows) {
    let y = (typeof r.dis_fw === 'number') ? r.dis_fw : undefined;
    if (y == null && typeof r.dis_sw === 'number') y = r.dis_sw / rho_ref; // convert tons@SW to FW-equivalent (m³)
    if (isFinite(r.draft_m) && isFinite(y)) seq.push({ T: r.draft_m, Y: y });
  }
  if (!seq.length) return null;
  // Clamp to bounds
  if (target_dis_fw <= seq[0].Y) return seq[0].T;
  if (target_dis_fw >= seq[seq.length-1].Y) return seq[seq.length-1].T;
  // Binary search on Y (assumed monotonic with T)
  let lo = 0, hi = seq.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (seq[mid].Y <= target_dis_fw) lo = mid; else hi = mid;
  }
  const a = seq[lo], b = seq[hi];
  const t = (target_dis_fw - a.Y) / (b.Y - a.Y);
  return a.T + (b.T - a.T) * t;
}

function el(id) { return document.getElementById(id); }

function fmt(n, digits = 3) {
  if (!isFinite(n)) return '-';
  return Number(n).toFixed(digits);
}

// Update hint under Constant L.C.G. according to active ship datum
function updateConstLCGHint() {
  const elHint = document.getElementById('const-hint');
  if (!elHint) return;
  const base = SHIP_ACTIVE || SHIP;
  const lbp = Number(base.LBP || SHIP.LBP || 0);
  const ref = String(LONG_REF_ACTIVE || 'ms_plus').toLowerCase();
  const f = (x)=> (isFinite(x)? (Math.round(x*100)/100).toFixed(2) : '-');
  let text = '';
  if (ref === 'ms_plus') {
    text = `Reference: midship (+ forward). Examples: 0.00 at MS, +${f(lbp/2)} at FP, -${f(lbp/2)} at AP.`;
  } else if (ref === 'ms_minus') {
    text = `Reference: midship (− forward). Examples: 0.00 at MS, +${f(lbp/2)} at AP, -${f(lbp/2)} at FP.`;
  } else if (ref === 'ap_plus') {
    text = `Reference: AP (+ forward). Examples: 0.00 at AP, +${f(lbp)} at FP.`;
  } else if (ref === 'fp_minus') {
    text = `Reference: FP (− aft). Examples: 0.00 at FP, -${f(lbp)} at AP.`;
  } else {
    text = `Reference: midship (+ forward).`;
  }
  elHint.textContent = text;
}

function renderConstants() {
  const box = document.getElementById('consts-list');
  if (!box) return;
  const base = SHIP_ACTIVE || SHIP;
  const { LBP, LCF, TPC, MCT1cm, RHO_REF } = base;
  const ls = window.LIGHT_SHIP || {};
  const parts = [
    `<div><b>LBP</b>: ${fmt(LBP, 2)} m</div>`,
    `<div><b>LCF</b>: ${fmt(LCF, 2)} m (midship +forward)</div>`,
    `<div><b>TPC</b>: ${fmt(TPC, 1)} t/cm</div>`,
    `<div><b>MCT1cm</b>: ${fmt(MCT1cm, 1)} t·m/cm</div>`,
    `<div><b>ρ_ref</b>: ${fmt(RHO_REF, 3)} t/m³</div>`,
    `<div><b>Light ship</b>: ${ls.weight ?? '-'} t @ LCG ${fmt(ls.lcg ?? 0, 2)} m</div>`,
    `<div><b>Consumables tanks</b>: ${Array.isArray(CONS_TANKS) ? CONS_TANKS.length : 0}</div>`,
    `<div><b>Tank count</b>: Cargo ${ACTIVE.cargo.length}, Ballast ${ACTIVE.ballast.length}</div>`,
  ];
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin-top:8px;color:#9fb3c8;font-size:12px;">${parts.join('')}</div>`;
}

function buildTankInputs(containerId, tanks) {
  const container = el(containerId);
  container.innerHTML = '';
  // Header row
  const head = document.createElement('div');
  head.className = 'tank tank-head';
  const hName = document.createElement('div'); hName.className = 'name'; hName.textContent = 'Tank'; head.appendChild(hName);
  const hCap = document.createElement('div'); hCap.className = 'cap'; hCap.textContent = 'Cap (m³)'; head.appendChild(hCap);
  const hPct = document.createElement('div'); hPct.className = 'muted'; hPct.textContent = '%'; head.appendChild(hPct);
  const hVol = document.createElement('div'); hVol.className = 'muted'; hVol.textContent = 'Volume (m³)'; head.appendChild(hVol);
  const hRho = document.createElement('div'); hRho.className = 'muted'; hRho.textContent = 'Density (g/cm³)'; head.appendChild(hRho);
  const hW = document.createElement('div'); hW.className = 'muted'; hW.textContent = 'Weight (t)'; head.appendChild(hW);
  container.appendChild(head);
  const lbpSort = (SHIP_ACTIVE?.LBP ?? SHIP.LBP);
  const refSort = (LONG_REF_ACTIVE || 'ms_plus').toLowerCase();
  const desc = (refSort === 'ms_minus') ? false : true;
  const ordered = [...tanks].sort((a,b)=>{
    const av = convertMidshipToRef(Number(a?.lcg), lbpSort, refSort);
    const bv = convertMidshipToRef(Number(b?.lcg), lbpSort, refSort);
    const aa = Number.isFinite(av) ? av : -Infinity;
    const bb = Number.isFinite(bv) ? bv : -Infinity;
    return desc ? (bb - aa) : (aa - bb); // order by chosen datum
  });
  for (let rowIndex = 0; rowIndex < ordered.length; rowIndex++) {
    const t = ordered[rowIndex];
    const wrap = document.createElement('div');
    wrap.className = 'tank';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = t.name;
    wrap.appendChild(name);

    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = (t.cap_m3 != null) ? `${t.cap_m3} m³` : '-';
    wrap.appendChild(cap);

    // Controls: %, Volume, Density, Weight with bi-directional sync
    // Inputs as grid columns to keep single-line layout
    const pInput = document.createElement('input');
    pInput.type = 'number'; pInput.step = '0.1'; pInput.id = `p_${t.id}`; pInput.placeholder = '%'; pInput.setAttribute('aria-label','Yüzde');
    pInput.dataset.col = 'pct'; pInput.dataset.row = String(rowIndex); pInput.dataset.container = containerId;
    wrap.appendChild(pInput);

    const vInput = document.createElement('input');
    vInput.type = 'number'; vInput.step = '0.1'; vInput.id = `v_${t.id}`; vInput.placeholder = 'm³'; vInput.setAttribute('aria-label','Hacim');
    vInput.dataset.col = 'vol'; vInput.dataset.row = String(rowIndex); vInput.dataset.container = containerId;
    wrap.appendChild(vInput);

    const rInput = document.createElement('input');
    rInput.type = 'text'; rInput.setAttribute('inputmode','decimal'); rInput.id = `r_${t.id}`; rInput.placeholder = (containerId === 'ballast-tanks') ? '1.025' : '0.80'; rInput.setAttribute('aria-label','Yoğunluk');
    rInput.dataset.col = 'rho'; rInput.dataset.row = String(rowIndex); rInput.dataset.container = containerId;
    wrap.appendChild(rInput);

    const wInput = document.createElement('input');
    wInput.type = 'number'; wInput.step = '0.1'; wInput.value = '0'; wInput.id = `w_${t.id}`; wInput.placeholder = 'mt'; wInput.setAttribute('aria-label','Ağırlık');
    wInput.dataset.col = 'w'; wInput.dataset.row = String(rowIndex); wInput.dataset.container = containerId;
    wrap.appendChild(wInput);

    // Sync logic per tank
    const capVal = isFinite(Number(t.cap_m3)) ? Number(t.cap_m3) : 0;
    const sync = (changed) => {
      const cap = capVal;
      // read values with ',' normalized to '.' without mutating active field
      const readNum = (el) => parseFloat(String(el.value||'').replace(',', '.'));
      let P = readNum(pInput);
      let V = readNum(vInput);
      let R = readNum(rInput);
      let W = readNum(wInput);
      P = isFinite(P) ? P : 0;
      V = isFinite(V) ? V : 0;
      // Do not coerce R; if NaN, we will skip dependent calcs
      W = isFinite(W) ? W : 0;
      if (changed === 'pct') {
        if (cap > 0) V = cap * (P/100);
        if (isFinite(R) && R > 0) W = V * R;
      } else if (changed === 'vol') {
        if (cap > 0) P = (V / cap) * 100;
        if (isFinite(R) && R > 0) W = V * R;
      } else if (changed === 'rho') {
        if (isFinite(R) && R > 0) W = V * R;
        if (cap > 0) P = (V / cap) * 100;
      } else if (changed === 'w') {
        if (isFinite(R) && R > 0) {
          V = W / R;
          if (cap > 0) P = (V / cap) * 100;
        }
      }
      // Avoid reformatting the field the user is actively typing in to allow multi-digit entry
      if (isFinite(P) && changed !== 'pct') pInput.value = (P || 0).toFixed(1);
      if (isFinite(V) && changed !== 'vol') vInput.value = (V || 0).toFixed(1);
      if (isFinite(W) && changed !== 'w') wInput.value = (W || 0).toFixed(1);
      updateTankTotals(containerId, tanks);
    };
    pInput.addEventListener('input', ()=> sync('pct'));
    vInput.addEventListener('input', ()=> sync('vol'));
    rInput.addEventListener('input', ()=> sync('rho'));
    wInput.addEventListener('input', ()=> sync('w'));
    // normalize to '.' only on change/blur to avoid caret jumps while typing
    const norm = (el)=> el.value = String(el.value||'').replace(',', '.');
    rInput.addEventListener('change', ()=> norm(rInput));

    // Column-wise Tab navigation: move focus to next/previous row within the same column
    const handleTabNav = (ev) => {
      if (ev.key !== 'Tab') return;
      const col = ev.currentTarget.dataset.col;
      const row = Number(ev.currentTarget.dataset.row || '0');
      const dir = ev.shiftKey ? -1 : 1;
      const nextRow = row + dir;
      const parent = container; // scope within the same list (cargo/ballast)
      const next = parent.querySelector(`input[data-col="${col}"][data-row="${nextRow}"]`);
      if (next) {
        ev.preventDefault();
        next.focus();
        try { next.select && next.select(); } catch(_){}
      }
    };
    pInput.addEventListener('keydown', handleTabNav);
    vInput.addEventListener('keydown', handleTabNav);
    rInput.addEventListener('keydown', handleTabNav);
    wInput.addEventListener('keydown', handleTabNav);

    container.appendChild(wrap);
  }
  // initial totals
  updateTankTotals(containerId, tanks);
}

function readWeights(tanks) {
  const items = [];
  for (const t of tanks) {
    const v = parseFloat(el(`w_${t.id}`).value || '0') || 0;
    if (v !== 0) items.push({ name: t.name, w: v, x: t.lcg });
  }
  return items;
}

function updateTankTotals(containerId, tanks) {
  const isCargo = (containerId === 'cargo-tanks');
  const totalEl = document.getElementById(isCargo ? 'cargo-total' : 'ballast-total');
  if (!totalEl) return;
  let sumV = 0, sumW = 0;
  for (const t of tanks) {
    const id = t.id;
    const cap = isFinite(Number(t.cap_m3)) ? Number(t.cap_m3) : 0;
    const p = parseFloat(el(`p_${id}`)?.value || '');
    const v = parseFloat(el(`v_${id}`)?.value || '');
    const r = parseFloat(el(`r_${id}`)?.value || '');
    const w = parseFloat(el(`w_${id}`)?.value || '');
    let V = 0, W = 0;
    if (isFinite(v)) V = v; else if (isFinite(p) && cap>0) V = cap * (p/100);
    if (isFinite(w)) W = w; else if (isFinite(V) && isFinite(r) && r>0) W = V * r;
    if (isFinite(V)) sumV += V;
    if (isFinite(W)) sumW += W;
  }
  totalEl.textContent = `Toplam Hacim: ${isFinite(sumV)? sumV.toFixed(1):'-'} m³ • Toplam Ağırlık: ${isFinite(sumW)? sumW.toFixed(1):'-'} t`;
}

function getConsGroupsFromTanks() {
  // Derive total capacity and average LCG per group
  const groups = { fw:{cap:0, lcg:0}, fo:{cap:0, lcg:0}, oth:{cap:0, lcg:0} };
  if (!Array.isArray(CONS_TANKS) || !CONS_TANKS.length) return groups;
  const map = { freshwater:'fw', fuel:'fo' };
  const accum = { fw:{cap:0, mom:0, cnt:0}, fo:{cap:0, mom:0, cnt:0}, oth:{cap:0, mom:0, cnt:0} };
  for (const t of CONS_TANKS) {
    const k = map[t.type] || 'oth';
    const cap = isFinite(t.cap_m3) ? Number(t.cap_m3) : 0;
    accum[k].cap += cap;
    accum[k].mom += (cap>0? cap : 1) * t.lcg;
    accum[k].cnt += 1;
  }
  for (const k of ['fw','fo','oth']) {
    const a = accum[k];
    const denom = (a.cap>0 ? a.cap : a.cnt || 1);
    groups[k].cap = a.cap;
    groups[k].lcg = a.mom / denom;
  }
  return groups;
}

function wireConsumablesUI() {
  // Show capacities computed from imported consumables and keep only weight inputs editable
  CONS_GROUPS = getConsGroupsFromTanks();
  const setCap = (id,val)=>{ const e=el(id); if(e) e.textContent = `Toplam Kap: ${val>0? val.toFixed(1):'-'} m³`; };
  setCap('cap-fw', CONS_GROUPS.fw.cap);
  setCap('cap-fo', CONS_GROUPS.fo.cap);
  setCap('cap-oth', CONS_GROUPS.oth.cap);
  const total = (CONS_GROUPS.fw.cap||0) + (CONS_GROUPS.fo.cap||0) + (CONS_GROUPS.oth.cap||0);
  const totalEl = el('cap-cons-total');
  if (totalEl) totalEl.textContent = `Toplam Consumables Kapasite: ${total>0? total.toFixed(1):'-'} m³`;
  const updateConsW = () => {
    const fw = el('fw_w'), fo = el('fo_w'), ot = el('oth_w');
    if (fw) fw.value = String(fw.value||'').replace(',', '.');
    if (fo) fo.value = String(fo.value||'').replace(',', '.');
    if (ot) ot.value = String(ot.value||'').replace(',', '.');
    const w_fw = parseFloat(fw?.value||'')||0;
    const w_fo = parseFloat(fo?.value||'')||0;
    const w_ot = parseFloat(ot?.value||'')||0;
    const sum = w_fw + w_fo + w_ot;
    const elSum = el('cons-tweight');
    if (elSum) elSum.textContent = `Total Consumables Weight: ${isFinite(sum)? sum.toFixed(1):'-'} t`;
  };
  ['fw_w','fo_w','oth_w'].forEach(id=>{ const e=el(id); if(e){ e.addEventListener('input', updateConsW); e.addEventListener('change', updateConsW);} });
  updateConsW();
}

function calc() {
  const base = SHIP_ACTIVE || SHIP;
  const rhoEl = el('rho');
  const rhoRaw = rhoEl ? String(rhoEl.value||'') : String(base.RHO_REF || 1.025);
  const rho = parseFloat(rhoRaw.replace(',', '.')) || (base.RHO_REF || 1.025);
  // Read consumables groups as separate masses at their average LCGs
  if (!CONS_GROUPS || !CONS_GROUPS.fw) CONS_GROUPS = getConsGroupsFromTanks();

  // Collect tank items
  const cargo = readWeights(ACTIVE.cargo);
  const ballast = readWeights(ACTIVE.ballast);

  const items = [...cargo, ...ballast];
  const groupsOrder = [
    {k:'fw', label:'FW'},
    {k:'fo', label:'FO'},
    {k:'oth', label:'Others'},
  ];
  for (const g of groupsOrder) {
    const w = parseFloat(el(`${g.k}_w`)?.value || '0') || 0;
    if (w !== 0) items.push({ name: `Cons ${g.label}`, w, x: CONS_GROUPS[g.k].lcg || LCG_FO_FW });
  }
  // Always include light ship if available
  if (window.LIGHT_SHIP && typeof window.LIGHT_SHIP.weight === 'number' && window.LIGHT_SHIP.weight > 0) {
    items.push({ name: 'Light Ship', w: window.LIGHT_SHIP.weight, x: (window.LIGHT_SHIP.lcg ?? 0) });
  }
  // Include constant weight from main UI if provided (UI overrides profile). If UI w===0 → disable constant.
  const cwEl = el('const_w'); const cxEl = el('const_x');
  const cwRaw = cwEl ? String(cwEl.value||'').trim() : '';
  const cxRaw = cxEl ? String(cxEl.value||'').trim() : '';
  let usedUIConst = false;
  if (cwRaw !== '' || cxRaw !== '') {
    if (cwEl) cwEl.value = cwRaw.replace(',', '.');
    if (cxEl) cxEl.value = cxRaw.replace(',', '.');
    const uiW = parseFloat(cwEl?.value || '');
    const uiX = parseFloat(cxEl?.value || '');
    if (isFinite(uiW) && isFinite(uiX)) {
      usedUIConst = true;
      if (uiW > 0) {
        // Convert UI X from current datum to midship-based coordinate
        const xMid = convertLongitudinalToMidship(uiX, base.LBP, LONG_REF_ACTIVE);
        items.push({ name: 'Constant', w: uiW, x: xMid });
      }
      // if uiW === 0, explicitly disable constant (no fallback)
    }
  }
  if (!usedUIConst && window.CONSTANT_LOAD && typeof window.CONSTANT_LOAD.weight === 'number' && window.CONSTANT_LOAD.weight > 0) {
    items.push({ name: 'Constant', w: window.CONSTANT_LOAD.weight, x: (window.CONSTANT_LOAD.lcg ?? 0) });
  }

  // Totals
  const W = items.reduce((s, it) => s + it.w, 0);
  const Mx_mid = items.reduce((s, it) => s + it.w * it.x, 0); // moment about midship

  // Hydro constants (LBP constant). TPC/LCF/MCT dynamic from hydro table if available, else fallback to SHIP.* or overrides
  const { LBP, RHO_REF } = base;
  let LCF = base.LCF ?? SHIP.LCF, LCB = 0, TPC = base.TPC ?? SHIP.TPC, MCT1cm = base.MCT1cm ?? SHIP.MCT1cm;

  // If hydro table available, solve Tmean from displacement at given ρ using DIS(F.W) column
  let Tmean_m;
  if (Array.isArray(HYDRO_ROWS) && HYDRO_ROWS.length > 0) {
    const target_dis_fw = W / rho; // ton @ ρ=1.0 equals m³ volume numerically
    const solved = solveDraftByDisFW(HYDRO_ROWS, target_dis_fw);
    if (isFinite(solved)) {
      Tmean_m = solved;
      const hp = interpHydro(HYDRO_ROWS, Tmean_m) || {};
      LCF = hp.LCF ?? LCF; LCB = hp.LCB ?? LCB; TPC = hp.TPC ?? TPC; MCT1cm = hp.MCT1cm ?? MCT1cm;
      LAST_TMEAN = Tmean_m;
    }
  }

  // Apply manual overrides if provided
  const vLCF = NaN, vTPC = NaN, vMCT = NaN; // overrides removed from UI
  // If no hydro table or T could not be solved, fall back to TPC method
  let dTmean_cm;
  if (!isFinite(Tmean_m)) {
    dTmean_cm = (W / TPC) * (RHO_REF / rho);
  } else {
    dTmean_cm = Tmean_m * 100.0; // for display consistency below
  }
  // If TPC override given, recompute Tmean based on it (fallback mode)
  if (!Number.isNaN(vTPC)) {
    TPC = vTPC;
    dTmean_cm = (W / TPC) * (RHO_REF / rho);
    Tmean_m = dTmean_cm / 100.0;
  }
  if (!Number.isNaN(vMCT)) MCT1cm = vMCT;

  // Mean draft (m)
  if (!isFinite(Tmean_m)) Tmean_m = dTmean_cm / 100.0;

  // Trim (cm), by stern positive. Use Δ*(LCG_total − LCB)/MCT1cm
  const LCG_total = (W !== 0) ? (Mx_mid / W) : 0;
  const Trim_cm = - (W * (LCG_total - (LCB ?? 0))) / MCT1cm;
  const Trim_m = Trim_cm / 100.0;

  // DA/DF from mean and trim distribution wrt LCF
  // LCF measured from midship (+ forward). Distances from LCF to AP/FP:
  // AP at -LBP/2, FP at +LBP/2 =>
  const dist_LCF_to_FP = (LBP / 2) - LCF; // FP - LCF
  const dist_LCF_to_AP = (LBP / 2) + LCF; // LCF - AP = LCF + L/2

  const Df = Tmean_m - Trim_m * (dist_LCF_to_FP / LBP); // fore draft
  const Da = Tmean_m + Trim_m * (dist_LCF_to_AP / LBP); // aft draft

  // Render results
  el('resW').textContent = fmt(W, 1);
  el('resTm').textContent = fmt(Tmean_m, 3);
  el('resTa').textContent = fmt(Da, 3);
  el('resTf').textContent = fmt(Df, 3);
  el('resTrim').textContent = fmt(Trim_m, 2);
  // Deadweight = total displacement minus light ship weight
  const lsW = (window.LIGHT_SHIP && typeof window.LIGHT_SHIP.weight === 'number') ? window.LIGHT_SHIP.weight : NaN;
  const dwt = isFinite(lsW) ? (W - lsW) : NaN;
  const dwtEl = document.getElementById('resDWT');
  if (dwtEl) dwtEl.textContent = isFinite(dwt) ? Number(dwt).toFixed(1) : '-';
  const dwtEl2 = document.getElementById('resDWTNote');
  if (dwtEl2) dwtEl2.textContent = isFinite(dwt) ? Number(dwt).toFixed(1) : '-';
}

function clearAll() {
  const base = SHIP_ACTIVE || SHIP;
  el('rho').value = String(base.RHO_REF || 1.025);
  const cW = el('const_w'); if (cW) cW.value = '';
  const cX = el('const_x'); if (cX) cX.value = '';
  ['fw','fo','oth'].forEach(k=>{
    const set=(id,val)=>{ const e=el(id); if(e) e.value = val; };
    set(k+'_w','');
  });
  // overrides and lightship input removed from UI
  for (const t of [...ACTIVE.cargo, ...ACTIVE.ballast]) {
    const wp = document.getElementById(`w_${t.id}`);
    if (wp) wp.value = '0';
    const pp = document.getElementById(`p_${t.id}`);
    if (pp) pp.value = '';
    const vp = document.getElementById(`v_${t.id}`);
    if (vp) vp.value = '';
  }
  el('resW').textContent = '0.0';
  el('resTm').textContent = '0.000';
  el('resTa').textContent = '0.000';
  el('resTf').textContent = '0.000';
  el('resTrim').textContent = '0.0';
  updateTankTotals('cargo-tanks', ACTIVE.cargo);
  updateTankTotals('ballast-tanks', ACTIVE.ballast);
  if (typeof wireConsumablesUI === 'function') wireConsumablesUI();
}

function prefillExample() {
  // New example:
  // - All COT: %98, density 0.874
  // - Ballast: empty
  // - Consumables: FW 359.4 t, FO 1129.3 t, Others 222.1 t
  const rhoCargo = 0.874;
  const fill = 0.98;
  el('rho').value = (SHIP.RHO_REF).toString();

  for (const t of ACTIVE.cargo) {
    const cap = Number(t.cap_m3 || 0);
    const p = document.getElementById(`p_${t.id}`);
    const v = document.getElementById(`v_${t.id}`);
    const r = document.getElementById(`r_${t.id}`);
    const w = document.getElementById(`w_${t.id}`);
    if (p) p.value = (fill*100).toFixed(1);
    if (r) r.value = rhoCargo.toFixed(3);
    if (cap > 0) {
      const vol = cap * fill;
      const wt = vol * rhoCargo;
      if (v) v.value = vol.toFixed(1);
      if (w) w.value = wt.toFixed(1);
    } else if (w) {
      w.value = '0';
    }
  }
  for (const t of ACTIVE.ballast) {
    const p = document.getElementById(`p_${t.id}`);
    const v = document.getElementById(`v_${t.id}`);
    const w = document.getElementById(`w_${t.id}`);
    if (p) p.value = '';
    if (v) v.value = '';
    if (w) w.value = '0';
  }
  const setVal = (id, val) => { const e=el(id); if(e) e.value = String(val); };
  setVal('fw_w', 359.4);
  setVal('fo_w', 1129.3);
  setVal('oth_w', 222.1);
  updateTankTotals('cargo-tanks', ACTIVE.cargo);
  updateTankTotals('ballast-tanks', ACTIVE.ballast);
  // Update consumables volumes display
  if (typeof wireConsumablesUI === 'function') wireConsumablesUI();
  calc();
}

// Ship management
async function loadShipsIndex() {
  try {
    const res = await fetch('./data/ships/index.json');
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.ships) ? data.ships : null;
  } catch (_) { return null; }
}

async function compileShipsIndex() {
  const remote = await loadShipsIndex() || [];
  const localIdx = getLocalIndex();
  const map = new Map();
  for (const s of remote) map.set(s.id, { id:s.id, name:s.name });
  for (const s of localIdx) map.set(s.id, { id:s.id, name:s.name }); // local wins
  return Array.from(map.values());
}

async function loadShipProfile(id) {
  // Prefer local storage
  const local = getLocalShip(id);
  if (local) return local;
  try {
    const res = await fetch(`./data/ships/${id}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch (_) { return null; }
}

async function activateShip(id) {
  const profile = await loadShipProfile(id);
  if (profile && profile.ship) {
    // Convert LCF/LCB/LCG to midship-based if profile specifies a longitudinal datum
    const profMid = convertProfileLongitudes(JSON.parse(JSON.stringify(profile)));
    const s = profMid.ship;
    LONG_REF_ACTIVE = (s.long_ref || 'ms_plus');
    SHIP_ACTIVE = {
      LBP: s.lbp ?? SHIP.LBP,
      LCF: SHIP.LCF, // base until per-ship static overrides provided
      TPC: SHIP.TPC,
      MCT1cm: SHIP.MCT1cm,
      RHO_REF: s.rho_ref ?? SHIP.RHO_REF,
    };
    window.LIGHT_SHIP = s.light_ship || window.LIGHT_SHIP;
    window.CONSTANT_LOAD = s.constant || undefined;
    const rows = (profMid.hydrostatics && Array.isArray(profMid.hydrostatics.rows)) ? profMid.hydrostatics.rows : [];
    HYDRO_ROWS = rows.length ? rows.sort((a,b)=>a.draft_m-b.draft_m) : await loadHydroFromJson();
    // Tanks
    const cargo = (profMid.tanks && Array.isArray(profMid.tanks.cargo)) ? profMid.tanks.cargo : [];
    const ballast = (profMid.tanks && Array.isArray(profMid.tanks.ballast)) ? profMid.tanks.ballast : [];
    if (cargo.length + ballast.length > 0) {
      ACTIVE = {
        cargo: cargo.map(t=>({ id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 })),
        ballast: ballast.map(t=>({ id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 })),
      };
    } else {
      const fromJson = await loadTanksFromJson();
      ACTIVE = fromJson || { cargo: CARGO_TANKS, ballast: BALLAST_TANKS };
    }
    // Consumables tanks: prefer per-ship, else global file
    const cons = (profMid.tanks && Array.isArray(profMid.tanks.consumables)) ? profMid.tanks.consumables : null;
  if (cons && cons.length) {
    CONS_TANKS = cons.map(t=>({ name: t.name, type: String(t.type||'').toLowerCase(), lcg: Number(t.lcg), cap_m3: t.cap_m3 }));
  } else {
    CONS_TANKS = await loadConsumablesFromJson();
  }
  // Rebuild UI
    buildTankInputs('cargo-tanks', ACTIVE.cargo);
    buildTankInputs('ballast-tanks', ACTIVE.ballast);
    renderConstants();
    wireConsumablesUI();
    updateConstLCGHint();
  }
  // After building inputs, if a stowage payload is pending, apply it now.
  try { if (PENDING_STOWAGE_APPLY) { const tmp = PENDING_STOWAGE_APPLY; PENDING_STOWAGE_APPLY = null; applyStowagePayload(tmp); } } catch(_){ }
}

function populateShipDropdown(ships) {
  const sel = document.getElementById('ship-select');
  if (!sel) return;
  sel.innerHTML = '';
  const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select Ship'; sel.appendChild(ph);
  for (const s of ships) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    sel.appendChild(opt);
  }
}

// Init UI
(async () => {
  SHIPS_INDEX = await compileShipsIndex();
  if (Array.isArray(SHIPS_INDEX)) populateShipDropdown(SHIPS_INDEX);
  const last = getActiveShipID();
  if (last) {
    const sel = document.getElementById('ship-select');
    if (sel) sel.value = last;
    await activateShip(last);
  } else {
    const make = (n, prefix) => Array.from({length:n}).map((_,i)=>({ id: `${prefix}${i+1}`, name: `${prefix.toUpperCase()} ${i+1}`, lcg: 0, cap_m3: null }));
    ACTIVE = { cargo: make(6,'COT'), ballast: make(6,'Ballast') };
    HYDRO_ROWS = null;
    CONS_TANKS = await loadConsumablesFromJson();
    buildTankInputs('cargo-tanks', ACTIVE.cargo);
    buildTankInputs('ballast-tanks', ACTIVE.ballast);
    renderConstants();
    wireConsumablesUI();
    updateConstLCGHint();
  }
  // Normalize decimal separator on rho change (do not mutate on each keypress)
  const rhoEl = document.getElementById('rho');
  if (rhoEl) rhoEl.addEventListener('change', ()=>{ rhoEl.value = String(rhoEl.value||'').replace(',', '.'); });
})();

el('calc').addEventListener('click', calc);
el('prefill').addEventListener('click', prefillExample);
el('clear').addEventListener('click', clearAll);
const shipSel = document.getElementById('ship-select');
if (shipSel) {
  shipSel.addEventListener('change', async (e) => {
    const id = e.target.value;
    if (id) { await activateShip(id); setActiveShipID(id); }
  });
}

// Export/Import (main header)
function exportAllLocalShips() {
  const idx = getLocalIndex();
  const ships = idx.map(s => getLocalShip(s.id)).filter(Boolean);
  const bundle = { schemaVersion: 1, ships };
  const name = `ships_export_${new Date().toISOString().slice(0,10)}.json`;
  download(name, JSON.stringify(bundle, null, 2));
}
async function importAllLocalShips(file) {
  try {
    const text = await readFileAsText(file);
    const data = JSON.parse(text);
    const arr = Array.isArray(data.ships) ? data.ships : [];
    for (const p of arr) { if (p && p.ship && p.ship.id) saveLocalShip(p); }
    // Refresh dropdown
    SHIPS_INDEX = await compileShipsIndex();
    populateShipDropdown(SHIPS_INDEX);
  } catch(e) { alert('Import failed: invalid JSON'); }
}
const expBtn = document.getElementById('export-ships');
if (expBtn) expBtn.addEventListener('click', exportAllLocalShips);
const impBtn = document.getElementById('import-ships');
const impFile = document.getElementById('import-file');
if (impBtn && impFile) {
  impBtn.addEventListener('click', ()=> impFile.click());
  impFile.addEventListener('change', async ()=>{ const f=impFile.files&&impFile.files[0]; if (f) await importAllLocalShips(f); impFile.value=''; });
}

// Delete ship (local-only)
function removeLocalShip(id) {
  try { localStorage.removeItem(LS_PREFIX + id); } catch(_) {}
  const idx = getLocalIndex().filter(s => s.id !== id);
  setLocalIndex(idx);
  const active = getActiveShipID();
  if (active === id) { try { localStorage.removeItem(LS_ACTIVE_KEY); } catch(_) {} }
}
async function showPlaceholders() {
  const make = (n, prefix) => Array.from({length:n}).map((_,i)=>({ id: `${prefix}${i+1}`, name: `${prefix.toUpperCase()} ${i+1}`, lcg: 0, cap_m3: null }));
  ACTIVE = { cargo: make(6,'COT'), ballast: make(6,'Ballast') };
  HYDRO_ROWS = null;
  CONS_TANKS = await loadConsumablesFromJson();
  buildTankInputs('cargo-tanks', ACTIVE.cargo);
  buildTankInputs('ballast-tanks', ACTIVE.ballast);
  renderConstants();
  wireConsumablesUI();
}
const delBtn = document.getElementById('delete-ship');
if (delBtn && shipSel) {
  delBtn.addEventListener('click', async ()=>{
    const id = shipSel.value;
    if (!id) { alert('Select a ship first.'); return; }
    if (!getLocalShip(id)) { alert('Only locally saved/imported ships can be deleted.'); return; }
    if (!confirm(`Delete ship "${id}" from local storage?`)) return;
    removeLocalShip(id);
    // Refresh dropdown
    SHIPS_INDEX = await compileShipsIndex();
    populateShipDropdown(SHIPS_INDEX);
    shipSel.value = '';
    await showPlaceholders();
  });
}
// Import wizard logic (basic paste-based parser)
const addShipBtn = document.getElementById('add-ship');
let WIZ = { hydro: [], cargo: [], ballast: [], cons: [] };
let WIZ_LAST = { hydroText: '', cargoText: '', ballastText: '', consText: '' };
let WIZ_BOUND = false;
let OPEN_BUSY = false; // prevent multi-open race (Chrome double listeners, etc.)
let WIZ_EDIT_MODE = false; // wizard opened for editing an existing ship

// --- Integration: accept stowage planner payload via postMessage ---
let PENDING_STOWAGE_APPLY = null;

function normalizeCargoNameToId(name) {
  if (!name) return null;
  const s = String(name).toUpperCase().trim();
  const mCot = /\bCOT\s*(\d+)\s*(P|S|C)\b/.exec(s);
  if (mCot) return `COT${mCot[1]}${mCot[2]}`;
  const mNo = /NO\.?\s*(\d+)\s*CARGO\s*TK\s*\((P|S|C)\)/.exec(s);
  if (mNo) return `COT${mNo[1]}${mNo[2]}`;
  if (/SLOP/.test(s)) {
    const mSide = /(\(|\s)(P|S)(\)|\b)/.exec(s);
    if (mSide && mSide[2]==='P') return 'SLOPP';
    if (mSide && mSide[2]==='S') return 'SLOPS';
  }
  return null;
}

function buildCargoNormIndex() {
  const map = new Map();
  try {
    for (const t of (ACTIVE && Array.isArray(ACTIVE.cargo) ? ACTIVE.cargo : [])) {
      const norm = normalizeCargoNameToId(t.name || t.id || '');
      if (norm) map.set(norm, t.id);
    }
  } catch(_) {}
  return map;
}

function applyStowagePayload(pl) {
  try {
    if (!pl) return;
    // General inputs
    if (isFinite(pl.rho)) { const e = el('rho'); if (e) e.value = String(pl.rho); }
    if (pl.constant) {
      const cw = el('const_w'); const cx = el('const_x');
      if (cw && isFinite(pl.constant.w)) cw.value = String(pl.constant.w);
      if (cx && isFinite(pl.constant.x_midship_m)) {
        // Convert from midship (+forward) to current display datum
        const base = SHIP_ACTIVE || SHIP;
        const xDisp = convertMidshipToRef(Number(pl.constant.x_midship_m), Number(base.LBP||SHIP.LBP), String(LONG_REF_ACTIVE||'ms_plus'));
        cx.value = String(xDisp);
      }
    }
    if (pl.consumables) {
      const set = (id,val)=>{ const e=el(id); if (e && isFinite(val)) e.value = String(val); };
      set('fo_w', pl.consumables.fo);
      set('fw_w', pl.consumables.fw);
      set('oth_w', pl.consumables.oth);
    }
    // Tanks: set weights per cargo tank
    const normIdx = buildCargoNormIndex();
    let missing = 0;
    if (Array.isArray(pl.allocations)) {
      for (const a of pl.allocations) {
        const key = a && a.tank_id;
        if (!key) continue;
        const rowId = normIdx.get(String(key).toUpperCase());
        if (!rowId) { missing++; continue; }
        const wp = document.getElementById(`w_${rowId}`);
        if (wp) wp.value = String(Number(a.weight_mt||0).toFixed(1)); else missing++;
        // Optional: clear %/vol to keep UI consistent with weight-driven input
        const pp = document.getElementById(`p_${rowId}`); if (pp) pp.value = '';
        const vp = document.getElementById(`v_${rowId}`); if (vp) vp.value = '';
      }
    }
    // Update totals and recompute
    try { updateTankTotals('cargo-tanks', ACTIVE.cargo); } catch(_) {}
    try { updateTankTotals('ballast-tanks', ACTIVE.ballast); } catch(_) {}
    if (typeof wireConsumablesUI === 'function') wireConsumablesUI();
    calc();
    // If not all fields were present (UI not built yet), keep pending and retry
    if (missing > 0) {
      PENDING_STOWAGE_APPLY = pl;
      setTimeout(()=>{ if (PENDING_STOWAGE_APPLY) { const tmp = PENDING_STOWAGE_APPLY; PENDING_STOWAGE_APPLY=null; applyStowagePayload(tmp); } }, 350);
    }
  } catch(_) { /* ignore */ }
}

window.addEventListener('message', (e) => {
  try {
    const data = e && e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'apply_stowage_plan' && data.payload) {
      applyStowagePayload(data.payload);
    }
  } catch(_){ /* noop */ }
});

function showWizard() {
  const ov = document.getElementById('wizard-overlay');
  if (!ov) { alert('Import wizard could not be opened.'); return; }
  ov.style.display = 'block';
  if (!WIZ_BOUND) bindWizardOnce();
  activateTab('hydro');
  updateWizStatus();
}
function hideWizard() {
  const ov = document.getElementById('wizard-overlay');
  if (ov) ov.style.display = 'none';
}
function getTabButtons() { return Array.from(document.querySelectorAll('.tab-btn')); }
function getPanes() {
  return {
    hydro: document.getElementById('tab-hydro'),
    cargo: document.getElementById('tab-cargo'),
    ballast: document.getElementById('tab-ballast'),
    cons: document.getElementById('tab-cons'),
  };
}
function activateTab(id) {
  const panes = getPanes();
  for (const [k, el] of Object.entries(panes)) { if (el) el.style.display = (k===id ? 'block' : 'none'); }
  for (const b of getTabButtons()) { b.classList.toggle('active', b.dataset.tab===id); }
}
function updateWizStatus() {
  const s = document.getElementById('wiz-status');
  if (!s) return;
  const counts = [
    `Hydro: ${WIZ.hydro.length}`,
    `Cargo: ${WIZ.cargo.length}`,
    `Ballast: ${WIZ.ballast.length}`,
    `Cons: ${WIZ.cons.length}`,
  ].join(' • ');
  s.textContent = counts;
  updateRequirementHints();
  updateProgramPreviews();
}
if (addShipBtn) addShipBtn.addEventListener('click', showWizard);

// Open wizard in edit mode with the selected ship's profile preloaded
async function openWizardForEdit() {
  const sel = document.getElementById('ship-select');
  const id = sel && sel.value;
  if (!id) { alert('Select a ship first.'); return; }
  const profile = await loadShipProfile(id);
  if (!profile || !profile.ship) { alert('Could not load ship profile.'); return; }
  const profMid = convertProfileLongitudes(JSON.parse(JSON.stringify(profile)));
  // Reset WIZ buffers
  WIZ = { hydro: [], cargo: [], ballast: [], cons: [] };
  WIZ_LAST = { hydroText: '', cargoText: '', ballastText: '', consText: '' };
  // Fill basics
  try {
    const s = profMid.ship || {};
    const setVal = (id,v)=>{ const e=document.getElementById(id); if(e) e.value = (v==null? '' : String(v)); };
    setVal('wiz-name', s.name || s.id || '');
    setVal('wiz-lbp', isFinite(s.lbp)? s.lbp : '');
    setVal('wiz-rho', isFinite(s.rho_ref)? s.rho_ref : '');
    const le = document.getElementById('wiz-longref'); if (le) le.value = (s.long_ref||'ms_plus');
    if (s.light_ship && isFinite(s.light_ship.weight)) setVal('wiz-ls-w', s.light_ship.weight);
    if (s.light_ship && isFinite(s.light_ship.lcg)) setVal('wiz-ls-x', Number(s.light_ship.lcg).toFixed(3));
    if (s.constant && isFinite(s.constant.weight)) setVal('wiz-c-w', s.constant.weight);
    if (s.constant && isFinite(s.constant.lcg)) setVal('wiz-c-x', s.constant.lcg);
  } catch(_){}
  // Fill lists
  try { WIZ.hydro = Array.isArray(profMid.hydrostatics?.rows) ? profMid.hydrostatics.rows.slice() : []; } catch(_){}
  try { WIZ.cargo = Array.isArray(profMid.tanks?.cargo) ? profMid.tanks.cargo.slice() : []; } catch(_){}
  try { WIZ.ballast = Array.isArray(profMid.tanks?.ballast) ? profMid.tanks.ballast.slice() : []; } catch(_){}
  try { WIZ.cons = Array.isArray(profMid.tanks?.consumables) ? profMid.tanks.consumables.slice() : []; } catch(_){}
  WIZ_EDIT_MODE = true;
  showWizard();
  updateProgramPreviews();
}
const editBtn = document.getElementById('edit-ship');
if (editBtn) editBtn.addEventListener('click', openWizardForEdit);

// Helpers for parsing
function detectDelimiter(line) {
  if (line.includes('\t')) return '\t';
  const counts = [',',';','|'].map(ch => [ch, (line.split(ch).length-1)]);
  counts.sort((a,b)=>b[1]-a[1]);
  if (counts[0][1]>0) return counts[0][0];
  return 'whitespace';
}
function readFileAsText(file) {
  return new Promise((resolve,reject)=>{
    const fr = new FileReader();
    fr.onerror = ()=>reject(fr.error);
    fr.onload = ()=>resolve(String(fr.result||''));
    fr.readAsText(file);
  });
}
function normText(text) {
  return text.replace(/[\u2013\u2014]/g,'-').replace(/[\u00B7\u2219\u22C5]/g,'.').replace(/\u00A0/g,' ');
}
function toNumber(s) {
  if (typeof s !== 'string') return Number(s);
  let t = s.trim();
  // convert 1.234,56 or 1,234.56 to 1234.56
  const hasComma = t.includes(',');
  const hasDot = t.includes('.');
  if (hasComma && hasDot) {
    if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g,'').replace(',', '.');
    else t = t.replace(/,/g,'');
  } else if (hasComma && !hasDot) {
    t = t.replace(',','.');
  }
  const n = Number(t);
  return isFinite(n) ? n : NaN;
}
function splitLine(line, delim) {
  if (delim==='\\t') return line.split('\t');
  if (delim==='whitespace') return line.trim().split(/\s+/);
  return line.split(delim);
}
// Normalize tank name from CSV: keep only first token (strip trailing ,cap and ,lcg tokens)
function cleanTankName(s) {
  let t = String(s||'').trim();
  if (!t) return t;
  if (t.includes(',')) t = t.split(',')[0].trim();
  else if (t.includes('\t')) t = t.split('\t')[0].trim();
  else if (t.includes(';')) t = t.split(';')[0].trim();
  return t.replace(/^"|"$/g,'');
}
// Extract helpers for name normalization
function extractTankNumber(name){
  const s = String(name||'');
  let m = s.match(/\bno\.?\s*(\d+)/i); if (m) return Number(m[1]);
  m = s.match(/\b(\d{1,3})\b/); if (m) return Number(m[1]);
  return null;
}
function extractTankSide(name){
  const s = String(name||'');
  let m = s.match(/\(([PSC])\)/i); if (m) return m[1].toUpperCase();
  m = s.match(/\b([PSC])\b/i); if (m) return m[1].toUpperCase();
  return null;
}
function isFPTorAPT(name){
  const s = String(name||'').toLowerCase();
  return /(\bf\.?p\.?t\b|fore\s*peak|\ba\.?p\.?t\b|after\s*peak)/i.test(s);
}
function looksLikeWBT(name){
  const s = String(name||'');
  // Accept WBT, W.B.T, WB TK/TANK, and dotted TK variants like W.B.TK/WBTK
  return /(\bw\.?b\.?t\b|\bw\.?b\.?\s*tk\b|\bwb\s*(?:tk|tank)\b|wing\s*ballast)/i.test(s);
}
function isSlopOrResidual(name){
  const s = String(name||'').toLowerCase();
  return /(slop|residual)/.test(s);
}
function normalizeCargoName(name){
  if (isSlopOrResidual(name)) return name;
  const n = extractTankNumber(name);
  if (n==null) return name;
  const side = extractTankSide(name);
  return `COT ${n}${side? ' '+side : ''}`;
}
function normalizeBallastName(name){
  if (isFPTorAPT(name)) return name; // keep FPT/APT as-is
  if (looksLikeWBT(name)){
    const n = extractTankNumber(name);
    if (n==null) return name;
    const side = extractTankSide(name);
    return `WBT ${n}${side? ' '+side : ''}`;
  }
  return name;
}
// Name classifier for Ballast-like tanks (accepts digits after tags like WBT1, SWBT2, etc.)
function isBallastName(name) {
  const raw = String(name||'');
  const s = raw.toLowerCase();
  const pats = [
    /\bw\.?b\.?t(?=\b|\d)/i,         // WBT, W.B.T, WBT1
    /\bswbt(?=\b|\d)/i,
    /\bbwbt(?=\b|\d)/i,
    /\bwb\s*(?:tk|tank)\b/i,
    /\bwing\s*ballast\b/i,
    /\bd\.?b\.?t(?=\b|\d)/i,         // DBT, D.B.T, DBT1
    /double\s*bottom/i,
    /\bf\s*\.?\s*p\s*\.?\s*t\s*\.?\s*(?:k|tk)?\b/i, // F. P. TK variants
    /\ba\s*\.?\s*p\s*\.?\s*t\s*\.?\s*(?:k|tk)?\b/i, // A. P. TK variants
    /fore\s*peak/i,
    /after\s*peak/i,
    /\bcwt\b/i,
    /\bballast\b/i,
  ];
  return pats.some(re => re.test(raw) || re.test(s));
}
function parseHydro(text) {
  const out = [];
  const rawLines = normText(text).split(/\r?\n/).filter(l=>l.trim().length>0);
  if (!rawLines.length) return out;
  const normalizeKey = (s) => String(s).toLowerCase().replace(/[\s\.()\-]/g,'');
  // Find a likely header line by normalized keywords (handles dotted forms like L.C.F.)
  let headerIdx = rawLines.findIndex(l => {
    const ln = normalizeKey(l);
    return /(draft|dis|disp|displ|dissw|lcf|lca|lcb|tpc|mct)/.test(ln);
  });
  if (headerIdx < 0) headerIdx = 0;
  const delim = detectDelimiter(rawLines[headerIdx]);
  const headerRaw = splitLine(rawLines[headerIdx], delim);
  const headerNorm = headerRaw.map(h => normalizeKey(h));
  // Single displacement: only SW-based; generic names default to SW
  const map = { draft:-1, dis_sw:-1, lcf:-1, lcb:-1, tpc:-1, mct:-1 };
  headerNorm.forEach((hn, i) => {
    if (map.draft < 0 && /draft/.test(hn)) map.draft = i;
    // DIS synonyms: displ, displt, disp, dis, displacement (+ optional fw/sw tags)
    const hasDis = /(displacement|displ|displt|disp|^dis$)/.test(hn) || /^dis[a-z]*$/.test(hn);
    const isFW = /(fw|fresh)/.test(hn);
    const isSW = /(sw|sea)/.test(hn);
    if (map.dis_sw < 0 && (/(dissw|\bsw$)/.test(hn) || (hasDis && isSW) || (hasDis && !isFW && !isSW))) map.dis_sw = i; // generic → SW by default
    if (map.lcf < 0 && /(lcf|lca)/.test(hn)) map.lcf = i; // accept LCA as LCF
    if (map.lcb < 0 && /lcb/.test(hn)) map.lcb = i;
    if (map.tpc < 0 && /tpc/.test(hn)) map.tpc = i;
    if (map.mct < 0 && /mct/.test(hn)) map.mct = i;
  });
  // Generic already routed to SW above
  // Fallback: tolerate dotted/space-separated kısaltmalar even if normalization fails
  if (map.mct < 0) {
    for (let i = 0; i < headerRaw.length; i++) {
      const raw = String(headerRaw[i] || '');
      if (/m[^a-z0-9]*t[^a-z0-9]*c/i.test(raw)) { map.mct = i; break; }
    }
  }
  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const cols = splitLine(rawLines[i], delim);
    const get = (idx) => (idx >= 0 && idx < cols.length) ? cols[idx] : '';
    const draft = toNumber(get(map.draft >= 0 ? map.draft : 0));
    if (!isFinite(draft)) continue;
    const dis_sw = isFinite(toNumber(get(map.dis_sw))) ? toNumber(get(map.dis_sw)) : undefined;
    const lcf = toNumber(get(map.lcf));
    const lcb = toNumber(get(map.lcb));
    const tpc = toNumber(get(map.tpc));
    const mct = toNumber(get(map.mct));
    out.push({ draft_m: draft, dis_sw, lcf_m: lcf, lcb_m: lcb, tpc, mct });
  }
  return out;
}
// Quick import classification
function classifyTextForSection(text) {
  const t = text.toLowerCase();
  let scoreHydro = 0, scoreCargo = 0, scoreBallast = 0, scoreCons = 0;
  if (/hydrostatic/.test(t)) scoreHydro += 3;
  if (/(draft|tpc|mct|lcf|lcb)/.test(t)) scoreHydro += 2;
  if (/(dis\s*\(fw\)|dis\s*\(sw\)|displacement)/.test(t)) scoreHydro += 2;

  if (/(cargo\s+tk|slop\s+tk|cargo\s+tank)/.test(t)) scoreCargo += 3;
  if (/(no\.\s*\d\s*cargo|c\d+p|c\d+s)/.test(t)) scoreCargo += 1;

  if (/(w\.b\.|ballast|f\.p\.\s*tk|a\.p\.\s*tk|wb\d)/.test(t)) scoreBallast += 3;

  if (/(hfo|f\.o\.|fuel|d\.o\.|mdo|mgo|diesel|bunker|fresh\s*water|fw\b|lube|lub\.?\s*oil|lo\b)/.test(t)) scoreCons += 3;
  if (/(hacim\s*\(100%\)|capacity\s*100%|m³)/.test(t)) scoreCons += 1;

  const arr = [
    ['hydro', scoreHydro],
    ['cargo', scoreCargo],
    ['ballast', scoreBallast],
    ['cons', scoreCons],
  ];
  arr.sort((a,b)=>b[1]-a[1]);
  return arr[0][1] > 0 ? arr[0][0] : 'unknown';
}

async function handleQuickFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const log = (msg) => {
    const el = document.getElementById('quick-log');
    if (el) el.textContent = msg;
  };
  log(`İşleniyor: ${fileList.length} dosya...`);
  // Snapshot counts BEFORE import to compute accurate deltas after reclassification
  const countNow = () => ({
    hydro: (WIZ.hydro||[]).length,
    cargo: (WIZ.cargo||[]).length,
    ballast: (WIZ.ballast||[]).length,
    cons: (WIZ.cons||[]).length,
  });
  const before = countNow();
  let added = { hydro:0, cargo:0, ballast:0, cons:0 }; // legacy accumulation (kept for potential debugging)
  for (const f of fileList) {
    try {
      const text = await readFileAsText(f);
      const first = String(text).split(/\r?\n/)[0] || '';
      const hasComma = (first.split(',').length-1) >= 2;
      const hasTab = (first.split('\t').length-1) >= 2;
      const isCSV = /\.(csv|tsv)$/i.test(f.name || '') || hasComma || hasTab;
      if (isCSV) {
        const parsed = parseCsvSmart(text);
        if (parsed.kind === 'hydro') {
          const rows = parsed.rows || [];
          if (rows.length) {
            WIZ.hydro = (WIZ.hydro||[]).concat(rows);
            WIZ_LAST.hydroText = text;
            added.hydro += rows.length;
          }
        } else if (parsed.kind === 'tanks') {
          const { cargo, ballast, cons } = parsed;
          if (cargo.length) { WIZ.cargo = (WIZ.cargo||[]).concat(cargo); added.cargo += cargo.length; }
          if (ballast.length) { WIZ.ballast = (WIZ.ballast||[]).concat(ballast); added.ballast += ballast.length; }
          if (cons.length) { WIZ.cons = (WIZ.cons||[]).concat(cons); added.cons += cons.length; }
        } else {
          // fallback classify
          const kind = classifyTextForSection(text);
          if (kind === 'hydro') {
            const rows = parseHydro(text);
            if (rows.length) { WIZ.hydro = (WIZ.hydro||[]).concat(rows); WIZ_LAST.hydroText = text; added.hydro += rows.length; }
          } else if (kind === 'cargo') {
            let rows = parseTanksGeneric(text, 'tank');
            rows = rows.map(r => ({ ...r, name: normalizeCargoName(r.name) }));
            if (rows.length) { WIZ.cargo = (WIZ.cargo||[]).concat(rows); added.cargo += rows.length; }
          } else if (kind === 'ballast') {
            let rows = parseTanksGeneric(text, 'tank');
            rows = rows.map(r => ({ ...r, name: normalizeBallastName(r.name) }));
            if (rows.length) { WIZ.ballast = (WIZ.ballast||[]).concat(rows); added.ballast += rows.length; }
          } else if (kind === 'cons') {
            const rows = parseTanksGeneric(text, 'cons');
            if (rows.length) { WIZ.cons = (WIZ.cons||[]).concat(rows); added.cons += rows.length; }
          }
        }
      } else {
        const kind = classifyTextForSection(text);
        if (kind === 'hydro') {
          const rows = parseHydro(text);
          if (rows.length) { WIZ.hydro = (WIZ.hydro||[]).concat(rows); WIZ_LAST.hydroText = text; added.hydro += rows.length; }
        } else if (kind === 'cargo') {
          let rows = parseTanksGeneric(text, 'tank');
          rows = rows.map(r => ({ ...r, name: normalizeCargoName(r.name) }));
          if (rows.length) { WIZ.cargo = (WIZ.cargo||[]).concat(rows); added.cargo += rows.length; }
        } else if (kind === 'ballast') {
          let rows = parseTanksGeneric(text, 'tank');
          rows = rows.map(r => ({ ...r, name: normalizeBallastName(r.name) }));
          if (rows.length) { WIZ.ballast = (WIZ.ballast||[]).concat(rows); added.ballast += rows.length; }
        } else if (kind === 'cons') {
          const rows = parseTanksGeneric(text, 'cons');
          if (rows.length) { WIZ.cons = (WIZ.cons||[]).concat(rows); added.cons += rows.length; }
        }
      }
    } catch (_) {}
  }
  // Update previews
  // Deduplicate by (name|lcg|cap) to avoid duplicates on repeated imports
  const keyTank = t=> `${t.name}|${t.lcg}|${t.cap_m3??''}`;
  const dedupe = (arr)=>{ const m=new Map(); for(const x of arr||[]){ const k=keyTank(x); if(!m.has(k)) m.set(k,x);} return Array.from(m.values()); };
  WIZ.cargo = dedupe(WIZ.cargo);
  WIZ.ballast = dedupe(WIZ.ballast);
  WIZ.cons = dedupe(WIZ.cons);
  // Post-fix reclassification: move ballast-like names mistakenly in Cons to Ballast
  if (!WIZ_MANUAL) {
    try {
      const move = [];
      const stay = [];
      for (const t of WIZ.cons) { (isBallastName(t.name) ? move : stay).push(t); }
      if (move.length) {
        WIZ.cons = stay;
        WIZ.ballast = dedupe((WIZ.ballast||[]).concat(move.map(({name,lcg,cap_m3})=>({name,lcg,cap_m3}))));
      }
    } catch(_) {}
  }
  renderTablePreview('preview-hydro', WIZ.hydro, ['draft_m',{key:'dis_sw',label:'Displacement'},'lcf_m','lcb_m','tpc','mct']);
  renderTablePreview('preview-cargo', WIZ.cargo, ['name','lcg','cap_m3']);
  renderTablePreview('preview-ballast', WIZ.ballast, ['name','lcg','cap_m3']);
  renderTablePreview('preview-cons', WIZ.cons, ['name','type','lcg','cap_m3']);
  updateWizStatus();
  // Compute AFTER counts and show net deltas so they match the status panel
  const after = countNow();
  const delta = {
    hydro: Math.max(0, after.hydro - before.hydro),
    cargo: Math.max(0, after.cargo - before.cargo),
    ballast: Math.max(0, after.ballast - before.ballast),
    cons: Math.max(0, after.cons - before.cons),
  };
  log(`Eklendi → Hydro:${delta.hydro} Cargo:${delta.cargo} Ballast:${delta.ballast} Cons:${delta.cons}`);
}
function buildMapUIHydro(lines, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML='';
  if (!lines || !lines.length) { el.innerHTML = '<div style="color:#94a3b8;">Eşleme için önce metin yapıştırın ya da dosya yükleyin.</div>'; return; }
  const delim = detectDelimiter(lines[0]);
  const sample = splitLine(lines[0], delim);
  function sel(id,label){
    const options = ['<option value="">-</option>'].concat(sample.map((t,i)=>`<option value="${i}">${i}: ${t}</option>`)).join('');
    return `<label style="display:flex;flex-direction:column;gap:4px;">${label}<select id="${id}">${options}</select></label>`;
  }
  el.innerHTML = `
    <div style="border:1px solid #1e293b; padding:8px; border-radius:6px;">
      <div style="font-size:12px; color:#9fb3c8; margin-bottom:6px;">Kolon Eşleme (örnek satırdaki kolonlara göre)</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px;">
        ${sel('map-h-draft','Draft (m)')}
        ${sel('map-h-dis','DIS (t) [SW varsayılan]')}
        ${sel('map-h-lcf','LCF (m)')}
        ${sel('map-h-lcb','LCB (m)')}
        ${sel('map-h-tpc','TPC (t/cm)')}
        ${sel('map-h-mct','MCT1cm (t·m/cm)')}
      </div>
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button id="apply-map-hydro">Eşlemeyi Uygula</button>
      </div>
    </div>`;
  const apply = document.getElementById('apply-map-hydro');
  if (apply) apply.addEventListener('click', ()=>{
    const idx = k=>{ const v = document.getElementById(`map-h-${k}`).value; return v===''?null:Number(v); };
    const map = { draft: idx('draft'), dis_sw: idx('dis'), lcf: idx('lcf'), lcb: idx('lcb'), tpc: idx('tpc'), mct: idx('mct') };
    const rows=[];
    for (const line of lines) {
      const cols = splitLine(line, delim);
      const val = (i)=> (i==null?undefined: toNumber(cols[i] ?? ''));
      const draft = val(map.draft);
      if (!isFinite(draft)) continue;
      rows.push({
        draft_m: draft,
        dis_sw: val(map.dis_sw),
        lcf_m: val(map.lcf),
        lcb_m: val(map.lcb),
        tpc: val(map.tpc),
        mct: val(map.mct),
      });
    }
    // Always append + dedupe by draft
    WIZ.hydro = dedupeHydro((WIZ.hydro||[]).concat(rows));
    try { WIZ_LAST.hydroText = lines.join('\n'); } catch(_) {}
    renderTablePreview('preview-hydro', WIZ.hydro, ['draft_m',{key:'dis_sw',label:'Displacement'},'lcf_m','lcb_m','tpc','mct']);
    updateWizStatus();
  });
}
function buildMapUITanks(lines, containerId, mode) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML='';
  if (!lines || !lines.length) { el.innerHTML = '<div style="color:#94a3b8;">Eşleme için önce metin yapıştırın ya da dosya yükleyin.</div>'; return; }
  const delim = detectDelimiter(lines[0]);
  const sample = splitLine(lines[0], delim);
  function sel(id,label){
    const options = ['<option value="">-</option>'].concat(sample.map((t,i)=>`<option value="${i}">${i}: ${t}</option>`)).join('');
    return `<label style="display:flex;flex-direction:column;gap:4px;">${label}<select id="${id}">${options}</select></label>`;
  }
  const extra = mode==='cons' ? sel('map-t-type','Type (fuel|freshwater|lube)') : '';
  el.innerHTML = `
    <div style="border:1px solid #1e293b; padding:8px; border-radius:6px;">
      <div style="font-size:12px; color:#9fb3c8; margin-bottom:6px;">Kolon Eşleme</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px;">
        ${sel('map-t-name','Name')}
        ${sel('map-t-lcg','LCG (m)')}
        ${sel('map-t-cap','Cap(100%) m³')}
        ${extra}
      </div>
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button id="apply-map-tank">Eşlemeyi Uygula</button>
      </div>
    </div>`;
  const apply = document.getElementById('apply-map-tank');
  if (apply) apply.addEventListener('click', ()=>{
    const idx = id=>{ const v=document.getElementById(id).value; return v===''?null:Number(v); };
    const m = { name: idx('map-t-name'), lcg: idx('map-t-lcg'), cap: idx('map-t-cap'), type: idx('map-t-type') };
    const rows=[];
    for (const line of lines) {
      const cols = splitLine(line, delim);
      const pick = i => (i==null?undefined: cols[i]);
      const name = cleanTankName(pick(m.name) || cols.join(' '));
      const lcg = toNumber(pick(m.lcg)); if (!isFinite(lcg)) continue;
      const cap = toNumber(pick(m.cap));
      let type = (m.type!=null? (pick(m.type)||'') : '');
      if (!type && mode==='cons') {
        // infer from name
        const s=name.toLowerCase();
        if (/hfo|f\.o|fuel|d\.o|mdo|mgo|diesel|bunker/.test(s)) type='fuel';
        else if (/fresh|fw\b|freshwater/.test(s)) type='freshwater';
        else if (/lube|lub\.? oil|lo\b/.test(s)) type='lube';
        else type='other';
      }
      if (mode==='cons') rows.push({ name, type, lcg, cap_m3: isFinite(cap)? cap : undefined });
      else rows.push({ name, lcg, cap_m3: isFinite(cap)? cap : undefined });
    }
    // Caller will handle assignment to WIZ lists if needed
    // Return rows by emitting a custom event
  });
}
  function parseTanksGeneric(text, mode) {
  // mode: 'cargo'|'ballast'|'cons'
  const out = [];
  const lines = normText(text).split(/\r?\n/);
  const typeFromName = (name) => {
    const s = name.toLowerCase();
    if (/(^|\b)(hfo|fo|f\.o\.|mdo|mgo|do|d\.o\.|diesel|bunker)(\b|\.)/.test(s) || /(serv|sett|slud|drain|over)/.test(s)) return 'fuel';
    if (/(fresh\s*water|^fw\b|f\.w\.|fwt\b|potable)/.test(s) || /\bf\s*\.?\s*w\s*\.?\s*tk\b/.test(s)) return 'freshwater';
    if (/(^|\b)(lo|l\.o\.|lube)(\b|\.)/.test(s) || /cyl\.o|cyl\.?oil|hyd\.o|hydraulic|lubric/.test(s)) return 'lube';
    return 'other';
  };
  for (const raw of lines) {
    const l = raw.trim(); if (!l) continue;
    // split into tokens, take last 1-2 numbers as lcg/cap if present
    const nums = (l.match(/[-+]?\d*\.?\d+/g)||[]).map(toNumber);
    let name = l;
    let lcg = NaN, cap = null;
    if (nums.length>=1) {
      lcg = nums[nums.length-1];
      // if there is a second to last and it's much bigger, treat as cap
      if (nums.length>=2 && Math.abs(nums[nums.length-2])>50) cap = nums[nums.length-2];
      // For free-form lines we keep full name to preserve labels like "NO.1 COT(P)"
    }
    if (!isFinite(lcg)) continue;
    if (mode==='cons') {
      const tp = typeFromName(name);
      out.push({ name, type: tp, lcg, cap_m3: cap });
    } else {
      out.push({ name, lcg, cap_m3: cap });
    }
  }
  return out;
}

// CSV-aware tank/hydro parser: detects headers and routes rows to categories
function parseCsvSmart(text) {
  const lines = String(text||'').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l=> l.trim().length>0);
  if (!lines.length) return { kind:'unknown' };
  // Robust delimiter guess: prefer comma, then tab, then semicolon, based on first non-empty lines
  function guessDelim(ls){
    const take = ls.slice(0, Math.min(5, ls.length));
    const score = { ',':0, '\t':0, ';':0 };
    for (const l of take){ if (!l) continue; score[','] += (l.split(',').length-1); score['\t'] += (l.split('\t').length-1); score[';'] += (l.split(';').length-1); }
    const entries = Object.entries(score).sort((a,b)=> b[1]-a[1]);
    if (entries[0][1] >= 2) return entries[0][0];
    return detectDelimiter(ls[0]);
  }
  const delim = guessDelim(lines);
  const head = splitLine(lines[0], delim).map(h=> String(h||'').trim());
  const norm = s=> s.toLowerCase().replace(/[^a-z0-9]+/g,'');
  const headNorm = head.map(h => norm(h));
  // Helper to prefer specific variants
  const pickFirst = (arr, pred) => { for (const it of arr) if (pred(it)) return it; return arr[0]; };
  // Draft: prefer DRAFT (MLD.) over others if present
  const draftCands = head.map((h,i)=>({i,raw:h,norm:headNorm[i]})).filter(o=> /draft/i.test(o.raw) || /draft/.test(o.norm));
  const draftPick = draftCands.length ? pickFirst(draftCands, o=> /mld/i.test(o.raw) || /mld/.test(o.norm)) : null;
  const idx = {
    name: head.findIndex(h=> /^(tank|name)/i.test(h) || /tankname/i.test(norm(h)) || norm(h)==='name' ),
    vol: head.findIndex(h=> /(vol|volume|cap|capacity)/i.test(h) || /m3|m²|m³/.test(h) ),
    lcg: head.findIndex(h=> /lcg/i.test(h)),
    draft: draftPick ? draftPick.i : head.findIndex(h=> /draft/i.test(h)),
    // Use normalized header tokens to catch dotted forms: T.P.C., M.T.C., L.C.F., L.C.B.
    tpc: headNorm.findIndex(hn=> /^tpc/.test(hn)),
    mct: headNorm.findIndex(hn=> /^(mct|mtc)/.test(hn)),
    lcf: headNorm.findIndex(hn=> /^(lcf|lca)/.test(hn)), // treat LCA as LCF
    lcb: headNorm.findIndex(hn=> /^lcb/.test(hn)),
    dissw: -1,
  };
  // DIS synonyms on CSV headers (normalized)
  for (let i=0;i<headNorm.length;i++){
    const hn = headNorm[i];
    const hasDis = /(displacement|displ|displt|disp|^dis$)/.test(hn) || /^dis[a-z]*$/.test(hn);
    const isFW = /(fw|fresh)/.test(hn);
    const isSW = /(sw|sea)/.test(hn);
    if (idx.dissw < 0 && (/(dis\(sw\)|dissw)/.test(hn) || (hasDis && isSW) || (hasDis && !isFW && !isSW))) idx.dissw = i; // generic → SW
  }
  // generic now routed to SW
  const hasHydro = (idx.draft>=0) && (idx.tpc>=0 || idx.mct>=0 || idx.lcf>=0 || idx.lcb>=0);
  if (hasHydro) {
    const rows=[];
    for (let i=1;i<lines.length;i++){
      const cols = splitLine(lines[i], delim);
      const val = (j)=> j>=0? toNumber(cols[j]??'') : undefined;
      const draft = val(idx.draft); if (!isFinite(draft)) continue;
      rows.push({ draft_m: draft, lcf_m: val(idx.lcf), lcb_m: val(idx.lcb), tpc: val(idx.tpc), mct: val(idx.mct), dis_sw: val(idx.dissw) });
    }
    return { kind:'hydro', rows };
  }
  // Tanks CSV
  if (idx.name>=0 && idx.lcg>=0) {
    const cargo=[], ballast=[], cons=[];
    // classifiers
    const any = (s, arr)=> arr.some(re=> re.test(s));
    const pat = {
      cargo: [/(^|\b)(cot|cargo)(\b|\(|\d)/i, /slop/i, /residual/i, /(sloptk|sloptank)/i],
      // Ballast patterns expanded
      ballast: [
        /\bw\.?b\.?t\b/i,                // W.B.T or WBT
        /\bwb\s*(?:tk|tank)\b/i,         // WB TK or WB TANK (also matches WBTK)
        /\bw\.?b\.?\s*tk\b/i,           // W.B.TK or WB.TK or W B TK
        /\bwing\s*ballast\b/i,
        /\bswbt\b/i,
        /\bbwbt\b/i,
        /\bd\.?b\.?t\b/i,                // D.B.T
        /double\s*bottom/i,
        /\bf\s*\.?\s*p\s*\.?\s*t\s*\.?\s*(?:k|tk)?\b/i, // F. P. TK variants
        /\ba\s*\.?\s*p\s*\.?\s*t\s*\.?\s*(?:k|tk)?\b/i, // A. P. TK variants
        /\bcwt\b/i,
        /\bballast\b/i
      ],
      fw: [/(fresh\s*water|^fw\b|f\.w\.|fwt\b)/i, /potable/i, /\bf\s*\.?\s*w\s*\.?\s*tk\b/i],
      fuel: [
        // Common fuel acronyms (plain): HFO, HSFO, LSFO, LFO, ULSF, ULSFO, ULFO, HSF, LSF
        /(\b)(hfo|hsfo|lsfo|lfo|ulsf|ulsfo|ulfo|hsf|lsf)(?=\b|\.)/i,
        // Dotted variants: H.S.F.O., L.S.F.O., U.L.S.F.O., U.L.F.O., H.S.F., L.S.F., L.F.O., H.F.O.
        /(?:^|\b)(?:h\.?(?:s\.?)?f\.?(?:o\.?)?|l\.?(?:s\.?)?f\.?(?:o\.?)?|u\.?l\.?(?:s\.?)?f\.?(?:o\.?)?)(?=\b|\.)/i,
        // Other fuels and keywords
        /(^|\b)(fo|f\.o\.|mdo|mgo|do|d\.o\.|diesel|bunker)(\b|\.)/i,
        /(serv|sett|slud|drain|over)/i
      ],
      lube: [/(^|\b)(lo|l\.o\.|lube)(\b|\.)/i, /cyl\.o|cyl\.?oil/i, /hyd\.o|hydraulic/i, /lubric/i]
    };
    const classifyTank = (name)=>{
      const raw = String(name||'');
      const s = raw.toLowerCase();
      if (any(raw, pat.cargo) || any(s, pat.cargo)) return { cat:'cargo' };
      if (any(raw, pat.ballast) || any(s, pat.ballast)) return { cat:'ballast' };
      // consumables typing
      if (any(raw, pat.fw) || any(s, pat.fw)) return { cat:'cons', type:'freshwater' };
      if (any(raw, pat.lube) || any(s, pat.lube)) return { cat:'cons', type:'lube' };
      if (any(raw, pat.fuel) || any(s, pat.fuel)) return { cat:'cons', type:'fuel' };
      // fallback: all others → Consumables (other)
      return { cat:'cons', type:'other' };
    };
    for (let i=1;i<lines.length;i++){
      const cols = splitLine(lines[i], delim);
      const name = cleanTankName(cols[idx.name]); if (!name) continue;
      const lcg = toNumber(cols[idx.lcg]); if (!isFinite(lcg)) continue;
      const cap = idx.vol>=0? toNumber(cols[idx.vol]) : undefined;
      let nm = name;
      const entry = { name: nm, lcg, cap_m3: isFinite(cap)? cap : undefined };
      const cls = classifyTank(name);
      if (cls.cat==='cargo') { entry.name = normalizeCargoName(nm); cargo.push(entry); }
      else if (cls.cat==='ballast') { entry.name = normalizeBallastName(nm); ballast.push(entry); }
      else cons.push({ ...entry, type: cls.type||'other' });
    }
    return { kind:'tanks', cargo, ballast, cons };
  }
  // No headers: try to infer (name, vol, lcg) layout if tokens >=3
  const tokens = splitLine(lines[0], delim);
  if (tokens.length >= 3) {
    const cargo=[], ballast=[], cons=[];
    const any = (s, arr)=> arr.some(re=> re.test(s));
    const pat = {
      cargo: [/(^|\b)(cot|cargo)(\b|\(|\d)/i, /slop/i, /residual/i, /(sloptk|sloptank)/i],
      ballast: [
        /\bw\.?b\.?t(?=\b|\d)/i,
        /\bwb\s*(?:tk|tank)\b/i,
        /\bw\.?b\.?\s*tk(?=\b|\d)/i,
        /\bwing\s*ballast\b/i,
        /\bswbt(?=\b|\d)/i,
        /\bbwbt(?=\b|\d)/i,
        /\bd\.?b\.?t(?=\b|\d)/i,
        /double\s*bottom/i,
        /\bf\s*\.?\s*p\s*\.?\s*t\s*\.?\s*(?:k|tk)?(?=\b|\d)/i,
        /\ba\s*\.?\s*p\s*\.?\s*t\s*\.?\s*(?:k|tk)?(?=\b|\d)/i,
        /\bcwt\b/i,
        /\bballast\b/i
      ],
      fw: [/(fresh\s*water|^fw\b|f\.w\.|fwt\b|potable)/i, /\bf\s*\.?\s*w\s*\.?\s*tk(?=\b|\d)/i],
      fuel: [
        /(\b)(hfo|hsfo|lsfo|lfo|ulsf|ulsfo|ulfo|hsf|lsf)(?=\b|\.)/i,
        /(?:^|\b)(?:h\.?(?:s\.?)?f\.?(?:o\.?)?|l\.?(?:s\.?)?f\.?(?:o\.?)?|u\.?l\.?(?:s\.?)?f\.?(?:o\.?)?)(?=\b|\.)/i,
        /(^|\b)(fo|f\.o\.|mdo|mgo|do|d\.o\.|diesel|bunker)(\b|\.)/i,
        /(serv|sett|slud|drain|over)/i
      ],
      lube: [/(^|\b)(lo|l\.o\.|lube)(\b|\.)/i, /cyl\.o|cyl\.?oil|hyd\.o|hydraulic|lubric/i]
    };
    const classify = (name)=>{
      const raw = String(name||''); const s = raw.toLowerCase();
      if (any(raw, pat.cargo) || any(s, pat.cargo)) return { cat:'cargo' };
      if (any(raw, pat.ballast) || any(s, pat.ballast)) return { cat:'ballast' };
      if (any(raw, pat.fw) || any(s, pat.fw)) return { cat:'cons', type:'freshwater' };
      if (any(raw, pat.lube) || any(s, pat.lube)) return { cat:'cons', type:'lube' };
      if (any(raw, pat.fuel) || any(s, pat.fuel)) return { cat:'cons', type:'fuel' };
      // fallback: all others → Consumables
      return { cat:'cons', type:'fuel' };
    };
    for (let i=0;i<lines.length;i++){
      const cols = splitLine(lines[i], delim);
      if (cols.length < 3) continue;
      const name = cleanTankName(cols[0]); if (!name) continue;
      const vol = toNumber(cols[1]);
      const lcg = toNumber(cols[cols.length-1]); if (!isFinite(lcg)) continue;
      const entry = { name, lcg, cap_m3: isFinite(vol)? vol : undefined };
      const cls = classify(name);
      if (cls.cat==='cargo') { entry.name = normalizeCargoName(entry.name); cargo.push(entry); }
      else if (cls.cat==='ballast') { entry.name = normalizeBallastName(entry.name); ballast.push(entry); }
      else cons.push({ ...entry, type: cls.type||'fuel' });
    }
    return { kind:'tanks', cargo, ballast, cons };
  }
  return { kind:'unknown' };
}

function renderTablePreview(elm, rows, cols) {
  const el = document.getElementById(elm);
  if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = '<div style="color:#94a3b8;">Veri yok</div>'; return; }
  const defs = cols.map(c => (typeof c === 'string') ? { key: c, label: c } : { key: c.key, label: c.label || c.key });
  const head = `<tr>${defs.map(d=>`<th style=\"text-align:left;padding:4px;\">${d.label}</th>`).join('')}</tr>`;
  const body = rows.slice(0,10).map(r=> `<tr>${defs.map(d=>`<td style=\"padding:4px;\">${r[d.key] ?? ''}</td>`).join('')}</tr>` ).join('');
  el.innerHTML = `<div style=\"font-size:12px;color:#9fb3c8;margin-bottom:6px;\">Toplam ${rows.length} satır</div><table style=\"width:100%;border-collapse:collapse;\">${head}${body}</table>`;
}

// Dedupe hydro rows by draft; keep row with more numeric fields
function dedupeHydro(arr){
  const score = (r)=> ['dis_sw','lcf_m','lcb_m','tpc','mct'].reduce((s,k)=> s + (isFinite(r?.[k])?1:0), 0);
  const key = (r)=> isFinite(r?.draft_m) ? (Math.round(r.draft_m*1000)/1000).toFixed(3) : '';
  const map = new Map();
  for (const r of (arr||[])){
    if (!isFinite(r?.draft_m)) continue;
    const k = key(r);
    if (!map.has(k)) { map.set(k, r); continue; }
    const old = map.get(k);
    map.set(k, (score(r) > score(old)) ? r : old);
  }
  return Array.from(map.values()).sort((a,b)=> a.draft_m - b.draft_m);
}

// Open a file chooser in a Safari-friendly way: create an ephemeral input that is
// invisible but not display:none, then trigger click synchronously in user gesture.
async function openFileDialogSafariSafe(multiple=true, accept='') {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = !!multiple;
    if (accept) inp.accept = accept;
    const style = inp.style;
    style.position = 'fixed';
    style.left = '-10000px';
    style.top = '0';
    style.width = '1px';
    style.height = '1px';
    style.opacity = '0';
    style.pointerEvents = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const files = inp.files ? Array.from(inp.files) : [];
      try { if (inp.parentNode) inp.parentNode.removeChild(inp); } catch(_) {}
      resolve(files);
    }, { once: true });
    try { inp.click(); } catch(_) { resolve([]); }
  });
}
function bindWizardOnce() {
  WIZ_BOUND = true;
  const closeBtn = document.getElementById('wizard-close');
  if (closeBtn) closeBtn.addEventListener('click', hideWizard);
  for (const b of getTabButtons()) b.addEventListener('click', () => activateTab(b.dataset.tab));

  // Runtime hotfix: remove legacy per-tab upload/parse controls if present
  (function sanitizeWizardUI(){
    const removeByIds = [
      'upload-hydro','file-hydro','parse-hydro',
      'upload-cargo','file-cargo','parse-cargo',
      'upload-ballast','file-ballast','parse-ballast',
      'upload-cons','file-cons','parse-cons'
    ];
    for (const id of removeByIds){ const el = document.getElementById(id); if (el && el.parentElement) el.parentElement.removeChild(el); }
    // Remove any stray buttons with text "Dosyadan Yükle" inside the wizard
    const wizard = document.getElementById('wizard-modal') || document;
    wizard.querySelectorAll('button').forEach(btn=>{ if ((btn.textContent||'').trim().toLowerCase()==='dosyadan yükle') btn.remove(); });
    // Update Hydro info text if old text is still present
    const hydroInfo = document.querySelector('#tab-hydro .info');
    if (hydroInfo) hydroInfo.textContent = '';
  })();

  // PDF Import (embedded) inside wizard
  const openPdfBtn = document.getElementById('open-pdf-import');
  const pdfEmbed = document.getElementById('pdf-embed');
  if (openPdfBtn && pdfEmbed) {
    async function ensurePdfImportModule() {
      if (window.PDFImportUI && typeof window.PDFImportUI.mountEmbedded === 'function') return true;
      // Try dynamic ESM import
      try { await import('./scripts/import/pdf-ui.js?v=lp3'); } catch(_) {}
      if (window.PDFImportUI && typeof window.PDFImportUI.mountEmbedded === 'function') return true;
      // Fallback: inject module script tag (in case initial tag failed to execute)
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.type = 'module';
          s.src = './scripts/import/pdf-ui.js?v=lp3';
          s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
        });
      } catch(_) {}
      return !!(window.PDFImportUI && typeof window.PDFImportUI.mountEmbedded === 'function');
    }
    openPdfBtn.addEventListener('click', async () => {
      try {
        pdfEmbed.style.display = 'block';
        const ok = await ensurePdfImportModule();
        if (ok) {
          window.PDFImportUI.mountEmbedded(pdfEmbed);
        } else {
          pdfEmbed.innerHTML = '<div style="color:#94a3b8;">PDF içe aktarma modülü yüklenemedi. Lütfen sayfayı yenileyin veya bir yerel sunucu üzerinden açın.</div>';
        }
      } catch (e) {
        console.error(e);
        alert('PDF içe aktarma yapılamadı.');
      }
    });
  }
  // PaddleOCR URL alanı kaldırıldı; Bulut OCR HF Space üzerinden pdf-ui.js içinde otomatik kullanılır.

  const hydroBtn = document.getElementById('parse-hydro');
  if (hydroBtn) hydroBtn.addEventListener('click', ()=>{
    const txt = document.getElementById('paste-hydro').value;
    const rows = parseHydro(txt);
    WIZ.hydro = rows;
    renderTablePreview('preview-hydro', rows, ['draft_m',{key:'dis_sw',label:'Displacement'},'lcf_m','lcb_m','tpc','mct']);
    updateWizStatus();
  });
  const mapHydBtn = document.getElementById('map-hydro-btn');
  if (mapHydBtn) mapHydBtn.addEventListener('click', ()=>{
    const raw = WIZ_LAST.hydroText || '';
    const lines = normText(raw).split(/\r?\n/).filter(l=>l.trim().length>0);
    if (!lines.length) { alert('Please load a file first.'); return; }
    buildMapUIHydro(lines, 'map-hydro');
  });
  const fileHydBtn = document.getElementById('upload-hydro');
  const fileHyd = document.getElementById('file-hydro');
  if (fileHydBtn && fileHyd) {
    fileHydBtn.addEventListener('click', ()=> fileHyd.click());
    fileHyd.addEventListener('change', async ()=>{
      const f = fileHyd.files && fileHyd.files[0]; if (!f) return;
      const text = await readFileAsText(f);
      WIZ_LAST.hydroText = text;
      const rows = parseHydro(text);
      WIZ.hydro = rows;
      renderTablePreview('preview-hydro', rows, ['draft_m',{key:'dis_sw',label:'Displacement'},'lcf_m','lcb_m','tpc','mct']);
      updateWizStatus();
    });
  }
  const hydroClr = document.getElementById('clear-hydro');
  if (hydroClr) hydroClr.addEventListener('click', ()=>{
    document.getElementById('preview-hydro').innerHTML='';
    WIZ.hydro = [];
    WIZ_LAST.hydroText = '';
    updateWizStatus();
  });

  for (const key of ['cargo','ballast','cons']){
    const btn = document.getElementById(`parse-${key}`);
    const clr = document.getElementById(`clear-${key}`);
    const mapBtn = document.getElementById(`map-${key}-btn`);
    const upBtn = document.getElementById(`upload-${key}`);
    const fileIn = document.getElementById(`file-${key}`);
    if (btn) btn.addEventListener('click', ()=>{
      const txt = document.getElementById(`paste-${key}`).value;
      let rows = parseTanksGeneric(txt, key==='cons'?'cons':'tank');
      if (key==='cargo') rows = rows.map(r => ({ ...r, name: normalizeCargoName(r.name) }));
      else if (key==='ballast') rows = rows.map(r => ({ ...r, name: normalizeBallastName(r.name) }));
      // Always append; no 'mevcutlara ekle' checkbox
      WIZ[key] = (WIZ[key] || []).concat(rows);
      const cols = key==='cons' ? ['name','type','lcg','cap_m3'] : ['name','lcg','cap_m3'];
      renderTablePreview(`preview-${key}`, WIZ[key], cols);
      updateWizStatus();
    });
    if (clr) clr.addEventListener('click', ()=>{
      document.getElementById(`preview-${key}`).innerHTML='';
      WIZ[key] = [];
      WIZ_LAST[`${key}Text`] = '';
      updateWizStatus();
    });
    if (mapBtn) mapBtn.addEventListener('click', ()=>{
      const raw = WIZ_LAST[`${key}Text`] || '';
      const lines = normText(raw).split(/\r?\n/).filter(l=>l.trim().length>0);
      if (!lines.length) { alert('Please load a file first.'); return; }
      buildMapUITanks(lines, `map-${key}`, key==='cons'?'cons':'tank');
    });
    if (upBtn && fileIn) {
      upBtn.addEventListener('click', ()=> fileIn.click());
      fileIn.addEventListener('change', async ()=>{
        const f = fileIn.files && fileIn.files[0]; if (!f) return;
        const text = await readFileAsText(f);
        WIZ_LAST[`${key}Text`] = text;
        let rows = parseTanksGeneric(text, key==='cons'?'cons':'tank');
        if (key==='cargo') rows = rows.map(r => ({ ...r, name: normalizeCargoName(r.name) }));
        else if (key==='ballast') rows = rows.map(r => ({ ...r, name: normalizeBallastName(r.name) }));
        // Always append
        WIZ[key] = (WIZ[key] || []).concat(rows);
        const cols = key==='cons' ? ['name','type','lcg','cap_m3'] : ['name','lcg','cap_m3'];
        renderTablePreview(`preview-${key}`, WIZ[key], cols);
        updateWizStatus();
      });
  }

  // Quick multi-file dropzone
  const chooseAll = document.getElementById('choose-all');
  const fileAll = document.getElementById('file-all');
  if (chooseAll && fileAll) {
    // Bind once: guard against accidental multiple bindings
    if (!chooseAll.dataset.bound) {
      chooseAll.addEventListener('click', async (ev)=>{
        if (OPEN_BUSY) return; OPEN_BUSY = true;
        try {
          const files = await openFileDialogSafariSafe(true, '.csv,.tsv,.txt');
          await handleQuickFiles(files);
        } finally {
          // small delay to avoid immediate re-entrancy in Chrome
          setTimeout(()=>{ OPEN_BUSY = false; }, 0);
        }
      });
      chooseAll.dataset.bound = '1';
    }
    if (!fileAll.dataset.boundChange) {
      fileAll.addEventListener('change', async ()=>{
        const files = fileAll.files ? Array.from(fileAll.files) : [];
        await handleQuickFiles(files);
        fileAll.value = '';
      });
      fileAll.dataset.boundChange = '1';
    }
  }
}

  const exportBtn = document.getElementById('wiz-export');
  if (exportBtn) exportBtn.addEventListener('click', ()=>{
    const js = buildShipJsonFromWizard();
    const fn = `${js.ship.id||'new_ship'}.json`;
    download(fn, JSON.stringify(js,null,2));
  });

  const activateBtn = document.getElementById('wiz-activate');
  if (activateBtn) activateBtn.addEventListener('click', async ()=>{
    const js = buildShipJsonFromWizard();
    // Save profile to local storage and remember as active
    saveLocalShip(js);
    setActiveShipID(js.ship.id);
    // Convert profile longitudes to midship-based using wizard datum before activating
    const profMid = convertProfileLongitudes(JSON.parse(JSON.stringify(js)));
    LONG_REF_ACTIVE = (profMid.ship.long_ref || 'ms_plus');
    // Activate in-memory without saving to server
    SHIP_ACTIVE = {
      LBP: profMid.ship.lbp ?? SHIP.LBP,
      LCF: SHIP.LCF,
      TPC: SHIP.TPC,
      MCT1cm: SHIP.MCT1cm,
      RHO_REF: profMid.ship.rho_ref ?? SHIP.RHO_REF,
    };
    window.LIGHT_SHIP = profMid.ship.light_ship || window.LIGHT_SHIP;
    window.CONSTANT_LOAD = profMid.ship.constant || undefined;
    HYDRO_ROWS = (profMid.hydrostatics.rows||[]).sort((a,b)=>a.draft_m-b.draft_m);
    ACTIVE = {
      cargo: (profMid.tanks.cargo||[]).map(t=>({ id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 })),
      ballast: (profMid.tanks.ballast||[]).map(t=>({ id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 })),
    };
    CONS_TANKS = (profMid.tanks.consumables||[]).map(t=>({ name: t.name, type: t.type, lcg: Number(t.lcg), cap_m3: t.cap_m3 }));
    buildTankInputs('cargo-tanks', ACTIVE.cargo);
    buildTankInputs('ballast-tanks', ACTIVE.ballast);
    renderConstants();
    updateConstLCGHint();
    // Update ship list dropdown with the new ship and select it
    try {
      if (!Array.isArray(SHIPS_INDEX)) SHIPS_INDEX = [];
      const entry = { id: profMid.ship.id, name: profMid.ship.name || profMid.ship.id };
      const i = SHIPS_INDEX.findIndex(s => s.id === entry.id);
      if (i >= 0) SHIPS_INDEX[i] = entry; else SHIPS_INDEX.push(entry);
      populateShipDropdown(SHIPS_INDEX);
      const sel = document.getElementById('ship-select');
      if (sel) sel.value = entry.id;
    } catch(_) { /* noop */ }
    hideWizard();
  });
  const clearAllBtn = document.getElementById('wiz-clear-all');
  if (clearAllBtn) clearAllBtn.addEventListener('click', ()=>{
    try {
      WIZ = { hydro: [], cargo: [], ballast: [], cons: [] };
      WIZ_LAST = { hydroText: '', cargoText: '', ballastText: '', consText: '' };
      // Clear quick previews and mapping areas if present
      ['hydro','cargo','ballast','cons'].forEach(k => {
        const pv = document.getElementById(`preview-${k}`);
        if (pv) pv.innerHTML = '';
        const map = document.getElementById(`map-${k}`);
        if (map) map.innerHTML = '';
      });
    } catch(_) { /* noop */ }
    updateWizStatus();
    updateProgramPreviews();
  });
}

function buildShipJsonFromWizard() {
  const name = document.getElementById('wiz-name').value.trim() || 'NEW SHIP';
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
  const lbpEl = document.getElementById('wiz-lbp');
  const rhoEl = document.getElementById('wiz-rho');
  const lswEl = document.getElementById('wiz-ls-w');
  const lsxEl = document.getElementById('wiz-ls-x');
  const longEl = document.getElementById('wiz-longref');
  const cwEl = document.getElementById('wiz-c-w');
  const cxEl = document.getElementById('wiz-c-x');
  const lbp = lbpEl ? toNumber(lbpEl.value) : NaN;
  const rho = rhoEl ? toNumber(rhoEl.value) : NaN;
  const lsw = lswEl ? toNumber(lswEl.value) : NaN;
  const lsx = lsxEl ? toNumber(lsxEl.value) : NaN;
  const long_ref = longEl ? String(longEl.value||'').toLowerCase() : undefined;
  const cw = cwEl ? toNumber(cwEl.value) : NaN;
  const cx = cxEl ? toNumber(cxEl.value) : NaN;
  const cargo = WIZ.cargo.map(t=>({ name:t.name, lcg:t.lcg, cap_m3: t.cap_m3!=null? t.cap_m3 : undefined }));
  const ballast = WIZ.ballast.map(t=>({ name:t.name, lcg:t.lcg, cap_m3: t.cap_m3!=null? t.cap_m3 : undefined }));
  const cons = WIZ.cons.map(t=>({ name:t.name, type:t.type, lcg:t.lcg, cap_m3: t.cap_m3!=null? t.cap_m3 : undefined }));
  const hydro = WIZ.hydro.map(r=>({
    draft_m: r.draft_m,
    dis_sw: r.dis_sw,
    lcf_m: r.lcf_m,
    lcb_m: r.lcb_m,
    tpc: r.tpc,
    mct: r.mct,
  }));
  return {
    ship: {
      id, name,
      lbp: isFinite(lbp) ? lbp : undefined,
      rho_ref: isFinite(rho) ? rho : undefined,
      long_ref: long_ref,
      light_ship: (isFinite(lsw) && isFinite(lsx)) ? { weight: lsw, lcg: lsx } : undefined,
      constant: (isFinite(cw) && isFinite(cx)) ? { weight: cw, lcg: cx } : undefined,
    },
    hydrostatics: { rows: hydro },
    tanks: { cargo, ballast, consumables: cons },
  };
}

function download(filename, text) {
  const a = document.createElement('a');
  a.setAttribute('href', 'data:application/json;charset=utf-8,' + encodeURIComponent(text));
  a.setAttribute('download', filename);
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// (export/activate handlers are bound lazily when wizard opens)

// --- Integration API for PDF Import Wizard ---
/**
 * Apply hydrostatics JSON to the running app state without breaking existing views.
 * Keeps key names compatible with existing loader: draft_m, lcf_m, tpc, mct
 * @param {{rows:Array<{draft_m:number,lcf_m:number,tpc:number,mct:number}>}} hydroJson
 */
function applyHydrostaticsJson(hydroJson) {
  try {
    const rows = Array.isArray(hydroJson?.rows) ? hydroJson.rows.slice() : [];
    if (!rows.length) { alert('Boş hydrostatik veri.'); return; }
    // Basic sanity
    const ok = rows.every(r => isFinite(r.draft_m) && isFinite(r.tpc) && isFinite(r.mct));
    if (!ok) { alert('Hydrostatik satırlar eksik veya hatalı.'); return; }
    HYDRO_ROWS = rows.sort((a,b)=>a.draft_m - b.draft_m);
    renderConstants();
  } catch (err) {
    console.error(err);
    alert('Hydrostatik veri uygulanamadı.');
  }
}

// expose for module usage
window.applyHydrostaticsJson = applyHydrostaticsJson;

// ---- Wizard helper views (requirements + editable previews) ----
function updateRequirementHints() {
  const el = document.getElementById('wiz-lints');
  if (!el) return;
  const has = { draft:false, tpc:false, mct:false, lcf:false, dis:false, lcb:false };
  for (const r of (WIZ.hydro||[])) {
    if (isFinite(r?.draft_m)) has.draft = true;
    if (isFinite(r?.tpc)) has.tpc = true;
    if (isFinite(r?.mct)) has.mct = true;
    if (isFinite(r?.lcf_m)) has.lcf = true;
    if (isFinite(r?.dis_sw)) has.dis = true;
    if (isFinite(r?.lcb_m)) has.lcb = true;
  }
  const missing = [];
  if (!has.draft) missing.push('Draft (m)');
  if (!has.tpc) missing.push('TPC (t/cm)');
  if (!has.mct) missing.push('MCT1cm (t·m/cm)');
  const improve = [];
  if (!has.lcf) improve.push('LCF (m)');
  if (!has.dis) improve.push('DIS (t) [SW]');
  if (!has.lcb) improve.push('LCB (m)');
  const parts = [];
  if (missing.length) parts.push(`Eksik (gerekli): ${missing.join(', ')}`);
  if (improve.length) parts.push(`Doğruluk artar: ${improve.join(', ')}`);
  el.innerHTML = parts.join(' • ');
}

function renderEditableTable(containerId, rows, columns, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = '<div class="muted">Veri yok</div>'; return; }
  const tbl = document.createElement('table');
  tbl.className = 'pdf-table';
  const trh = document.createElement('tr');
  for (const c of columns) { const th = document.createElement('th'); th.textContent = c.label; trh.appendChild(th); }
  // Allow moves between tank categories in program view (not for hydro)
  const isTankTable = ['prog-cargo','prog-ballast','prog-cons'].includes(containerId);
  if (isTankTable) { const th = document.createElement('th'); th.textContent = 'Move'; trh.appendChild(th); }
  tbl.appendChild(trh);
  const fmt = (v, type)=> {
    if (v==null) return '';
    if (type==='number') {
      const n = Number(String(v).replace(',', '.'));
      return Number.isFinite(n) ? n.toFixed(3) : '';
    }
    return String(v);
  };
  for (let i=0; i<rows.length; i++) {
    const r = rows[i];
    const tr = document.createElement('tr');
    // DnD support
    if (isTankTable) {
      tr.draggable = true;
      tr.addEventListener('dragstart', (ev)=>{
        try { ev.dataTransfer.setData('application/json', JSON.stringify({ from: containerId, index: i })); } catch(_) {}
        ev.dataTransfer.effectAllowed = 'move';
      });
    }
    for (const c of columns) {
      const td = document.createElement('td');
      const isSelect = c.editor === 'select' && Array.isArray(c.options);
      if (isSelect) {
        const sel = document.createElement('select');
        for (const opt of c.options){ const o=document.createElement('option'); o.value=opt; o.textContent=opt; sel.appendChild(o); }
        const cur = String(r[c.key]||'').toLowerCase();
        sel.value = c.options.includes(cur)? cur : c.options[0];
        sel.addEventListener('change', ()=>{
          r[c.key] = sel.value;
          WIZ_MANUAL = true;
          if (typeof onChange === 'function') onChange(i, c.key, r[c.key]);
        });
        td.appendChild(sel);
      } else {
        td.contentEditable = 'true';
        td.textContent = fmt(r[c.key], c.type);
        td.addEventListener('blur', ()=>{
          const txtRaw = td.textContent.trim();
          const txt = txtRaw.replace(',', '.');
          const num = Number(txt);
          if (c.type==='number') {
            r[c.key] = (Number.isFinite(num)? Number(num.toFixed(3)) : NaN);
            td.textContent = Number.isFinite(num) ? num.toFixed(3) : '';
          } else {
            r[c.key] = txtRaw;
          }
          WIZ_MANUAL = true;
          if (typeof onChange === 'function') onChange(i, c.key, r[c.key]);
        });
      }
      tr.appendChild(td);
    }
    if (isTankTable) {
      const tdMove = document.createElement('td');
      const sel = document.createElement('select');
      const options = [
        {v:'prog-cargo', t:'Cargo'},
        {v:'prog-ballast', t:'Ballast'},
        {v:'prog-cons', t:'Consumables'},
      ];
      for (const o of options){ const opt=document.createElement('option'); opt.value=o.v; opt.textContent=o.t; if (o.v===containerId) opt.selected=true; sel.appendChild(opt); }
      sel.addEventListener('change', ()=>{
        const to = sel.value;
        if (to === containerId) return;
        WIZ_MANUAL = true;
        moveTankRow(containerId, i, to);
        updateProgramPreviews();
      });
      tdMove.appendChild(sel);
      tr.appendChild(tdMove);
    }
    tbl.appendChild(tr);
  }
  el.innerHTML = '';
  el.appendChild(tbl);
}

function updateProgramPreviews() {
  const hydroCols = [
    { key:'draft_m', label:'Draft (m)', type:'number' },
    { key:'lcf_m', label:'LCF (m)', type:'number' },
    { key:'tpc', label:'TPC (t/cm)', type:'number' },
    { key:'mct', label:'MCT1cm (t·m/cm)', type:'number' },
  ];
  renderEditableTable('prog-hydro', (WIZ.hydro||[]), hydroCols, ()=>{ WIZ_MANUAL = true; });
  const tankCols = [
    { key:'name', label:'Tank', type:'text' },
    { key:'lcg', label:'LCG (m)', type:'number' },
    { key:'cap_m3', label:'Kapasite (m³)', type:'number' },
  ];
  renderEditableTable('prog-cargo', (WIZ.cargo||[]), tankCols, ()=>{ WIZ_MANUAL = true; });
  renderEditableTable('prog-ballast', (WIZ.ballast||[]), tankCols, ()=>{ WIZ_MANUAL = true; });
  const consCols = [
    { key:'name', label:'Tank', type:'text' },
    { key:'type', label:'Type', type:'text', editor:'select', options:['fuel','freshwater','lube','other'] },
    { key:'lcg', label:'LCG (m)', type:'number' },
    { key:'cap_m3', label:'Kapasite (m³)', type:'number' },
  ];
  renderEditableTable('prog-cons', (WIZ.cons||[]), consCols, ()=>{ WIZ_MANUAL = true; });
  // Bind DnD targets (idempotent)
  ensureDnDBindings();
}

function moveTankRow(fromId, index, toId) {
  const mapIdToArr = (id)=> id==='prog-cargo'? 'cargo' : id==='prog-ballast'? 'ballast' : 'cons';
  const src = mapIdToArr(fromId);
  const dst = mapIdToArr(toId);
  let arrSrc = WIZ[src] || [];
  let arrDst = WIZ[dst] || [];
  if (index < 0 || index >= arrSrc.length) return;
  const it = arrSrc[index];
  arrSrc.splice(index,1);
  // Normalize shape between categories
  let toPush;
  if (dst === 'cons') {
    toPush = { name: String(it.name||''), type: (it.type||'fuel'), lcg: Number(it.lcg), cap_m3: (isFinite(it.cap_m3)? Number(it.cap_m3): undefined) };
    if (!toPush.type || !/^(fuel|freshwater|lube|other)$/i.test(String(toPush.type))) toPush.type = 'fuel';
  } else {
    toPush = { name: String(it.name||''), lcg: Number(it.lcg), cap_m3: (isFinite(it.cap_m3)? Number(it.cap_m3): undefined) };
  }
  arrDst.push(toPush);
  WIZ[src] = arrSrc; WIZ[dst] = arrDst;
}

function ensureDnDBindings(){
  const ids = ['prog-cargo','prog-ballast','prog-cons'];
  for (const id of ids){
    const el = document.getElementById(id);
    if (!el || el.dataset.dndBound==='1') continue;
    el.addEventListener('dragover', (ev)=>{ ev.preventDefault(); ev.dataTransfer.dropEffect='move'; });
    el.addEventListener('drop', (ev)=>{
      ev.preventDefault();
      try {
        const data = ev.dataTransfer.getData('application/json');
        const obj = JSON.parse(data||'{}');
        if (!obj || !obj.from) return;
        const from = obj.from; const idx = Number(obj.index);
        moveTankRow(from, idx, id);
        WIZ_MANUAL = true;
        updateProgramPreviews();
      } catch(_) {}
    });
    el.dataset.dndBound = '1';
  }
}
