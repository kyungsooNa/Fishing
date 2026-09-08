import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMetrics, formatMetrics, platformFamily } from '../core/metrics.js';

const registry = [
  { id: 'sun', adapter: 'sunsang24' },
  { id: 'fish', adapter: 'thefishing', source: 'detail' },
  { id: 'own', adapter: 'generic' },
  { id: 'off', adapter: 'sunsang24', enabled: false },
];

const NOW = new Date('2026-09-08T03:00:00.000Z');

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
  const result = collectMetrics(registry, data, NOW);

  assert.deepEqual(result.platforms, [
    { platform: '선상24', sites: 1, success: 1, failed: 0, held: 0, uncollected: 0, trips: 2, successRate: 1 },
    { platform: '더피싱', sites: 1, success: 0, failed: 1, held: 0, uncollected: 0, trips: 1, successRate: 0 },
    { platform: '자체', sites: 1, success: 0, failed: 0, held: 0, uncollected: 1, trips: 1, successRate: 0 },
  ]);
  assert.deepEqual(result.totals,
    { platform: '합계', sites: 3, success: 1, failed: 1, held: 0, uncollected: 1, trips: 4, successRate: 1 / 3 });
  assert.equal(result.platforms.reduce((sum, row) => sum + row.trips, 0), data.trips.length);
});

test('마지막 확인 시각을 겹치지 않는 구간으로 나눈다', () => {
  const result = collectMetrics(registry, data, NOW);
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
  const text = formatMetrics(collectMetrics(registry, data, NOW));
  assert.match(text, /선상24\s+1\s+1\s+0\s+0\s+0\s+100\.0%\s+2/);
  assert.match(text, /합계\s+3\s+1\s+1\s+0\s+1\s+33\.3%\s+4/);
  assert.match(text, /15분 이내 1곳/);
  assert.match(text, /미확인 1곳/);
});

// 백오프는 러너가 일부러 안 두드린 것입니다(core/runner.js). 실제로 더피싱 111곳이 한꺼번에
// 보류에 걸리는데, 실패로 세면 "111곳 전부 실패"로 읽혀서 정말 죽은 곳이 그 안에 묻힙니다.
test('백오프로 건너뛴 곳은 실패와 나눠 센다', () => {
  const held = {
    ...data,
    sites: {
      ...data.sites,
      fish: { ok: false, skipped: 'timeout-backoff', at: '2026-09-08T01:00:00.000Z', error: 'timeout' },
    },
  };
  const result = collectMetrics(registry, held, NOW);
  const row = result.platforms.find((p) => p.platform === '더피싱');

  assert.equal(row.failed, 0);
  assert.equal(row.held, 1);
  assert.equal(result.totals.held, 1);
  assert.equal(row.sites, row.success + row.failed + row.held + row.uncollected, '어느 칸에도 안 들어가면 안 됩니다');
});

// 실패한 사이트는 직전 결과를 그대로 씁니다. 시도 시각으로 세면 며칠 묵은 값이
// "15분 이내"로 잡혀서, 이 표를 최신성 확인용으로 쓸 수가 없습니다.
test('실패한 곳은 시도 시각이 아니라 그 값이 언제 것인지로 센다', () => {
  const stale = {
    ...data,
    sites: {
      ...data.sites,
      fish: {
        ok: false,
        at: '2026-09-08T02:59:00.000Z',        // 방금 시도했지만
        keptFrom: '2026-09-05T03:00:00.000Z',  // 화면에 실린 값은 사흘 전 것
        error: '500',
      },
    },
  };
  const result = collectMetrics(registry, stale, NOW);

  assert.equal(result.checkedAt.within15m, 1, '방금 성공한 sun 하나뿐입니다');
  assert.equal(result.checkedAt.over24h, 1, 'fish의 값은 사흘 전 것입니다');
});

test('직전 성공 기록이 없는 실패는 시도 시각으로 센다', () => {
  const result = collectMetrics(registry, data, NOW);
  assert.equal(result.checkedAt.within6h, 1, '한 번도 성공한 적 없으면 그거라도 씁니다');
});
