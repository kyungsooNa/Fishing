// 전체 순회. 한 사이트가 죽어도 나머지는 그대로 수집합니다.

import { readFile } from 'node:fs/promises';
import { mergeDuplicates } from './merge.js';
import { platformOf } from './platform.js';
import { kstDate, kstMinutes } from './when.js';
import { loadPorts, usedPorts } from './ports.js';
import { closeBrowser, describeError, gapKey } from './fetcher.js';
import { load, save } from './store.js';
import { findOpenings } from './diff.js';
import { makeTrip, STATUS } from './schema.js';

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
  // 사이트 제목이나 플랫폼명이 배 이름으로 섞여 들어오는 경우도 여기서 한 번 더 거릅니다.
  return trips.filter((t) => t && t.date && !site.excludeBoats?.includes(t.boat));
}

/**
 * 등록된 사이트를 모두 돌고 data.json을 갱신합니다.
 * 실패한 사이트는 직전 수집 결과를 그대로 남겨둡니다 — 화면이 갑자기 비지 않도록.
 */
export async function runAll({
  only = null,
  days = 21,
  registryPath,
  dataPath,
  portsPath,
  dryRun = false,
  now = new Date(),
  timeoutBackoffHours = defaultTimeoutBackoffHours(),
} = {}) {
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

  const failed = new Set();
  const startedAt = new Date();
  const timeoutBackoffMs = Math.max(0, Number(timeoutBackoffHours) || 0) * 60 * 60 * 1000;
  const tripsById = new Map();
  const statusById = new Map();

  const collectOne = async (site) => {
    const at = new Date().toISOString();
    const prevStatus = prev.sites?.[site.id];
    if (!only && inTimeoutBackoff(prevStatus, timeoutBackoffMs, now)) {
      failed.add(site.id);
      const kept = (prevBySite.get(site.id) ?? []).map((t) => refreshKeptTrip(site, t));
      const retryAt = new Date(Date.parse(prevStatus.at) + backoffMsFor(prevStatus, timeoutBackoffMs)).toISOString();
      const error = `${baseTimeoutError(prevStatus.error)} — 최근 timeout이라 ${retryAt}까지 재시도 보류`;
      tripsById.set(site.id, kept);
      statusById.set(site.id, {
        ...prevStatus,
        ok: false,
        error,
        count: kept.length,
        keptFrom: prevStatus.keptFrom ?? prevStatus.at ?? prev.generatedAt ?? null,
        retryAt,
        skipped: 'timeout-backoff',
        ...meta(site),
      });
      console.warn(`  ${site.id.padEnd(14)} 건너뜀: 최근 timeout, ${retryAt} 이후 재시도`);
      return;
    }

    try {
      const trips = await collectSite({ days, ...site });
      tripsById.set(site.id, trips);
      statusById.set(site.id, { ok: true, at, count: trips.length, ...meta(site) });
      console.log(`  ${site.id.padEnd(14)} ${String(trips.length).padStart(4)}건`);
    } catch (err) {
      failed.add(site.id);
      const kept = (prevBySite.get(site.id) ?? []).map((t) => refreshKeptTrip(site, t));
      const error = describeError(err).slice(0, 300);
      // 연달아 timeout이면 다음 대기가 길어집니다. 다른 이유로 실패했으면 세지 않습니다.
      const streak = isTimeoutError(error) ? timeoutStreakOf(prevStatus) + 1 : 0;
      tripsById.set(site.id, kept);
      statusById.set(site.id, {
        ok: false,
        at,
        error,
        count: kept.length,
        keptFrom: prev.sites?.[site.id]?.at ?? prev.generatedAt ?? null,
        ...(streak ? { timeoutStreak: streak } : {}),
        ...meta(site),
      });
      console.warn(`  ${site.id.padEnd(14)} 실패: ${error}`);
    }
  };

  // 서버가 다르면 동시에 받습니다. 한 줄로 세우면 사이트 수만큼 대기가 쌓입니다 —
  // 284곳이 되자 한 바퀴가 한 시간을 넘겼습니다. 같은 서버(도메인)에 묶인 사이트는
  // 한 줄로 두고, 그 안에서는 fetcher가 3초 간격을 지킵니다. 상대에게 가는 부담은
  // 그대로고 기다리는 시간만 겹칩니다.
  const groups = [...groupBy(targets, serverOf).values()];
  await inParallel(groups, Number(process.env.PARALLEL ?? 6), async (group) => {
    for (const site of group) await collectOne(site);
  });

  await closeBrowser();

  // 저장은 registry 순서로. 동시에 받으면 끝나는 순서가 매번 달라지는데, 그대로 쓰면
  // data.json이 실행마다 통째로 뒤집혀 커밋 diff가 쓸모없어집니다.
  const collected = targets.flatMap((site) => tripsById.get(site.id) ?? []);
  const status = Object.fromEntries(
    targets.filter((site) => statusById.has(site.id)).map((site) => [site.id, statusById.get(site.id)]),
  );

  const trips = sortTrips(mergeDuplicates(pruneOld(collected, days, now)));
  const openings = findOpenings(prev.trips ?? [], trips, failed);

  // 지도에 찍을 항구. 좌표가 없는 항구는 지도에서 빠지므로 로그로 알려줍니다.
  const { places, missing } = usedPorts(trips, await loadPorts(portsPath));
  if (missing.length) console.warn(`  좌표 없는 항구: ${missing.join(', ')} — sites/ports.json에 추가하세요`);

  const data = { generatedAt: startedAt.toISOString(), sites: status, ports: places, trips };

  if (!dryRun) await save(data, dataPath);
  // prevSites는 "그 사이트를 직전에 확인한 시각"입니다. 취소석을 얼마나 빨리 잡았는지는
  // 그 시각과 이번 시각 사이의 폭으로만 알 수 있어서(core/alerts.js) 같이 돌려줍니다.
  return { data, openings, failed: [...failed], prevSites: prev.sites ?? {} };
}

