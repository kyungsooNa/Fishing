// 실패 격리는 이 프로젝트의 핵심 약속입니다 — 한 사이트가 죽어도 나머지는 살고,
// 죽은 사이트는 직전 결과를 그대로 남깁니다. 화면이 갑자기 비면 안 됩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAll } from '../core/runner.js';

async function fixture(sites, prevData = null) {
  const dir = await mkdtemp(join(tmpdir(), 'fishing-'));
  const registryPath = join(dir, 'registry.json');
  const dataPath = join(dir, 'data.json');
  await writeFile(registryPath, JSON.stringify({ sites }));
  if (prevData) await writeFile(dataPath, JSON.stringify(prevData));
  return { registryPath, dataPath };
}

const mockSite = { id: 'mock', name: '예시', adapter: '_mock', url: 'https://example.invalid' };
const brokenSite = { id: 'broken', name: '깨진곳', adapter: '_nonexistent', url: 'https://example.invalid' };

test('서버가 다른 사이트는 동시에 받고, 결과 순서는 registry 그대로다', async () => {
  // 한 줄로 세우면 사이트 수만큼 대기가 쌓입니다(284곳에서 한 바퀴가 한 시간을 넘겼습니다).
  // 동시에 받되 저장 순서는 실행마다 뒤집히면 안 됩니다 — diff가 매번 통째로 바뀝니다.
  const sites = [
    { ...mockSite, id: 'a', url: 'https://a.example.com' },
    { ...mockSite, id: 'b', url: 'https://b.otherhost.com' },
    { ...mockSite, id: 'c', url: 'https://c.example.com' },
  ];
  const { registryPath, dataPath } = await fixture(sites);
  const { data } = await runAll({ registryPath, dataPath, days: 21 });

  assert.deepEqual(Object.keys(data.sites), ['a', 'b', 'c'], 'registry 순서 그대로여야 합니다');
  assert.ok(data.trips.length > 0);
});

