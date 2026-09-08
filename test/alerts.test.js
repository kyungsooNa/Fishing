// 취소석 감시가 값어치가 있는지는 "얼마나 빨리 잡았나 / 알림이 실제로 갔나"로만 압니다.
// 둘 다 그때 남기지 않으면 나중에 셀 수 없어서, 무엇을 남기고 무엇을 안 남기는지를 고정합니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { alertRecords, appendAlerts, readAlerts, summarizeAlerts, alertKey, dropRepeats, rememberSent, REPEAT_MS } from '../core/alerts.js';
import { findOpenings } from '../core/diff.js';
import { format } from '../core/notify.js';
import { STATUS } from '../core/schema.js';

const run = promisify(execFile);

const AT = '2026-09-08T03:00:00.000Z';
const opening = (over = {}) => ({
  siteId: 'a', siteName: 'A', boat: '가호', date: '2026-09-09', departAt: '05:00',
  reason: 'reopened', before: 0, seatsLeft: 2, url: 'https://a', ...over,
});

test('기록 한 줄에 감지 시각·직전 확인 시각·지연 상한이 같이 남는다', () => {
  const [r] = alertRecords({
    openings: [opening()],
    at: AT,
    since: { a: '2026-09-08T02:57:00.000Z' },
    result: { attempted: ['telegram'], sent: ['telegram'], failed: [] },
  });

  assert.equal(r.at, AT);
  assert.equal(r.since, '2026-09-08T02:57:00.000Z');
  assert.equal(r.delayMaxMs, 3 * 60 * 1000, '3분 주기면 지연 상한도 3분입니다');
  assert.equal(r.boat, '가호');
  assert.equal(r.before, 0);
  assert.equal(r.after, 2);
  assert.deepEqual(r.notify, { attempted: ['telegram'], sent: ['telegram'], failed: [] });
});

// 자리가 실제로 언제 났는지는 사이트가 안 알려줍니다. 직전 확인 시각을 모르면
// 지연을 계산할 수 없고, 모르는 걸 0으로 적으면 통계가 통째로 거짓말이 됩니다.
test('직전 확인 시각을 모르면 지연을 지어내지 않는다', () => {
  const [none] = alertRecords({ openings: [opening()], at: AT, since: {} });
  assert.equal(none.since, null);
  assert.equal(none.delayMaxMs, null);

  const [backwards] = alertRecords({ openings: [opening()], at: AT, since: { a: '2026-09-08T04:00:00.000Z' } });
  assert.equal(backwards.delayMaxMs, null, '시계가 거꾸로 간 기록은 지연으로 세지 않습니다');
});

test('알림 실패는 채널과 이유까지 남는다', () => {
  const [r] = alertRecords({
    openings: [opening()],
    at: AT,
    since: { a: '2026-09-08T02:00:00.000Z' },
    result: { attempted: ['telegram', 'discord'], sent: ['telegram'], failed: [{ channel: 'discord', error: 'HTTP 500' }] },
  });
  assert.deepEqual(r.notify.failed, [{ channel: 'discord', error: 'HTTP 500' }]);
});

test('발송을 아예 안 했으면 그 사실이 남는다', () => {
  const [never] = alertRecords({ openings: [opening()], at: AT });
  assert.equal(never.notify.skipped, 'not-attempted');

  const [noChannel] = alertRecords({
    openings: [opening()], at: AT,
    result: { attempted: [], sent: [], failed: [], skipped: 'no-credentials' },
  });
  assert.equal(noChannel.notify.skipped, 'no-credentials');
  assert.deepEqual(noChannel.notify.attempted, [], '채널이 없으면 시도한 것도 없습니다');
});

// ── 무엇을 기록하지 "않는가" — findOpenings가 거르는 세 가지가 기록에도 안 남아야 합니다.
const base = { siteId: 'a', boat: '가호', date: '2026-09-09', departAt: '05:00' };

test('새로 올라온 일정은 기록하지 않는다', () => {
  const openings = findOpenings([], [{ ...base, status: STATUS.OPEN, seatsLeft: 5 }]);
  assert.deepEqual(alertRecords({ openings, at: AT }), [], '아무도 예약 안 한 게 당연한 자리입니다');
});

test('수집에 실패한 사이트는 기록하지 않는다', () => {
  const prev = [{ ...base, status: STATUS.CLOSED, seatsLeft: 0 }];
  const next = [{ ...base, status: STATUS.OPEN, seatsLeft: 2 }];
  const openings = findOpenings(prev, next, new Set(['a']));
  assert.deepEqual(alertRecords({ openings, at: AT }), [], '남아 있던 예전 값으로 오탐이 납니다');
});

