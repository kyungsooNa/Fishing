// 커버리지를 재는 숫자라 "합이 맞는가"가 거의 전부입니다. 계열별로 나눠 세다가 한 칸을
// 빠뜨리면 선상24 비중이 실제보다 낮게 나오고, 그 숫자를 보고 다음 작업을 고릅니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { summarize } from '../core/status.js';

const run = promisify(execFile);

const NOW = new Date('2026-09-08T12:00:00+09:00');
const ago = (hours) => new Date(Number(NOW) - hours * 3600_000).toISOString();

const site = (id, adapter, extra = {}) => ({ id, name: id, adapter, url: `https://${id}.example`, ...extra });
const trip = (siteId, extra = {}) => ({ siteId, boat: '가호', date: '2026-09-09', ...extra });

// 선상24 둘(하나는 실패) · 더피싱 상세 하나(보류) · 자체 하나(성공).
const registry = [
  site('a', 'sunsang24'),
  site('b', 'sunsang24'),
  site('t', 'thefishing', { source: 'detail' }),
  site('g', 'generic'),
  site('off', 'sunsang24', { enabled: false }),
];

const data = {
  generatedAt: ago(1),
  sites: {
    a: { ok: true, at: ago(1), count: 2, platform: '선상24' },
    b: { ok: false, at: ago(1), error: '500', count: 1, keptFrom: ago(7), platform: '선상24' },
    t: { ok: false, at: ago(1), error: 'timeout', skipped: 'timeout-backoff', count: 1, keptFrom: ago(30), platform: '더피싱(상세)' },
    g: { ok: true, at: ago(1), count: 1, platform: '자체' },
  },
  trips: [trip('a'), trip('a', { date: '2026-09-10' }), trip('b'), trip('t'), trip('g')],
};

test('계열별 합이 전체와 같다', () => {
  const s = summarize({ registry, data, now: NOW });
  const sum = (pick) => s.platforms.reduce((n, p) => n + pick(p), 0);

  assert.equal(sum((p) => p.trips), s.totals.trips, '출조를 어느 계열에도 안 넣고 흘리면 안 됩니다');
  assert.equal(sum((p) => p.sites.tracked), s.totals.sites.tracked);
  assert.equal(sum((p) => p.sites.ok), s.totals.sites.ok);
  assert.equal(s.freshness.reduce((n, b) => n + b.count, 0), s.totals.sites.tracked);
});

test('꺼둔 사이트는 등록 수에만 있고 집계에는 없다', () => {
  const s = summarize({ registry, data, now: NOW });
  assert.equal(s.totals.sites.registered, 5);
  assert.equal(s.totals.sites.disabled, 1);
  assert.equal(s.totals.sites.tracked, 4, '켜진 곳만 셉니다');
});

// 방금 끈 곳은 다음 수집 전까지 data.json에 남아 있습니다. 빼버리면 화면에 보이는
// 출조의 출처가 어디에도 안 잡혀서 합이 어긋납니다.
test('꺼둔 직후라 수집 결과에 남아 있는 사이트도 센다', () => {
  const s = summarize({
    registry,
    data: { ...data, sites: { ...data.sites, off: { ok: true, at: ago(1), count: 1, platform: '선상24' } } },
    now: NOW,
  });
  assert.equal(s.totals.sites.tracked, 5);
  assert.deepEqual(s.platforms.find((p) => p.label === '선상24').siteIds.sort(), ['a', 'b', 'off']);
});

test('백오프 보류는 실패로 세지 않고 성공률에서도 뺀다', () => {
  const s = summarize({ registry, data, now: NOW });
  assert.equal(s.totals.sites.failed, 1, '보류를 실패에 섞으면 정말 죽은 곳이 안 보입니다');
  assert.equal(s.totals.sites.skipped, 1);
  assert.equal(s.totals.successRate, 2 / 3, '요청한 세 곳 중 둘 성공 — 보류한 t는 분모에서 빠집니다');
});

// 성공률만 보면 "요청한 곳은 다 됐다"로 읽힙니다. 실제로 111곳이 보류 중인데도 100%가
// 나옵니다. 화면에 지금 얼마나 최신 값이 실려 있는지는 따로 세야 합니다.
test('최신 비율은 보류·기록 없음까지 분모에 넣는다', () => {
  const s = summarize({ registry, data, now: NOW });
  assert.equal(s.totals.freshRate, 0.5, '집계 4곳 중 성공 2곳');

  const held = summarize({
    registry: [site('t', 'thefishing', { source: 'detail' })],
    data: { sites: { t: { ok: false, skipped: 'timeout-backoff', at: ago(1), error: 'timeout', keptFrom: ago(3) } }, trips: [] },
    now: NOW,
  });
  assert.equal(held.totals.successRate, null, '한 곳도 요청 안 했으면 성공률은 없습니다');
  assert.equal(held.totals.freshRate, 0, '그래도 최신 값은 하나도 없습니다');
});

