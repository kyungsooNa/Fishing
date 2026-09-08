// 감시 목록을 사람마다 나눠 두는 규칙. 잘못되면 남의 감시가 내 화면에 뜨거나,
// 내가 남의 감시를 해제하게 됩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { watcherId, loadWatchers, listOf, allWatches, setList, MAX_WATCHES } from '../core/watchers.js';

const watch = (siteId, boat = '가호') => ({ siteId, boat, date: '2026-09-09', departAt: '05:00' });

test('같은 토큰은 같은 열쇠, 다른 토큰은 다른 열쇠', () => {
  const a = watcherId('watcher-token-0123456789');
  assert.equal(a, watcherId('watcher-token-0123456789'));
  assert.notEqual(a, watcherId('watcher-token-9876543210'));
  assert.match(a, /^[0-9a-f]{32}$/);
});

// 파일이 새더라도 남의 감시를 대신 걸거나 지울 수는 없어야 합니다.
test('토큰 자체는 열쇠에 남지 않는다', () => {
  const token = 'watcher-token-0123456789';
  assert.ok(!watcherId(token).includes(token));
});

test('짧은 토큰은 받지 않는다 — 찍어 맞히면 남의 목록이 열립니다', () => {
  assert.equal(watcherId('짧다'), null);
  assert.equal(watcherId(''), null);
  assert.equal(watcherId(null), null);
  assert.equal(watcherId(undefined), null);
  assert.equal(watcherId('   0123456789abcdef   '), watcherId('0123456789abcdef'), '앞뒤 공백은 같은 토큰입니다');
});

test('사람마다 목록을 따로 읽고 따로 쓴다', () => {
  const { watchers } = loadWatchers({ watchers: { me: [watch('a')], you: [watch('b')] } });
  assert.deepEqual(listOf(watchers, 'me').map((w) => w.siteId), ['a']);
  assert.deepEqual(listOf(watchers, 'you').map((w) => w.siteId), ['b']);
  assert.deepEqual(listOf(watchers, '모르는사람'), []);
  assert.deepEqual(listOf(watchers, null), []);
});

test('수집 스케줄은 모두의 목록을 합쳐 정한다', () => {
  const { watchers } = loadWatchers({ watchers: { me: [watch('a')], you: [watch('b')] } });
  assert.deepEqual(allWatches(watchers).map((w) => w.siteId).sort(), ['a', 'b'],
    '한 번 받아 다 같이 나눠 씁니다');
});

test('감시를 다 끄면 그 사람의 열쇠는 파일에서 사라진다', () => {
  const one = setList({}, 'me', [watch('a')]);
  assert.deepEqual(Object.keys(one), ['me']);
  assert.deepEqual(Object.keys(setList(one, 'me', [])), [], '빈 목록을 남길 이유가 없습니다');
  assert.deepEqual(Object.keys(one), ['me'], '원본을 건드리지 않습니다');
});

// 사용자 구분이 없던 시절의 파일. 주인을 모르니 버리지도, 아무에게나 주지도 않습니다.
test('예전 파일의 목록은 legacy로 따로 들고 온다', () => {
  const { watchers, legacy } = loadWatchers({ watches: [watch('a')], records: {} });
  assert.deepEqual(watchers, {});
  assert.deepEqual(legacy.map((w) => w.siteId), ['a']);
});

test('깨진 항목은 버리고 나머지는 읽는다', () => {
  const { watchers, legacy } = loadWatchers({
    watchers: { me: [watch('a'), { siteId: 'b' }, null], 빈사람: [] },
    watches: ['문자열', watch('c')],
  });
  assert.deepEqual(listOf(watchers, 'me').map((w) => w.siteId), ['a'], '배·날짜가 없으면 감시할 수 없습니다');
  assert.equal('빈사람' in watchers, false);
  assert.deepEqual(legacy.map((w) => w.siteId), ['c']);
});

test('파일이 없거나 모양이 달라도 읽다가 죽지 않는다', () => {
  for (const bad of [null, undefined, {}, { watchers: null }, { watchers: [] }, { watches: '아님' }]) {
    const { watchers, legacy } = loadWatchers(bad);
    assert.deepEqual(watchers, {});
    assert.deepEqual(legacy, []);
  }
});

test('상한은 사람마다 센다', () => {
  assert.equal(MAX_WATCHES, 50);
});
