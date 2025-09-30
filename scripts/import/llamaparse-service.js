/**
 * Client for LlamaParse via our HF Space proxy.
 */
import { getHFBase } from './hfspace-service.js';

function parseMarkdownTables(md){
  // Extract all GitHub-style markdown tables from markdown
  if (!md) return [];
  const lines = String(md).split(/\r?\n/);
  const tables = [];
  let cur = [];
  let inBlock = false;
  for (const raw of lines){
    const s = raw.trim();
    if (/^\|.*\|$/.test(s)) {
      // markdown table row
      cur.push(s);
      inBlock = true;
      continue;
    }
    // separator line in table: keep inside cur but skip when materializing rows
    if (inBlock && s === '') {
      if (cur.length) tables.push(cur.splice(0, cur.length));
      inBlock = false;
      continue;
    }
    // non-table line while in a block ends the table
    if (inBlock) {
      if (cur.length) tables.push(cur.splice(0, cur.length));
      inBlock = false;
    }
  }
  if (cur.length) tables.push(cur);

  const toCells = (tableLines)=>{
    const rows = [];
    for (const l of tableLines){
      if (/^\|\s*-/.test(l)) continue; // separator line
      const cells = l.split('|').slice(1,-1).map(x=> x.trim());
      if (cells.length) rows.push(cells);
    }
    return rows;
  };
  return tables.map(toCells).filter(t => t && t.length);
}

export async function parseWithLlamaParse(file){
  const base = getHFBase().replace(/\/$/, '');
  const fd = new FormData();
  fd.append('file', file, file.name || 'file');
  const res = await fetch(base + '/lp/table', { method: 'POST', body: fd });
  if (!res.ok){
    let msg=''; try{ msg = await res.text(); }catch(_){ }
    throw new Error('LlamaParse API hatası: ' + (msg || (res.status + ' ' + res.statusText)));
  }
  const js = await res.json();
  // Prefer structured cells if provided; also parse all markdown tables for multi-page PDFs
  if (!js.cells || !js.cells.length){
    const tables = parseMarkdownTables(js.markdown || js.md || '');
    js.tables = tables;
    js.cells = (tables && tables.length) ? tables[0] : [];
  } else {
    js.tables = [js.cells];
  }
  return js;
}