test('더피싱은 상세 방식을 따로 센다', () => {
  const s = summarize({
    registry: [...registry, site('t2', 'thefishing')],
    data: { ...data, sites: { ...data.sites, t2: { ok: true, at: ago(1), count: 0, platform: '더피싱' } } },
    now: NOW,
  });
  assert.deepEqual(
    s.platforms.map((p) => p.label).sort(),
    ['더피싱', '더피싱(상세)', '선상24', '자체'].sort(),
    '요청 수가 3배 다른 둘을 한 칸에 넣으면 어느 쪽이 죽었는지 안 보입니다',
  );
});

test('마지막 확인 시각은 실패한 곳의 직전 성공 시각으로 센다', () => {
  const s = summarize({ registry, data, now: NOW });
  const bucket = (label) => s.freshness.find((b) => b.label === label).count;

  assert.equal(bucket('1시간 이내'), 2, '방금 성공한 a·g');
  assert.equal(bucket('24시간 이내'), 1, '7시간 전 값을 쓰는 b — 실패한 시각이 아니라 값의 나이입니다');
  assert.equal(bucket('24시간 넘음'), 1, '30시간 전 값을 쓰는 t');
  assert.equal(bucket('확인된 적 없음'), 0);
});

test('한 번도 수집한 적 없는 사이트는 기록 없음으로 센다', () => {
  const s = summarize({ registry: [...registry, site('new', 'generic')], data, now: NOW });
  assert.equal(s.totals.sites.never, 1);
  assert.equal(s.freshness.find((b) => b.label === '확인된 적 없음').count, 1);
  assert.equal(s.totals.successRate, 2 / 3, '요청도 안 한 곳은 성공률을 낮추지 않습니다');
});

// registry에서 지웠는데 data.json에는 남아 있는 사이트. 출조를 어디에도 안 넣으면 합이 어긋납니다.
test('registry에 없는 사이트의 출조도 표기로 묶어 센다', () => {
  const s = summarize({
    registry: registry.filter((x) => x.id !== 'g'),
    data,
    now: NOW,
  });
  assert.equal(s.platforms.reduce((n, p) => n + p.trips, 0), s.totals.trips);
  assert.equal(s.platforms.find((p) => p.label === '자체').trips, 1, 'data.json에 남은 계열 표기를 씁니다');
});

test('계열 표기조차 없으면 알 수 없음으로 센다', () => {
  const s = summarize({ registry: [], data: { sites: {}, trips: [trip('ghost')] }, now: NOW });
  assert.equal(s.platforms.find((p) => p.label === '알 수 없음').trips, 1);
  assert.equal(s.platforms.reduce((n, p) => n + p.trips, 0), 1);
});

// 여러 사이트에서 온 줄을 계열마다 한 번씩 세면 합이 전체를 넘습니다. 대표 사이트 기준으로
// 한 번만 세고, 몇 줄이 합쳐진 것인지는 따로 알려줍니다.
test('합쳐진 출조는 대표 사이트 계열로 한 번만 센다', () => {
  const merged = trip('a', { sources: [{ siteId: 'a' }, { siteId: 't' }] });
  const s = summarize({ registry, data: { ...data, trips: [merged] }, now: NOW });

  assert.equal(s.totals.trips, 1);
  assert.equal(s.platforms.find((p) => p.label === '선상24').trips, 1);
  assert.equal(s.platforms.find((p) => p.label === '더피싱(상세)').trips, 0);
  assert.deepEqual(s.merged, { trips: 1, crossPlatform: 1 });
});

test('실패 목록은 값이 오래된 곳부터 준다', () => {
  const s = summarize({ registry, data, now: NOW });
  assert.deepEqual(s.failures.map((f) => f.id), ['t', 'b']);
  assert.deepEqual(s.failures.map((f) => f.state), ['skipped', 'failed']);
  assert.equal(s.failures[0].platform, '더피싱(상세)');
});

test('수집 결과가 비어 있어도 세다가 죽지 않는다', () => {
  const s = summarize({ registry, data: {}, now: NOW });
  assert.equal(s.totals.trips, 0);
  assert.equal(s.totals.sites.never, 4);
  assert.equal(s.totals.successRate, null);
  assert.deepEqual(s.merged, { trips: 0, crossPlatform: 0 });
});

// 세는 건 core/status.js가 맞게 하는데 화면에 뿌리다가 죽으면 명령이 통째로 못 씁니다
// (실제로 한 번 그랬습니다 — 표를 그리는 자리에서 초기화 전 변수를 썼습니다).
// 그래서 실제로 한 번 돌려봅니다.
async function runCli(args) {
  const dir = await mkdtemp(join(tmpdir(), 'status-'));
  const path = join(dir, 'data.json');
  await writeFile(path, JSON.stringify(data), 'utf8');
  return run(process.execPath, ['status.js', '--from', path, ...args]);
}

test('명령이 실제로 돈다', async () => {
  const { stdout } = await runCli([]);
  assert.match(stdout, /■ 전체/);
  assert.match(stdout, /■ 계열별/);
  assert.match(stdout, /선상24/);
});

test('--json은 그대로 파싱되는 형식이다', async () => {
  const { stdout } = await runCli(['--json']);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.totals.trips, data.trips.length);
  assert.ok(parsed.platforms.length);
});
