// 목록에서 원본 예약처로 넘어간 기록(core/usage.js, serve.js의 /api/usage, 화면의 markOutbound).
// 밖에 열 수 있는 길이라(WATCH_PUBLIC) "아는 칸만 적는다"와 "사람을 알아볼 것은 안 적는다"를 먼저 봅니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageRecord, summarizeUsage, readUsage } from '../core/usage.js';
import { createApp, apiAccess, USAGE_PER_MINUTE } from '../serve.js';

const AT = new Date('2026-09-30T05:00:00.000Z');
const VISIT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

test('방문과 이동만 적고, 아는 칸만 골라 새로 만든다', () => {
  assert.deepEqual(usageRecord({ kind: 'visit', visit: VISIT, watcher: 'secret' }, { at: AT }),
    { at: AT.toISOString(), visit: VISIT, kind: 'visit' });

  const out = usageRecord({
    kind: 'outbound', visit: VISIT, siteId: 'raraho', platform: '선상24', from: 'alert', urlDated: true,
    boat: '라라호', date: '2026-10-03', url: 'https://example.com', watcher: 'token',
  }, { at: AT });
  assert.deepEqual(out, {
    at: AT.toISOString(), visit: VISIT, kind: 'outbound',
    siteId: 'raraho', platform: '선상24', from: 'alert', urlDated: true,
  }, '배·날짜·주소·감시 토큰은 적지 않습니다 — 누가 어느 배를 노리는지 드러납니다');
});

test('모르는 모양은 적지 않는다', () => {
  for (const body of [
    null, 'x', {}, { kind: 'visit' }, { kind: 'visit', visit: 'short' },
    { kind: 'visit', visit: '../../etc/passwd' },
    { kind: 'outbound', visit: VISIT },
    { kind: 'outbound', visit: VISIT, siteId: '<script>' },
    { kind: 'outbound', visit: VISIT, siteId: 'a'.repeat(81) },
    { kind: 'delete', visit: VISIT },
  ]) assert.equal(usageRecord(body, { at: AT }), null, JSON.stringify(body));

  const odd = usageRecord({ kind: 'outbound', visit: VISIT, siteId: 'a', platform: 'x'.repeat(21), from: 'evil' }, { at: AT });
  assert.equal(odd.platform, null);
  assert.equal(odd.from, 'table');
  assert.equal(odd.urlDated, false);
});

test('넘어간 비율은 방문 기록이 있는 방문만 분모·분자로 센다', () => {
  const v = (id) => ({ kind: 'visit', visit: id, at: AT.toISOString() });
  const o = (id, over = {}) => ({ kind: 'outbound', visit: id, siteId: 's1', platform: '선상24', from: 'table', urlDated: true, at: AT.toISOString(), ...over });
  const s = summarizeUsage([
    v('a'), v('b'), v('c'), v('d'),
    o('a'), o('a', { siteId: 's2', platform: '더피싱', urlDated: false }),
    o('b', { from: 'alert' }),
    o('ghost'),   // 방문 기록이 없는 id — 분자에 넣으면 비율이 100%를 넘을 수 있습니다
  ]);
  assert.equal(s.visits, 4);
  assert.equal(s.convertedVisits, 2);
  assert.equal(s.rate, 0.5);
  assert.equal(s.outbound, 4);
  assert.deepEqual(s.byPlatform, { 선상24: 3, 더피싱: 1 });
  assert.deepEqual(s.byFrom, { table: 3, alert: 1 });
  assert.equal(s.undated, 1);
  assert.deepEqual(s.bySite[0], { siteId: 's1', count: 3 });

  assert.equal(summarizeUsage([]).rate, null, '방문이 없으면 0%가 아니라 모름입니다');
});

test('기록 파일의 깨진 줄은 건너뛴다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const path = join(dir, 'usage.jsonl');
  await writeFile(path, `${JSON.stringify({ kind: 'visit', visit: VISIT })}\n{"kind":"vis\n`);
  const { records, broken } = await readUsage(path);
  assert.equal(records.length, 1);
  assert.equal(broken, 1);
  assert.deepEqual(await readUsage(join(dir, '없음.jsonl')), { records: [], broken: 0 });
});

