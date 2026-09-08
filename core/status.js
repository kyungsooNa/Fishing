// 지금 무엇을 얼마나 보고 있는지 세는 곳.
//
// "선상24 밖도 검색된다"가 이 제품의 존재 이유인데(PRODUCT.md), 정작 지금 선상24가
// 몇 %인지 물으면 아무도 답을 못 했습니다. registry는 켜진 곳을 알려주지만 그게 실제로
// 수집되고 있는지는 모르고, data.json은 수집 결과를 알려주지만 계열별로 묶어주지 않습니다.
// 두 파일을 맞춰봐야 나오는 숫자라 매번 손으로 세게 됩니다.
//
// 세는 규칙 하나: **모든 분류는 합이 전체와 같아야 합니다.** 계열별 사이트 수를 더하면
// 전체 사이트 수가 되고, 계열별 출조를 더하면 data.json의 출조 수가 됩니다. 어긋나면
// 어딘가 빠뜨린 것이므로, 모르는 사이트도 버리지 않고 '알 수 없음'으로 셉니다.

import { platformOf } from './platform.js';

const HOUR_MS = 60 * 60 * 1000;

// 마지막으로 값을 확인한 지 얼마나 됐나. 수집이 매시간 도니 1시간이 첫 칸입니다.
const AGE_BUCKETS = [
  { label: '1시간 이내', maxHours: 1 },
  { label: '6시간 이내', maxHours: 6 },
  { label: '24시간 이내', maxHours: 24 },
  { label: '24시간 넘음', maxHours: Infinity },
  { label: '확인된 적 없음', maxHours: null },
];

export const UNKNOWN = { id: 'unknown', label: '알 수 없음' };

/**
 * registry(무엇을 보기로 했나)와 data.json(실제로 무엇을 봤나)을 맞춰 셉니다.
 *
 * 세는 대상은 **켜져 있는 사이트 ∪ 수집 결과에 남아 있는 사이트**입니다. 방금 끈 곳은
 * 다음 수집 전까지 data.json에 남아 있는데, 그걸 빼면 화면에 보이는 출조의 출처가
 * 어디에도 안 잡힙니다.
 */
export function summarize({ registry = [], data = {}, now = new Date() } = {}) {
  const sites = data.sites ?? {};
  const trips = data.trips ?? [];
  const nowMs = Number(now);

  const byId = new Map(registry.map((s) => [s.id, s]));
  const tracked = [...new Set([
    ...registry.filter((s) => s.enabled !== false).map((s) => s.id),
    ...Object.keys(sites),
  ])];

  const rows = tracked.map((id) => {
    const site = byId.get(id);
    const status = sites[id] ?? null;
    return {
      id,
      name: site?.name ?? status?.name ?? id,
      platform: platformFor(site, status),
      enabled: site ? site.enabled !== false : false,
      state: stateOf(status),
      error: status?.error ?? null,
      count: status?.count ?? 0,
      at: status?.at ?? null,
      // 실패한 곳의 값은 직전 성공 때 것입니다. "언제 확인한 값이냐"는 그쪽이 답입니다.
      lastOkAt: status?.ok ? status.at ?? null : status?.keptFrom ?? null,
    };
  });

  // 묶는 단위는 계열 id가 아니라 **표기**입니다. `더피싱`과 `더피싱(상세)`는 id가 같지만
  // 사이트당 요청 수가 3배 달라 한 칸에 넣으면 어느 쪽이 죽었는지 안 보이고, generic에
  // `"platform": "서로피싱"`을 적어둔 곳은 id가 같다고 '자체'로 뭉뚱그려집니다.
  // 화면 하단 "수집 상태"와 `debug.js` 목록도 이 표기로 보여줍니다.
  const tripsByPlatform = new Map();
  for (const t of trips) {
    const { label } = platformFor(byId.get(t.siteId), sites[t.siteId]);
    tripsByPlatform.set(label, (tripsByPlatform.get(label) ?? 0) + 1);
  }

  const labels = [...new Set([...rows.map((r) => r.platform.label), ...tripsByPlatform.keys()])];
  const platforms = labels
    .map((label) => {
      const mine = rows.filter((r) => r.platform.label === label);
      return {
        id: mine[0]?.platform.id ?? UNKNOWN.id,
        label,
        sites: countStates(mine),
        trips: tripsByPlatform.get(label) ?? 0,
        successRate: successRate(mine),
        freshRate: freshRate(mine),
        freshness: freshness(mine, nowMs),
        siteIds: mine.map((r) => r.id),
      };
    })
    // 큰 계열부터. 의존도를 보는 표라 제일 큰 곳이 맨 위에 있어야 합니다.
    .sort((a, b) => b.trips - a.trips || b.sites.tracked - a.sites.tracked || a.label.localeCompare(b.label));

  return {
    generatedAt: data.generatedAt ?? null,
    now: new Date(nowMs).toISOString(),
    totals: {
      sites: {
        registered: registry.length,
        disabled: registry.filter((s) => s.enabled === false).length,
        ...countStates(rows),
      },
      trips: trips.length,
      successRate: successRate(rows),
      freshRate: freshRate(rows),
    },
    platforms,
    freshness: freshness(rows, nowMs),
    // 실패는 오래된 것부터. 어제부터 죽어 있는 곳이 방금 죽은 곳보다 급합니다.
    failures: rows
      .filter((r) => r.state === 'failed' || r.state === 'skipped')
      .sort((a, b) => ageMs(b.lastOkAt, nowMs) - ageMs(a.lastOkAt, nowMs))
      .map(({ id, name, platform, state, error, count, lastOkAt }) =>
        ({ id, name, platform: platform.label, state, error, count, lastOkAt })),
    merged: mergedCounts(trips, byId, sites),
  };
}

