// 수집 전체를 한 번 돌려봅니다 — fetcher → 어댑터 → 합치기 → 저장까지.
//
// 조각마다 테스트가 있어도 이어붙인 데서 깨질 수 있습니다. 실제로 fetcher에
// dispatcher를 잘못 붙여 모든 사이트가 죽은 채로 머지된 적이 있습니다.
// 로컬 서버에 진짜 마크업 모양을 띄워두고 끝까지 돌립니다. 바깥 네트워크는 안 탑니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAll } from '../core/runner.js';
import { kstDate } from '../core/when.js';

// 날짜를 오늘 기준으로 만듭니다. 고정 날짜로 두면 그 날이 지나는 순간
// "지난 날짜 정리"에 걸려 테스트가 저절로 깨집니다.
function schedulePage(days) {
  const rows = days.map(({ date, boat, time, species, seats }) => `
    <tr>
      <td>${date}</td><td>7물</td>
      <td class="ships_warp">
        <table class="ship_unit"><tbody><tr>
          <td>${boat}</td>
          <td><ul><li>어종 : ${species}</li>
              <li class="shiptime"><strong>운항시간 :</strong> ${time}</li></ul></td>
          <td>${seats}</td>
        </tr></tbody></table>
      </td>
    </tr>`).join('');
  return `<html><body><table>${rows}</table></body></html>`;
}

const label = (offset) => {
  const [, m, d] = kstDate(offset).split('-');
  return `${Number(m)}월 ${Number(d)}일`;
};

test('수집 한 바퀴 — 받아오고, 읽고, 합치고, 저장한다', async () => {
  const page = schedulePage([
    { date: label(0), boat: '악바리호', time: '04:00 ~ 17:00', species: '주꾸미', seats: '5명 예약/21명' },
    { date: label(1), boat: '레드맨호', time: '13:00 ~ 18:00', species: '갑오징어', seats: '예약마감 20명 예약/20명' },
  ]);

  const server = createServer((req, res) => {
    if (!req.url.startsWith('/ship/schedule_fleet')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const dir = await mkdtemp(join(tmpdir(), 'fishing-smoke-'));
  const registryPath = join(dir, 'registry.json');
  const dataPath = join(dir, 'data.json');
  await writeFile(registryPath, JSON.stringify({
    sites: [{
      id: 'local', name: '로컬 선사', adapter: 'sunsang24',
      url: `http://127.0.0.1:${port}`, port: '충남 태안 구매항',
      phone: '010-0000-0000', mode: 'static',
      boats: { 악바리호: { prices: { 주꾸미: 100000 } } },
    }],
  }));

  try {
    const { data, failed } = await runAll({
      registryPath, dataPath, days: 21, now: new Date('2026-09-03T15:00:00Z'),
    });

    assert.deepEqual(failed, [], '실패한 사이트가 없어야 한다');
    assert.equal(data.trips.length, 2);

    const [first, second] = data.trips;
    assert.equal(first.boat, '악바리호');
    assert.equal(first.date, kstDate(0));
    assert.equal(first.seatsLeft, 16, '21명 정원에 5명 예약');
    assert.equal(first.session, '종일');
    assert.equal(first.price, 100000);
    assert.equal(first.port, '충남 태안 구매항');

    assert.equal(second.seatsLeft, 0, '예약마감');
    assert.equal(second.session, '오후');

    assert.ok(data.ports['충남 태안 구매항'], '항구 좌표가 지도용으로 실려야 한다');
    assert.equal(data.sites.local.platform, '선상24');

    const saved = JSON.parse(await readFile(dataPath, 'utf8'));
    assert.equal(saved.trips.length, 2, '파일로도 저장돼야 한다');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('수집 한 바퀴 — 자리가 나면 알림거리로 잡힌다', async () => {
  const page = schedulePage([
    { date: label(0), boat: '악바리호', time: '05:00 ~ 12:00', species: '광어', seats: '18명 예약/21명' },
  ]);
  const server = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const dir = await mkdtemp(join(tmpdir(), 'fishing-smoke-'));
  const registryPath = join(dir, 'registry.json');
  const dataPath = join(dir, 'data.json');
  await writeFile(registryPath, JSON.stringify({
    sites: [{ id: 'local', name: '로컬 선사', adapter: 'sunsang24', url: `http://127.0.0.1:${port}`, mode: 'static' }],
  }));
  // 어제는 마감이었다고 해둡니다.
  await writeFile(dataPath, JSON.stringify({
    generatedAt: '2026-01-01T00:00:00.000Z',
    sites: {},
    trips: [{ siteId: 'local', boat: '악바리호', date: kstDate(0), departAt: '05:00', status: 'closed', seatsLeft: 0 }],
  }));

  try {
    const { openings } = await runAll({
      registryPath, dataPath, days: 21, now: new Date('2026-09-03T15:00:00Z'),
    });
    assert.equal(openings.length, 1, '마감이던 배에 자리가 났으면 알린다');
    assert.equal(openings[0].reason, 'reopened');
    assert.equal(openings[0].seatsLeft, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
