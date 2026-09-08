// 빈 칸을 세는 목적은 "다음에 무엇을 손볼까"를 고르는 것입니다. 그래서 숫자보다
// **나뉘는 방식**을 확인합니다 — 신원과 표시를 섞지 않는지, registry 고칠 일과 파서 고칠
// 일을 섞지 않는지, 합칠 상대가 없는 배까지 "막혔다"고 세지 않는지.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectQuality, sitesMissing, portHints, FIELDS } from '../core/quality.js';

const run = promisify(execFile);

const registry = [
  { id: 'sun', name: '선상', adapter: 'sunsang24' },
  { id: 'fish', name: '더피싱', adapter: 'thefishing', source: 'detail' },
];

const trip = (siteId, boat, extra = {}) => ({
  siteId, boat, date: '2026-09-09', port: '홍원항', phone: '010-1234-5678',
  departAt: '05:00', price: 90000, seatsTotal: 20, url: 'https://a', ...extra,
});

test('빈 칸을 항목별로 세고 그 항목이 빠진 선사 수도 같이 낸다', () => {
  const q = collectQuality(registry, {
    trips: [
      trip('sun', '가호', { price: null }),
      trip('sun', '나호', { price: null, seatsTotal: null }),
      trip('fish', '다호', { price: null }),
    ],
  });
  const field = (key) => q.fields.find((f) => f.key === key);

  assert.equal(field('price').missing, 3);
  assert.equal(field('price').rate, 1);
  assert.equal(field('price').sites, 2);
  assert.equal(field('seatsTotal').missing, 1);
  assert.equal(field('seatsTotal').sites, 1);
  assert.equal(field('url').missing, 0);
});

// 항구·전화번호는 사람이 registry에 적는 값이고 출항시각·승선료는 어댑터가 읽는 값입니다.
// 한 줄에 붙여두면 "이걸 고치려면 어디를 열어야 하나"가 매번 헷갈립니다.
test('고칠 곳이 registry인지 어댑터인지 항목마다 붙어 있다', () => {
  const where = Object.fromEntries(FIELDS.map((f) => [f.key, f.where]));
  assert.deepEqual(where, {
    port: 'registry', phone: 'registry',
    departAt: 'adapter', price: 'adapter', seatsTotal: 'adapter', url: 'adapter',
  });
  assert.deepEqual(FIELDS.filter((f) => f.identity).map((f) => f.key), ['port', 'phone']);
});

// 전화번호는 core/merge.js가 숫자만 남겨 비교합니다. 표기가 남아 있어도 자릿수가 모자라면
// 합치기에는 못 씁니다 — 있는 것으로 세면 "신원 갖춤"이 실제보다 부풀어 오릅니다.
test('전화번호는 합치기에 쓸 수 있는 값일 때만 있는 것으로 센다', () => {
  const q = collectQuality(registry, { trips: [trip('sun', '가호', { phone: '문의' })] });
  assert.equal(q.fields.find((f) => f.key === 'phone').missing, 1);
  assert.equal(q.identity.complete, 0);
});

test('신원은 배마다 센다 — 한 사이트 안에서도 배별로 갈립니다', () => {
  const q = collectQuality(registry, {
    trips: [
      trip('sun', '가호'),
      trip('sun', '나호', { port: null }),
      trip('sun', '나호', { port: null }),
      trip('fish', '다호', { port: null, phone: null }),
    ],
  });

  assert.equal(q.identity.boats, 3, '사이트가 아니라 배 단위입니다');
  assert.equal(q.identity.complete, 1);
  assert.equal(q.identity.portMissing, 1);
  assert.equal(q.identity.bothMissing, 1);
  assert.equal(q.identity.phoneMissing, 0);
});

// 항구가 비어도 그 이름의 배가 한 사이트에만 있으면 합칠 상대가 없습니다. 그런 것까지
// "막혔다"고 세면 목록이 수백 줄이 되고 정작 두 줄로 뜨고 있는 배가 묻힙니다.
test('합칠 상대가 있는 배만 막힌 것으로 센다', () => {
  const alone = collectQuality(registry, { trips: [trip('sun', '가호', { port: null })] });
  assert.deepEqual(alone.identity.blocked, [], '한 사이트에만 있는 배는 지금 손해가 없습니다');

  const q = collectQuality(registry, {
    trips: [trip('sun', '가호', { port: null }), trip('fish', '가호')],
  });
  assert.equal(q.identity.blocked.length, 1);
  assert.equal(q.identity.blocked[0].boat, '가호');
  assert.deepEqual(q.identity.blocked[0].sites, [
    { siteId: 'sun', port: false, phone: true },
    { siteId: 'fish', port: true, phone: true },
  ], '어느 쪽에 무엇이 없는지 나와야 registry에서 그 줄을 찾습니다');
});

test('양쪽 다 신원을 갖춘 배는 막힌 것이 아니다', () => {
  const q = collectQuality(registry, { trips: [trip('sun', '가호'), trip('fish', '가호')] });
  assert.deepEqual(q.identity.blocked, []);
});

test('배 이름의 공백 차이는 같은 배로 본다', () => {
  const q = collectQuality(registry, {
    trips: [trip('sun', '가 호', { port: null }), trip('fish', '가호')],
  });
  assert.equal(q.identity.blocked.length, 1);
});

test('막힌 배는 출조가 많은 것부터 준다', () => {
  const q = collectQuality(registry, {
    trips: [
      trip('sun', '작은호', { port: null }), trip('fish', '작은호'),
      trip('sun', '큰호', { port: null }), trip('sun', '큰호', { port: null }), trip('fish', '큰호'),
    ],
  });
  assert.deepEqual(q.identity.blocked.map((b) => b.boat), ['큰호', '작은호']);
  assert.equal(q.identity.blocked[0].trips, 3);
});