test('전체 수집 진행률은 시작과 사이트별 완료를 알려준다', async () => {
  const sites = [
    { ...mockSite, id: 'a', url: 'https://a.example.com' },
    { ...mockSite, id: 'b', url: 'https://b.otherhost.com' },
  ];
  const { registryPath, dataPath } = await fixture(sites);
  const progress = [];
  await runAll({ registryPath, dataPath, days: 21, onProgress: (p) => progress.push(p) });

  assert.deepEqual(progress[0], { done: 0, total: 2, siteId: null });
  assert.deepEqual(progress.map((p) => p.done).sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(progress.at(-1).total, 2);
});

test('수집 결과에 등록 출처를 실어 보낸다 — 서버 없는 화면도 수동/자동을 안다', async () => {
  const { registryPath, dataPath } = await fixture([
    { ...mockSite, addedBy: 'discover' },
    { ...mockSite, id: 'byhand', name: '손으로 넣은 곳' },
  ]);
  const { data } = await runAll({ registryPath, dataPath, days: 21 });

  assert.equal(data.sites.mock.addedBy, 'discover');
  assert.equal(data.sites.byhand.addedBy, null, '손으로 넣은 곳은 비어 있습니다');
});

test('수집 결과에서 registry 제외 배 이름을 제거한다', async () => {
  const { registryPath, dataPath } = await fixture([
    { ...mockSite, id: 'ssfish', excludeBoats: ['모형호'] },
  ]);
  const { data } = await runAll({ registryPath, dataPath, days: 21 });
  assert.ok(data.trips.every((trip) => trip.boat !== '모형호'));
});

test('한 사이트가 죽어도 나머지는 수집된다', async () => {
  const { registryPath, dataPath } = await fixture([mockSite, brokenSite]);
  const { data, failed } = await runAll({ registryPath, dataPath, days: 21 });

  assert.deepEqual(failed, ['broken']);
  assert.ok(data.trips.length > 0, '살아있는 사이트의 출조는 남아야 한다');
  assert.equal(data.sites.mock.ok, true);
  assert.equal(data.sites.broken.ok, false);
  assert.match(data.sites.broken.error, /_nonexistent/);
});

test('더피싱이 3곳 연속 timeout이면 남은 곳은 요청하지 않고 보류한다', async () => {
  const sites = Array.from({ length: 5 }, (_, index) => ({
    id: `fish${index + 1}`,
    name: `더피싱 ${index + 1}`,
    adapter: 'thefishing',
    source: 'detail',
    // 자체 도메인이어도 같은 더피싱 백엔드이므로 하나의 회로로 묶여야 합니다.
    url: `https://boat${index + 1}.example.com/index.php?mid=bk`,
  }));
  const 이전시각 = '2026-09-09T00:00:00.000Z';
  const prevData = {
    generatedAt: 이전시각,
    sites: Object.fromEntries(sites.map((site) => [site.id, { ok: true, at: 이전시각, count: 1 }])),
    trips: sites.map((site) => ({
      siteId: site.id, siteName: site.name, boat: site.name,
      date: '2026-09-11', status: 'open', seatsLeft: 3,
    })),
  };
  const { registryPath, dataPath } = await fixture(sites, prevData);
  let calls = 0;
  const { data } = await runAll({
    registryPath, dataPath, days: 21,
    now: new Date('2026-09-10T00:00:00.000Z'),
    timeoutBackoffHours: 0,
    collectFn: async () => {
      calls += 1;
      throw new Error('30000ms 안에 응답이 없습니다');
    },
  });

  assert.equal(calls, 3, '공통 장애인데 모든 선사를 계속 두드리면 안 됩니다');
  assert.equal(data.sites.fish3.skipped, undefined, '실제로 요청한 세 곳은 실패입니다');
  assert.equal(data.sites.fish4.skipped, 'platform-timeout');
  assert.equal(data.sites.fish5.skipped, 'platform-timeout');
  assert.equal(data.sites.fish4.timeoutStreak, undefined, '요청하지 않은 곳의 연속 실패를 올리면 안 됩니다');
  assert.equal(data.trips.length, 5, '보류해도 직전 출조는 모두 유지해야 합니다');

  // 회로가 막아 보류한 곳은 다음 정기 수집에서 즉시 복구 여부를 시험합니다. 실제 timeout이
  // 난 앞의 세 곳은 기존 사이트별 백오프를 지키고, 나머지는 성공하면 정상 수집으로 돌아옵니다.
  calls = 0;
  const 다음시각 = new Date(Date.parse(data.sites.fish1.at) + 30 * 60 * 1000);
  const recovered = await runAll({
    registryPath, dataPath, days: 21,
    now: 다음시각,
    timeoutBackoffHours: 6,
    collectFn: async () => { calls += 1; return []; },
  });
  assert.equal(calls, 2, '플랫폼 보류는 사이트별 백오프에 갇히면 안 됩니다');
  assert.equal(recovered.data.sites.fish4.ok, true);
  assert.equal(recovered.data.sites.fish5.ok, true);
});

test('죽은 사이트는 직전 결과를 그대로 남긴다', async () => {
  const 어제것 = {
    generatedAt: '2026-09-01T00:00:00.000Z',
    sites: { broken: { ok: true, at: '2026-09-01T00:00:00.000Z', count: 1 } },
    trips: [{ siteId: 'broken', siteName: '깨진곳', boat: '옛날호', date: '2999-12-31', status: 'open', seatsLeft: 3 }],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 어제것);
  const { data } = await runAll({ registryPath, dataPath, days: 21 });

  assert.equal(data.trips.length, 0, '수집 범위 밖 날짜는 정리된다');
  assert.equal(data.sites.broken.ok, false);
  assert.equal(data.sites.broken.keptFrom, '2026-09-01T00:00:00.000Z', '언제 것을 남겼는지 알 수 있어야 한다');
});

test('죽은 사이트의 보존 행도 현재 스키마로 다시 정규화한다', async () => {
  const 예전것 = {
    generatedAt: '2026-09-01T00:00:00.000Z',
    sites: { broken: { ok: true, at: '2026-09-01T00:00:00.000Z', count: 1 } },
    trips: [{
      siteId: 'broken',
      siteName: '깨진곳',
      boat: '피싱마린호',
      date: '2026-09-07',
      species: '쭈꾸미',
      status: 'off',
      statusText: '쭈꾸미 출조 << 정상출조 >> 04시30분까지 매장에 도착해주세요.',
      seatsLeft: 12,
    }],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 예전것);
  const { data } = await runAll({
    registryPath,
    dataPath,
    days: 21,
    now: new Date('2026-09-07T00:00:00+09:00'),
  });

  assert.equal(data.trips.length, 1);
  assert.equal(data.trips[0].species, '주꾸미');
  assert.equal(data.trips[0].status, 'open');
});

test('최근 timeout 실패는 백오프 시간 동안 다시 붙잡지 않고 직전 결과를 남긴다', async () => {
  const 이전시각 = '2026-09-07T00:00:00.000Z';
  const 어제것 = {
    generatedAt: 이전시각,
    sites: {
      broken: {
        ok: false,
        at: 이전시각,
        error: '30000ms 안에 응답이 없습니다 — 최근 timeout이라 2026-09-07T06:00:00.000Z까지 재시도 보류',
        count: 1,
      },
    },
    trips: [{
      siteId: 'broken',
      siteName: '깨진곳',
      boat: '옛날호',
      date: '2026-09-08',
      status: '예약가능',
      seatsLeft: 3,
    }],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 어제것);
  const { data, failed } = await runAll({
    registryPath,
    dataPath,
    days: 21,
    now: new Date('2026-09-07T00:30:00.000Z'),   // 첫 대기(1시간)가 아직 안 지났습니다
    timeoutBackoffHours: 6,
  });

  assert.deepEqual(failed, ['broken']);
  assert.equal(data.trips.length, 1, '직전 행은 그대로 남아야 한다');
  assert.equal(data.sites.broken.skipped, 'timeout-backoff');
  // 첫 timeout은 1시간만 쉽니다. 상한(6시간)을 통째로 쉬면 매시간 도는 수집이 5~6회 헛돕니다.
  assert.equal(data.sites.broken.retryAt, '2026-09-07T01:00:00.000Z');
  assert.match(data.sites.broken.error, /재시도 보류/);
  assert.equal(data.sites.broken.error.match(/재시도 보류/g).length, 1, '보류 문구가 반복되면 안 된다');
});

test('timeout 백오프 시간이 지나면 실제 수집을 다시 시도한다', async () => {
  const 이전시각 = '2026-09-07T00:00:00.000Z';
  const 어제것 = {
    generatedAt: 이전시각,
    sites: { broken: { ok: false, at: 이전시각, error: '30000ms 안에 응답이 없습니다', count: 0 } },
    trips: [],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 어제것);
  const { data } = await runAll({
    registryPath,
    dataPath,
    days: 21,
    now: new Date('2026-09-07T07:00:00.000Z'),
    timeoutBackoffHours: 6,
  });

  assert.equal(data.sites.broken.skipped, undefined);
  assert.match(data.sites.broken.error, /_nonexistent/);
});

// 잠깐 막힌 곳은 금방 돌아오고, 정말 죽은 곳은 매시간 두드리지 않게 합니다.
test('연달아 timeout이 나면 쉬는 시간이 1→2→4시간으로 늘고 상한에서 멈춘다', async () => {
  const 이전시각 = '2026-09-07T00:00:00.000Z';
  const 대기 = async (streak) => {
    const 어제것 = {
      generatedAt: 이전시각,
      sites: { broken: {
        ok: false, at: 이전시각, error: '30000ms 안에 응답이 없습니다', count: 0,
        ...(streak ? { timeoutStreak: streak } : {}),
      } },
      trips: [],
    };
    const { registryPath, dataPath } = await fixture([brokenSite], 어제것);
    const { data } = await runAll({
      registryPath, dataPath, days: 21,
      now: new Date('2026-09-07T00:30:00.000Z'),   // 어느 경우에도 아직 쉬는 중
      timeoutBackoffHours: 6,
    });
    assert.equal(data.sites.broken.skipped, 'timeout-backoff', `streak ${streak}`);
    return data.sites.broken.retryAt;
  };

  assert.equal(await 대기(0), '2026-09-07T01:00:00.000Z', '기록이 없으면 첫 번째로 봅니다');
  assert.equal(await 대기(1), '2026-09-07T01:00:00.000Z');
  assert.equal(await 대기(2), '2026-09-07T02:00:00.000Z');
  assert.equal(await 대기(3), '2026-09-07T04:00:00.000Z');
  assert.equal(await 대기(4), '2026-09-07T06:00:00.000Z', '상한을 넘지 않습니다');
  assert.equal(await 대기(99), '2026-09-07T06:00:00.000Z', '아무리 오래 죽어 있어도 상한입니다');
});

test('연속 timeout 횟수를 세고, 성공하면 다시 0부터 센다', async () => {
  const 이전시각 = '2026-09-07T00:00:00.000Z';
  // 백오프가 끝난 뒤 또 실패하면 2번째입니다.
  const 어제것 = {
    generatedAt: 이전시각,
    sites: { broken: { ok: false, at: 이전시각, error: '30000ms 안에 응답이 없습니다', count: 0, timeoutStreak: 2 } },
    trips: [],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 어제것);
  const { data } = await runAll({
    registryPath, dataPath, days: 21,
    now: new Date('2026-09-07T09:00:00.000Z'),   // 쉬는 시간이 끝나 실제로 다시 붙잡습니다
    timeoutBackoffHours: 6,
  });

  assert.equal(data.sites.broken.skipped, undefined, '쉬는 시간이 끝나면 다시 시도합니다');
  // 이 자리는 DNS 실패(timeout이 아님)라 연속 횟수가 붙지 않습니다.
  assert.match(data.sites.broken.error, /_nonexistent/);
  assert.equal(data.sites.broken.timeoutStreak, undefined, 'timeout이 아닌 실패는 세지 않습니다');
});

test('수집 결과를 파일로 남긴다', async () => {
  const { registryPath, dataPath } = await fixture([mockSite]);
  await runAll({ registryPath, dataPath, days: 21 });

  const saved = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.ok(saved.generatedAt);
  assert.equal(saved.sites.mock.platform, '예시', '계열 꼬리표가 같이 저장된다');
  // 서버 없는 GitHub Pages의 관리 페이지는 registry를 못 읽습니다. 여기 실려야 표에 나옵니다.
  assert.equal(saved.sites.mock.url, mockSite.url, '주소가 같이 저장된다');
  assert.ok('port' in saved.sites.mock && 'phone' in saved.sites.mock, '항구·전화 자리는 없어도 키는 있어야 한다');
  assert.ok(saved.trips.every((t) => t.date >= saved.trips[0].date), '날짜순으로 정렬된다');
});

test('dryRun이면 파일을 건드리지 않는다', async () => {
  const { registryPath, dataPath } = await fixture([mockSite]);
  const { data } = await runAll({ registryPath, dataPath, days: 21, dryRun: true });

  assert.ok(data.trips.length > 0);
  await assert.rejects(readFile(dataPath, 'utf8'), '파일이 생기면 안 된다');
});