test('통합 출처가 바뀐 것은 한 건으로 기록한다', () => {
  const identity = { boat: '은가비호', port: '충남 홍성 남당항', phone: '010-2495-2060', date: '2026-09-09', departAt: '05:00' };
  const openings = findOpenings(
    [{ ...identity, siteId: 'sunsang', status: STATUS.CLOSED, seatsLeft: 0 }],
    [{ ...identity, siteId: 'thefishing', status: STATUS.OPEN, seatsLeft: 2 }],
  );
  const records = alertRecords({ openings, at: AT, since: { thefishing: '2026-09-08T02:00:00.000Z' } });

  assert.equal(records.length, 1, '본체 사이트가 바뀐 것은 새 자리가 아닙니다');
  assert.equal(records[0].siteId, 'thefishing');
  assert.equal(records[0].reason, 'reopened');
});

// ── 파일 ────────────────────────────────────────────────────────────────────
test('한 줄에 한 건씩 덧붙이고 다시 읽는다', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'alerts-')), 'alerts.jsonl');
  await appendAlerts(alertRecords({ openings: [opening()], at: AT, since: { a: '2026-09-08T02:00:00.000Z' } }), path);
  await appendAlerts(alertRecords({ openings: [opening({ boat: '나호' })], at: AT }), path);

  const text = await readFile(path, 'utf8');
  assert.equal(text.trim().split('\n').length, 2, 'JSON Lines — 덧붙이기만 하면 됩니다');

  const { records, broken } = await readAlerts(path);
  assert.deepEqual(records.map((r) => r.boat), ['가호', '나호']);
  assert.equal(broken, 0);
});

test('줄 하나가 깨져도 나머지는 읽는다', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'alerts-')), 'alerts.jsonl');
  await writeFile(path, `${JSON.stringify({ at: AT, boat: '가호' })}\n{깨진 줄\n${JSON.stringify({ at: AT, boat: '나호' })}\n`);

  const { records, broken } = await readAlerts(path);
  assert.deepEqual(records.map((r) => r.boat), ['가호', '나호']);
  assert.equal(broken, 1);
});

test('기록이 없으면 빈 결과를 준다', async () => {
  const { records, broken } = await readAlerts(join(tmpdir(), 'alerts-없는파일.jsonl'));
  assert.deepEqual(records, []);
  assert.equal(broken, 0);
});

test('빈 기록을 쓰라고 하면 파일을 만들지 않는다', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'alerts-')), 'alerts.jsonl');
  assert.equal(await appendAlerts([], path), 0);
  await assert.rejects(readFile(path, 'utf8'));
});

// ── 요약 ────────────────────────────────────────────────────────────────────
const record = (delayMaxMs, notify) => ({ at: AT, delayMaxMs, reason: 'reopened', notify });

test('지연은 평균이 아니라 분위수로 낸다', () => {
  const s = summarizeAlerts([
    record(60_000, { attempted: ['telegram'], sent: ['telegram'], failed: [] }),
    record(120_000, { attempted: ['telegram'], sent: ['telegram'], failed: [] }),
    record(180_000, { attempted: ['telegram'], sent: ['telegram'], failed: [] }),
    // 한 건이 하루 묵어도 중앙값은 흔들리지 않아야 합니다.
    record(86_400_000, { attempted: ['telegram'], sent: ['telegram'], failed: [] }),
  ]);

  assert.equal(s.delayMaxMs.measured, 4);
  assert.equal(s.delayMaxMs.p50, 180_000);
  assert.equal(s.delayMaxMs.max, 86_400_000);
});

test('지연을 모르는 기록은 분모에서 빼고 따로 센다', () => {
  const s = summarizeAlerts([record(60_000, { sent: ['telegram'] }), record(null, { sent: ['telegram'] })]);
  assert.equal(s.delayMaxMs.measured, 1);
  assert.equal(s.delayMaxMs.unknown, 1);
});

test('알림 성공·실패·못 보냄을 나눠 세고 실패 이유를 모은다', () => {
  const s = summarizeAlerts([
    record(1000, { attempted: ['telegram', 'discord'], sent: ['telegram'], failed: [{ channel: 'discord', error: 'HTTP 500' }] }),
    record(1000, { attempted: ['discord'], sent: [], failed: [{ channel: 'discord', error: 'HTTP 500' }] }),
    record(1000, { attempted: [], sent: [], failed: [], skipped: 'no-credentials' }),
  ]);

  assert.equal(s.notify.sent, 1);
  assert.equal(s.notify.failed, 2);
  assert.equal(s.notify.unsent, 1, '채널이 없어 아예 못 보낸 건은 실패와 다릅니다');
  assert.deepEqual(s.notify.byChannel, { telegram: 1 });
  assert.deepEqual(s.notify.failures, [{ reason: 'discord: HTTP 500', count: 2 }]);
});

test('기록이 없어도 요약하다가 죽지 않는다', () => {
  const s = summarizeAlerts([]);
  assert.equal(s.records, 0);
  assert.equal(s.delayMaxMs.p50, null);
  assert.equal(s.notify.sent, 0);
});

