// Non-module usage; constants are on window.* (see constants.js)

let ACTIVE = { cargo: [], ballast: [] };
let HYDRO_ROWS = null; // active ship hydro rows
let CONS_TANKS = null; // active ship consumable tanks
let LAST_TMEAN = null; // remember last mean draft for better iteration start
let SHIP_ACTIVE = null; // active ship constants (fallback to SHIP)
let SHIPS_INDEX = null; // available ships list

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
    // keep only known types and numeric lcg; cap_m3 optional
    const valid = ['fuel', 'freshwater', 'lube'];
    const rows = tanks
      .map(t => ({ name: t.name, type: String(t.type||'').toLowerCase(), lcg: Number(t.lcg), cap_m3: (t.cap_m3!=null?Number(t.cap_m3):null) }))
      .filter(t => valid.includes(t.type) && isFinite(t.lcg));
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
  // Monotonic in draft
  if (typeof rows[0].dis_fw !== 'number') return null;
  if (target_dis_fw <= rows[0].dis_fw) return rows[0].draft_m;
  if (target_dis_fw >= rows[rows.length - 1].dis_fw) return rows[rows.length - 1].draft_m;
  let lo = 0, hi = rows.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].dis_fw <= target_dis_fw) lo = mid; else hi = mid;
  }
  const a = rows[lo], b = rows[hi];
  const t = (target_dis_fw - a.dis_fw) / (b.dis_fw - a.dis_fw);
  return a.draft_m + (b.draft_m - a.draft_m) * t;
}

function el(id) { return document.getElementById(id); }

function fmt(n, digits = 3) {
  if (!isFinite(n)) return '-';
  return Number(n).toFixed(digits);
}

function renderConstants() {
  const box = document.getElementById('consts-list');
  if (!box) return;
  const base = SHIP_ACTIVE || SHIP;
  const { LBP, LCF, TPC, MCT1cm, RHO_REF } = base;
  const ls = window.LIGHT_SHIP || {};
  const parts = [
    `<div><b>LBP</b>: ${fmt(LBP, 2)} m</div>`,
    `<div><b>LCF</b>: ${fmt(LCF, 2)} m (midship +ileri)</div>`,
    `<div><b>TPC</b>: ${fmt(TPC, 1)} t/cm</div>`,
    `<div><b>MCT1cm</b>: ${fmt(MCT1cm, 1)} t·m/cm</div>`,
    `<div><b>ρ_ref</b>: ${fmt(RHO_REF, 3)} t/m³</div>`,
    `<div><b>Light ship</b>: ${ls.weight ?? '-'} t @ LCG ${fmt(ls.lcg ?? 0, 2)} m</div>`,
    `<div><b>Consumables tankları</b>: ${Array.isArray(CONS_TANKS) ? CONS_TANKS.length : 0} adet</div>`,
    `<div><b>Tank sayısı</b>: Cargo ${ACTIVE.cargo.length}, Ballast ${ACTIVE.ballast.length}</div>`,
  ];
  box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin-top:8px;color:#9fb3c8;font-size:12px;">${parts.join('')}</div>`;
}

function buildTankInputs(containerId, tanks) {
  const container = el(containerId);
  container.innerHTML = '';
  for (const t of tanks) {
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

    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.value = '0';
    input.id = `w_${t.id}`;
    input.placeholder = 'ağırlık (t)';
    wrap.appendChild(input);

    container.appendChild(wrap);
  }
}

function readWeights(tanks) {
  const items = [];
  for (const t of tanks) {
    const v = parseFloat(el(`w_${t.id}`).value || '0') || 0;
    if (v !== 0) items.push({ name: t.name, w: v, x: t.lcg });
  }
  return items;
}