test('어댑터별로 묶어 파서 하나를 고치면 몇 건이 채워지는지 낸다', () => {
  const q = collectQuality(registry, {
    trips: [
      trip('sun', '가호'),
      trip('fish', '다호', { departAt: null }),
      trip('fish', '라호', { departAt: null }),
    ],
  });
  const row = (key) => q.adapters.find((a) => a.key === key);

  assert.equal(row('thefishing').missing.departAt, 2);
  assert.equal(row('sunsang24').missing.departAt, 0);
  assert.equal(q.adapters.reduce((sum, a) => sum + a.trips, 0), 3);
});

test('registry에 없는 사이트의 출조도 흘리지 않는다', () => {
  const q = collectQuality(registry, {
    sites: { ghost: { platform: '선상24', name: '유령' } },
    trips: [trip('ghost', '가호', { port: null })],
  });
  assert.equal(q.adapters.find((a) => a.key === '미등록').trips, 1);
  assert.equal(q.sites[0].platform, '선상24', '수집 결과에 남은 표기라도 씁니다');
  assert.equal(q.sites.reduce((sum, s) => sum + s.trips, 0), q.trips);
});

test('그 항목이 빠진 사이트 id를 그대로 집어낼 수 있다', () => {
  const q = collectQuality(registry, {
    trips: [trip('sun', '가호', { seatsTotal: null }), trip('fish', '다호')],
  });
  assert.deepEqual(sitesMissing(q, 'seatsTotal'), ['sun']);
  assert.deepEqual(sitesMissing(q, 'url'), []);
});

test('수집 결과가 비어 있어도 세다가 죽지 않는다', () => {
  const q = collectQuality(registry, {});
  assert.equal(q.trips, 0);
  assert.equal(q.identity.boats, 0);
  assert.equal(q.fields.find((f) => f.key === 'port').rate, null);
  assert.deepEqual(q.adapters, []);
});

// 세는 건 맞는데 표를 그리다가 죽으면 명령을 통째로 못 씁니다(개발 중에 실제로 그랬습니다).
async function runCli(args) {
  const dir = await mkdtemp(join(tmpdir(), 'quality-'));
  const path = join(dir, 'data.json');
  await writeFile(path, JSON.stringify({ trips: [trip('sun', '가호', { port: null }), trip('fish', '가호')] }), 'utf8');
  return run(process.execPath, ['quality.js', '--from', path, ...args]);
}

test('명령이 실제로 돈다', async () => {
  const { stdout } = await runCli([]);
  assert.match(stdout, /■ 합치기 신원/);
  assert.match(stdout, /■ 빈 칸/);
  assert.match(stdout, /■ 어댑터별/);
});

test('--json은 그대로 파싱되는 형식이다', async () => {
  const { stdout } = await runCli(['--json']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.trips, 2);
  assert.equal(parsed.identity.blocked.length, 1);
});

test('없는 항목을 물으면 무엇이 있는지 알려주고 실패한다', async () => {
  await assert.rejects(runCli(['--sites', '없는것']), (err) => {
    assert.match(err.stderr, /port/);
    return true;
  });
});

// ── 항구를 채울 곳 찾기 ─────────────────────────────────────────────────────
// 항구가 빈 사이트는 수백 곳인데 지금 당장 두 줄로 뜨게 만드는 곳은 그중 일부입니다.
// discover가 note에 적어둔 후보는 **확인 전에는 값이 아닙니다** — 라벨 글자가 섞여 있습니다.
test('note에 적힌 출항지 후보를 읽는다', () => {
  assert.deepEqual(
    portHints({ note: '자동 발견 — 시험 수집 8건. 출항지 후보: 장고항, 공지사항, 시입항 전화 후보: 010-1234-5678' }),
    ['장고항', '공지사항', '시입항'],
    '전화 후보는 섞이지 않습니다',
  );
  assert.deepEqual(portHints({ note: '출항지 후보: 홍원항 · 공지사항' }), ['홍원항', '공지사항']);
  assert.deepEqual(portHints({ note: '후보가 없는 메모' }), []);
  assert.deepEqual(portHints({}), []);
  assert.deepEqual(portHints(null), []);
});

test('후보는 합치기가 막힌 사이트 것만 준다', () => {
  const q = collectQuality(
    [
      { id: 'a', name: 'A', adapter: 'sunsang24', note: '출항지 후보: 장고항, 공지사항' },
      { id: 'b', name: 'B', adapter: 'thefishing', note: '출항지 후보: 오천항' },
      { id: 'c', name: 'C', adapter: 'generic', note: '출항지 후보: 대천항' },
    ],
    {
      trips: [
        // 가호는 두 사이트에 걸쳐 있고 a에 항구가 없습니다 — 지금 두 줄로 뜹니다.
        trip('a', '가호', { port: null }),
        trip('b', '가호'),
        // 나호는 c에만 있습니다 — 항구가 비어도 합칠 상대가 없습니다.
        trip('c', '나호', { port: null }),
      ],
    },
  );

  assert.deepEqual(q.portHints, [{ siteId: 'a', hints: ['장고항', '공지사항'] }],
    '합칠 상대가 없는 곳까지 목록에 넣으면 정작 급한 곳이 묻힙니다');
});

test('후보가 없는 사이트는 목록에 넣지 않는다', () => {
  const q = collectQuality(
    [{ id: 'a', name: 'A', adapter: 'sunsang24' }, { id: 'b', name: 'B', adapter: 'thefishing' }],
    { trips: [trip('a', '가호', { port: null }), trip('b', '가호')] },
  );
  assert.deepEqual(q.portHints, [], '적어둔 후보가 없으면 보여줄 것도 없습니다');
});
