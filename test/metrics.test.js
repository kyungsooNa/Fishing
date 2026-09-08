import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMetrics, formatMetrics, platformFamily } from '../core/metrics.js';

const registry = [
  { id: 'sun', adapter: 'sunsang24' },
  { id: 'fish', adapter: 'thefishing', source: 'detail' },
  { id: 'own', adapter: 'generic' },
  { id: 'off', adapter: 'sunsang24', enabled: false },
];

const data = {
  generatedAt: '2026-09-08T03:00:00.000Z',
  sites: {
    sun: { ok: true, at: '2026-09-08T02:55:00.000Z', platform: '선상24' },
    fish: { ok: false, at: '2026-09-08T01:00:00.000Z', platform: '더피싱(상세)' },
    off: { ok: true, at: '2026-09-08T02:59:00.000Z', platform: '선상24' },
  },
  trips: [
    { siteId: 'sun' },
    { siteId: 'sun', sources: [{ siteId: 'sun' }, { siteId: 'fish' }] },
    { siteId: 'fish' },
    { siteId: 'own' },
  ],
};

test('더피싱 상세 수집은 커버리지에서 더피싱 하나로 센다', () => {
  assert.equal(platformFamily(registry[1]), '더피싱');
});

test('플랫폼별 활성 사이트·성공률·출조 수를 합계가 맞게 센다', () => {
  const result = collectMetrics(registry, data, new Date('2026-09-08T03:00:00.000Z'));

  assert.deepEqual(result.platforms, [
    { platform: '선상24', sites: 1, success: 1, failed: 0, uncollected: 0, trips: 2, successRate: 1 },
    { platform: '더피싱', sites: 1, success: 0, failed: 1, uncollected: 0, trips: 1, successRate: 0 },
    { platform: '자체', sites: 1, success: 0, failed: 0, uncollected: 1, trips: 1, successRate: 0 },
  ]);
  assert.deepEqual(result.totals,
    { platform: '합계', sites: 3, success: 1, failed: 1, uncollected: 1, trips: 4, successRate: 1 / 3 });
  assert.equal(result.platforms.reduce((sum, row) => sum + row.trips, 0), data.trips.length);
});

test('마지막 확인 시각을 겹치지 않는 구간으로 나눈다', () => {
  const result = collectMetrics(registry, data, new Date('2026-09-08T03:00:00.000Z'));
  assert.deepEqual(result.checkedAt, {
    within15m: 1,
    within1h: 0,
    within6h: 1,
    within24h: 0,
    over24h: 0,
    unknown: 1,
  });
});

test('사람이 읽는 표에 합계와 확인 시각 분포가 나온다', () => {
  const text = formatMetrics(collectMetrics(registry, data, new Date('2026-09-08T03:00:00.000Z')));
  assert.match(text, /선상24\s+1\s+1\s+0\s+0\s+100\.0%\s+2/);
  assert.match(text, /합계\s+3\s+1\s+1\s+1\s+33\.3%\s+4/);
  assert.match(text, /15분 이내 1곳/);
  assert.match(text, /미확인 1곳/);
});
