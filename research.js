#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadRegistry } from './core/runner.js';
import { fetchHtml, closeBrowser } from './core/fetcher.js';
import { researchTargets, dueForResearch, researchSite, researchMarkdown } from './core/research.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const bounded = (name, fallback, max) => {
  const n = Number(option(name, fallback));
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name}: 1~${max} 정수 필요`);
  return n;
};
const limit = bounded('--limit', 5, 50), maxPages = bounded('--pages', 6, 20);
const out = option('--out', 'tmp/research');
const registry = await loadRegistry();
const data = JSON.parse(await readFile(option('--from', 'docs/data.json'), 'utf8'));
let history = {};
try { history = JSON.parse(await readFile(`${out}/history.json`, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const ids = option('--sites', '').split(',').filter(Boolean);
for (const id of ids) if (!registry.some(s => s.id === id)) throw new Error(`미등록 선사: ${id}`);
const targets = researchTargets(registry, data).filter(t => !ids.length || ids.includes(t.id));
if (args.includes('--list')) {
  console.log(JSON.stringify(targets, null, 2));
} else {
  await mkdir(out, { recursive: true });
  const due = targets.filter(t => args.includes('--force') || dueForResearch(t, history[t.id])).slice(0, limit);
  console.log(`대상 ${targets.length}곳 · 이번 조사 ${due.length}곳 · 선사당 최대 ${maxPages}페이지`);
  const results = [];
  try {
    for (const target of due) {
      const result = await researchSite(target, { maxPages, readPage: url => fetchHtml(url, { mode: 'static', retries: 0, timeoutMs: 15000 }) });
      results.push(result);
      history[target.id] = result;
      // 중간 종료되어도 이미 확인한 선사를 잃지 않습니다.
      await writeFile(`${out}/history.json`, JSON.stringify(history, null, 2) + '\n');
      await writeFile(`${out}/report.json`, JSON.stringify(results, null, 2) + '\n');
      await writeFile(`${out}/report.md`, researchMarkdown(results));
      console.log(`${target.id}: ${result.status} · 근거 ${result.evidence.length} · 첨부 ${result.media.length} · 페이지 ${result.pages.length}`);
    }
    if (!due.length) console.log('재확인 대기 중입니다. 기존 history.json을 보거나 --force로 다시 조사하세요.');
  } finally { await closeBrowser(); }
}
