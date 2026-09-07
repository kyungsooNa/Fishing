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

test('어종이 둘인 출조는 어느 쪽으로 걸러도 나오고, 값이 없는 것도 골라 볼 수 있다', () => {
  const start = inline.indexOf('const NO_SPECIES');
  const end = inline.indexOf('const NO_PORT');
  assert.ok(start >= 0 && end > start, '어종·운항 부분을 찾지 못했습니다');
  const m = new Function(`${inline.slice(start, end)}\nreturn { NO_SPECIES, NO_SESSION, speciesOf, sessionOf };`)();

  assert.deepEqual(m.speciesOf({ species: '주꾸미·갑오징어' }), ['주꾸미', '갑오징어']);
  assert.deepEqual(m.speciesOf({ species: '갈치' }), ['갈치']);
  // 값이 없다고 필터에서 통째로 빠지면 "왜 이 배가 안 보이지"가 됩니다.
  assert.deepEqual(m.speciesOf({ species: null }), [m.NO_SPECIES]);
  assert.equal(m.sessionOf({ session: '오전' }), '오전');
  assert.equal(m.sessionOf({ session: null }), m.NO_SESSION);

  assert.match(inline, /speciesOf\(t\)\.some\(\(s\) => species\.has\(s\)\)/);
  assert.match(inline, /hasSelection\(session, sessionOf\(t\)\)/);
});

test('빈자리 필터는 기본으로 켜져 있다', () => {
  assert.match(html, /id="f-open" checked/);
});

test('오후 3시 이후 오늘 출조는 화면에서 숨긴다', () => {
  assert.match(inline, /const HIDE_TODAY_AFTER = 15 \* 60/);
  assert.match(inline, /showTripByTime\(t\)/);
});

test('물때는 날짜 그룹 줄에 한 번만 표시한다', () => {
  assert.match(html, /<th>어종<\/th><th>상태<\/th>/);
  assert.match(inline, /function dayTideParts/);
  assert.match(inline, /td\.colSpan = 12/);
  assert.match(inline, /물때는 날짜별 공통 표기/);
});