// 오늘 이전과 수집 범위 밖의 날짜를 떨궈냅니다. 기준은 한국 날짜입니다.
export function pruneOld(trips, days, now = new Date()) {
  const from = kstDate(0, now);
  const to = kstDate(days, now);
  const minutes = kstMinutes(now);
  return trips.filter((t) =>
    t.date >= from &&
    t.date <= to &&
    !(t.date === from && t.departAt && toMinutes(t.departAt) <= minutes),
  );
}


function refreshKeptTrip(site, t) {
  const refreshed = makeTrip(site, {
    boat: t.boat,
    date: t.date,
    departAt: t.departAt,
    returnAt: t.returnAt,
    species: t.species,
    tide: t.tide,
    status: t.statusText ?? t.status,
    seatsLeft: t.seatsLeft,
    seatsTotal: t.seatsTotal,
    price: t.price,
    port: t.port,
    url: t.url,
  });

  return {
    ...t,
    ...refreshed,
    status: refreshed.status === STATUS.UNKNOWN && t.status ? t.status : refreshed.status,
    statusText: refreshed.statusText ?? t.statusText ?? null,
  };
}

function toMinutes(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Infinity;
}

function defaultTimeoutBackoffHours() {
  if ('TIMEOUT_BACKOFF_HOURS' in process.env) return Number(process.env.TIMEOUT_BACKOFF_HOURS);
  return process.env.GITHUB_ACTIONS === 'true' ? 6 : 0;
}

const isTimeoutError = (error) => /timeout|timed out|안에 응답/i.test(String(error ?? ''));

// 연달아 몇 번 timeout이 났는지. 성공했거나 다른 이유로 실패했으면 0부터 다시 셉니다.
function timeoutStreakOf(status) {
  if (!status || status.ok !== false || !isTimeoutError(status.error)) return 0;
  return Math.max(1, Number(status.timeoutStreak) || 1);
}

// timeout은 대개 잠깐입니다 — 상대가 잠시 막았다가 풉니다. 더피싱 111곳이 한꺼번에
// 죽었다가 재시도하면 그대로 살아났습니다. 그런데 한 번 막힐 때마다 상한(6시간)을
// 통째로 쉬면 매시간 도는 수집이 5~6회 헛돕니다. 그래서 처음엔 1시간만 쉬고, 연달아
// 또 timeout이면 2·4시간으로 늘려 상한에서 멈춥니다 — 잠깐 막힌 곳은 금방 돌아오고,
// 정말 죽은 곳은 매시간 두드리지 않습니다.
const FIRST_BACKOFF_MS = 60 * 60 * 1000;

function backoffMsFor(status, maxMs) {
  const streak = Math.max(1, timeoutStreakOf(status));
  // 2의 거듭제곱은 금방 커집니다. 지수부터 묶어 두고 상한으로 자릅니다.
  return Math.min(FIRST_BACKOFF_MS * 2 ** Math.min(streak - 1, 20), maxMs);
}

function inTimeoutBackoff(status, maxMs, now) {
  if (!maxMs || !status || status.ok !== false) return false;
  if (!isTimeoutError(status.error)) return false;
  const lastTried = Date.parse(status.at ?? '');
  const nowMs = Number(now);
  if (!Number.isFinite(lastTried) || !Number.isFinite(nowMs) || nowMs < lastTried) return false;
  return nowMs - lastTried < backoffMsFor(status, maxMs);
}

function baseTimeoutError(error) {
  const text = String(error ?? '이전 수집 실패');
  return text.split(/\s+—\s+최근 timeout이라\s+/)[0] || '이전 수집 실패';
}

export function sortTrips(trips) {
  return trips.sort(
    (a, b) =>
      (a.date ?? '').localeCompare(b.date ?? '') ||
      (a.departAt ?? '').localeCompare(b.departAt ?? '') ||
      (a.siteName ?? '').localeCompare(b.siteName ?? '') ||
      (a.boat ?? '').localeCompare(b.boat ?? ''),
  );
}

/** 같은 서버에 얹힌 사이트끼리 묶는 키. 주소가 없으면(예시 어댑터) 저 혼자 한 무리입니다. */
function serverOf(site) {
  try {
    return gapKey(site.url);
  } catch {
    return `site:${site.id}`;
  }
}

/** 동시에 최대 limit개씩. 한 무리가 죽어도 나머지는 계속합니다(collectOne이 다 삼킵니다). */
async function inParallel(items, limit, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await work(queue.shift());
  });
  await Promise.all(workers);
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