function calc() {
  const base = SHIP_ACTIVE || SHIP;
  const rho = parseFloat(el('rho').value || String(base.RHO_REF || 1.025)) || (base.RHO_REF || 1.025);
  const wCons = parseFloat(el('fofw').value || '0') || 0;
  // Auto-consumables LCG from data/consumables.json if available
  const lcgConsumables = (() => {
    if (!(Array.isArray(CONS_TANKS) && CONS_TANKS.length && wCons>0)) return LCG_FO_FW;
    const rhoBy = { fuel: 0.85, freshwater: 1.00, lube: 0.90 };
    const types = ['fuel','freshwater','lube'];
    let eqWeights = {};
    let typeLCG = {};
    for (const tp of types) {
      const arr = CONS_TANKS.filter(t => t.type===tp);
      if (!arr.length) continue;
      const sumCap = arr.reduce((s,t)=> s + (isFinite(t.cap_m3)? t.cap_m3 : 0), 0);
      const rho_t = rhoBy[tp] ?? 1.0;
      const eq = sumCap > 0 ? rho_t * sumCap : arr.length * rho_t; // fallback equal if no caps
      eqWeights[tp] = eq;
      // capacity-weighted LCG for the type
      let lcg;
      if (sumCap > 0) {
        const num = arr.reduce((s,t)=> s + (t.cap_m3||0) * t.lcg, 0);
        lcg = num / sumCap;
      } else {
        const num = arr.reduce((s,t)=> s + t.lcg, 0); lcg = num / arr.length;
      }
      typeLCG[tp] = lcg;
    }
    const eqSum = Object.values(eqWeights).reduce((s,v)=> s+v, 0);
    if (eqSum <= 0) return LCG_FO_FW;
    // split total consumables to types by equivalent weights
    const Wt = {};
    for (const tp of Object.keys(eqWeights)) Wt[tp] = wCons * (eqWeights[tp] / eqSum);
    const wSum = Object.values(Wt).reduce((s,v)=> s+v, 0);
    if (wSum <= 0) return LCG_FO_FW;
    const num = Object.keys(Wt).reduce((s,tp)=> s + (Wt[tp] * (typeLCG[tp] ?? 0)), 0);
    return num / wSum;
  })();

  // Collect tank items
  const cargo = readWeights(ACTIVE.cargo);
  const ballast = readWeights(ACTIVE.ballast);

  // FO+FW single input as one mass at fixed LCG
  const items = [...cargo, ...ballast];
  if (wCons !== 0) items.push({ name: 'Consumables', w: wCons, x: lcgConsumables });
  // Always include light ship if available
  if (window.LIGHT_SHIP && typeof window.LIGHT_SHIP.weight === 'number' && window.LIGHT_SHIP.weight > 0) {
    items.push({ name: 'Light Ship', w: window.LIGHT_SHIP.weight, x: (window.LIGHT_SHIP.lcg ?? 0) });
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
  el('resTrim').textContent = fmt(Trim_cm, 1);
}

function clearAll() {
  const base = SHIP_ACTIVE || SHIP;
  el('rho').value = String(base.RHO_REF || 1.025);
  el('fofw').value = '0';
  // overrides and lightship input removed from UI
  for (const t of [...ACTIVE.cargo, ...ACTIVE.ballast]) {
    const inp = document.getElementById(`w_${t.id}`);
    if (inp) inp.value = '0';
  }
  el('resW').textContent = '0.0';
  el('resTm').textContent = '0.000';
  el('resTa').textContent = '0.000';
  el('resTf').textContent = '0.000';
  el('resTrim').textContent = '0.0';
}

function prefillExample() {
  // İstenilen kural: ballast boş, cargo %98 doluluk ve ρ=0.78 t/m³
  const rhoCargo = 0.78;
  const fill = 0.98;
  el('rho').value = (SHIP.RHO_REF).toString();
  el('fofw').value = '0';

  for (const t of ACTIVE.cargo) {
    const cap = Number(t.cap_m3 || 0);
    const mt = cap > 0 ? cap * fill * rhoCargo : 0;
    const inp = document.getElementById(`w_${t.id}`);
    if (inp) inp.value = mt.toFixed(1);
  }
  for (const t of ACTIVE.ballast) {
    const inp = document.getElementById(`w_${t.id}`);
    if (inp) inp.value = '0';
  }

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

async function loadShipProfile(id) {
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
    const s = profile.ship;
    SHIP_ACTIVE = {
      LBP: s.lbp ?? SHIP.LBP,
      LCF: SHIP.LCF, // base until per-ship static overrides provided
      TPC: SHIP.TPC,
      MCT1cm: SHIP.MCT1cm,
      RHO_REF: s.rho_ref ?? SHIP.RHO_REF,
    };
    window.LIGHT_SHIP = s.light_ship || window.LIGHT_SHIP;
    const rows = (profile.hydrostatics && Array.isArray(profile.hydrostatics.rows)) ? profile.hydrostatics.rows : [];
    HYDRO_ROWS = rows.length ? rows.sort((a,b)=>a.draft_m-b.draft_m) : await loadHydroFromJson();
    // Tanks
    const cargo = (profile.tanks && Array.isArray(profile.tanks.cargo)) ? profile.tanks.cargo : [];
    const ballast = (profile.tanks && Array.isArray(profile.tanks.ballast)) ? profile.tanks.ballast : [];
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
    const cons = (profile.tanks && Array.isArray(profile.tanks.consumables)) ? profile.tanks.consumables : null;
    if (cons && cons.length) {
      CONS_TANKS = cons.map(t=>({ name: t.name, type: String(t.type||'').toLowerCase(), lcg: Number(t.lcg), cap_m3: t.cap_m3 }));
    } else {
      CONS_TANKS = await loadConsumablesFromJson();
    }
    // Rebuild UI
    buildTankInputs('cargo-tanks', ACTIVE.cargo);
    buildTankInputs('ballast-tanks', ACTIVE.ballast);
    renderConstants();
  }
}

function populateShipDropdown(ships) {
  const sel = document.getElementById('ship-select');
  if (!sel) return;
  sel.innerHTML = '';
  for (const s of ships) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    sel.appendChild(opt);
  }
}