test('좋은 물때는 날짜 줄에 배지로 표시한다', () => {
  assert.match(html, /\.tidegood/);
  assert.match(inline, /function isGoodTide/);
  assert.match(inline, /n === 12 \|\| n === 13 \|\| n === 1 \|\| n === 2/);
  assert.match(inline, /좋은 물때/);
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

// 항구 이름 다루는 부분도 떼어내 돌려봅니다. 바깥 것을 안 써서 그대로 실행됩니다.
function portModule() {
  const start = inline.indexOf("const NO_PORT");
  const end = inline.indexOf('function fillOptions');
  assert.ok(start >= 0 && end > start, 'NO_PORT 부분을 찾지 못했습니다');
  return new Function(`${inline.slice(start, end)}\nreturn { NO_PORT, portOf, regionOf };`)();
}

test('항구를 모르는 출조도 골라서 볼 수 있다', () => {
  const { NO_PORT, portOf, regionOf } = portModule();
  assert.equal(portOf({ port: null }), NO_PORT, '항구가 없다고 필터에서 빠지면 안 됩니다');
  assert.equal(regionOf(null), NO_PORT);
  assert.equal(portOf({ port: '충남 보령 대천항' }), '충남 보령 대천항');
  assert.equal(regionOf('충남 보령 대천항'), '충남 보령');
  assert.equal(regionOf('인천 중구 거잠포선착장'), '인천 중구');
  assert.equal(regionOf('영목항'), '영목항', '시·군을 안 적은 항구는 그대로 씁니다');
  assert.match(inline, /hasSelection\(port, portOf\(t\)\)/);
});

test('지도에서 빠진 출조는 몇 건인지 힌트에 적는다', () => {
  assert.match(inline, /항구를 모르는 출조 \$\{noPort\}건은 지도에 없습니다/);
  assert.match(inline, /좌표 없는 항구 \$\{noCoord\.size\}곳/);
});

// 별점은 현황판에서 읽기만 합니다. 이 블록도 localStorage·document만 가짜로 넣으면 돕니다.
function rateModule(saved) {
  const start = inline.indexOf('// ── 별점 보기 ──');
  const end = inline.indexOf('// ── 별점 보기 끝 ──');
  assert.ok(start >= 0 && end > start, '별점 블록 표시를 찾지 못했습니다');

  const localStorage = { getItem: () => (saved === undefined ? null : saved) };
  const document = { createElement: () => ({}) };
  return new Function('localStorage', 'document',
    `${inline.slice(start, end)}\nreturn { RATES, rateOf, rateStars, rateBadge };`,
  )(localStorage, document);
}

test('현황판은 별점을 읽기만 한다', async () => {
  // 저장하는 코드가 여기 있으면 표를 누르다 점수가 바뀝니다. 매기는 곳은 관리 화면 한 군데입니다.
  assert.ok(!inline.includes('setRate'), '현황판에 별점을 고치는 코드가 있습니다');
  assert.ok(!/setItem\(\s*RATE_KEY/.test(inline), '현황판이 별점을 저장하고 있습니다');
  // 누를 수 있는 것처럼 보이면 안 됩니다 — 버튼이 아니라 글자로 붙입니다.
  assert.match(inline, /span\.className = 'rate'/);
  assert.match(inline, /rateBadge\(src\.siteId\)/, '선사 칸에 붙어야 합니다');

  // 저장 형식은 관리 화면과 같아야 합니다. 어긋나면 매긴 별점이 안 보입니다.
  const adminInline = (await readFile('docs/admin.html', 'utf8')).match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  for (const line of ["const RATE_KEY = 'fishing:ratings';", 'const RATE_MAX = 5;']) {
    assert.ok(inline.includes(line) && adminInline.includes(line), `양쪽이 같이 써야 합니다: ${line}`);
  }
});

test('매기지 않은 선사에는 별점을 붙이지 않는다', () => {
  const m = rateModule(JSON.stringify({ aaa: 4 }));
  assert.equal(m.rateOf(m.RATES, 'aaa'), 4);
  assert.equal(m.rateOf(m.RATES, 'bbb'), 0);
  assert.equal(m.rateBadge('bbb'), null, '288곳에 ☆☆☆☆☆가 깔리면 표가 안 읽힙니다');
  assert.equal(m.rateBadge('aaa').textContent, '★★★★☆');
  assert.match(m.rateBadge('aaa').title, /시스템 관리/, '어디서 매기는지 알려줘야 합니다');
});

test('별점 저장값이 깨져 있어도 화면은 그대로 돈다', () => {
  assert.deepEqual(rateModule('붙여넣다 만 글자').RATES, {});
  assert.deepEqual(rateModule('[1,2,3]').RATES, {}, '객체가 아니면 없는 셈 칩니다');
  assert.deepEqual(rateModule().RATES, {});

  const m = rateModule(JSON.stringify({ a: 0, b: 6, c: 2.5, d: '3', e: null }));
  for (const id of ['a', 'b', 'c', 'e']) assert.equal(m.rateOf(m.RATES, id), 0, `${id}는 별점이 아닙니다`);
  assert.equal(m.rateOf(m.RATES, 'd'), 3);
  assert.equal(m.rateStars(3), '★★★☆☆');
  assert.equal(m.rateStars(0), '☆☆☆☆☆');
});

// 쪽 나누기도 떼어내 돌려봅니다. 바깥 것을 안 써서 그대로 실행됩니다.
function pager() {
  const start = inline.indexOf('// ── 쪽 나누기 ──');
  const end = inline.indexOf('// ── 쪽 나누기 끝 ──');
  assert.ok(start >= 0 && end > start, '쪽 나누기 블록 표시를 찾지 못했습니다');
  return new Function(
    `${inline.slice(start, end)}\nreturn { DAYS_PER_PAGE, paginate, get PAGE() { return PAGE; }, set PAGE(v) { PAGE = v; } };`,
  )();
}

const trip = (date, boat) => ({ date, boat });

test('표는 일주일치씩 끊어서 보여준다', () => {
  const m = pager();
  assert.equal(m.DAYS_PER_PAGE, 7);

  // 출조가 있는 날 10일치. 달력 주가 아니라 날짜 7개가 한 쪽입니다.
  const days = ['09', '10', '11', '12', '13', '14', '15', '16', '17', '18'].map((d) => `2026-09-${d}`);
  const trips = days.flatMap((d) => [trip(d, '가'), trip(d, '나')]);

  const first = m.paginate(trips);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.groups[0], days.slice(0, 7));
  assert.deepEqual(first.groups[1], days.slice(7));
  assert.equal(first.rows.length, 14, '한 쪽에 7일 × 2건');
  assert.deepEqual([...new Set(first.rows.map((t) => t.date))], days.slice(0, 7));

  m.PAGE = 1;
  const second = m.paginate(trips);
  assert.deepEqual([...new Set(second.rows.map((t) => t.date))], days.slice(7));
  assert.equal(second.rows.length, 6, '한 날의 출조가 두 쪽에 갈리면 안 됩니다');
});

test('필터를 좁혀 쪽이 사라지면 마지막 쪽으로 당긴다', () => {
  const m = pager();
  m.PAGE = 5;
  const view = m.paginate([trip('2026-09-09'), trip('2026-09-10')]);
  assert.equal(m.PAGE, 0, '없는 쪽을 보고 있으면 표가 빈 채로 남습니다');
  assert.equal(view.pages, 1);
  assert.equal(view.rows.length, 2);

  // 출조가 하나도 없어도 죽지 않아야 합니다.
  m.PAGE = 3;
  const none = m.paginate([]);
  assert.equal(none.pages, 1);
  assert.deepEqual(none.rows, []);
});

test('쪽 넘기는 막대는 표 위아래에 있고, 한 쪽뿐이면 숨는다', () => {
  for (const id of ['pager-top', 'pager-bottom']) {
    assert.ok(html.includes(`id="${id}"`), `쪽 막대가 없습니다: ${id}`);
  }
  assert.match(inline, /box\.hidden = view\.pages <= 1 \|\| !\$\('map'\)\.hidden/);
  assert.match(inline, /aria-current/, '지금 보는 주가 어디인지 알려줘야 합니다');
  // 필터를 바꾸면 보던 쪽 번호는 의미가 없습니다.
  assert.match(inline, /const filtered = \(\) => \{ PAGE = 0; refresh\(\); \}/);
  assert.match(inline, /updateMultiLabel\(control\); filtered\(\);/);
  assert.match(inline, /\$\('f-q'\)\.addEventListener\('input', filtered\)/);
});

test('표가 옆으로 삐져나가지 않게 긴 이름 칸만 줄이 갈린다', () => {
  // 모든 칸에 nowrap을 걸면 표의 자연 폭이 화면을 넘어 오른쪽 칸이 잘립니다.
  assert.ok(!/th, td \{[^}]*white-space: nowrap/.test(html), '칸 전체에 nowrap을 걸면 안 됩니다');
  assert.match(html, /th, td\.nowrap, td\.num, td\.starcell, td\.watchcell \{ white-space: nowrap; \}/);
  // 날짜·운항·구분·상태는 갈리면 읽기 나쁩니다. 선사·배·항구·어종에서 폭을 법니다.
  assert.match(inline, /if \(i <= 2 \|\| i === 7\) td\.className = 'nowrap';/);
  assert.match(inline, /watchCell\.className = 'watchcell';/);
});