test('이용 기록은 감시 API처럼 켰을 때만, 토큰 헤더가 있을 때만 밖에서 받는다', () => {
  const outside = (headers = {}) => ({ socket: { remoteAddress: '203.0.113.9' }, headers: { host: 'fishing.example', ...headers } });
  assert.equal(apiAccess(outside({ 'x-watcher': 'token-0123456789abcdef' }), '/api/usage', { watchPublic: false }), 'deny');
  assert.equal(apiAccess(outside({ 'x-watcher': 'token-0123456789abcdef' }), '/api/usage', { watchPublic: true }), 'watch');
  assert.equal(apiAccess(outside(), '/api/usage', { watchPublic: true }), 'deny', '커스텀 헤더가 없으면 다른 사이트 폼이 쏠 수 있습니다(CSRF)');
});

test('/api/usage는 적기만 하고, 모르는 것은 400, 너무 많으면 429', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-api-'));
  const usagePath = join(dir, 'usage.jsonl');
  await writeFile(join(dir, 'data.json'), JSON.stringify({ sites: {}, trips: [] }));
  const server = createApp({
    root: dir, registry: join(dir, 'registry.json'), restartable: false, usagePath, usagePerMinute: 3,
    now: () => AT.getTime(),   // 분이 바뀌면 창이 새로 열려 429를 못 봅니다
    autoResearch: { everyMs: 0 },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/usage', {
    method: 'POST',
    headers: { 'X-Admin': '1', 'X-Watcher': 'token-0123456789abcdef', 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    assert.equal((await post({ kind: 'visit', visit: VISIT })).status, 200);
    assert.equal((await post({ kind: 'outbound', visit: VISIT, siteId: 'raraho', boat: '라라호' })).status, 200);
    assert.equal((await post({ kind: 'nope', visit: VISIT })).status, 400);
    assert.equal((await post('{깨진')).status, 400);
    assert.equal((await post({ kind: 'visit', visit: VISIT, pad: 'x'.repeat(3000) })).status, 400, '큰 본문은 안 받습니다');
    assert.equal((await fetch(base + '/api/usage', { headers: { 'X-Admin': '1' } })).status, 404, '읽는 길은 없습니다');

    const lines = (await readFile(usagePath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.kind), ['visit', 'outbound']);
    assert.equal(lines[1].boat, undefined);

    assert.equal((await post({ kind: 'visit', visit: VISIT })).status, 200, '받은 줄은 셋째');
    assert.equal((await post({ kind: 'visit', visit: VISIT })).status, 429, '1분에 받는 줄 수에 한도가 있습니다');
    assert.equal((await readFile(usagePath, 'utf8')).trim().split('\n').length, 3, '넘친 것은 안 적습니다');
    assert.equal(USAGE_PER_MINUTE, 600);
  } finally {
    server.close();
  }
});

// ── 화면 ────────────────────────────────────────────────────────────────────
const html = await readFile('docs/index.html', 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

test('화면: 목록과 알림 이력의 예약처 링크를 둘 다 센다', () => {
  assert.match(inline, /markOutbound\(a, src, 'table'\);/);
  assert.match(inline, /markOutbound\(link, a, 'alert'\);/);
  assert.match(inline, /document\.addEventListener\('click', trackOutbound\);/);
  assert.match(inline, /document\.addEventListener\('auxclick', trackOutbound\);/, '가운데 버튼으로 새 탭을 여는 사람도 셉니다');
});

test('화면: 받을 서버가 있을 때만 보내고, 답을 안 기다린다', () => {
  const send = inline.slice(inline.indexOf('function sendUsage'), inline.indexOf('function trackOutbound'));
  assert.match(send, /if \(!usageReady\(\)\) return;/, 'GitHub Pages에서는 아무것도 안 나갑니다');
  assert.match(send, /keepalive: true/, '새 탭이 열리며 페이지가 뒤로 가도 요청은 끝까지 갑니다');
  assert.doesNotMatch(send, /await /, '기록 때문에 예약처로 가는 길을 늦추면 안 됩니다');
  assert.match(inline, /const usageReady = \(\) => WATCH_API \|\| ADMIN_API;/);
});

test('화면: 방문 id는 페이지마다 새로 뽑고 어디에도 저장하지 않는다', () => {
  const block = inline.slice(inline.indexOf('const VISIT = '), inline.indexOf('function markOutbound'));
  assert.match(block, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(block, /localStorage|sessionStorage|document\.cookie/);
  const track = inline.slice(inline.indexOf('function trackOutbound'), inline.indexOf("document.addEventListener('click', trackOutbound)"));
  assert.doesNotMatch(track, /\bboat\b|\bdate\b|href/, '배·날짜·주소는 보내지 않습니다');
});
