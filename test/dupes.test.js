// 같은 일정표를 두 번 긁는 사이트 찾기. 잘못 끄면 배가 통째로 사라지므로,
// "값이 다르면 끄지 않는다"를 특히 확인합니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, disableInRegistry, activeTrips, explainPair } from '../core/dupes.js';

const trip = (siteId, boat, date, extra = {}) => ({
  siteId, boat, date, departAt: '05:00', seatsLeft: 3, seatsTotal: 20, species: '주꾸미', ...extra,
});

test('겹치는 배가 없으면 남남이다', () => {
  const { groups, reviews } = findDuplicates([
    trip('a', '가호', '2026-09-07'),
    trip('b', '나호', '2026-09-07'),
  ]);
  assert.deepEqual(groups, []);
  assert.deepEqual(reviews, []);
});

test('배가 더 많은 쪽을 남기고 부분집합을 끈다', () => {
  const { groups, reviews } = findDuplicates([
    trip('small', '가호', '2026-09-07'),
    trip('big', '가호', '2026-09-07'),
    trip('big', '나호', '2026-09-07'),
  ]);
  assert.deepEqual(reviews, []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep, 'big');
  assert.deepEqual(groups[0].drop.map((d) => d.id), ['small']);
  assert.equal(groups[0].saved, 1);
});

// 다른 지역에 같은 이름의 배가 있습니다. 이름만 같고 값이 다르면 끄면 안 됩니다.
test('겹치는 배의 잔여석이 다르면 끄지 않고 사람에게 넘긴다', () => {
  const { groups, reviews } = findDuplicates([
    trip('a', '가호', '2026-09-07', { seatsLeft: 3 }),
    trip('b', '가호', '2026-09-07', { seatsLeft: 9 }),
  ]);
  assert.deepEqual(groups, [], '값이 다르면 자동으로 끄지 않습니다');
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0].sites, ['a', 'b']);
});

test('한쪽에만 있는 날짜가 있어도 끄지 않는다', () => {
  const { groups, reviews } = findDuplicates([
    trip('a', '가호', '2026-09-07'),
    trip('b', '가호', '2026-09-07'),
    trip('b', '가호', '2026-09-08'),
  ]);
  assert.deepEqual(groups, []);
  assert.equal(reviews.length, 1);
});

// 서로 상대에게 없는 배를 하나씩 가진 경우. 어느 쪽을 꺼도 배가 사라집니다.
test('어느 쪽도 나머지를 덮지 못하면 끄지 않는다', () => {
  const { groups, reviews } = findDuplicates([
    trip('a', '공통호', '2026-09-07'), trip('a', '에이호', '2026-09-07'),
    trip('b', '공통호', '2026-09-07'), trip('b', '비호', '2026-09-07'),
  ]);
  assert.deepEqual(groups, []);
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0].sites.sort(), ['a', 'b']);
});

test('세 곳이 같은 일정표면 한 곳만 남긴다', () => {
  const rows = [];
  for (const site of ['a', 'b', 'c']) rows.push(trip(site, '가호', '2026-09-07'));
  rows.push(trip('c', '나호', '2026-09-07'));

  const { groups } = findDuplicates(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep, 'c');
  assert.deepEqual(groups[0].drop.map((d) => d.id).sort(), ['a', 'b']);
});

// 같은 입력이면 늘 같은 답이 나와야 합니다 — 돌릴 때마다 끄는 곳이 바뀌면 못 씁니다.
test('완전히 같은 두 곳은 id 순으로 정해진 쪽을 남긴다', () => {
  const rows = [trip('zzz', '가호', '2026-09-07'), trip('aaa', '가호', '2026-09-07')];
  const first = findDuplicates(rows);
  const second = findDuplicates([...rows].reverse());
  assert.equal(first.groups[0].keep, 'aaa');
  assert.equal(second.groups[0].keep, 'aaa');
});

// ── registry 고치기 ──────────────────────────────────────────────────────────
// JSON을 통째로 다시 쓰면 이번 변경과 상관없는 줄까지 diff에 섞입니다.

const REG = `{
  "sites": [
    {
      "id": "keep",
      "name": "남길 곳",
      "enabled": true,
      "timeGuide": {
        "species": ["주꾸미", "갑오징어"]
      }
    },
    {
      "id": "gone",
      "name": "끌 곳",
      "enabled": true,
      "note": "옛 메모"
    }
  ]
}
`;

test('끄면 enabled와 note만 바뀐다', () => {
  const out = disableInRegistry(REG, 'gone', '새 메모');
  const parsed = JSON.parse(out);

  assert.equal(parsed.sites[1].enabled, false);
  assert.equal(parsed.sites[1].note, '새 메모');
  assert.equal(parsed.sites[0].enabled, true, '다른 사이트는 건드리지 않습니다');
  assert.match(out, /"species": \["주꾸미", "갑오징어"\]/, '손으로 적은 한 줄 배열이 풀리면 안 됩니다');
});

