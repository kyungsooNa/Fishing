// 실패 격리는 이 프로젝트의 핵심 약속입니다 — 한 사이트가 죽어도 나머지는 살고,
// 죽은 사이트는 직전 결과를 그대로 남깁니다. 화면이 갑자기 비면 안 됩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAll } from '../core/runner.js';

async function fixture(sites, prevData = null) {
  const dir = await mkdtemp(join(tmpdir(), 'fishing-'));
  const registryPath = join(dir, 'registry.json');
  const dataPath = join(dir, 'data.json');
  await writeFile(registryPath, JSON.stringify({ sites }));
  if (prevData) await writeFile(dataPath, JSON.stringify(prevData));
  return { registryPath, dataPath };
}

const mockSite = { id: 'mock', name: '예시', adapter: '_mock', url: 'https://example.invalid' };
const brokenSite = { id: 'broken', name: '깨진곳', adapter: '_nonexistent', url: 'https://example.invalid' };

test('한 사이트가 죽어도 나머지는 수집된다', async () => {
  const { registryPath, dataPath } = await fixture([mockSite, brokenSite]);
  const { data, failed } = await runAll({ registryPath, dataPath, days: 21 });

  assert.deepEqual(failed, ['broken']);
  assert.ok(data.trips.length > 0, '살아있는 사이트의 출조는 남아야 한다');
  assert.equal(data.sites.mock.ok, true);
  assert.equal(data.sites.broken.ok, false);
  assert.match(data.sites.broken.error, /_nonexistent/);
});

test('죽은 사이트는 직전 결과를 그대로 남긴다', async () => {
  const 어제것 = {
    generatedAt: '2026-09-01T00:00:00.000Z',
    sites: { broken: { ok: true, at: '2026-09-01T00:00:00.000Z', count: 1 } },
    trips: [{ siteId: 'broken', siteName: '깨진곳', boat: '옛날호', date: '2999-12-31', status: 'open', seatsLeft: 3 }],
  };
  const { registryPath, dataPath } = await fixture([brokenSite], 어제것);
  const { data } = await runAll({ registryPath, dataPath, days: 21 });

  assert.equal(data.trips.length, 0, '수집 범위 밖 날짜는 정리된다');
  assert.equal(data.sites.broken.ok, false);
  assert.equal(data.sites.broken.keptFrom, '2026-09-01T00:00:00.000Z', '언제 것을 남겼는지 알 수 있어야 한다');
});

test('수집 결과를 파일로 남긴다', async () => {
  const { registryPath, dataPath } = await fixture([mockSite]);
  await runAll({ registryPath, dataPath, days: 21 });

  const saved = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.ok(saved.generatedAt);
  assert.equal(saved.sites.mock.platform, '예시', '계열 꼬리표가 같이 저장된다');
  assert.ok(saved.trips.every((t) => t.date >= saved.trips[0].date), '날짜순으로 정렬된다');
});

test('dryRun이면 파일을 건드리지 않는다', async () => {
  const { registryPath, dataPath } = await fixture([mockSite]);
  const { data } = await runAll({ registryPath, dataPath, days: 21, dryRun: true });

  assert.ok(data.trips.length > 0);
  await assert.rejects(readFile(dataPath, 'utf8'), '파일이 생기면 안 된다');
});