// Init UI
(async () => {
  SHIPS_INDEX = await loadShipsIndex();
  if (Array.isArray(SHIPS_INDEX) && SHIPS_INDEX.length) {
    populateShipDropdown(SHIPS_INDEX);
    const first = SHIPS_INDEX[0].id;
    const sel = document.getElementById('ship-select');
    if (sel) sel.value = first;
    await activateShip(first);
  } else {
    // Fallback to legacy single-ship data
    const fromJson = await loadTanksFromJson();
    ACTIVE = fromJson || { cargo: CARGO_TANKS, ballast: BALLAST_TANKS };
    HYDRO_ROWS = await loadHydroFromJson();
    CONS_TANKS = await loadConsumablesFromJson();
    buildTankInputs('cargo-tanks', ACTIVE.cargo);
    buildTankInputs('ballast-tanks', ACTIVE.ballast);
    renderConstants();
  }
})();

el('calc').addEventListener('click', calc);
el('prefill').addEventListener('click', prefillExample);
el('clear').addEventListener('click', clearAll);
const shipSel = document.getElementById('ship-select');
if (shipSel) {
  shipSel.addEventListener('change', async (e) => {
    const id = e.target.value;
    await activateShip(id);
  });
}
// Import wizard logic (basic paste-based parser)
const addShipBtn = document.getElementById('add-ship');
const overlay = document.getElementById('wizard-overlay');
const closeBtn = document.getElementById('wizard-close');
const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
const panes = {
  hydro: document.getElementById('tab-hydro'),
  cargo: document.getElementById('tab-cargo'),
  ballast: document.getElementById('tab-ballast'),
  cons: document.getElementById('tab-cons'),
};
const WIZ = { hydro: [], cargo: [], ballast: [], cons: [] };

function showWizard() { if (overlay) overlay.style.display = 'block'; activateTab('hydro'); updateWizStatus(); }
function hideWizard() { if (overlay) overlay.style.display = 'none'; }
function activateTab(id) {
  for (const [k, el] of Object.entries(panes)) { el.style.display = (k===id ? 'block' : 'none'); }
  for (const b of tabBtns) { b.classList.toggle('active', b.dataset.tab===id); }
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
}

if (addShipBtn) addShipBtn.addEventListener('click', showWizard);
if (closeBtn) closeBtn.addEventListener('click', hideWizard);
for (const b of tabBtns) b.addEventListener('click', () => activateTab(b.dataset.tab));