/** 계열은 registry가 기준입니다. registry에서 사라진 사이트는 data.json에 남은 표기로 셉니다. */
function platformFor(site, status) {
  if (site) return platformOf(site);
  return { id: UNKNOWN.id, label: status?.platform ?? UNKNOWN.label };
}

function stateOf(status) {
  if (!status) return 'never';
  if (status.ok) return 'ok';
  // 백오프로 건너뛴 곳은 실패가 아니라 "아직 안 두드린" 것입니다. 섞으면 실패율이 부풀고,
  // 정말 죽은 곳을 찾을 때 눈에 안 들어옵니다.
  return status.skipped ? 'skipped' : 'failed';
}

function countStates(rows) {
  const count = (state) => rows.filter((r) => r.state === state).length;
  return {
    tracked: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    ok: count('ok'),
    failed: count('failed'),
    skipped: count('skipped'),
    never: count('never'),
  };
}

/** 실제로 요청한 곳 중 성공한 비율. 보류·기록 없음은 요청 자체를 안 했으므로 분모에서 뺍니다. */
function successRate(rows) {
  const attempted = rows.filter((r) => r.state === 'ok' || r.state === 'failed').length;
  return attempted ? rows.filter((r) => r.state === 'ok').length / attempted : null;
}

/**
 * 집계 대상 중 이번 수집에서 값을 새로 받아온 비율 — 실제 커버리지입니다.
 *
 * 성공률과 따로 둡니다. 백오프로 112곳을 건너뛰면 요청한 곳은 다 성공해서 성공률이
 * 100%인데, 화면의 절반은 몇 시간 전 값입니다. 그 상태를 "이상 없음"으로 읽으면 안 됩니다.
 */
function freshRate(rows) {
  return rows.length ? rows.filter((r) => r.state === 'ok').length / rows.length : null;
}

function ageMs(at, nowMs) {
  const ms = Date.parse(at ?? '');
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return Infinity;
  return Math.max(0, nowMs - ms);
}

function freshness(rows, nowMs) {
  return AGE_BUCKETS.map((b) => ({
    label: b.label,
    count: rows.filter((r) => bucketOf(r.lastOkAt, nowMs) === b.label).length,
  }));
}

function bucketOf(at, nowMs) {
  const age = ageMs(at, nowMs);
  if (!Number.isFinite(age)) return '확인된 적 없음';
  return AGE_BUCKETS.find((b) => b.maxHours !== null && age <= b.maxHours * HOUR_MS)?.label ?? '24시간 넘음';
}

/**
 * 합쳐진 출조. 계열별 출조 수는 대표 사이트 기준으로 한 번만 세므로, 여러 곳에서 온 줄이
 * 몇 건인지는 따로 알려줘야 "계열별 합 = 전체"가 왜 성립하는지 설명이 됩니다.
 */
function mergedCounts(trips, byId, sites) {
  let merged = 0;
  let crossPlatform = 0;
  for (const t of trips) {
    const sources = t.sources ?? [];
    if (sources.length < 2) continue;
    merged += 1;
    const labels = new Set(sources.map((s) => platformFor(byId.get(s.siteId), sites[s.siteId]).label));
    if (labels.size > 1) crossPlatform += 1;
  }
  return { trips: merged, crossPlatform };
}
