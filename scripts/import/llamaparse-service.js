/**
 * Client for LlamaParse via our HF Space proxy.
 */
import { getHFBase } from './hfspace-service.js';

function parseMarkdownTable(md){
  if (!md) return [];
  const lines = String(md).split(/\r?\n/);
  const tableLines = [];
  let inBlock = false;
  for (const l of lines){
    const s = l.trim();
    if (/^\|.*\|$/.test(s)) { tableLines.push(s); inBlock = true; }
    else if (inBlock && s==='') break;
  }
  if (!tableLines.length) return [];
  const rows = [];
  for (const l of tableLines){
    if (/^\|\s*-/.test(l)) continue; // separator
    const cells = l.split('|').slice(1,-1).map(x=> x.trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
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
  if (!js.cells || !js.cells.length){
    js.cells = parseMarkdownTable(js.markdown || js.md || '');
  }
  return js;
}

