/*
 Test runner for draft/trim calculator using condition DOCX files.
 - Parses DOCX texts (via unzip) to extract tank weights, consumables, light ship, and expected drafts/trim.
 - Reimplements the core hydrostatic calculation (same as app.js) without DOM.
 - Compares computed results to expected values from the booklet conditions.

 Usage: node scripts/test_conditions.js
*/

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Constants mirroring constants.js
const SHIP = {
  LBP: 171.2,
  RHO_REF: 1.025,
};

// Load hydrostatics JSON
const hydroPath = path.join(ROOT, 'data', 'hydrostatics.json');
const HY = JSON.parse(fs.readFileSync(hydroPath, 'utf8'));
const HYDRO_ROWS = HY.rows.sort((a, b) => a.draft_m - b.draft_m);

function interpHydro(rows, T) {
  if (!rows || rows.length === 0 || !isFinite(T)) return null;
  if (T <= rows[0].draft_m) {
    const r = rows[0];
    return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct };
  }
  if (T >= rows[rows.length - 1].draft_m) {
    const r = rows[rows.length - 1];
    return { LCF: r.lcf_m, LCB: r.lcb_m, TPC: r.tpc, MCT1cm: r.mct };
  }
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

function parseDocxText(file) {
  const full = path.join(ROOT, file);
  const xmlText = execSync(`unzip -p ${JSON.stringify(full)} word/document.xml`, { encoding: 'utf8' });
  const text = xmlText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text;
}

function toNumbers(str) {
  // Extract numeric tokens including signs and decimals
  const nums = [];
  const re = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  let m;
  while ((m = re.exec(str))) {
    nums.push(Number(m[0]));
  }
  return nums;
}

function extractCondition(text) {
  const tanks = [];
  const tankNameRe = /NO\.(\d)\s+CARGO\s+TK\((P|S)\)|SLOP\s+TK\((P|S)\)/ig;
  // Split into chunks near tank names to parse their numbers
  let match;
  while ((match = tankNameRe.exec(text))) {
    const name = match[0].replace(/\s+/g, ' ').trim();
    const start = match.index;
    const end = Math.min(text.length, start + 140); // next ~140 chars hold the numbers
    const segment = text.slice(start, end);
    const nums = toNumbers(segment);
    // Find a plausible window [density, weight, VCG, LCG, FSM]
    let picked = null;
    for (let i = 0; i + 4 < nums.length; i++) {
      const d = nums[i], w = nums[i + 1], vcg = nums[i + 2], lcg = nums[i + 3], fsm = nums[i + 4];
      if (d >= 0.6 && d <= 1.7 && w >= 200 && w <= 4000 && vcg >= 5 && vcg <= 12 && lcg >= -80 && lcg <= 90 && fsm >= 100 && fsm <= 10000) {
        picked = { weight: w, lcg };
        break;
      }
    }
    if (picked) tanks.push({ name, weight: picked.weight, lcg: picked.lcg });
  }

  // TOTAL CONSUMABLE line
  const consRe = /TOTAL\s+CONSUMABLE\([^)]*\)\s+([\s\S]*?)\s+(?:TOTAL|LIGHT\s+SHIP)/i;
  let consumables = null;
  const cm = consRe.exec(text);
  if (cm) {
    const nums = toNumbers(cm[1]);
    // Pattern: weight, VCG, LCG, FSM
    if (nums.length >= 3) {
      consumables = { weight: nums[0], lcg: nums[2] };
    }
  }

  // LIGHT SHIP line
  const lsRe = /LIGHT\s+SHIP\s+([\s\S]*?)\s+(?:TOTAL\s+DISPLACEMENT|TOTAL\s+DISP\b)/i;
  let lightShip = null;
  const lsm = lsRe.exec(text);
  if (lsm) {
    const nums = toNumbers(lsm[1]);
    // Pattern: weight, VCG, LCG
    if (nums.length >= 3) lightShip = { weight: nums[0], lcg: nums[2] };
  }

  // TOTAL DISPLACEMENT
  const dispRe = /TOTAL\s+DISPLACEMENT\s+([\d\.]+)/i;
  const disp = dispRe.exec(text);
  const displacement = disp ? Number(disp[1]) : null;

  // Additional Parameters
  function grab(name) {
    const re = new RegExp(name + '\\s*=\\s*([-+]?\\d*\\.?\\d+)', 'i');
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  }
  const expected = {
    draft_mean: grab('DRAFT\\s+MEAN'),
    draft_aft: grab('DRAFT\\s+AFT'),
    draft_fore: grab('DRAFT\\s+FORE'),
    total_trim_m: grab('TOTAL\\s+TRIM'), // sign as printed
    lcf_m: grab('L\\.C\\.F\\\.'),
    lcb_m: grab('L\\.C\\.B\\\.'),
    tpc: grab('T\\.P\\.C\\\.'),
    mct: grab('M\\.T\\.C\\\.'),
  };

  return { tanks, consumables, lightShip, displacement, expected };
}

