// 수집 결과가 어느 플랫폼에 얼마나 기대고 있는지 숫자로 봅니다.
// 출조 건수만 크면 같은 일정표를 여러 번 센 것일 수도 있으므로, 활성 사이트와 성공률도 같이 냅니다.

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
      groups.set(label, { platform: label, sites: 0, success: 0, failed: 0, uncollected: 0, trips: 0 });
    }
    return groups.get(label);
  };

  for (const site of enabled) {
    const group = groupFor(platformFamily(site));
    const status = data.sites?.[site.id];
    group.sites++;
    if (status?.ok === true) group.success++;
    else if (status?.ok === false) group.failed++;
    else group.uncollected++;
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
    const atMs = Date.parse(data.sites?.[site.id]?.at);
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
    uncollected: sum.uncollected + row.uncollected,
    trips: sum.trips + row.trips,
  }), { sites: 0, success: 0, failed: 0, uncollected: 0, trips: 0 }));

  return { generatedAt: data.generatedAt ?? null, platforms, totals, checkedAt };
}

function withRate(row) {
  return { ...row, successRate: row.sites ? row.success / row.sites : null };
}

export function formatMetrics(metrics) {
  const header = ['플랫폼', '활성', '성공', '실패', '미수집', '성공률', '출조'];
  const rows = [...metrics.platforms, metrics.totals].map((row) => [
    row.platform,
    String(row.sites),
    String(row.success),
    String(row.failed),
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
    `최근 확인: ${ages}`,
  ].join('\n');
}

const percent = (value) => value === null ? '-' : `${(value * 100).toFixed(1)}%`;
const displayWidth = (value) => [...value].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 2 : 1), 0);
const pad = (value, width, side) => {
  const spaces = ' '.repeat(Math.max(0, width - displayWidth(value)));
  return side === 'left' ? spaces + value : value + spaces;
};
