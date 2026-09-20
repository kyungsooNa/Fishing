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

test('먼 일정은 7일 창을 순환하며 별도 파일에 90일까지 쌓는다', async () => {
  const site = {
    id: 'farfish', name: '먼바다호', adapter: 'thefishing', source: 'detail',
    url: 'https://farfish.thefishing.kr/index.php?mid=bk',
  };
  const { registryPath, dataPath } = await fixture([site]);
  const futureDataPath = join(tmpdir(), `future-${Date.now()}-${Math.random()}.json`);
  const calls = [];
  const collectFn = async (request) => {
    calls.push({ days: request.days, startDay: request.startDay });
    const date = request.startDay === 22 ? '2026-10-02'
      : request.startDay === 29 ? '2026-10-09' : '2026-09-15';
    return [{
      siteId: request.id, siteName: request.name, boat: '먼바다호', date,
      status: 'open', seatsLeft: 3, port: '충남 보령 오천항', phone: '010-0000-0000',
    }];
  };
  const options = {
    registryPath, dataPath, futureDataPath, collectFn,
    days: 21, horizonDays: 90, farWindowDays: 7,
    now: new Date('2026-09-10T00:00:00+09:00'), rotatePerRun: {},
  };

  await runAll(options);
  let future = JSON.parse(await readFile(futureDataPath, 'utf8'));
  assert.deepEqual(calls, [{ days: 21, startDay: undefined }, { days: 7, startDay: 22 }]);
  assert.equal(future.cursors.farfish, 29);
  assert.deepEqual(future.trips.map((trip) => trip.date), ['2026-10-02']);

  calls.length = 0;
  await runAll(options);
  future = JSON.parse(await readFile(futureDataPath, 'utf8'));
  assert.deepEqual(calls, [{ days: 21, startDay: undefined }, { days: 7, startDay: 29 }]);
  assert.equal(future.cursors.farfish, 36);
  assert.deepEqual(future.trips.map((trip) => trip.date), ['2026-10-02', '2026-10-09'],
    '새 창을 받을 때 앞서 받은 먼 일정을 버리지 않습니다');
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

test('수집 실패로 이전 결과를 보존해도 registry 제외 배는 되살리지 않는다', async () => {
  const site = { ...brokenSite, excludeBoats: ['흑돼지호'] };
  const 이전시각 = '2026-09-09T00:00:00.000Z';
  const prevData = {
    generatedAt: 이전시각,
    sites: { broken: { ok: true, at: 이전시각, count: 2 } },
    trips: [
      { siteId: 'broken', siteName: '깨진곳', boat: '흑돼지호', date: '2026-09-11', status: 'unknown', seatsLeft: null },
      { siteId: 'broken', siteName: '깨진곳', boat: '남길호', date: '2026-09-11', status: 'open', seatsLeft: 3 },
    ],
  };
  const { registryPath, dataPath } = await fixture([site], prevData);

  const { data } = await runAll({
    registryPath,
    dataPath,
    days: 21,
    now: new Date('2026-09-10T00:00:00+09:00'),
  });

  assert.deepEqual(data.trips.map((trip) => trip.boat), ['남길호']);
  assert.equal(data.sites.broken.count, 1, '보존 상태의 건수도 실제 남은 행과 같아야 합니다');
});

test('수집 보류로 이전 결과를 보존해도 공지사항 오탐은 되살리지 않는다', async () => {
  const 이전시각 = '2026-09-09T00:00:00.000Z';
  const prevData = {
    generatedAt: 이전시각,
    sites: { broken: { ok: true, at: 이전시각, count: 2 } },
    trips: [
      {
        siteId: 'broken', siteName: '오천항 유진호', boat: '오천항 유진호',
        date: '2026-09-19', departAt: '20:00', status: 'open', statusText: '공지사항', seatsLeft: 20,
      },
      {
        siteId: 'broken', siteName: '오천항 유진호', boat: '유진호',
        date: '2026-09-19', status: 'closed', statusText: '유진호(EUGENE)', seatsLeft: 0,
      },
    ],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], prevData);

  const { data } = await runAll({
    registryPath,
    dataPath,
    days: 21,
    now: new Date('2026-09-14T00:00:00+09:00'),
  });

  assert.deepEqual(data.trips.map((trip) => trip.boat), ['유진호']);
  assert.equal(data.sites.broken.count, 1);
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

test('계속 실패하는 사이트의 keptFrom은 앞으로 밀리지 않는다', async () => {
  // 실패가 이어지면 keptFrom을 직전 "시도" 시각으로 덮어써서, 며칠 묵은 값이 방금 확인한
  // 것처럼 보였습니다. 한솔호가 9/13부터 한 번도 성공 못 했는데 화면에는 "0.8시간 전"으로
  // 떴습니다 — 취소석 레이더에서 이건 없는 자리를 예약가능으로 보여주는 것과 같습니다.
  const 성공한때 = '2026-09-01T00:00:00.000Z';
  const 어제것 = {
    generatedAt: 성공한때,
    sites: { broken: { ok: true, at: 성공한때, count: 1 } },
    trips: [{ siteId: 'broken', siteName: '깨진곳', boat: '옛날호', date: '2999-12-31', status: 'open', seatsLeft: 3 }],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 어제것);

  const 첫실패 = await runAll({ registryPath, dataPath, days: 21 });
  assert.equal(첫실패.data.sites.broken.keptFrom, 성공한때);

  // 같은 이유로 또 실패합니다. 화면에 실린 값은 여전히 9월 1일 것입니다.
  const 두번째 = await runAll({ registryPath, dataPath, days: 21 });
  assert.equal(두번째.data.sites.broken.keptFrom, 성공한때,
    '두 번째 실패에도 값의 나이는 그대로여야 합니다');

  const 세번째 = await runAll({ registryPath, dataPath, days: 21 });
  assert.equal(세번째.data.sites.broken.keptFrom, 성공한때,
    '실패가 이어져도 값의 나이는 계속 그대로여야 합니다');
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

// 선상24가 2026-09-17 08시부터 IP당 요청량을 막습니다. 8번 실행 전부 27~31곳에서 405로
// 끊기고, 그 뒤 22분을 10.6초 간격으로 물어도 성공이 0곳이었습니다 — 간격을 늘려 풀리는
// 종류가 아닙니다. 그래서 한 실행에 도는 수를 줄이고 다음 실행에서 이어 봅니다. 안 그러면
// 앞쪽 몇 곳만 매시간 갱신되고 나머지는 **영원히** 안 갱신됩니다.
test('차례를 나눠 돌고, 다음 실행은 이어서 본다', async () => {
  const sites = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    ...mockSite, id, url: `https://${id}.shared.example`,
  }));
  const { registryPath, dataPath } = await fixture(sites);
  const rotatePerRun = { 'shared.example': 2 };

  const first = await runAll({ registryPath, dataPath, days: 21, rotatePerRun });
  const seen = (d) => Object.entries(d.sites).filter(([, s]) => s.ok).map(([id]) => id);
  const held = (d) => Object.entries(d.sites).filter(([, s]) => s.skipped === 'rotation').map(([id]) => id);

  assert.deepEqual(seen(first.data), ['a', 'b'], '이번 차례만 봅니다');
  assert.deepEqual(held(first.data), ['c', 'd', 'e'], '나머지는 보류입니다 — 실패가 아닙니다');
  assert.equal(first.data.rotation['shared.example'], 'b', '어디까지 봤는지 남깁니다');

  const second = await runAll({ registryPath, dataPath, days: 21, rotatePerRun });
  assert.deepEqual(seen(second.data), ['c', 'd'], '다음 실행은 이어서 봅니다');

  // 저장은 **registry 순서**입니다(본 순서가 아닙니다 — diff가 매번 뒤집히지 않도록).
  // 그래서 여기서는 "무엇을 봤나"만 보고, 어디서 멈췄는지는 커서로 확인합니다.
  const third = await runAll({ registryPath, dataPath, days: 21, rotatePerRun });
  assert.deepEqual(seen(third.data).sort(), ['a', 'e'], '끝에 닿으면 처음으로 돌아옵니다');
  assert.equal(third.data.rotation['shared.example'], 'a', '한 바퀴 돌아 a에서 멈춥니다');
});

// 미룬 곳이 화면에서 사라지면 "배가 없어졌다"로 보입니다. 연속 timeout 보류와 같은 규칙입니다.
test('차례가 아닌 곳은 직전 결과를 그대로 남긴다', async () => {
  const sites = ['a', 'b'].map((id) => ({ ...mockSite, id, url: `https://${id}.shared.example` }));
  const { registryPath, dataPath } = await fixture(sites);
  const rotatePerRun = { 'shared.example': 1 };

  const first = await runAll({ registryPath, dataPath, days: 21, rotatePerRun });
  const bTrips = first.data.trips.filter((t) => t.siteId === 'b').length;
  assert.equal(bTrips, 0, '첫 실행에서 b는 아직 차례가 아닙니다');

  const second = await runAll({ registryPath, dataPath, days: 21, rotatePerRun });
  assert.ok(second.data.trips.some((t) => t.siteId === 'b'), '두 번째 실행에서 b를 봅니다');

  const third = await runAll({ registryPath, dataPath, days: 21, rotatePerRun });
  assert.ok(third.data.trips.some((t) => t.siteId === 'b'),
    'b가 차례를 넘겨도 직전 출조는 화면에 남아야 합니다');
  assert.equal(third.data.sites.b.skipped, 'rotation');
  assert.equal(third.data.sites.b.ok, false);
  assert.ok(third.data.sites.b.keptFrom, '지금 실린 값이 언제 것인지 같이 남깁니다');
});

// 관리 화면의 "선사 최신화"는 한 곳만 다시 봅니다. 거기서 차례를 따지면 누른 사람이
// 아무 일도 안 일어나는 것을 봅니다. 전체 차례도 그 한 번에 되감기면 안 됩니다.
test('한 곳만 다시 보는 길은 차례를 따지지 않고, 전체 차례도 안 건드린다', async () => {
  const sites = ['a', 'b', 'c'].map((id) => ({ ...mockSite, id, url: `https://${id}.shared.example` }));
  const { registryPath, dataPath } = await fixture(sites);
  const rotatePerRun = { 'shared.example': 1 };

  await runAll({ registryPath, dataPath, days: 21, rotatePerRun });          // a
  const before = JSON.parse(await readFile(dataPath, 'utf8')).rotation['shared.example'];

  const one = await runAll({ registryPath, dataPath, days: 21, rotatePerRun, only: 'c' });
  assert.equal(one.data.sites.c.ok, true, '차례와 상관없이 봅니다');
  assert.equal(one.data.rotation['shared.example'], before, '전체 차례는 그대로입니다');
});

// 회전을 거는 **열쇠**는 사람이 적은 문자열이 아니라 `gapKey`가 내는 값이어야 합니다.
// 'thefishing.co.kr'이나 'ssfish.thefishing.kr'처럼 한 글자만 어긋나도 조용히 아무 곳에도
// 안 걸리고, 그러면 109곳이 그대로 매시간 다시 돕니다 — 실패가 아니라 **무효**라 로그에도
// 안 남습니다. 그래서 registry의 진짜 주소로 열쇠를 만들어 맞춰 봅니다.
//
// 더피싱을 넣은 이유는 선상24와 같습니다: 09-19 05:31~22:57 줄곧 0/109였고, 유일한 부분
// 성공이 01:25의 31/109로 선상24에서 잰 27~31과 같은 띠였습니다(core/runner.js).
test('회전 기본값은 두 플랫폼 서버에 gapKey 열쇠로 걸린다', async () => {
  const { ROTATE_PER_RUN } = await import('../core/runner.js');
  const { gapKey } = await import('../core/fetcher.js');

  const registry = JSON.parse(await readFile('sites/registry.json', 'utf8'));
  const sites = registry.sites ?? registry;
  const keyOf = (id) => gapKey(sites.find((s) => s.id === id).url);

  // 두 플랫폼에서 실제로 쓰는 주소로 열쇠를 만듭니다.
  assert.equal(keyOf('plus'), 'thefishing.kr');
  assert.equal(keyOf('nara'), 'sunsang24.com');

  assert.equal(ROTATE_PER_RUN[keyOf('plus')], 25, '더피싱도 한 실행에 25곳입니다');
  assert.equal(ROTATE_PER_RUN[keyOf('nara')], 25, '선상24는 그대로 25곳입니다');
});
