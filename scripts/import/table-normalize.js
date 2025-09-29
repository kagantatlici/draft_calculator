/**
 * Normalize hydrostatic table cells extracted in "wide" format into a tall table
 * with columns: Draft (m), LCF (m), TPC (t/cm), MCT1cm (t·m/cm).
 * Heuristics: detect a header row that contains DRAFT and many numeric tokens,
 * then find property rows by fuzzy label match (LCF, TPC, MTC/MCT).
 */

function normalizeLabel(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'')
    .replace(/ı/g,'i')
    .replace(/ç/g,'c')
    .replace(/ğ/g,'g')
    .replace(/ö/g,'o')
    .replace(/ş/g,'s')
    .replace(/ü/g,'u');
}

function toNumber(t){
  let s = String(t||'').trim();
  if (!s) return NaN;
  // Common OCR fixes
  s = s.replace(/[Oo]/g,'0').replace(/[lI]/g,'1');
  s = s.replace(/[,]/g,'.');
  // Remove stray symbols
  s = s.replace(/[^0-9.+\-]/g,'');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function countNums(arr){
  let c=0; for(const v of arr){ if (isFinite(toNumber(v))) c++; } return c;
}

export function normalizeHydroCells(cells){
  try{
    const rows = Array.isArray(cells)? cells : [];
    if (!rows.length) return null;
    // 1) Find header row with DRAFT and many numeric tokens
    let headerIdx = -1;
    for (let i=0;i<Math.min(rows.length,10);i++){
      const line = rows[i].map(x=> String(x||''));
      const joined = line.join(' ').toUpperCase();
      if (/(DRAFT)/.test(joined) && countNums(line) >= 4){ headerIdx = i; break; }
    }
    if (headerIdx < 0) return null;
    const headerRow = rows[headerIdx];
    // header may start with "DRAFT (MLD.)" token then numbers
    // find first index where a valid number appears
    let startCol = 1;
    while (startCol < headerRow.length && !isFinite(toNumber(headerRow[startCol]))) startCol++;
    const drafts = headerRow.slice(startCol).map(toNumber).filter(n => isFinite(n));
    if (drafts.length < 3) return null;
    // 2) Find property rows by fuzzy matching first cell
    const labelIndex = 0; // first column contains labels
    let lcfRow=null, tpcRow=null, mctRow=null;
    for (let i=0;i<rows.length;i++){
      const lbl = normalizeLabel(rows[i][labelIndex]||'');
      if (!lbl) continue;
      if (!lcfRow && /lcf/.test(lbl)) lcfRow = rows[i];
      else if (!tpcRow && /tpc/.test(lbl)) tpcRow = rows[i];
      else if (!mctRow && /(mct|mtc)/.test(lbl)) mctRow = rows[i];
    }
    if (!tpcRow && !mctRow && !lcfRow) return null;
    // 3) Build tall grid
    const out = [[ 'Draft (m)', 'LCF (m)', 'TPC (t/cm)', 'MCT1cm (t·m/cm)' ]];
    const takeNums = (row)=> row ? row.slice(startCol, startCol+drafts.length).map(toNumber) : Array(drafts.length).fill(NaN);
    const lcfVals = takeNums(lcfRow);
    const tpcVals = takeNums(tpcRow);
    const mctVals = takeNums(mctRow);
    for (let i=0;i<drafts.length;i++){
      out.push([
        String(drafts[i]),
        isFinite(lcfVals[i])? String(lcfVals[i]) : '',
        isFinite(tpcVals[i])? String(tpcVals[i]) : '',
        isFinite(mctVals[i])? String(mctVals[i]) : '',
      ]);
    }
    return out;
  }catch(_){ return null; }
}

// expose for debugging
// eslint-disable-next-line no-undef
window.TableNormalize = { normalizeHydroCells };

