// 전체 순회. 한 사이트가 죽어도 나머지는 그대로 수집합니다.

import { readFile } from 'node:fs/promises';
import { mergeDuplicates } from './merge.js';
import { platformOf } from './platform.js';
import { closeBrowser } from './fetcher.js';
import { load, save } from './store.js';
import { findOpenings } from './diff.js';

export const REGISTRY_PATH = 'sites/registry.json';

export async function loadRegistry(path = REGISTRY_PATH) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const sites = Array.isArray(parsed) ? parsed : parsed.sites ?? [];
  const ids = new Set();
  for (const s of sites) {
    if (!s.id) throw new Error(`registry에 id 없는 항목이 있습니다: ${JSON.stringify(s).slice(0, 80)}`);
    if (ids.has(s.id)) throw new Error(`registry에 id가 겹칩니다: ${s.id}`);
    ids.add(s.id);
  }
  return sites;
}

export async function collectSite(site) {
  const { collect } = await import(`../adapters/${site.adapter}.js`);
  const trips = (await collect(site)) ?? [];
  // 날짜 없는 행은 화면에서 정렬도 비교도 안 되므로 버립니다.
  return trips.filter((t) => t && t.date);
}

/**
 * 등록된 사이트를 모두 돌고 data.json을 갱신합니다.
 * 실패한 사이트는 직전 수집 결과를 그대로 남겨둡니다 — 화면이 갑자기 비지 않도록.
 */
export async function runAll({ only = null, days = 21, dataPath, dryRun = false } = {}) {
  const registry = await loadRegistry();
  const targets = registry.filter((s) => (only ? s.id === only : s.enabled !== false));

  if (only && !targets.length) {
    throw new Error(`registry에 '${only}' 가 없습니다. 등록된 id: ${registry.map((s) => s.id).join(', ')}`);
  }

  const prev = await load(dataPath);
  const prevBySite = groupBy(prev.trips ?? [], (t) => t.siteId);

  const status = {};
  const failed = new Set();
  const collected = [];
  const startedAt = new Date();

  for (const site of targets) {
    const at = new Date().toISOString();
    try {
      const trips = await collectSite({ days, ...site });
      collected.push(...trips);
      status[site.id] = { ok: true, at, count: trips.length, name: site.name ?? site.id, platform: platformOf(site).label };
      console.log(`  ${site.id.padEnd(14)} ${String(trips.length).padStart(4)}건`);
    } catch (err) {
      failed.add(site.id);
      const kept = prevBySite.get(site.id) ?? [];
      collected.push(...kept);
      status[site.id] = {
        ok: false,
        at,
        error: String(err?.message ?? err).slice(0, 300),
        count: kept.length,
        keptFrom: prev.sites?.[site.id]?.at ?? prev.generatedAt ?? null,
        name: site.name ?? site.id,
        platform: platformOf(site).label,
      };
      console.warn(`  ${site.id.padEnd(14)} 실패: ${status[site.id].error}`);
    }
  }

  await closeBrowser();

  const trips = sortTrips(mergeDuplicates(pruneOld(collected, days)));
  const openings = findOpenings(prev.trips ?? [], trips, failed);
  const data = { generatedAt: startedAt.toISOString(), sites: status, trips };

  if (!dryRun) await save(data, dataPath);
  return { data, openings, failed: [...failed] };
}

// 오늘 이전과 수집 범위 밖의 날짜를 떨궈냅니다.
function pruneOld(trips, days) {
  const today = new Date();
  const from = iso(today);
  const to = iso(new Date(today.getTime() + days * 86400e3));
  return trips.filter((t) => t.date >= from && t.date <= to);
}

const iso = (d) => d.toISOString().slice(0, 10);

function sortTrips(trips) {
  return trips.sort(
    (a, b) =>
      (a.date ?? '').localeCompare(b.date ?? '') ||
      (a.departAt ?? '').localeCompare(b.departAt ?? '') ||
      (a.siteName ?? '').localeCompare(b.siteName ?? '') ||
      (a.boat ?? '').localeCompare(b.boat ?? ''),
  );
}

function groupBy(list, keyOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
