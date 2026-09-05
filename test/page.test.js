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

test('어종 필터는 갑오징어·주꾸미를 기본 선택한다', () => {
  assert.match(inline, /fillOptions\(\$\('f-species'\),[\s\S]*\['갑오징어', '주꾸미'\]\)/);
  assert.match(inline, /input\.checked = defaults\.includes\(v\)/);
});

test('어종이 둘인 출조는 어느 쪽으로 걸러도 나온다', () => {
  const start = inline.indexOf('const speciesOf');
  const speciesOf = new Function(`${inline.slice(start, inline.indexOf('\n', start))}\nreturn speciesOf;`)();
  assert.deepEqual(speciesOf({ species: '주꾸미·갑오징어' }), ['주꾸미', '갑오징어']);
  assert.deepEqual(speciesOf({ species: '갈치' }), ['갈치']);
  assert.deepEqual(speciesOf({ species: null }), [], '어종을 모르는 출조는 어느 어종에도 안 걸립니다');
  assert.match(inline, /speciesOf\(t\)\.some\(\(s\) => species\.has\(s\)\)/);
});

test('빈자리 필터는 기본으로 켜져 있다', () => {
  assert.match(html, /id="f-open" checked/);
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

// 즐겨찾기 부분만 떼어내 실제로 돌려봅니다. 화면 전체는 fetch·DOM이 필요해 못 돌리지만,
// 이 블록은 localStorage·$·DATA만 받으면 되니 가짜로 채워 넣으면 그대로 실행됩니다.
function favModule(saved = []) {
  const start = inline.indexOf('// ── 즐겨찾기 ──');
  const end = inline.indexOf('// ── 즐겨찾기 끝 ──');
  assert.ok(start >= 0 && end > start, '즐겨찾기 블록 표시를 찾지 못했습니다');
  const src = inline.slice(start, end);

  const store = new Map(saved.length ? [['fishing:favorites', JSON.stringify(saved)]] : []);
  const localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const checks = { 'f-fav': { checked: true } };
  const DATA = { trips: [] };
  const module = new Function('localStorage', '$', 'DATA', 'refresh',
    `${src}\nreturn { FAVS, favKey, migrateFavs, emptyMessage, toggleFav };`,
  )(localStorage, (id) => checks[id], DATA, () => {});
  return { ...module, DATA, checks, stored: () => JSON.parse(store.get('fishing:favorites') ?? '[]') };
}

test('항구가 바뀐 즐겨찾기는 새 항구를 따라간다', () => {
  const m = favModule(['바하호|충남 태안 백사장항']);
  m.migrateFavs([{ boat: '바하호', port: '충남 태안 구매항' }]);
  assert.deepEqual([...m.FAVS], ['바하호|충남 태안 구매항']);
  assert.deepEqual(m.stored(), ['바하호|충남 태안 구매항'], '옮긴 결과가 저장돼야 다음에도 남습니다');
});

test('같은 이름의 배가 둘이면 즐겨찾기를 옮기지 않는다', () => {
  const m = favModule(['한바다호|충남 보령 대천항']);
  m.migrateFavs([
    { boat: '한바다호', port: '인천 옹진 영흥도' },
    { boat: '한바다호', port: '경남 통영 삼덕항' },
  ]);
  assert.deepEqual([...m.FAVS], ['한바다호|충남 보령 대천항'], '어느 쪽인지 모르면 그대로 둡니다');
});

test('즐겨찾기가 비었는지, 사라졌는지, 필터에 걸렸는지 갈라 말한다', () => {
  const empty = favModule();
  assert.match(empty.emptyMessage(), /☆/, '별을 누르라고 알려줘야 합니다');

  const gone = favModule(['없는배|']);
  gone.DATA.trips = [{ boat: '다른배', port: '' }];
  assert.match(gone.emptyMessage(), /지금 목록에 없습니다/);

  const filtered = favModule(['있는배|']);
  filtered.DATA.trips = [{ boat: '있는배', port: '' }];
  assert.match(filtered.emptyMessage(), /필터/);

  const off = favModule(['있는배|']);
  off.checks['f-fav'].checked = false;
  assert.equal(off.emptyMessage(), '조건에 맞는 출조가 없습니다.');
});

// 필터 메뉴 닫기도 떼어내 돌려봅니다. document만 가짜로 넣으면 그대로 실행됩니다.
function menuCloser(menus) {
  const start = inline.indexOf('function closeMenusOutside');
  const end = inline.indexOf('document.addEventListener', start);
  assert.ok(start >= 0 && end > start, 'closeMenusOutside를 찾지 못했습니다');
  const doc = { querySelectorAll: (sel) => (assert.match(sel, /details\.multi\[open\]/), menus.filter((m) => m.open)) };
  return new Function('document', `${inline.slice(start, end)}\nreturn closeMenusOutside;`)(doc);
}

test('열린 필터 메뉴는 바깥을 누르면 닫힌다', () => {
  const 표 = {}, 메뉴안 = {};
  const menus = [
    { open: true, contains: (t) => t === 메뉴안 },
    { open: false, contains: () => false },
  ];
  const close = menuCloser(menus);

  close(메뉴안);
  assert.equal(menus[0].open, true, '메뉴 안(체크박스·스크롤바)을 누른 건 그대로 둡니다');

  close(표);
  assert.equal(menus[0].open, false, '바깥을 누르면 닫혀야 합니다');
});

test('Esc로도 필터 메뉴가 닫힌다', () => {
  const menus = [{ open: true, contains: () => false }];
  menuCloser(menus)(null);
  assert.equal(menus[0].open, false);
  assert.match(inline, /keydown[\s\S]{0,80}Escape[\s\S]{0,40}closeMenusOutside\(null\)/);
});
