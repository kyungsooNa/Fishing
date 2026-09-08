import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitor, WATCH_MS, FULL_MS } from '../core/monitor.js';
import { acquireCollectorLock } from '../core/collector-lock.js';
import { tripKey } from '../core/schema.js';
import { createApp } from '../serve.js';

// 감시 목록은 사람마다 따로입니다(core/watchers.js). 서버가 받는 것은 토큰이 아니라
// 그 해시라, 여기서는 아무 문자열이나 열쇠로 씁니다.
const ME = 'watcher-me';
const YOU = 'watcher-you';

const date = '2026-09-05';
const a = { id: 'a', name: 'A', adapter: '_mock', url: 'https://a.example.com' };
const b = { ...a, id: 'b', name: 'B', url: 'https://b.example.com' };
const trip = (siteId = 'a', seatsLeft = 0) => ({ siteId, boat: '테스트호', date, departAt: '23:00',
  status: seatsLeft ? 'open' : 'closed', seatsLeft });

async function fixture({ sites = [a], collect, send, writeAlerts, baseTrips = [trip()] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-'));
  let now = Date.parse('2026-09-05T00:00:00Z');
  const dataPath = join(dir, 'data.json');
  const statePath = join(dir, 'state.json');
  await writeFile(dataPath, JSON.stringify({ trips: baseTrips, sites: {
    a: { ok: true, at: '2026-09-04T00:00:00Z', count: 1 },
  } }));
  // 알림 이력은 기본값이 tmp/alerts.jsonl이라 그냥 두면 테스트가 레포에 파일을 씁니다.
  const alerts = [];
  const opts = { dataPath, statePath, readRegistry: async () => sites, clock: () => now,
    collect: collect ?? (async (s) => [trip(s.id)]), send: send ?? (async () => {}),
    writeAlerts: writeAlerts ?? (async (records) => { alerts.push(...records); }) };
  const monitor = createMonitor(opts);
  await monitor.init();
  return { monitor, opts, dir, alerts, advance: (ms) => { now += ms; } };
}

test('관심 출조는 3분, 나머지는 60분에 확인하고 변경만 즉시 알린다', async () => {
  let seats = 0;
  const calls = [], notices = [];
  const f = await fixture({ sites: [a, { ...b, url: 'https://other.net' }],
    collect: async (s) => { calls.push(s.id); return [trip(s.id, seats)]; },
    send: async (o) => notices.push(o) });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
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
  await f.monitor.setWatch(tripKey(trip('b')), true, ME);
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
  await f.monitor.setWatch(tripKey(trip()), true, ME);
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
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.tick(); await f.monitor.idle();
  const resumed = createMonitor(f.opts); await resumed.init();
  assert.equal(resumed.status(ME).watches.length, 1);
  assert.equal(resumed.data().trips.length, 1);
  await resumed.setWatch(tripKey(trip()), false, ME);
  assert.equal(resumed.status(ME).watches.length, 0);
  await resumed.setWatch(tripKey(trip()), true, ME);
  f.advance(24 * FULL_MS);
  assert.equal(resumed.status(ME).watches.length, 0);
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
  await f.monitor.setWatch(tripKey(trip()), true, ME);
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
    const token = 'watcher-token-0123456789';
    const headers = { 'X-Admin': '1', 'X-Watcher': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/monitor', { method: 'POST', body })).status, 403);

    // 누가 거는 감시인지 모르면 걸지 않습니다 — 목록이 한 벌로 섞입니다.
    const anonymous = await fetch(base + '/api/monitor', { method: 'POST', body,
      headers: { 'X-Admin': '1', 'Content-Type': 'application/json' } });
    assert.equal(anonymous.status, 400);

    const res = await fetch(base + '/api/monitor', { method: 'POST', body, headers });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).watches.length, 1);

    // 다른 브라우저에는 그 감시가 보이지 않습니다.
    const other = await fetch(base + '/api/monitor',
      { headers: { 'X-Admin': '1', 'X-Watcher': 'another-token-0123456789' } }).then((r) => r.json());
    assert.deepEqual(other.watches, [], '남의 목록은 응답에 싣지 않습니다');

    const invalid = await fetch(base + '/api/monitor', { method: 'POST',
      headers, body: JSON.stringify({ key: 'fake', enabled: true }) });
    assert.equal(invalid.status, 400);
    await f.monitor.tick(); await f.monitor.idle();
    assert.equal((await fetch(base + '/data.json').then((r) => r.json())).sites.a.ok, true);
    assert.equal(await readFile(f.opts.dataPath, 'utf8'), before);
    const res2 = await fetch(base + '/api/collect', { method: 'POST', headers: { 'X-Admin': '1' } });
    assert.equal(res2.status, 202);
    assert.equal(f.monitor.status(ME).running, true);
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

// 3분 주기가 값어치가 있는지는 이력으로만 확인됩니다 — 감시 주기를 줄일지 말지의 근거입니다.
test('관심 출조에서 자리를 잡으면 지연 상한과 알림 결과를 이력에 남긴다', async () => {
  let seats = 0;
  const f = await fixture({
    collect: async (s) => [trip(s.id, seats)],
    send: async () => ({ attempted: ['telegram'], sent: ['telegram'], failed: [] }),
  });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.tick(); await f.monitor.idle();
  assert.deepEqual(f.alerts, [], '처음은 비교 기준이라 남길 것이 없습니다');

  seats = 2;
  f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();

  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0].reason, 'reopened');
  assert.equal(f.alerts[0].delayMaxMs, WATCH_MS, '직전 확인이 3분 전이면 지연 상한도 3분입니다');
  assert.deepEqual(f.alerts[0].notify.sent, ['telegram']);
});