test('note가 없던 곳에는 새로 넣는다', () => {
  const out = disableInRegistry(REG, 'keep', '메모');
  const parsed = JSON.parse(out);
  assert.equal(parsed.sites[0].enabled, false);
  assert.equal(parsed.sites[0].note, '메모');
  assert.equal(parsed.sites[1].note, '옛 메모');
});

test('없는 id를 끄려 하면 조용히 넘어가지 않는다', () => {
  assert.throws(() => disableInRegistry(REG, '없음', '메모'), /없습니다/);
});

test('실제 registry를 끄고 다시 읽어도 JSON이 성립한다', async () => {
  const { readFile } = await import('node:fs/promises');
  const { REGISTRY_PATH } = await import('../core/runner.js');
  const text = await readFile(REGISTRY_PATH, 'utf8');
  const before = JSON.parse(text);
  const id = before.sites.find((s) => s.enabled !== false).id;

  const after = JSON.parse(disableInRegistry(text, id, '시험'));
  assert.equal(after.sites.length, before.sites.length);
  assert.equal(after.sites.find((s) => s.id === id).enabled, false);
});

// ── 이미 꺼둔 곳 ────────────────────────────────────────────────────────────
// 끄고 나서 수집이 아직 안 돌면 결과에 그대로 남습니다. 그걸 또 끄라고 하면
// --disable을 다시 돌릴 때 note가 겹쳐 쌓입니다.

test('꺼둔 사이트의 출조는 빼고, 뭘 뺐는지 알려준다', () => {
  const rows = [trip('on', '가호', '2026-09-07'), trip('off', '가호', '2026-09-07')];
  const { trips, skipped } = activeTrips(rows, [{ id: 'on', enabled: true }, { id: 'off', enabled: false }]);

  assert.deepEqual(trips.map((t) => t.siteId), ['on']);
  assert.deepEqual(skipped, ['off']);
});

test('꺼둔 곳을 빼고 나면 이미 정리한 중복은 다시 안 나온다', () => {
  const rows = [trip('keep', '가호', '2026-09-07'), trip('keep', '나호', '2026-09-07'), trip('gone', '가호', '2026-09-07')];
  const registry = [{ id: 'keep', enabled: true }, { id: 'gone', enabled: false }];

  assert.equal(findDuplicates(rows).groups.length, 1, '끄기 전에는 잡힙니다');
  assert.deepEqual(findDuplicates(activeTrips(rows, registry).trips).groups, [], '끄고 나면 안 잡힙니다');
});

test('결과에 없는 사이트를 꺼둔 건 알리지 않는다', () => {
  const rows = [trip('on', '가호', '2026-09-07')];
  const { skipped } = activeTrips(rows, [{ id: 'on', enabled: true }, { id: '수집한적없음', enabled: false }]);
  assert.deepEqual(skipped, [], '수집 결과에 없던 곳까지 늘어놓으면 매번 시끄럽습니다');
});

// ── 어디가 다른지 ───────────────────────────────────────────────────────────
// 값이 갈린 쌍은 사람이 정해야 합니다. "다르다"만 알려주면 매번 손으로 파보게 됩니다.

test('필드별로 몇 건이 다른지 센다', () => {
  const rows = [
    trip('a', '가호', '2026-09-07', { seatsTotal: 20, tide: '2물' }),
    trip('b', '가호', '2026-09-07', { seatsTotal: 15, tide: '한객기' }),
    trip('a', '가호', '2026-09-08', { seatsTotal: 20 }),
    trip('b', '가호', '2026-09-08', { seatsTotal: 20 }),
  ];
  const r = explainPair(rows, 'a', 'b');

  assert.equal(r.slots, 2);
  assert.deepEqual(r.byField, { seatsTotal: 1, tide: 1 });
  assert.deepEqual(r.boats, ['가호']);
});

test('한쪽에만 있는 자리를 따로 센다', () => {
  const rows = [
    trip('a', '가호', '2026-09-07'),
    trip('a', '가호', '2026-09-08'),
    trip('b', '가호', '2026-09-07'),
  ];
  const r = explainPair(rows, 'a', 'b');

  assert.equal(r.slots, 1);
  assert.equal(r.onlyA, 1);
  assert.equal(r.onlyB, 0);
  assert.deepEqual(r.byField, {}, '겹치는 자리만 견줍니다');
});

test('겹치는 자리의 값이 전부 같으면 다른 값이 하나도 없다', () => {
  const rows = [trip('a', '가호', '2026-09-07'), trip('b', '가호', '2026-09-07')];
  assert.deepEqual(explainPair(rows, 'a', 'b').diffs, []);
});

test('수집 결과에 없는 id를 물으면 알려준다', () => {
  const rows = [trip('a', '가호', '2026-09-07')];
  assert.throws(() => explainPair(rows, 'a', '없음'), /없습니다/);
});
