import { readFile } from 'node:fs/promises';
import { closeBrowser } from './fetcher.js';

/**
 * registry.json 을 읽고 각 사이트의 어댑터를 동적으로 로드한다.
 * 새 선사 추가 = registry에 한 줄 + (필요하면) adapters/ 에 파일 하나.
 */
export async function loadSites(registryPath = './sites/registry.json') {
  const raw = JSON.parse(await readFile(registryPath, 'utf8'));
  const sites = [];
  for (const site of raw) {
    if (site.enabled === false) continue;
    const mod = await import(`../adapters/${site.adapter}.js`);
    if (typeof mod.collect !== 'function') {
      throw new Error(`adapters/${site.adapter}.js 에 collect() 가 없습니다`);
    }
    sites.push({ ...site, collect: mod.collect });
  }
  return sites;
}

/**
 * 한 사이트가 죽어도 나머지는 계속 돈다.
 * 실패하면 기존 데이터는 그대로 두고 실패 사실만 기록한다.
 */
export async function runAll(sites, store, { concurrency = 3, days = 14 } = {}) {
  const queue = [...sites];
  const report = [];

  const worker = async () => {
    while (queue.length) {
      const site = queue.shift();
      const started = Date.now();
      try {
        const trips = await site.collect(site, { days });
        store.save(site.id, trips);
        report.push({ id: site.id, ok: true, count: trips.length, ms: Date.now() - started });
      } catch (err) {
        store.fail(site.id, err);
        report.push({ id: site.id, ok: false, error: String(err.message ?? err) });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  await closeBrowser();
  return report;
}

/** 앞으로 n일치 날짜 문자열 (KST 기준) */
export function upcomingDates(days = 14) {
  const out = [];
  const base = new Date(Date.now() + 9 * 3600 * 1000); // 러너는 UTC로 돈다
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