// Helpers for parsing
function detectDelimiter(line) {
  if (line.includes('\t')) return '\t';
  const counts = [',',';','|'].map(ch => [ch, (line.split(ch).length-1)]);
  counts.sort((a,b)=>b[1]-a[1]);
  if (counts[0][1]>0) return counts[0][0];
  return 'whitespace';
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
function parseHydro(text) {
  const out = [];
  const lines = normText(text).split(/\r?\n/).filter(l=>l.trim().length>0);
  if (!lines.length) return out;
  const delim = detectDelimiter(lines[0]);
  // try to find header: pick first line with any keyword
  const keyRe = /(draft|dis\s*\(?(fw|sw)\)?|lcf|lcb|tpc|mct)/i;
  let headerIdx = lines.findIndex(l=> keyRe.test(l));
  if (headerIdx<0) headerIdx = 0;
  const header = splitLine(lines[headerIdx], delim).map(x=>x.trim().toLowerCase());
  const map = { draft:-1, dis_fw:-1, dis_sw:-1, lcf:-1, lcb:-1, tpc:-1, mct:-1 };
  header.forEach((h,i)=>{
    if (map.draft<0 && /draft/.test(h)) map.draft=i;
    if (map.dis_fw<0 && /(dis.*fw|fw\b)/.test(h)) map.dis_fw=i;
    if (map.dis_sw<0 && /(dis.*sw|sw\b)/.test(h)) map.dis_sw=i;
    if (map.lcf<0 && /lcf/.test(h)) map.lcf=i;
    if (map.lcb<0 && /lcb/.test(h)) map.lcb=i;
    if (map.tpc<0 && /tpc/.test(h)) map.tpc=i;
    if (map.mct<0 && /mct/.test(h)) map.mct=i;
  });
  for (let i=headerIdx+1;i<lines.length;i++){
    const cols = splitLine(lines[i], delim);
    const get = idx => (idx>=0 && idx<cols.length) ? cols[idx] : '';
    const draft = toNumber(get(map.draft>=0?map.draft:0));
    if (!isFinite(draft)) continue;
    const dis_fw = isFinite(toNumber(get(map.dis_fw))) ? toNumber(get(map.dis_fw)) : undefined;
    const dis_sw = isFinite(toNumber(get(map.dis_sw))) ? toNumber(get(map.dis_sw)) : undefined;
    const lcf = toNumber(get(map.lcf));
    const lcb = toNumber(get(map.lcb));
    const tpc = toNumber(get(map.tpc));
    const mct = toNumber(get(map.mct));
    out.push({ draft_m:draft, dis_fw, dis_sw, lcf_m:lcf, lcb_m:lcb, tpc, mct });
  }
  return out;
}
function parseTanksGeneric(text, mode) {
  // mode: 'cargo'|'ballast'|'cons'
  const out = [];
  const lines = normText(text).split(/\r?\n/);
  const typeFromName = (name) => {
    const s = name.toLowerCase();
    if (/hfo|f\.o|fuel|d\.o|mdo|mgo|diesel|bunker/.test(s)) return 'fuel';
    if (/fresh|fw\b|freshwater/.test(s)) return 'freshwater';
    if (/lube|lub\.? oil|lo\b/.test(s)) return 'lube';
    return 'fuel';
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
      // cut name before numbers start
      const idx = l.search(/[-+]?\d/);
      if (idx>0) name = l.slice(0, idx).trim();
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

function renderTablePreview(elm, rows, cols) {
  const el = document.getElementById(elm);
  if (!el) return;
  if (!rows || !rows.length) { el.innerHTML = '<div style="color:#94a3b8;">Veri yok</div>'; return; }
  const head = `<tr>${cols.map(c=>`<th style=\"text-align:left;padding:4px;\">${c}</th>`).join('')}</tr>`;
  const body = rows.slice(0,10).map(r=> `<tr>${cols.map(c=>`<td style=\"padding:4px;\">${r[c] ?? ''}</td>`).join('')}</tr>` ).join('');
  el.innerHTML = `<div style=\"font-size:12px;color:#9fb3c8;margin-bottom:6px;\">Toplam ${rows.length} satır</div><table style=\"width:100%;border-collapse:collapse;\">${head}${body}</table>`;
}

// Hook parsers to buttons
const hydroBtn = document.getElementById('parse-hydro');
if (hydroBtn) hydroBtn.addEventListener('click', ()=>{
  const txt = document.getElementById('paste-hydro').value;
  const rows = parseHydro(txt);
  WIZ.hydro = rows;
  renderTablePreview('preview-hydro', rows, ['draft_m','dis_fw','dis_sw','lcf_m','lcb_m','tpc','mct']);
  updateWizStatus();
});
const hydroClr = document.getElementById('clear-hydro');
if (hydroClr) hydroClr.addEventListener('click', ()=>{
  document.getElementById('paste-hydro').value='';
  document.getElementById('preview-hydro').innerHTML='';
  WIZ.hydro = [];
  updateWizStatus();
});

for (const key of ['cargo','ballast','cons']){
  const btn = document.getElementById(`parse-${key}`);
  const clr = document.getElementById(`clear-${key}`);
  if (btn) btn.addEventListener('click', ()=>{
    const txt = document.getElementById(`paste-${key}`).value;
    const rows = parseTanksGeneric(txt, key==='cons'?'cons':'tank');
    WIZ[key] = rows;
    const cols = key==='cons' ? ['name','type','lcg','cap_m3'] : ['name','lcg','cap_m3'];
    renderTablePreview(`preview-${key}`, rows, cols);
    updateWizStatus();
  });
  if (clr) clr.addEventListener('click', ()=>{
    document.getElementById(`paste-${key}`).value='';
    document.getElementById(`preview-${key}`).innerHTML='';
    WIZ[key] = [];
    updateWizStatus();
  });
}

function buildShipJsonFromWizard() {
  const name = document.getElementById('wiz-name').value.trim() || 'NEW SHIP';
  const id = document.getElementById('wiz-id').value.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
  const lbp = toNumber(document.getElementById('wiz-lbp').value);
  const rho = toNumber(document.getElementById('wiz-rho').value);
  const lsw = toNumber(document.getElementById('wiz-ls-w').value);
  const lsx = toNumber(document.getElementById('wiz-ls-x').value);
  const cargo = WIZ.cargo.map(t=>({ name:t.name, lcg:t.lcg, cap_m3: t.cap_m3!=null? t.cap_m3 : undefined }));
  const ballast = WIZ.ballast.map(t=>({ name:t.name, lcg:t.lcg, cap_m3: t.cap_m3!=null? t.cap_m3 : undefined }));
  const cons = WIZ.cons.map(t=>({ name:t.name, type:t.type, lcg:t.lcg, cap_m3: t.cap_m3!=null? t.cap_m3 : undefined }));
  const hydro = WIZ.hydro.map(r=>({
    draft_m: r.draft_m,
    dis_fw: r.dis_fw,
    dis_sw: r.dis_sw,
    lcf_m: r.lcf_m,
    lcb_m: r.lcb_m,
    tpc: r.tpc,
    mct: r.mct,
  }));
  return {
    ship: {
      id, name,
      lbp: isFinite(lbp) ? lbp : SHIP.LBP,
      rho_ref: isFinite(rho) ? rho : SHIP.RHO_REF,
      light_ship: (isFinite(lsw) && isFinite(lsx)) ? { weight: lsw, lcg: lsx } : undefined,
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

const exportBtn = document.getElementById('wiz-export');
if (exportBtn) exportBtn.addEventListener('click', ()=>{
  const js = buildShipJsonFromWizard();
  const fn = `${js.ship.id||'new_ship'}.json`;
  download(fn, JSON.stringify(js,null,2));
});

const activateBtn = document.getElementById('wiz-activate');
if (activateBtn) activateBtn.addEventListener('click', async ()=>{
  const js = buildShipJsonFromWizard();
  // Activate in-memory without saving to server
  SHIP_ACTIVE = {
    LBP: js.ship.lbp ?? SHIP.LBP,
    LCF: SHIP.LCF,
    TPC: SHIP.TPC,
    MCT1cm: SHIP.MCT1cm,
    RHO_REF: js.ship.rho_ref ?? SHIP.RHO_REF,
  };
  window.LIGHT_SHIP = js.ship.light_ship || window.LIGHT_SHIP;
  HYDRO_ROWS = (js.hydrostatics.rows||[]).sort((a,b)=>a.draft_m-b.draft_m);
  ACTIVE = {
    cargo: (js.tanks.cargo||[]).map(t=>({ id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 })),
    ballast: (js.tanks.ballast||[]).map(t=>({ id: t.name.replace(/\s+/g,'_'), name: t.name, lcg: Number(t.lcg), cap_m3: t.cap_m3 })),
  };
  CONS_TANKS = (js.tanks.consumables||[]).map(t=>({ name: t.name, type: t.type, lcg: Number(t.lcg), cap_m3: t.cap_m3 }));
  buildTankInputs('cargo-tanks', ACTIVE.cargo);
  buildTankInputs('ballast-tanks', ACTIVE.ballast);
  renderConstants();
  hideWizard();
});
