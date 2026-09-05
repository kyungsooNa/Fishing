import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitor, WATCH_MS, FULL_MS } from '../core/monitor.js';
import { acquireCollectorLock } from '../core/collector-lock.js';
import { tripKey } from '../core/schema.js';
import { createApp } from '../serve.js';

const date = '2026-09-05';
const a = { id: 'a', name: 'A', adapter: '_mock', url: 'https://a.example.com' };
const b = { ...a, id: 'b', name: 'B', url: 'https://b.example.com' };
const trip = (siteId = 'a', seatsLeft = 0) => ({ siteId, boat: '테스트호', date, departAt: '23:00',
  status: seatsLeft ? 'open' : 'closed', seatsLeft });

async function fixture({ sites = [a], collect, send, baseTrips = [trip()] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-'));
  let now = Date.parse('2026-09-05T00:00:00Z');
  const dataPath = join(dir, 'data.json');
  const statePath = join(dir, 'state.json');
  await writeFile(dataPath, JSON.stringify({ trips: baseTrips, sites: {
    a: { ok: true, at: '2026-09-04T00:00:00Z', count: 1 },
  } }));
  const opts = { dataPath, statePath, readRegistry: async () => sites, clock: () => now,
    collect: collect ?? (async (s) => [trip(s.id)]), send: send ?? (async () => {}) };
  const monitor = createMonitor(opts);
  await monitor.init();
  return { monitor, opts, dir, advance: (ms) => { now += ms; } };
}

test('관심 출조는 3분, 나머지는 60분에 확인하고 변경만 즉시 알린다', async () => {
  let seats = 0;
  const calls = [], notices = [];
  const f = await fixture({ sites: [a, { ...b, url: 'https://other.net' }],
    collect: async (s) => { calls.push(s.id); return [trip(s.id, seats)]; },
    send: async (o) => notices.push(o) });
  await f.monitor.setWatch(tripKey(trip()), true);
  await f.monitor.tick(); await f.monitor.idle();
  assert.deepEqual(calls.sort(), ['a', 'b']);
  assert.equal(notices.length, 0, '처음은 비교 기준');
  seats = 2;
  f.advance(WATCH_MS - 1);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(calls.length, 2);
  f.advance(1);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(calls.at(-1), 'a');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0].reason, 'reopened');
  assert.equal(f.monitor.data().trips.find((t) => t.siteId === 'a').seatsLeft, 2);
  f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(notices.length, 1, '같은 잔여석은 다시 알리지 않는다');
  f.advance(FULL_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(calls.filter((id) => id === 'b').length, 2);
});

test('같은 플랫폼은 겹치지 않고 관심 선사를 다음 순서로 우선한다', async () => {
  let release;
  const calls = [];
  const f = await fixture({ sites: [a, b], baseTrips: [trip('a'), trip('b')],
    collect: async (s) => {
      calls.push(s.id);
      if (s.id === 'b') await new Promise((r) => { release = r; });
      return [trip(s.id)];
    } });
  await f.monitor.setWatch(tripKey(trip('b')), true);
  await f.monitor.tick();
  await f.monitor.tick();
  assert.deepEqual(calls, ['b']);
  release(); await f.monitor.idle();
  await f.monitor.tick(); await f.monitor.idle();
  assert.deepEqual(calls, ['b', 'a']);
});

test('수집 실패는 이전 좌석과 확인 시각을 보존하고 재시도 간격을 늘린다', async () => {
  let failing = false, calls = 0, notices = 0;
  const f = await fixture({ collect: async () => {
    calls++; if (failing) throw new Error('timeout'); return [trip('a', 2)];
  }, send: async () => { notices++; } });
  await f.monitor.setWatch(tripKey(trip()), true);
  await f.monitor.tick(); await f.monitor.idle();
  const at = f.monitor.data().sites.a.at;
  failing = true; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(f.monitor.data().sites.a.ok, false);
  assert.equal(f.monitor.data().sites.a.keptFrom, at);
  assert.equal(f.monitor.data().trips[0].seatsLeft, 2);
  f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(calls, 2);
  f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(calls, 3);
  assert.equal(f.monitor.data().sites.a.keptFrom, at);
  assert.equal(notices, 0);
});

