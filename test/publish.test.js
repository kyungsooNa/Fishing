// 국내 PC 수집을 main에 얹는 길(publish.js). 받는 동안 main이 움직여도 그 사이 다른 선사의
// 값을 되돌리지 않는지, 묵은 로컬 값으로 새 값을 덮지 않는지가 핵심입니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAll } from '../core/runner.js';
import {
  createRecorder, domesticTargets, fetchedOk, monitorSource, stampFetchTimes,
} from '../core/publish.js';

const NOW = new Date('2026-10-13T09:00:00+09:00');
const trip = (siteId, date, seats) => ({
  siteId, boat: siteId, date, time: '05:00', seats, seatsTotal: 20, status: 'open',
  url: `https://${siteId}.example.com`,
});

const sites = [
  { id: 'fish', name: '더피싱배', adapter: 'thefishing', url: 'https://fish.thefishing.kr', source: 'detail' },
  { id: 'home', name: '국내전용', adapter: 'generic', url: 'https://home.example.kr', domesticOnly: true },
  { id: 'sun', name: '선상배', adapter: 'sunsang24', url: 'https://sun.sunsang24.com' },
  { id: 'off', name: '꺼진배', adapter: 'thefishing', url: 'https://off.thefishing.kr', enabled: false },
];

async function fixture(prev) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-'));
  const registryPath = join(dir, 'registry.json');
  const dataPath = join(dir, 'data.json');
  await writeFile(registryPath, JSON.stringify({ sites }));
  await writeFile(dataPath, JSON.stringify(prev));
  return { registryPath, dataPath };
}

test('국내에서 받을 선사는 켜진 더피싱과 국내 전용뿐이다', () => {
  assert.deepEqual(domesticTargets(sites), ['fish', 'home']);
});

test('받는 동안 main이 움직여도 다른 선사의 새 값을 되돌리지 않는다', async () => {
  const before = {
    generatedAt: '2026-10-13T00:00:00Z',
    rotation: { 'sunsang24.com': 'a' },
    sites: { sun: { ok: true, at: '2026-10-13T00:00:00Z', count: 1 } },
    trips: [trip('sun', '2026-10-14', 3)],
  };
  const first = await fixture(before);
  let clock = new Date('2026-10-13T00:05:00Z');
  const recorder = createRecorder(async (site) => {
    if (site.id === 'home') throw new Error('timeout');
    return [trip(site.id, '2026-10-15', 7)];
  }, () => clock);
  const ids = domesticTargets(sites);
  const { data: probe } = await runAll({
    ...first, onlyIds: ids, days: 21, now: NOW, dryRun: true, overseas: false,
    timeoutBackoffHours: 0, collectFn: recorder.record,
  });
  assert.equal(fetchedOk(probe, recorder.times), 1);

  // 20분 뒤 Actions가 선상24를 새로 받아 main에 올렸습니다.
  const after = {
    ...before,
    rotation: { 'sunsang24.com': 'b' },
    sites: { sun: { ok: true, at: '2026-10-13T00:20:00Z', count: 1 } },
    trips: [trip('sun', '2026-10-14', 1)],
  };
  const latest = await fixture(after);
  clock = new Date('2026-10-13T00:30:00Z');
  const { data } = await runAll({
    ...latest, onlyIds: ids, days: 21, now: NOW, dryRun: true, overseas: false,
    timeoutBackoffHours: 0, collectFn: async (site) => {
      if (site.id === 'sun') assert.fail('선상24는 다시 받지 않습니다');
      return recorder.replay(site);
    },
  });
  stampFetchTimes(data, recorder.times);

  assert.deepEqual(data.sites.sun, after.sites.sun, '그 사이 올라온 선상24 상태가 그대로입니다');
  assert.equal(data.trips.find((t) => t.siteId === 'sun').seats, 1, '선상24 출조도 새 값 그대로입니다');
  assert.equal(data.rotation['sunsang24.com'], 'b', '선상24 회전 위치를 되돌리지 않습니다');
  assert.equal(data.trips.find((t) => t.siteId === 'fish').seats, 7, '받아둔 더피싱 값이 실립니다');
  assert.equal(data.sites.fish.at, '2026-10-13T00:05:00.000Z', '확인 시각은 조립 때가 아니라 받은 때입니다');
  assert.equal(data.sites.home.ok, false, '받지 못한 곳은 실패로 남습니다');
  assert.deepEqual(data.collection.scope, { type: 'sites', value: 2 });
});

test('기록에 없는 요청만 실제로 다시 받는다', async () => {
  let calls = 0;
  const recorder = createRecorder(async () => { calls += 1; return []; });
  await recorder.record({ id: 'a', days: 21 });
  await recorder.replay({ days: 21, id: 'a' });
  assert.equal(calls, 1, '키 순서만 다른 같은 요청은 기록으로 답합니다');
  await recorder.replay({ id: 'a', days: 7, startDay: 22 });
  assert.equal(calls, 2);
});

test('로컬 서버 값은 main보다 새로 받은 선사만 올린다', async () => {
  const state = {
    records: {
      fish: { status: { ok: true, at: '2026-10-13T00:10:00Z', count: 1 }, trips: [trip('fish', '2026-10-15', 4)] },
      home: { status: { ok: true, at: '2026-10-12T00:00:00Z', count: 1 }, trips: [trip('home', '2026-10-15', 2)] },
    },
    futureTrips: [trip('fish', '2026-11-20', 9)],
  };
  const base = {
    sites: {
      fish: { ok: false, at: '2026-10-13T00:30:00Z', keptFrom: '2026-10-04T23:07:00Z', skipped: 'platform-timeout' },
      home: { ok: true, at: '2026-10-12T12:00:00Z' },
    },
  };
  const source = monitorSource(state, base, ['fish', 'home']);
  assert.deepEqual(source.ids, ['fish'], '보류 상태는 시도 시각이 아니라 마지막 성공 시각과 비교합니다');
  assert.equal(source.times.get('fish'), '2026-10-13T00:10:00Z');
  assert.equal((await source.collect({ id: 'fish', days: 21 }))[0].seats, 4);
  assert.equal((await source.collect({ id: 'fish', days: 7, startDay: 22 }))[0].date, '2026-11-20');
});

test('runAll은 dryRun이어도 먼 일정 파일 내용을 돌려준다', async () => {
  const { registryPath, dataPath } = await fixture({ sites: {}, trips: [] });
  const futureDataPath = join(await mkdtemp(join(tmpdir(), 'publish-future-')), 'future.json');
  const { future } = await runAll({
    registryPath, dataPath, futureDataPath, onlyIds: ['fish'], days: 21, horizonDays: 90,
    now: NOW, dryRun: true, collectFn: async () => [],
  });
  assert.equal(future.horizonDays, 90);
  assert.ok(Array.isArray(future.trips));
});