test('명령이 실제로 돈다', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'alerts-')), 'alerts.jsonl');
  await appendAlerts(alertRecords({
    openings: [opening()],
    at: AT,
    since: { a: '2026-09-08T02:57:00.000Z' },
    result: { attempted: ['telegram'], sent: [], failed: [{ channel: 'telegram', error: 'HTTP 429' }] },
  }), path);

  const { stdout } = await run(process.execPath, ['alerts.js', '--from', path, '--last', '5']);
  assert.match(stdout, /감지 지연/);
  assert.match(stdout, /3분/);
  assert.match(stdout, /HTTP 429/);
});

test('기록이 없으면 어떻게 쌓이는지 알려준다', async () => {
  const { stdout } = await run(process.execPath, ['alerts.js', '--from', join(tmpdir(), 'alerts-없음.jsonl')]);
  assert.match(stdout, /기록이 없습니다/);
});

// ── 같은 소식을 다시 울리지 않기 ────────────────────────────────────────────
// 3분마다 보니 자리가 붙었다 떨어졌다 하면 계속 울립니다. 몇 번 헛울리면 사람이 알림을
// 꺼버리고, 그러면 정작 필요한 알림도 같이 잃습니다.
test('같은 출조·같은 이유·같은 자리 수면 같은 소식이다', () => {
  const base = opening();
  assert.equal(alertKey(base), alertKey({ ...base, siteName: '이름만 다름' }));
  assert.notEqual(alertKey(base), alertKey({ ...base, seatsLeft: 5 }), '자리가 더 늘면 다른 소식입니다');
  assert.notEqual(alertKey(base), alertKey({ ...base, reason: 'more-seats' }));
  assert.notEqual(alertKey(base), alertKey({ ...base, date: '2026-09-10' }));
});

test('이미 보낸 소식은 걸러내고 새 소식만 남긴다', () => {
  const now = Date.parse(AT);
  const sent = rememberSent({}, [opening()], { now: now - 60_000 });

  const { fresh, repeats } = dropRepeats([opening(), opening({ seatsLeft: 5 })], sent, { now });
  assert.deepEqual(repeats.map((o) => o.seatsLeft), [2]);
  assert.deepEqual(fresh.map((o) => o.seatsLeft), [5], '자리가 더 늘어난 건 알립니다');
});

test('시간이 지나면 다시 알린다 — 사람에게는 새 소식입니다', () => {
  const now = Date.parse(AT);
  const sent = rememberSent({}, [opening()], { now: now - REPEAT_MS - 1 });
  assert.equal(dropRepeats([opening()], sent, { now }).fresh.length, 1);
});

test('보낸 기록은 오래된 것부터 버린다 — 안 버리면 파일이 계속 자랍니다', () => {
  const now = Date.parse(AT);
  const old = rememberSent({}, [opening({ boat: '옛날호' })], { now: now - REPEAT_MS - 1 });
  const next = rememberSent(old, [opening()], { now });

  assert.equal(Object.keys(next).length, 1);
  assert.equal(dropRepeats([opening()], next, { now }).repeats.length, 1);
});

test('기록이 없거나 깨져 있어도 거르다가 죽지 않는다', () => {
  for (const bad of [undefined, null, {}, { 'a|b': '숫자아님' }]) {
    assert.equal(dropRepeats([opening()], bad).fresh.length, 1);
    assert.deepEqual(Object.keys(rememberSent(bad, [])), []);
  }
});

// ── 알림 본문 ───────────────────────────────────────────────────────────────
// 알림을 받고 바로 예약하러 갈 수 있어야 합니다. 주소가 없으면 사이트를 다시 찾아
// 날짜를 뒤져야 하고, 그 사이에 자리는 없어집니다.
test('알림에 원본 링크와 확인 시각이 같이 간다', () => {
  const text = format([opening({ url: 'https://x.example/bk?day=9', urlDated: true })],
    new Date('2026-09-08T03:05:00Z'));

  assert.match(text, /https:\/\/x\.example\/bk\?day=9/);
  assert.match(text, /12:05 확인/, '한국시간입니다 — 러너는 UTC라 그냥 찍으면 9시간 전으로 보입니다');
  assert.match(text, /취소석/);
  assert.match(text, /감시 해제는/, '그만 받는 방법을 모르면 알림을 통째로 끕니다');
});

test('주소로 날짜를 못 가는 링크는 그렇다고 적는다', () => {
  const dated = format([opening({ url: 'https://x.example/day', urlDated: true })]);
  const listing = format([opening({ url: 'https://x.example/list' })]);

  assert.ok(!dated.includes('일정표'), '그 날짜로 바로 가면 덧붙일 말이 없습니다');
  assert.match(listing, /일정표 — 날짜는 직접 고르세요/);
});

test('주소가 없으면 그 줄만 빠지고 나머지는 간다', () => {
  const text = format([opening({ url: null })]);
  assert.match(text, /가호/);
  assert.equal(text.includes('undefined'), false);
});

test('시각을 모르면 지어내지 않는다', () => {
  assert.match(format([opening()], '시각아님'), /시각 미상/);
});
