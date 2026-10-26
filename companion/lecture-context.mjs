import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execute=promisify(execFile);
import { hashFile } from '../core/artifacts.mjs';
const tokens = text => String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [];
const stop = new Set('the and with from this that for are was were you your has have into than which will can not'.split(' '));
export function contextIndex(pages) {
  const counts = new Map();
  for (const p of pages) for (const word of new Set(tokens(p.text))) counts.set(word, (counts.get(word) || 0) + 1);
  const terms = new Map();
  for (const p of pages) for (const term of p.text.match(/[\p{L}][\p{L}\p{N}'-]{3,}/gu) || []) {
    const key = term.toLowerCase(); if (stop.has(key) || (pages.length > 3 && counts.get(key) > pages.length * .8)) continue;
    if (!terms.has(key)) terms.set(key, { term, pages: [], occurrences: 0 });
    const item = terms.get(key); item.occurrences++; if (!item.pages.includes(p.page)) item.pages.push(p.page);
  }
  return { pages, glossary: [...terms.values()].sort((a, b) => b.occurrences - a.occurrences || a.term.localeCompare(b.term)) };
}
export function retrieveContext(index, query = '', maxChars = 320) {
  if (!index?.pages?.length) return { vocabulary: '', references: [] };
  const q = new Set(tokens(query));
  const ranked = index.pages.map(p => ({ ...p, score: [...new Set(tokens(p.text))].filter(w => q.has(w) && !stop.has(w)).length })).filter(p => !q.size || p.score > 0).sort((a, b) => b.score - a.score);
  if (q.size && !ranked.length) return { vocabulary: '', references: [] };
  const selected = ranked.slice(0, 3), selectedPages = new Set(selected.map(p => p.page));
  let vocabulary = '';
  for (const term of index.glossary.filter(t => t.pages.some(p => selectedPages.has(p)))) {
    if ((vocabulary + ' ' + term.term).length > maxChars) continue;
    vocabulary += (vocabulary ? ', ' : '') + term.term;
  }
  return { vocabulary, references: selected.map(p => ({ page: p.page, file: p.file, match: q.size ? 'lexical' : 'lecture-glossary', score: p.score, verified: false })) };
}
export async function readLecturePdfs(files, { signal, ocr = false } = {}) {
  const pages = [], warnings = [], sources = []; let pageId = 0;
  for (const file of files || []) {
    signal?.throwIfAborted();
    if ((await stat(file)).size > 100 * 1024 ** 2) throw new Error('Lecture PDF exceeds 100 MB.');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    const abort = () => void task.destroy(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const doc = await task.promise; if (doc.numPages > 1000) throw new Error('Lecture PDF exceeds 1,000 pages.');
      sources.push({ file, hash: await hashFile(file), pages: doc.numPages });
      for (let n = 1; n <= doc.numPages; n++) {
        signal?.throwIfAborted(); const page = await doc.getPage(n), content = await page.getTextContent();
        let text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').slice(0, 100000);
        if(!text.trim() && ocr) {
          const directory=await mkdtemp(path.join(os.tmpdir(),'notakillite-ocr-'));
          try { const png=path.join(directory,'page.png'); await renderPdfPage(file,n,png); const result=await execute(process.env.NOTAKILLITE_TESSERACT || 'tesseract',[png,'stdout','-l','ara+eng','tsv'],{timeout:120000,signal,maxBuffer:4*1024**2,windowsHide:true}); const rows=result.stdout.split('\n').slice(1).map(line=>line.split('\t')).filter(r=>r.length>=12 && +r[10]>=40 && r[11].trim()); text=rows.map(r=>r[11]).join(' '); warnings.push(`${path.basename(file)} page ${n}: OCR-derived text, terminology requires review.`); }
          catch(e) { if(signal?.aborted) throw e; warnings.push(`${path.basename(file)} page ${n}: optional OCR unavailable; install Tesseract with ara+eng.`); }
          finally {await rm(directory,{recursive:true,force:true});}
        }
        pages.push({ page: ++pageId, sourcePage: n, file, text });
        if (!text.trim()) warnings.push(`${path.basename(file)} page ${n}: no embedded text; scanned pages need OCR.`);
        page.cleanup();
      }
    } finally { signal?.removeEventListener('abort', abort); await task.destroy(); }
  }
  return { ...contextIndex(pages), sources, warnings };
}
export async function renderPdfPage(file, pageNumber, target) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { writeFile } = await import('node:fs/promises');
  const task = getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) throw new Error('Invalid PDF page.');
    const page = await doc.getPage(pageNumber); const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1.5, 1800 / Math.max(original.width,original.height)) });
    const canvas = createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    await writeFile(target,canvas.toBuffer('image/png'));
    const content = await page.getTextContent(); return content.items.map(i=>i.str).join(' ');
  } finally { await task.destroy(); }
}