test('알림이 실패해도 이력은 남는다', async () => {
  let seats = 0;
  const f = await fixture({
    collect: async (s) => [trip(s.id, seats)],
    send: async () => { throw new Error('네트워크 끊김'); },
  });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.tick(); await f.monitor.idle();
  seats = 2;
  f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();

  assert.equal(f.alerts.length, 1, '알림이 막힌 것이야말로 남아야 하는 기록입니다');
  assert.equal(f.alerts[0].notify.failed[0].error, '네트워크 끊김');
});

// ── 사람마다 다른 감시 목록 ─────────────────────────────────────────────────
test('다른 사람의 감시는 내 목록에 안 보이고, 내가 해제할 수도 없다', async () => {
  const f = await fixture({ sites: [a, b], baseTrips: [trip('a'), trip('b')] });
  await f.monitor.setWatch(tripKey(trip('a')), true, ME);
  await f.monitor.setWatch(tripKey(trip('b')), true, YOU);

  assert.deepEqual(f.monitor.status(ME).watches.map((w) => w.siteId), ['a']);
  assert.deepEqual(f.monitor.status(YOU).watches.map((w) => w.siteId), ['b']);
  assert.deepEqual(f.monitor.status(null).watches, [], '누군지 모르면 아무 목록도 안 줍니다');

  // 남의 감시를 끄려고 해도 내 목록에 없으니 아무 일도 일어나지 않습니다.
  await f.monitor.setWatch(tripKey(trip('b')), false, ME);
  assert.deepEqual(f.monitor.status(YOU).watches.map((w) => w.siteId), ['b'], '남의 목록은 그대로입니다');
});

test('수집 주기는 모두의 감시를 합쳐 정한다', async () => {
  const calls = [];
  const f = await fixture({ sites: [a, { ...b, url: 'https://other.net' }], baseTrips: [trip('a'), trip('b')],
    collect: async (s) => { calls.push(s.id); return [trip(s.id)]; } });
  await f.monitor.setWatch(tripKey(trip('b')), true, YOU);   // 내가 아니라 남이 건 감시
  await f.monitor.tick(); await f.monitor.idle();
  calls.length = 0;

  f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.deepEqual(calls, ['b'], '누가 걸었든 3분마다 봅니다 — 받아온 결과는 다 같이 씁니다');
});

test('누가 거는 감시인지 모르면 걸지 않는다', async () => {
  const f = await fixture();
  await assert.rejects(f.monitor.setWatch(tripKey(trip()), true), /브라우저 식별자/);
  await assert.rejects(f.monitor.setWatch(tripKey(trip()), true, null), /브라우저 식별자/);
});

test('상한은 사람마다 센다 — 남이 채워도 나는 걸 수 있다', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ ...trip('a'), boat: `배${i}` }));
  const f = await fixture({ baseTrips: [...many, trip('a')] });
  for (const t of many) await f.monitor.setWatch(tripKey(t), true, YOU);

  await assert.rejects(f.monitor.setWatch(tripKey(trip()), true, YOU), /최대 50개/);
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  assert.equal(f.monitor.status(ME).watches.length, 1, '남이 다 채워도 내 자리는 남아 있습니다');
});

// 사용자 구분이 없던 시절의 파일에는 주인 없는 목록이 남아 있습니다. 그때 서버는 루프백
// 전용이라 주인은 이 PC를 쓰던 사람 하나뿐이었습니다. 그 사람에게만, 한 번만 넘깁니다.
test('예전 감시 목록은 로컬 화면이 처음 붙을 때 그 사람에게 넘어간다', async () => {
  const f = await fixture();
  await writeFile(f.opts.statePath, JSON.stringify({ watches: [trip()], records: {} }));
  const resumed = createMonitor(f.opts); await resumed.init();

  assert.deepEqual(resumed.status(ME).watches, [], '넘기기 전에는 아무에게도 안 보입니다');
  assert.equal(await resumed.adopt(ME), true);
  assert.equal(resumed.status(ME).watches.length, 1);

  assert.equal(await resumed.adopt(YOU), false, '한 번 넘어가면 다음 사람은 못 가져갑니다');
  assert.deepEqual(resumed.status(YOU).watches, []);

  // 넘어간 목록은 파일에도 사람별로 남습니다.
  const saved = JSON.parse(await readFile(f.opts.statePath, 'utf8'));
  assert.equal('watches' in saved, false);
  assert.equal(saved.watchers[ME].length, 1);
});

