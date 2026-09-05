// 화면(docs/index.html)은 테스트가 없어서 그동안 브라우저로만 확인했습니다.
// 문법이 깨지거나 필터 id가 바뀌면 화면이 통째로 안 뜨는데 CI가 못 잡습니다.
// 브라우저 없이 확인할 수 있는 만큼만 확인합니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('docs/index.html', 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

test('화면 스크립트에 문법 오류가 없다', () => {
  assert.ok(inline.length > 500, '인라인 스크립트를 찾지 못했습니다');
  // 파싱만 합니다. 실행하면 fetch/DOM이 필요합니다.
  assert.doesNotThrow(() => new Function(inline));
});

test('스크립트가 쓰는 요소가 화면에 다 있다', () => {
  const used = [...inline.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], 'id가 바뀌면 그 부분이 조용히 안 돕니다');
});

test('주요 필터는 다중 선택 메뉴다', () => {
  for (const id of ['f-site', 'f-region', 'f-port', 'f-species', 'f-session', 'f-date']) {
    assert.match(html, new RegExp(`<details class="multi" id="${id}"[\\s\\S]*?<div class="multi-menu"></div>`));
  }
  assert.match(inline, /selectedValues\('f-site'\)/);
});

test('어종 필터는 갑오징어·주꾸미·쭈꾸미를 기본 선택한다', () => {
  assert.match(inline, /fillOptions\(\$\('f-species'\),[\s\S]*\['갑오징어', '주꾸미', '쭈꾸미'\]\)/);
  assert.match(inline, /input\.checked = defaults\.includes\(v\)/);
});

test('data.json은 화면이 기대하는 모양이다', async () => {
  const data = JSON.parse(await readFile('docs/data.json', 'utf8'));
  for (const key of ['generatedAt', 'sites', 'trips']) {
    assert.ok(key in data, `data.json에 ${key}가 없습니다`);
  }
  assert.ok(Array.isArray(data.trips));
  for (const trip of data.trips.slice(0, 20)) {
    assert.match(trip.date ?? '', /^\d{4}-\d{2}-\d{2}$/, '날짜는 YYYY-MM-DD여야 합니다');
    assert.ok('seatsLeft' in trip && 'status' in trip);
  }
});
