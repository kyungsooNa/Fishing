// 수집 결과가 어느 플랫폼에 얼마나 기대고 있는지 숫자로 봅니다.
// 출조 건수만 크면 같은 일정표를 여러 번 센 것일 수도 있으므로, 활성 사이트와 성공률도 같이 냅니다.
// 성공률만으로는 부족합니다 — 백오프로 보류 중인 곳은 실패가 아니지만 값은 낡았습니다.
// 그래서 상태를 성공·실패·보류·미수집 넷으로 나누고, 시각은 "언제 시도했나"가 아니라
// "지금 화면에 실린 값이 언제 것인가"로 셉니다.

import { platformOf } from './platform.js';

export const AGE_BUCKETS = [
  { key: 'within15m', label: '15분 이내', maxMs: 15 * 60 * 1000 },
  { key: 'within1h', label: '1시간 이내', maxMs: 60 * 60 * 1000 },
  { key: 'within6h', label: '6시간 이내', maxMs: 6 * 60 * 60 * 1000 },
  { key: 'within24h', label: '24시간 이내', maxMs: 24 * 60 * 60 * 1000 },
  { key: 'over24h', label: '24시간 초과', maxMs: Infinity },
  { key: 'unknown', label: '미확인', maxMs: null },
];

// 더피싱(상세)는 수집 방식이지 별도 플랫폼이 아닙니다. 커버리지에서는 더피싱 하나로 셉니다.
export function platformFamily(site) {
  return platformOf(site).label.replace(/\(상세\)$/, '');
}

export function collectMetrics(registry, data, now = new Date()) {
  const enabled = registry.filter((site) => site.enabled !== false);
  const siteById = new Map(registry.map((site) => [site.id, site]));
  const groups = new Map();

  const groupFor = (label) => {
    if (!groups.has(label)) {
      groups.set(label, { platform: label, sites: 0, success: 0, failed: 0, held: 0, uncollected: 0, trips: 0 });
    }
    return groups.get(label);
  };

  for (const site of enabled) {
    const group = groupFor(platformFamily(site));
    group.sites++;
    group[stateOf(data.sites?.[site.id])]++;
  }

  // 통합된 출조가 여러 출처를 가져도 화면의 한 행은 한 번만 셉니다. 대표 siteId 기준이라
  // 플랫폼별 합계를 더하면 화면의 전체 출조 수와 정확히 맞습니다.
  for (const trip of data.trips ?? []) {
    const site = siteById.get(trip.siteId);
    const label = site ? platformFamily(site) : (data.sites?.[trip.siteId]?.platform ?? '미등록');
    groupFor(label.replace(/\(상세\)$/, '')).trips++;
  }

  const platforms = [...groups.values()]
    .map(withRate)
    .sort((a, b) => b.trips - a.trips || b.sites - a.sites || a.platform.localeCompare(b.platform, 'ko'));

  const checkedAt = Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket.key, 0]));
  const nowMs = new Date(now).getTime();
  for (const site of enabled) {
    const atMs = Date.parse(confirmedAt(data.sites?.[site.id]));
    if (!Number.isFinite(atMs)) {
      checkedAt.unknown++;
      continue;
    }
    const age = Math.max(0, nowMs - atMs);
    const bucket = AGE_BUCKETS.find((candidate) => candidate.maxMs !== null && age <= candidate.maxMs);
    checkedAt[bucket.key]++;
  }

  const totals = withRate(platforms.reduce((sum, row) => ({
    platform: '합계',
    sites: sum.sites + row.sites,
    success: sum.success + row.success,
    failed: sum.failed + row.failed,
    held: sum.held + row.held,
    uncollected: sum.uncollected + row.uncollected,
    trips: sum.trips + row.trips,
  }), { sites: 0, success: 0, failed: 0, held: 0, uncollected: 0, trips: 0 }));

  return { generatedAt: data.generatedAt ?? null, platforms, totals, checkedAt };
}

/**
 * 실패와 보류는 다릅니다. 보류는 연달아 timeout이 난 곳을 러너가 일부러 안 두드린 것이라
 * (core/runner.js의 백오프) 지금 그 사이트가 죽었다는 뜻이 아닙니다. 한 칸에 넣으면
 * "더피싱 111곳 전부 실패"로 읽혀서, 정말 죽은 곳을 찾을 때 그 안에 묻힙니다.
 */
function stateOf(status) {
  if (!status) return 'uncollected';
  if (status.ok === true) return 'success';
  if (status.ok === false) return status.skipped ? 'held' : 'failed';
  return 'uncollected';
}

/**
 * 그 사이트의 값이 언제 것인가. 실패한 곳은 직전 결과를 그대로 쓰므로(core/runner.js의
 * keptFrom) 방금 시도했어도 화면에 실린 값은 그때 것입니다. 시도 시각으로 세면 며칠 묵은
 * 값이 "15분 이내"로 잡혀서, 이 표를 최신성 확인용으로 쓸 수가 없습니다.
 */
function confirmedAt(status) {
  if (!status) return null;
  return status.ok ? status.at : status.keptFrom ?? status.at;
}

function withRate(row) {
  return { ...row, successRate: row.sites ? row.success / row.sites : null };
}

export function formatMetrics(metrics) {
  const header = ['플랫폼', '활성', '성공', '실패', '보류', '미수집', '성공률', '출조'];
  const rows = [...metrics.platforms, metrics.totals].map((row) => [
    row.platform,
    String(row.sites),
    String(row.success),
    String(row.failed),
    String(row.held),
    String(row.uncollected),
    percent(row.successRate),
    String(row.trips),
  ]);
  const widths = header.map((value, i) => Math.max(displayWidth(value), ...rows.map((row) => displayWidth(row[i]))));
  const line = (row) => row.map((value, i) => pad(value, widths[i], i === 0 ? 'right' : 'left')).join('  ');

  const ages = AGE_BUCKETS.map((bucket) => `${bucket.label} ${metrics.checkedAt[bucket.key]}곳`).join(' · ');
  return [
    `수집 결과: ${metrics.generatedAt ?? '없음'}`,
    '',
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
    `값을 확인한 때: ${ages}`,
  ].join('\n');
}

const percent = (value) => value === null ? '-' : `${(value * 100).toFixed(1)}%`;
const displayWidth = (value) => [...value].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 2 : 1), 0);
const pad = (value, width, side) => {
  const spaces = ' '.repeat(Math.max(0, width - displayWidth(value)));
  return side === 'left' ? spaces + value : value + spaces;
};