test('감시와 비교 기준이 재시작 후 남고, 감시 해제와 지난 출조는 3분 대상에서 빠진다', async () => {
  const f = await fixture();
  await f.monitor.setWatch(tripKey(trip()), true);
  await f.monitor.tick(); await f.monitor.idle();
  const resumed = createMonitor(f.opts); await resumed.init();
  assert.equal(resumed.status().watches.length, 1);
  assert.equal(resumed.data().trips.length, 1);
  await resumed.setWatch(tripKey(trip()), false);
  assert.equal(resumed.status().watches.length, 0);
  await resumed.setWatch(tripKey(trip()), true);
  f.advance(24 * FULL_MS);
  assert.equal(resumed.status().watches.length, 0);
  assert.equal(resumed.data().trips.length, 0);
});

test('통합된 과거 최대 좌석을 새 원문에 섞지 않고, 다른 선사 결과는 유지한다', async () => {
  const merged = { ...trip('a', 9), sources: [{ siteId: 'a', seatsLeft: 9 }, { siteId: 'b', seatsLeft: 1 }] };
  const f = await fixture({ sites: [a, b, { ...a, id: 'c' }], baseTrips: [merged, trip('c', 3)],
    collect: async (s) => [trip(s.id, 1)] });
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(f.monitor.data().trips.find((t) => t.siteId === 'a').seatsLeft, 1);
  assert.equal(f.monitor.data().trips.find((t) => t.siteId === 'c').seatsLeft, 3);
});

test('알림 채널 실패가 성공한 수집을 실패로 바꾸지 않는다', async () => {
  let seats = 0;
  const f = await fixture({ collect: async () => [trip('a', seats)], send: async () => { throw new Error('offline'); } });
  await f.monitor.setWatch(tripKey(trip()), true);
  await f.monitor.tick(); await f.monitor.idle();
  seats = 1; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(f.monitor.data().sites.a.ok, true);
  assert.equal(f.monitor.data().trips[0].seatsLeft, 1);
});

test('로컬 API는 헤더를 검사하고 감시 결과를 제공하며 원래 data.json은 보존한다', async () => {
  const f = await fixture();
  const before = await readFile(f.opts.dataPath, 'utf8');
  const server = createApp({ root: f.dir, monitor: f.monitor });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ key: tripKey(trip()), enabled: true });
    assert.equal((await fetch(base + '/api/monitor', { method: 'POST', body })).status, 403);
    const res = await fetch(base + '/api/monitor', { method: 'POST', body,
      headers: { 'X-Admin': '1', 'Content-Type': 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).watches.length, 1);
    const invalid = await fetch(base + '/api/monitor', { method: 'POST',
      headers: { 'X-Admin': '1' }, body: JSON.stringify({ key: 'fake', enabled: true }) });
    assert.equal(invalid.status, 400);
    await f.monitor.tick(); await f.monitor.idle();
    assert.equal((await fetch(base + '/data.json').then((r) => r.json())).sites.a.ok, true);
    assert.equal(await readFile(f.opts.dataPath, 'utf8'), before);
    const res2 = await fetch(base + '/api/collect', { method: 'POST', headers: { 'X-Admin': '1' } });
    assert.equal(res2.status, 202);
    assert.equal(f.monitor.status().running, true);
  } finally { await f.monitor.stop(); server.close(); }
});

test('별도 수집 프로세스의 동시 실행은 잠금으로 막는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-lock-'));
  const path = join(dir, 'lock');
  const release = await acquireCollectorLock(path);
  await assert.rejects(acquireCollectorLock(path), /이미 실행 중/);
  await release();
  await (await acquireCollectorLock(path))();
});