function computeDrafts({ items, rho }) {
  const W = items.reduce((s, it) => s + it.w, 0);
  const Mx = items.reduce((s, it) => s + it.w * it.x, 0);
  const target_dis_fw = W / rho; // m^3 numerically
  let Tmean_m = solveDraftByDisFW(HYDRO_ROWS, target_dis_fw);
  const h = interpHydro(HYDRO_ROWS, Tmean_m) || {};
  const LCF = h.LCF ?? 0;
  const LCB = h.LCB ?? 0;
  const MCT1cm = h.MCT1cm ?? 1;

  const LCG_total = W !== 0 ? (Mx / W) : 0;
  const Trim_cm = - (W * (LCG_total - LCB)) / MCT1cm; // by stern +, by doc may show − for by head
  const Trim_m = Trim_cm / 100.0;

  const dist_LCF_to_FP = (SHIP.LBP / 2) - LCF;
  const dist_LCF_to_AP = (SHIP.LBP / 2) + LCF;
  const Df = Tmean_m - Trim_m * (dist_LCF_to_FP / SHIP.LBP);
  const Da = Tmean_m + Trim_m * (dist_LCF_to_AP / SHIP.LBP);

  return { W, Mx, Tmean_m, Da, Df, Trim_m, Trim_cm, LCF, LCB, MCT1cm };
}

function summarizeDiff(label, got, exp) {
  const err = isFinite(got) && isFinite(exp) ? (got - exp) : NaN;
  const ok = isFinite(err) && Math.abs(err) <= 0.02; // 2 cm tolerance on drafts
  return { label, got, exp, err, ok };
}

function runOne(file) {
  const text = parseDocxText(file);
  const cond = extractCondition(text);
  // Debug parse presence
  // console.error(file, 'consumables', cond.consumables, 'lightShip', cond.lightShip);
  const rho = SHIP.RHO_REF; // booklet shows SW 1.025

  // Build items: all tank weights at their LCG, plus consumables and light ship
  const items = [];
  for (const t of cond.tanks) items.push({ name: t.name, w: t.weight, x: t.lcg });
  if (cond.consumables) items.push({ name: 'FO+FW', w: cond.consumables.weight, x: cond.consumables.lcg });
  if (cond.lightShip) items.push({ name: 'Light Ship', w: cond.lightShip.weight, x: cond.lightShip.lcg });

  const res = computeDrafts({ items, rho });

  // Compare with expected (note: sign convention: our Trim is by stern +; booklet prints negative when by head)
  const out = [];
  out.push(summarizeDiff('Draft Mean (m)', res.Tmean_m, cond.expected.draft_mean));
  out.push(summarizeDiff('Draft Aft (m)', res.Da, cond.expected.draft_aft));
  out.push(summarizeDiff('Draft Fore (m)', res.Df, cond.expected.draft_fore));
  if (cond.expected.total_trim_m != null) {
    const expTrim = cond.expected.total_trim_m; // booklet sign; negative means by head
    out.push(summarizeDiff('Trim (m, by stern +)', res.Trim_m, -expTrim));
  }

  return { file, items, consumables: cond.consumables, result: res, expected: cond.expected, checks: out };
}

function fmt(n, d = 3) { return isFinite(n) ? n.toFixed(d) : String(n); }

function main() {
  const files = ['Condition 10.docx', 'condition 12.docx', 'cond 9.docx'];
  const results = files.map(runOne);
  for (const r of results) {
    console.log(`\n=== ${r.file} ===`);
    const W = r.result.W;
    const n = r.items.length;
    console.log(`Items: ${n}, W=${fmt(W,1)} t, rho=${SHIP.RHO_REF}`);
    console.log(`Parsed consumables: ${r.consumables ? JSON.stringify(r.consumables) : 'NONE'}`);
    const lsLine = r.items.find(it => it.name==='Light Ship');
    console.log(`Light ship parsed: ${lsLine ? `w=${fmt(lsLine.w,1)} x=${fmt(lsLine.x,2)}` : 'NONE'}`);
    if (r.file === 'Condition 10.docx') {
      console.log('First 8 items:', r.items.slice(0,8));
      const LCG_total = r.result.Mx / r.result.W;
      console.log(`LCB=${fmt(r.result.LCB,3)} LCF=${fmt(r.result.LCF,3)} LCGtot=${fmt(LCG_total,3)} MCT=${fmt(r.result.MCT1cm,1)} Trim(m)=${fmt(r.result.Trim_m,3)}`);
    }
    for (const c of r.checks) {
      const ok = c.ok ? 'OK ' : 'DIFF';
      console.log(`${ok}  ${c.label}: got ${fmt(c.got, 3)} vs exp ${fmt(c.exp, 3)}  (Δ=${fmt(c.err, 3)})`);
    }
  }
}

main();
