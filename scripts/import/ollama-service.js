/**
 * Minimal client for Ollama vision models (e.g., llama3.2-vision, llava, qwen2-vl).
 * Calls the local Ollama HTTP API and tries to parse table output into cells.
 */

const DEFAULT_OLLAMA_BASE = 'https://Kagantatlici-draft-calculator-ocr.hf.space';
const DEFAULT_OLLAMA_MODEL = 'llama3.2-vision';

export function getOllamaBase() {
  try {
    const v = localStorage.getItem('OLLAMA_BASE');
    if (v && /^https?:\/\//i.test(v)) return v.trim().replace(/\/$/, '');
  } catch (_) {}
  return DEFAULT_OLLAMA_BASE;
}
export function setOllamaBase(url){ try{ localStorage.setItem('OLLAMA_BASE', String(url||'').trim()); }catch(_){ } return getOllamaBase(); }

export function getOllamaModel() {
  try {
    const v = localStorage.getItem('OLLAMA_MODEL');
    if (v && v.trim()) return v.trim();
  } catch (_) {}
  return DEFAULT_OLLAMA_MODEL;
}
export function setOllamaModel(m){ try{ localStorage.setItem('OLLAMA_MODEL', String(m||'').trim()); }catch(_){ } return getOllamaModel(); }

export async function ollamaHealthy() {
  try {
    const res = await fetch(getOllamaBase() + '/api/version', { method: 'GET' });
    return res.ok;
  } catch (_) { return false; }
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result||''));
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBase64(dataUrl) {
  const m = String(dataUrl||'').match(/^data:[^;]+;base64,(.+)$/i);
  return m ? m[1] : '';
}

/**
 * Ask Ollama VLM to extract a table as CSV (or Markdown).
 * Returns { text, html?, cells }
 */
export async function ollamaExtractTable(imageBlob, opts={}) {
  const base = getOllamaBase();
  const model = opts.model || getOllamaModel();
  const prompt = opts.prompt || 'Extract the table from this image as RFC4180 CSV. Use dot as decimal separator. Return only CSV without commentary.';
  const dataUrl = await blobToDataURL(imageBlob);
  const b64 = dataUrlToBase64(dataUrl);
  const res = await fetch(base + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, images: [b64], stream: false, options: { num_ctx: 4096 } })
  });
  if (!res.ok) throw new Error('Ollama API erişilemedi');
  const js = await res.json();
  const text = String(js.response || js.message || '');
  const cells = toCellsFromLLM(text);
  return { text, cells };
}

// Try to parse LLM output: prefer CSV in fenced block, then Markdown table, then loose CSV.
function toCellsFromLLM(s) {
  const t = String(s||'');
  const code = matchFence(t);
  const body = code || t;
  if (looksMarkdownTable(body)) return parseMarkdownTable(body);
  if (looksCSV(body)) return parseCSV(body);
  return splitWhitespaceGrid(body);
}

function matchFence(s){
  const m = s.match(/```(?:csv|table|text)?\n([\s\S]*?)```/i); return m? m[1].trim() : '';
}
function looksMarkdownTable(s){ return /\n?\|[^\n]+\|/.test(s) && /\|\s*-+\s*\|/.test(s); }
function looksCSV(s){ return /,/.test(s) && /\n/.test(s); }

function parseMarkdownTable(s){
  const lines = s.split(/\r?\n/).filter(l=>l.trim());
  const rows = [];
  for (const l of lines){
    if (/^\s*\|\s*-/.test(l)) continue; // separator row
    if (l.indexOf('|')<0) continue;
    const parts = l.split('|').slice(1,-1).map(x=>x.trim());
    if (parts.length) rows.push(parts);
  }
  return rows;
}
function parseCSV(s){
  const out=[]; let row=[]; let cur=''; let q=false;
  const push=()=>{ row.push(cur); cur=''; };
  for (let i=0;i<s.length;i++){
    const ch=s[i];
    if (q){ if (ch==='"'){ if (s[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=ch; }
    else {
      if (ch==='"') q=true; else if (ch===',') push(); else if (ch==='\n'){ push(); out.push(row.map(x=>x.trim())); row=[]; } else cur+=ch;
    }
  }
  if (cur.length||row.length) { push(); out.push(row.map(x=>x.trim())); }
  return out.filter(r=>r.some(c=>c&&c.trim().length));
}
function splitWhitespaceGrid(s){
  const lines = s.split(/\r?\n/).map(l=>l.trim()).filter(l=>l);
  return lines.map(l=> l.split(/\s{2,}|\t|,/) );
}

// expose helpers for debugging
// eslint-disable-next-line no-undef
window.OllamaClient = { getBase: getOllamaBase, setBase: setOllamaBase, getModel: getOllamaModel, setModel: setOllamaModel, healthy: ollamaHealthy };
