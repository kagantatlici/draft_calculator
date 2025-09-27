/**
 * Header mapping, normalization and hydrostatics validation utilities.
 * @file scripts/import/table-map-validate.js
 */

/** @type {Record<string,string[]>} */
export const HEADER_ALIASES = {
  draft_m: ['draft','draught','çekim','draft(m)','draft m','draft (m)'],
  tpc_t_per_cm: ['tpc','t/cm','tonnes per cm','t per cm','tpc(t/cm)'],
  mct1cm_t_m_per_cm: ['mct','mct 1 cm','mtc','t·m/cm','tm/cm','mct1cm'],
  lcf_m: ['lcf','longitudinal center of flotation','lcf(m)','lcf (m)']
};

/**
 * Normalize common OCR and locale issues.
 * - Decimal comma/dot
 * - Minus char variants
 * - O/0 and l/1 swaps when surrounded by digits
 * @param {string} s
 * @returns {string}
 */
export function normalizeCellText(s) {
  if (s == null) return '';
  let t = String(s).trim();
  t = t.replace(/[\u2013\u2014\u2212]/g, '-');
  // Replace thousand/decimal variations
  if (/(\d)[.,](\d{3})([.,])(\d{2,})/.test(t)) {
    // 1.234,56 or 1,234.56 -> 1234.56
    t = t.replace(/[.,](?=\d{3}[.,]\d)/g, '');
    t = t.replace(/,/, '.');
  } else if (/\d,\d+/.test(t) && !/\d\.\d+/.test(t)) {
    t = t.replace(/,/g, '.');
  }
  // OCR O/0 and l/1 near digits
  t = t.replace(/(?<=\d)O(?=\d)/g, '0').replace(/(?<=\d)l(?=\d)/g, '1');
  return t;
}

/**
 * Map header strings to canonical keys using aliases.
 * @param {string[]} headers
 * @returns {Record<string, number>} mapping from canonical -> column index
 */
export function mapHeaders(headers) {
  const norm = (h) => normalizeCellText(String(h||'').toLowerCase()).replace(/[\s\-().]/g, '');
  const map = {};
  const taken = new Set();
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]);
    for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[canon] != null) continue;
      for (const a of aliases) {
        const aa = norm(a);
        if (h.includes(aa)) { map[canon] = i; taken.add(i); break; }
      }
    }
  }
  return map;
}

/**
 * Validate hydrostatics rows for basic maritime rules.
 * @param {Array<{draft_m:number,tpc?:number,mct?:number,lcf_m?:number}>} rows
 * @param {{LBP:number}} opts
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validateHydro(rows, { LBP }) {
  const errors = [], warnings = [];
  if (!Array.isArray(rows) || !rows.length) return { errors: ['Boş tablo'], warnings };
  const drafts = rows.map(r => r.draft_m);
  for (let i = 1; i < drafts.length; i++) {
    if (!(drafts[i] >= drafts[i - 1])) warnings.push(`Satır ${i+1}: draft artan değil`);
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!(r.tpc > 0)) errors.push(`Satır ${i+1}: TPC > 0 olmalı`);
    if (!(r.mct > 0)) errors.push(`Satır ${i+1}: MCT1cm > 0 olmalı`);
    if (isFinite(r.lcf_m)) {
      const min = -LBP/2, max = LBP/2;
      if (r.lcf_m < min || r.lcf_m > max) warnings.push(`Satır ${i+1}: LCF aralığı dışında (${r.lcf_m})`);
    }
    if (i>0) {
      if (rows[i].tpc < rows[i-1].tpc) warnings.push(`Satır ${i+1}: TPC azalan`);
      if (rows[i].mct < rows[i-1].mct) warnings.push(`Satır ${i+1}: MCT1cm azalan`);
    }
  }
  return { errors, warnings };
}

/**
 * Convert parsed rows to the app’s hydrostatics schema.
 * Keeps key names compatible with existing loader: draft_m, lcf_m, tpc, mct
 * @param {Array<Record<string,any>>} rows
 * @returns {{rows:Array<{draft_m:number,lcf_m:number,tpc:number,mct:number}>}}
 */
export function toHydrostaticsJson(rows) {
  const out = [];
  for (const r of rows) {
    const draft = Number(r.draft_m);
    if (!isFinite(draft)) continue;
    const tpc = Number(r.tpc ?? r.tpc_t_per_cm);
    const mct = Number(r.mct ?? r.mct1cm_t_m_per_cm);
    const lcf = Number(r.lcf_m);
    out.push({ draft_m: draft, lcf_m: isFinite(lcf) ? lcf : 0, tpc: isFinite(tpc) ? tpc : NaN, mct: isFinite(mct) ? mct : NaN });
  }
  out.sort((a, b) => a.draft_m - b.draft_m);
  return { rows: out };
}

