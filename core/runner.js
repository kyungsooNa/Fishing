// 전체 순회. 한 사이트가 죽어도 나머지는 그대로 수집합니다.

import { readFile } from 'node:fs/promises';
import { mergeDuplicates } from './merge.js';
import { platformOf } from './platform.js';
import { kstDate } from './when.js';
import { loadPorts, usedPorts } from './ports.js';
import { closeBrowser, describeError } from './fetcher.js';
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
export async function runAll({ only = null, days = 21, registryPath, dataPath, portsPath, dryRun = false } = {}) {
  const registry = await loadRegistry(registryPath);
  const targets = registry.filter((s) => (only ? s.id === only : s.enabled !== false));

  if (only && !targets.length) {
    throw new Error(`registry에 '${only}' 가 없습니다. 등록된 id: ${registry.map((s) => s.id).join(', ')}`);
  }

  const prev = await load(dataPath);
  const prevBySite = groupBy(prev.trips ?? [], (t) => t.siteId);

  // 사이트별로 같이 남기는 값. 화면(특히 서버 없는 GitHub Pages의 관리 페이지)은
  // registry를 못 읽으므로, 주소·항구·전화를 여기 실어 보내야 표에 나옵니다.
  const meta = (site) => ({
    name: site.name ?? site.id,
    platform: platformOf(site).label,
    url: site.url ?? null,
    port: site.port ?? null,
    phone: site.phone ?? null,
    // 손으로 넣은 곳인지 discover가 찾은 곳인지. 관리 화면이 서버 없이도 구분합니다.
    addedBy: site.addedBy ?? null,
  });

  const status = {};
  const failed = new Set();
  const collected = [];
  const startedAt = new Date();

  for (const site of targets) {
    const at = new Date().toISOString();
    try {
      const trips = await collectSite({ days, ...site });
      collected.push(...trips);
      status[site.id] = { ok: true, at, count: trips.length, ...meta(site) };
      console.log(`  ${site.id.padEnd(14)} ${String(trips.length).padStart(4)}건`);
    } catch (err) {
      failed.add(site.id);
      const kept = prevBySite.get(site.id) ?? [];
      collected.push(...kept);
      status[site.id] = {
        ok: false,
        at,
        error: describeError(err).slice(0, 300),
        count: kept.length,
        keptFrom: prev.sites?.[site.id]?.at ?? prev.generatedAt ?? null,
        ...meta(site),
      };
      console.warn(`  ${site.id.padEnd(14)} 실패: ${status[site.id].error}`);
    }
  }

  await closeBrowser();

  const trips = sortTrips(mergeDuplicates(pruneOld(collected, days)));
  const openings = findOpenings(prev.trips ?? [], trips, failed);

  // 지도에 찍을 항구. 좌표가 없는 항구는 지도에서 빠지므로 로그로 알려줍니다.
  const { places, missing } = usedPorts(trips, await loadPorts(portsPath));
  if (missing.length) console.warn(`  좌표 없는 항구: ${missing.join(', ')} — sites/ports.json에 추가하세요`);

  const data = { generatedAt: startedAt.toISOString(), sites: status, ports: places, trips };

  if (!dryRun) await save(data, dataPath);
  return { data, openings, failed: [...failed] };
}

// 오늘 이전과 수집 범위 밖의 날짜를 떨궈냅니다. 기준은 한국 날짜입니다.
export function pruneOld(trips, days, now = new Date()) {
  const from = kstDate(0, now);
  const to = kstDate(days, now);
  return trips.filter((t) => t.date >= from && t.date <= to);
}

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