test('바깥에서 온 요청에는 예전 목록을 넘기지 않는다', async () => {
  const f = await fixture();
  await writeFile(f.opts.statePath, JSON.stringify({ watches: [trip()], records: {} }));
  const resumed = createMonitor(f.opts); await resumed.init();

  assert.equal(await resumed.adopt(YOU, { local: false }), false, '남의 감시를 통째로 가져가게 됩니다');
  assert.deepEqual(resumed.status(YOU).watches, []);
  assert.equal(await resumed.adopt(ME), true, '로컬 화면은 그대로 받습니다');
});

test('주인 없는 예전 목록도 그동안은 계속 감시한다', async () => {
  const calls = [];
  const f = await fixture({ sites: [a, { ...b, url: 'https://other.net' }], baseTrips: [trip('a'), trip('b')],
    collect: async (s) => { calls.push(s.id); return [trip(s.id)]; } });
  await writeFile(f.opts.statePath, JSON.stringify({ watches: [trip('b')], records: {} }));
  const resumed = createMonitor(f.opts); await resumed.init();
  await resumed.tick(); await resumed.idle();
  calls.length = 0;

  f.advance(WATCH_MS);
  await resumed.tick(); await resumed.idle();
  assert.deepEqual(calls, ['b'], '주인을 못 찾았다고 감시를 멈추면 그 사이 자리를 놓칩니다');
});

// 3분마다 보니 자리가 붙었다 떨어졌다 하면 계속 울립니다. 몇 번 헛울리면 사람이 알림을
// 꺼버리고, 그러면 정작 필요한 알림도 같이 잃습니다(core/alerts.js의 dropRepeats).
test('같은 소식은 다시 울리지 않고, 자리가 더 늘면 알린다', async () => {
  let seats = 0;
  const notices = [];
  const f = await fixture({ collect: async () => [trip('a', seats)], send: async (o) => { notices.push(o); } });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.tick(); await f.monitor.idle();

  seats = 2; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(notices.length, 1, '처음 잡힌 자리는 알립니다');

  seats = 0; f.advance(WATCH_MS);            // 누가 예약해서 다시 마감
  await f.monitor.tick(); await f.monitor.idle();
  seats = 2; f.advance(WATCH_MS);            // 또 취소 — 사람에게는 같은 소식
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(notices.length, 1, '같은 자리 수로 돌아온 것은 다시 안 울립니다');

  seats = 5; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(notices.length, 2, '자리가 더 늘어난 것은 새 소식입니다');
});

test('보낸 기록은 재시작해도 남는다 — 서버가 뜰 때마다 다시 울리면 안 됩니다', async () => {
  let seats = 0;
  const notices = [];
  const send = async (o) => { notices.push(o); };
  const f = await fixture({ collect: async () => [trip('a', seats)], send });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.tick(); await f.monitor.idle();
  seats = 2; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  assert.equal(notices.length, 1);
  await f.monitor.stop();

  const resumed = createMonitor({ ...f.opts, send });
  await resumed.init();
  seats = 0; f.advance(WATCH_MS);
  await resumed.tick(); await resumed.idle();
  seats = 2; f.advance(WATCH_MS);
  await resumed.tick(); await resumed.idle();
  assert.equal(notices.length, 1, '재시작 전에 보낸 소식입니다');
});

test('알림이 실패해도 3분 뒤에 같은 소식을 또 보내지 않는다', async () => {
  let seats = 0, tries = 0;
  const f = await fixture({ collect: async () => [trip('a', seats)],
    send: async () => { tries += 1; throw new Error('offline'); } });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.tick(); await f.monitor.idle();

  seats = 2; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  seats = 0; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();
  seats = 2; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();

  assert.equal(tries, 1, '채널이 살아나는 순간 밀린 알림이 한꺼번에 오면 안 됩니다');
  assert.equal(f.alerts.length, 1, '실패한 것도 이력에는 남습니다');
  assert.equal(f.alerts[0].notify.failed[0].error, 'offline');
});

test('알림 이력에 누구의 감시였는지 남는다', async () => {
  let seats = 0;
  const f = await fixture({ collect: async () => [trip('a', seats)], send: async () => ({ attempted: [], sent: [], failed: [] }) });
  await f.monitor.setWatch(tripKey(trip()), true, ME);
  await f.monitor.setWatch(tripKey(trip()), true, YOU);   // 같은 출조를 둘이 봅니다
  await f.monitor.tick(); await f.monitor.idle();

  seats = 2; f.advance(WATCH_MS);
  await f.monitor.tick(); await f.monitor.idle();

  assert.equal(f.alerts.length, 1);
  assert.deepEqual(f.alerts[0].watchers.sort(), [ME, YOU].sort(), '둘 다의 화면에 떠야 합니다');
});
