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
  for (const id of ['f-platform', 'f-site', 'f-region', 'f-port', 'f-species', 'f-session', 'f-date']) {
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
  assert.match(inline, /showTripByTime\(t, kst\)/);
  assert.match(inline, /const kst = kstParts\(\);/, '기준 시각은 거르기 전에 한 번만 구합니다');
});

// 여기서 한 번 크게 데었습니다. showTripByTime이 출조마다 kstParts()를 부르고
// kstParts()가 매번 Intl.DateTimeFormat을 새로 만들어서, 1만 건을 거르는 데 3초가 걸렸습니다.
// 검색어 한 글자마다 그게 세 번이라 화면이 멈춘 것처럼 보였습니다.
test('시각 포맷터는 한 번만 만든다', () => {
  const made = inline.match(/new Intl\.DateTimeFormat/g) ?? [];
  assert.equal(made.length, 1, '포맷터를 여러 번 만들면 거를 때마다 그 값을 다 치릅니다');
  assert.match(inline, /const KST_FORMAT = new Intl\.DateTimeFormat/, '만드는 자리는 함수 밖이어야 합니다');
  assert.match(inline, /KST_FORMAT\.formatToParts\(now\)/);

  // 실제로 돌려봅니다. 이 블록은 바깥 것을 안 써서 그대로 실행됩니다.
  const start = inline.indexOf('const KST_FORMAT');
  const end = inline.indexOf('const NO_SPECIES', start);
  assert.ok(start >= 0 && end > start, '시각 부분을 찾지 못했습니다');
  const m = new Function(`${inline.slice(start, end)}\nreturn { kstParts, showTripByTime };`)();
  const noon = m.kstParts(new Date('2026-09-07T03:00:00Z'));   // 한국 12:00
  assert.equal(noon.date, '2026-09-07');
  assert.equal(noon.minutes, 12 * 60);
  assert.equal(m.showTripByTime({ date: '2026-09-07' }, noon), true, '정오에는 오늘 출조를 보여줍니다');
  const late = m.kstParts(new Date('2026-09-07T07:00:00Z'));   // 한국 16:00
  assert.equal(m.showTripByTime({ date: '2026-09-07' }, late), false);
  assert.equal(m.showTripByTime({ date: '2026-09-08' }, late), true, '내일 출조는 그대로 둡니다');
});

// 표와 지도가 각자 거르면 같은 1만 건을 두 번(예전엔 세 번) 훑습니다.
test('한 번 거른 결과를 표와 지도가 나눠 쓴다', () => {
  assert.match(inline, /const refresh = \(\) => \{ const trips = sortTrips\(visibleTrips\(\)\); render\(trips\); drawMap\(trips\); \}/);
  assert.match(inline, /function render\(all = sortTrips\(visibleTrips\(\)\)\)/, '혼자 부르는 자리도 있어 기본값을 둡니다');
  assert.match(inline, /function drawMap\(trips = visibleTrips\(\)\)/);
  assert.ok(!/const hidden = visibleTrips\(\)/.test(inline), '지도가 다시 거르면 안 됩니다');
});

// 한 쪽이 3천 줄 · 4만 노드입니다. 살아 있는 표에 하나씩 붙이면 붙일 때마다 값을 치릅니다.
test('표의 행은 조각에 모아 한 번에 붙인다', () => {
  assert.match(inline, /const frag = document\.createDocumentFragment\(\);/);
  assert.match(inline, /\$\('rows'\)\.replaceChildren\(frag\);/);
  assert.ok(!/tbody\.append/.test(inline), '살아 있는 표에 직접 붙이면 안 됩니다');
});

test('날짜별 물때는 한 번에 모은다', () => {
  const start = inline.indexOf('function tidesByDate');
  const end = inline.indexOf('function kstParts');
  assert.ok(start >= 0 && end > start, 'tidesByDate를 찾지 못했습니다');
  const src = `function dayLabel(d){return d;}\nfunction isGoodTide(t){return t === '조금';}\n${inline.slice(start, end)}`;
  const m = new Function(`${src}\nreturn { tidesByDate, dayTideParts };`)();

  const rows = [
    { date: '2026-09-07', tide: '1물' }, { date: '2026-09-07', tide: '1물' },
    { date: '2026-09-07', tide: '조금' }, { date: '2026-09-08', tide: null },
  ];
  const map = m.tidesByDate(rows);
  assert.deepEqual([...map.get('2026-09-07')], ['1물', '조금'], '같은 물때는 한 번만 적습니다');
  // 위 rows는 1물 2건 · 조금 1건이라 많이 쓰인 순서가 그대로 나옵니다.
  assert.equal(map.has('2026-09-08'), false);

  assert.deepEqual(m.dayTideParts('2026-09-07', map.get('2026-09-07')),
    { label: '2026-09-07 · 1물 / 조금', good: true });
  assert.deepEqual(m.dayTideParts('2026-09-08', map.get('2026-09-08')),
    { label: '2026-09-08', good: false }, '물때를 모르는 날도 날짜는 나옵니다');
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
  assert.match(inline, /좋은 물때/);
});

// 어떤 물때가 좋은 물때인지는 글자를 찾아 확인하면 조건을 고칠 때마다 테스트도
// 같이 고쳐야 해서 아무것도 못 잡습니다. 함수를 꺼내 값으로 확인합니다.
function goodTide() {
  const start = inline.indexOf('const GOOD_TIDE_NAMES');
  const end = inline.indexOf('function tidesByDate');
  assert.ok(start >= 0 && end > start, 'isGoodTide를 찾지 못했습니다');
  return new Function(`${inline.slice(start, end)}\nreturn { isGoodTide };`)().isGoodTide;
}

test('좋은 물때는 조금 앞뒤 — 12~15물, 조금·무시, 1~4물', () => {
  const isGoodTide = goodTide();
  for (const t of ['조금', '무시', '12물', '13물', '14물', '15물', '1물', '2물', '3물', '4물']) {
    assert.equal(isGoodTide(t), true, `${t}은 좋은 물때입니다`);
  }
  for (const t of ['5물', '7물', '9물', '11물', null, '']) {
    assert.equal(isGoodTide(t), false, `${t}은 좋은 물때가 아닙니다`);
  }
});

// 같은 날을 사이트마다 다르게 부릅니다. 2026-09-16 하루에 12물 235건 · 한객기 150건 ·
// 13물 108건이 같이 붙었습니다. 표기에 따라 배지가 붙었다 안 붙었다 하면 안 됩니다.
test('이름으로 부르는 물때도 같은 날이면 같은 판단을 받는다', () => {
  const isGoodTide = goodTide();
  // 9/16 = 12물 = 한객기, 9/17 = 13물 = 대객기 (수집 결과에서 확인한 대응)
  assert.equal(isGoodTide('한객기'), isGoodTide('12물'));
  assert.equal(isGoodTide('대객기'), isGoodTide('13물'));
  assert.equal(isGoodTide('조금'), isGoodTide('14물'));
  assert.equal(isGoodTide('무시'), isGoodTide('15물'));
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
  const checks = { 'f-fav': { checked: true }, 'f-fav-label': { textContent: '' } };
  const DATA = { trips: [] };
  // 별을 누르면 표를 통째로 다시 그리는 대신 그 별들만 고쳐 그립니다. 그 두 가지를
  // 가짜로 넣어 실제로 어느 쪽이 도는지 봅니다.
  const ROW_BUTTONS = [];
  let refreshed = 0;
  const paintStar = (star, on) => { star.on = on; };
  const module = new Function('localStorage', '$', 'DATA', 'refresh', 'ROW_BUTTONS', 'paintStar',
    `${src}\nreturn { FAVS, favKey, favLabel, migrateFavs, emptyMessage, toggleFav };`,
  )(localStorage, (id) => checks[id], DATA, () => { refreshed += 1; }, ROW_BUTTONS, paintStar);
  return { ...module, DATA, checks, ROW_BUTTONS,
    refreshed: () => refreshed,
    stored: () => JSON.parse(store.get('fishing:favorites') ?? '[]') };
}

// 별 하나 누를 때마다 표(행 1200개 · 노드 2만 개)를 다시 그리면 130ms씩 멈춥니다.
// 줄이 사라져야 하는 경우가 아니면 별만 고쳐 그립니다.
test('별을 누르면 표를 다시 그리지 않고 그 별만 고쳐 그린다', () => {
  const m = favModule();
  m.checks['f-fav'].checked = false;   // "즐겨찾기만"이 꺼져 있으면 나오는 줄은 그대로입니다
  // 같은 배가 여러 날에 여러 줄로 나옵니다 — 키가 이름+출항지라서 전부 같이 켜져야 합니다.
  const 같은배 = [{ boat: '무적호', port: '충남 보령 대천항' }, { boat: '무적호', port: '충남 보령 대천항' }];
  const 다른배 = { boat: '한바다호', port: '인천 옹진 영흥도' };
  for (const trip of [...같은배, 다른배]) m.ROW_BUTTONS.push({ trip, star: { on: false }, watch: null });

  m.toggleFav(같은배[0]);
  assert.equal(m.refreshed(), 0, '표를 다시 그리면 안 됩니다');
  assert.deepEqual(m.ROW_BUTTONS.map((r) => r.star.on), [true, true, false], '같은 배는 다 같이 켜집니다');
  assert.deepEqual(m.stored(), ['무적호|충남 보령 대천항']);
  assert.equal(m.checks['f-fav-label'].textContent, '★ 즐겨찾기만 (1)', '개수도 같이 고쳐야 합니다');

  m.toggleFav(같은배[1]);
  assert.deepEqual(m.ROW_BUTTONS.map((r) => r.star.on), [false, false, false]);
  assert.equal(m.refreshed(), 0);
});

test('"즐겨찾기만"을 켠 채로 별을 빼면 그 줄이 사라져야 하므로 다시 그린다', () => {
  const m = favModule(['무적호|충남 보령 대천항']);
  m.checks['f-fav'].checked = true;
  m.ROW_BUTTONS.push({ trip: { boat: '무적호', port: '충남 보령 대천항' }, star: { on: true }, watch: null });

  m.toggleFav({ boat: '무적호', port: '충남 보령 대천항' });
  assert.equal(m.refreshed(), 1, '줄이 사라져야 하면 표를 다시 그립니다');
});

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

test('관리창에서 별점을 바꾸면 열린 현황판에도 바로 반영한다', () => {
  assert.match(inline, /window\.addEventListener\('storage'/);
  assert.match(inline, /event\.key !== RATE_KEY/);
  assert.match(inline, /RATES = loadRates\(\);\s+refresh\(\);/);
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
  assert.match(inline, /\$\('f-q'\)\.addEventListener\('input', queueSearch\)/);
});

// 한 글자마다 1만 건을 다시 거르면 "무적호"를 치는 동안 표를 예닐곱 번 다시 그립니다.
// 한글은 조합 중에도 input이 떠서(ㅁ→무→뭇→무적) 디바운스만으로는 모자랍니다.
test('검색어는 손이 멈춘 뒤에, 한글 조합이 끝난 뒤에 건다', () => {
  const start = inline.indexOf('const SEARCH_DELAY');
  const end = inline.indexOf('// <details>는');
  assert.ok(start >= 0 && end > start, '검색어 디바운스 부분을 찾지 못했습니다');

  const handlers = {};
  const $ = () => ({ addEventListener: (type, fn) => { handlers[type] = fn; } });
  let ran = 0;
  const timers = [];
  const setTimeout = (fn) => (timers.push(fn), timers.length);
  const clearTimeout = (id) => { if (id) timers[id - 1] = null; };
  new Function('$', 'filtered', 'setTimeout', 'clearTimeout', inline.slice(start, end))(
    $, () => { ran += 1; }, setTimeout, clearTimeout);
  const fire = () => { for (const fn of timers.splice(0)) fn?.(); };

  handlers.input(); handlers.input(); handlers.input();
  fire();
  assert.equal(ran, 1, '연달아 친 글자는 한 번만 겁니다');

  ran = 0;
  handlers.compositionstart();
  handlers.input();
  fire();
  assert.equal(ran, 0, '조합 중(ㅁ, 무)에는 그리지 않습니다');
  handlers.compositionend();
  fire();
  assert.equal(ran, 1, '조합이 끝나면 겁니다');
});

test('감시를 걸고 풀 때도 표를 다시 그리지 않는다', () => {
  // 예전엔 버튼 문구 하나 바꾸자고 render()를 통째로 불렀습니다.
  assert.ok(!/monitorMessage\(\); render\(\);/.test(inline), '감시 토글이 표를 다시 그리면 안 됩니다');
  assert.match(inline, /for \(const row of ROW_BUTTONS\) if \(row\.watch\) paintWatch\(row\.watch, row\.trip\);/);
  // 표를 다시 그리지 않으니 버튼을 직접 풀어줘야 합니다. 안 그러면 영영 눌리지 않습니다.
  assert.match(inline, /button\.disabled = false;\s+\/\/ 표를 다시 그리지 않으니/);
  assert.match(inline, /ROW_BUTTONS\.push\(\{ trip: t, star, watch \}\);/);
  assert.match(inline, /ROW_BUTTONS\.length = 0;/, '다시 그릴 때마다 비워야 옛 버튼이 안 남습니다');
});

test('표가 옆으로 삐져나가지 않게 긴 이름 칸만 줄이 갈린다', () => {
  // 모든 칸에 nowrap을 걸면 표의 자연 폭이 화면을 넘어 오른쪽 칸이 잘립니다.
  assert.ok(!/th, td \{[^}]*white-space: nowrap/.test(html), '칸 전체에 nowrap을 걸면 안 됩니다');
  assert.match(html, /th, td\.nowrap, td\.num, td\.starcell, td\.watchcell \{ white-space: nowrap; \}/);
  // 날짜·운항·구분·상태는 갈리면 읽기 나쁩니다. 선사·배·항구·어종에서 폭을 법니다.
  assert.match(inline, /if \(i <= 2 \|\| i === 7\) td\.classList\.add\('nowrap'\);/);
  assert.match(inline, /watchCell\.className = 'watchcell';/);
});

test('모바일에서는 출조 한 건이 사진형 식별 타일을 둔 카드로 보인다', () => {
  assert.match(html, /@media \(max-width: 720px\)/);
  assert.match(html, /tbody tr\.triprow \{[^}]*display: grid;[^}]*grid-template-areas:/s);
  assert.match(html, /"thumb boat state"[\s\S]*"thumb port watch"/);
  assert.match(html, /\.boatmark \{ display: flex;/);
  assert.match(inline, /tr\.className = 'triprow';/);
  assert.match(inline, /boatMark\.textContent = \(t\.boat \?\? '배'\)/);
  assert.match(inline, /starCell\.append\(boatMark, star\);/);
  assert.match(html, /\.cell-site \{[^}]*overflow: visible;[^}]*white-space: normal;/,
    '선사 이름 뒤의 별점이 작은 화면에서 잘리면 안 됩니다');
});

test('모바일 필터는 가로 칩이고 선택된 값이 눈에 띈다', () => {
  assert.match(html, /\.filters \{ position: sticky;[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/s);
  assert.match(html, /\.multi\[data-selected="1"\] summary/);
  assert.match(inline, /control\.dataset\.selected = checked\.length \? '1' : '0';/);
});

// ── 플랫폼(예약 사이트 계열) ────────────────────────────────────────────────
// "선상24 밖도 같이 본다"가 이 화면의 존재 이유인데, 어디서 온 출조인지 보이지도 고르지도
// 못했습니다. 계열 표기는 화면이 registry를 못 읽어서 data.json의 사이트 상태에서 옵니다.
function platformFns() {
  const start = inline.indexOf('const UNKNOWN_PLATFORM');
  const end = inline.indexOf('function fillOptions');
  assert.ok(start >= 0 && end > start, '플랫폼 헬퍼를 찾지 못했습니다');
  return new Function(`${inline.slice(start, end)}\nreturn { platformOf, platformsOf };`)();
}

test('플랫폼 필터가 있고 표에도 걸린다', () => {
  assert.match(html, /id="f-platform"[\s\S]*?<div class="multi-menu"><\/div>/);
  assert.match(inline, /selectedValues\('f-platform'\)/);
  assert.match(inline, /platformsOf\(DATA\.sites, t\)\.some/);
  assert.match(inline, /fillOptions\(\$\('f-platform'\)/);
});

test('(상세)는 우리가 긁는 방식이라 사용자에게는 떼고 보여준다', () => {
  const { platformOf } = platformFns();
  const sites = { a: { platform: '더피싱(상세)' }, b: { platform: '더피싱' }, c: { platform: '선상24' } };
  assert.equal(platformOf(sites, 'a'), '더피싱');
  assert.equal(platformOf(sites, 'b'), '더피싱');
  assert.equal(platformOf(sites, 'c'), '선상24');
});

test('계열을 모르는 사이트도 한 칸으로 모은다', () => {
  const { platformOf } = platformFns();
  assert.equal(platformOf({}, 'ghost'), '(미상)', '거르는 순간 이유 없이 사라지면 안 됩니다');
  assert.equal(platformOf(undefined, 'ghost'), '(미상)');
});

test('합쳐진 줄은 출처의 플랫폼을 모두 돌려준다', () => {
  const { platformsOf } = platformFns();
  const sites = { s: { platform: '선상24' }, f: { platform: '더피싱(상세)' } };

  assert.deepEqual(platformsOf(sites, { siteId: 's' }), ['선상24']);
  assert.deepEqual(
    platformsOf(sites, { siteId: 's', sources: [{ siteId: 's' }, { siteId: 'f' }] }),
    ['선상24', '더피싱'],
    '둘 중 하나만 골라도 걸려야 합니다 — 어디서 잡든 같은 자리입니다',
  );
  assert.deepEqual(
    platformsOf(sites, { siteId: 's', sources: [{ siteId: 'f' }, { siteId: 'f' }] }),
    ['더피싱'],
    '같은 플랫폼이 둘이면 한 번만',
  );
});

test('출처마다 계열 배지를 달고, 잔여석이 갈리면 그 숫자도 보여준다', () => {
  assert.match(html, /\.srcchip/);
  assert.match(html, /\.srcseats/);
  assert.match(inline, /function platformChip/);
  assert.match(inline, /td\.append\(platformChip\(src\.siteId\)\)/);
  // 합친 줄은 잔여석이 큰 쪽을 쓰므로(core/merge.js) 어느 사이트에 그 자리가 있는지는
  // 출처별 숫자를 보여줘야만 알 수 있습니다.
  assert.match(inline, /const split = sources\.length > 1 && new Set\(seats\)\.size > 1;/);
});

// 주소로 날짜를 지정할 수 있는 사이트는 그 날 예약 화면이 바로 열리고, 아닌 곳은 일정표
// 한 장으로 갑니다. 누르기 전에 알아야 해서 링크 옆에 적습니다(TODO 2번).
test('날짜로 못 가는 링크는 링크 옆에 그렇다고 적는다', () => {
  assert.match(html, /\.srchint/);
  assert.match(inline, /if \(!src\.urlDated && src\.url\)/);
  assert.match(inline, /hint\.textContent = '일정표';/);
  assert.match(inline, /주소로 날짜를 지정할 수 없습니다/);
});

test('합쳐지지 않은 줄도 출처 하나로 똑같이 그린다', () => {
  assert.match(inline, /siteName: t\.siteName, url: t\.url, seatsLeft: t\.seatsLeft, urlDated: t\.urlDated/);
});

// ── 전화 걸기 ───────────────────────────────────────────────────────────────
// 번호는 시스템 관리 화면에만 있었습니다. 자리를 찾은 사람이 배 이름을 들고 다시
// 검색해야 했다는 뜻입니다 — 취소석은 전화가 제일 빠른데 말입니다.
function phoneFns() {
  const start = inline.indexOf('// ── 전화 걸기 ──');
  const end = inline.indexOf('// ── 전화 걸기 끝 ──');
  assert.ok(start >= 0 && end > start, '전화 블록 표시를 찾지 못했습니다');
  const document = { createElement: () => ({}) };
  return new Function('document', `${inline.slice(start, end)}\nreturn { phoneHref, phoneLink };`)(document);
}

test('전화번호는 표기가 제각각이라 tel: 에는 숫자만 넣는다', () => {
  const { phoneHref } = phoneFns();
  assert.equal(phoneHref('010-9791-4445'), 'tel:01097914445');
  assert.equal(phoneHref('010.9791.4445'), 'tel:01097914445');
  assert.equal(phoneHref(' 051 123 4567 '), 'tel:0511234567');
  assert.equal(phoneHref('+82-10-9791-4445'), 'tel:+821097914445');
});

test('번호가 없으면 아무것도 달지 않는다', () => {
  const { phoneHref, phoneLink } = phoneFns();
  assert.equal(phoneHref(null), null);
  assert.equal(phoneHref(''), null);
  assert.equal(phoneHref('전화문의'), null, '숫자가 없으면 걸 수 없습니다');
  assert.equal(phoneLink(null), null, '빈 칸에 빈 링크를 달면 줄만 늘어납니다');
});

test('보여주는 글자는 registry에 적어둔 표기 그대로다', () => {
  const { phoneLink } = phoneFns();
  const a = phoneLink('010-9791-4445');
  assert.equal(a.href, 'tel:01097914445');
  assert.equal(a.textContent, '\u260e 010-9791-4445', '사람이 눈으로 맞춰보는 값입니다');
  assert.equal(a.className, 'phone');
});

test('전화는 선사 칸에 줄마다 한 번만 단다', () => {
  // 칸을 새로 만들면 표의 자연 폭이 그만큼 늘어 오른쪽 칸(관심 출조)이 잘립니다.
  assert.match(html, /\.phone \{ display: block;/);
  assert.match(inline, /const phone = phoneLink\(t\.phone\);/);
  assert.match(inline, /if \(phone\) td\.append\(phone\);/);
  // 합쳐진 줄도 번호는 하나입니다(core/merge.js) — 출처마다 달면 같은 번호가 두 번 나옵니다.
  assert.ok(!inline.includes('phoneLink(src.phone)'), '출처마다 달면 같은 번호가 겹칩니다');
});

// ── 정렬 ────────────────────────────────────────────────────────────────────
// 값이 없는 행이 어디로 가는지가 이 기능의 거의 전부입니다. 승선료는 지금 99%가 비어 있어서
// (node quality.js) 낮은순으로 올리면 첫 화면이 빈 칸으로 덮입니다.
function sortFns(sites = {}) {
  const start = inline.indexOf('const SORTS = {');
  const end = inline.indexOf('// ── 쪽 나누기');
  assert.ok(start >= 0 && end > start, '정렬 함수를 찾지 못했습니다');
  const stub = `const DATA = ${JSON.stringify({ sites })};\nconst $ = () => ({ value: 'default' });\n`;
  return new Function(`${stub}${inline.slice(start, end)}\nreturn { sortTrips, checkedAt };`)();
}

const t = (over) => ({ date: '2026-09-09', departAt: '05:00', siteId: 'a', boat: '가호', ...over });

test('정렬은 하루 안에서만 건다 — 날짜 머리글과 쪽 나누기가 날짜 기준입니다', () => {
  const { sortTrips } = sortFns();
  const rows = [
    t({ date: '2026-09-09', boat: '적음', seatsLeft: 1 }),
    t({ date: '2026-09-10', boat: '많음', seatsLeft: 9 }),
    t({ date: '2026-09-09', boat: '많음', seatsLeft: 8 }),
  ];
  assert.deepEqual(
    sortTrips(rows, 'seats-desc').map((x) => [x.date, x.boat]),
    [['2026-09-09', '많음'], ['2026-09-09', '적음'], ['2026-09-10', '많음']],
    '날짜를 넘어 섞이면 안 됩니다',
  );
});

test('잔여석은 많은순·적은순 둘 다 되고, 값이 없으면 뒤로 간다', () => {
  const { sortTrips } = sortFns();
  const rows = [t({ boat: '없음', seatsLeft: null }), t({ boat: '셋', seatsLeft: 3 }), t({ boat: '아홉', seatsLeft: 9 })];

  assert.deepEqual(sortTrips(rows, 'seats-desc').map((x) => x.boat), ['아홉', '셋', '없음']);
  assert.deepEqual(sortTrips(rows, 'seats-asc').map((x) => x.boat), ['셋', '아홉', '없음'],
    '적은순에서도 모르는 값이 앞에 오면 안 됩니다');
});

test('승선료도 없는 값은 뒤로 간다', () => {
  const { sortTrips } = sortFns();
  const rows = [t({ boat: '없음', price: null }), t({ boat: '비쌈', price: 120000 }), t({ boat: '쌈', price: 90000 })];
  assert.deepEqual(sortTrips(rows, 'price-asc').map((x) => x.boat), ['쌈', '비쌈', '없음']);
});

test('최신 확인순은 그 사이트를 마지막으로 확인한 때로 센다', () => {
  const sites = {
    fresh: { ok: true, at: '2026-09-08T03:00:00.000Z' },
    stale: { ok: true, at: '2026-09-08T01:00:00.000Z' },
    failed: { ok: false, at: '2026-09-08T03:00:00.000Z', keptFrom: '2026-09-05T00:00:00.000Z' },
    never: {},
  };
  const { sortTrips } = sortFns(sites);
  const rows = ['never', 'stale', 'failed', 'fresh'].map((id) => t({ siteId: id, boat: id }));

  assert.deepEqual(sortTrips(rows, 'checked-desc').map((x) => x.boat), ['fresh', 'stale', 'failed', 'never'],
    '실패한 곳은 시도한 때가 아니라 그 값이 언제 것인지로 셉니다');
});

test('합쳐진 줄은 가장 오래된 출처를 기준으로 센다', () => {
  const sites = { new: { ok: true, at: '2026-09-08T03:00:00.000Z' }, old: { ok: true, at: '2026-09-01T03:00:00.000Z' } };
  const { checkedAt } = sortFns(sites);
  assert.equal(
    checkedAt({ siteId: 'new', sources: [{ siteId: 'new' }, { siteId: 'old' }] }),
    Date.parse('2026-09-01T03:00:00.000Z'),
    '한쪽이 낡았으면 그 줄은 낡은 것입니다',
  );
});

test('기본순은 빈자리 안에서 수집이 정렬해 온 순서를 그대로 둔다', () => {
  const { sortTrips } = sortFns();
  const rows = [t({ boat: '먼저', status: 'open' }), t({ boat: '나중', status: 'open' })];
  assert.deepEqual(sortTrips(rows, 'default').map((x) => x.boat), ['먼저', '나중'],
    '같은 급끼리는 출항 시각·선사 순서(core/runner.js)를 그대로 씁니다');
});

// 이 화면은 잡을 수 있는 자리를 찾는 화면입니다. "빈자리만"을 끄고 하루를 통째로 보면
// 마감된 배가 앞줄을 차지해 위에서부터 헛것을 읽게 됩니다.
test('빈자리가 있는 줄이 그 날의 맨 위로 간다', () => {
  const { sortTrips } = sortFns();
  const rows = [
    t({ boat: '마감', status: 'closed' }),
    t({ boat: '휴항', status: 'off' }),
    t({ boat: '적음', status: 'few' }),
    t({ boat: '모름', status: 'unknown' }),
    t({ boat: '가능', status: 'open' }),
  ];
  assert.deepEqual(sortTrips(rows, 'default').map((x) => x.boat),
    ['적음', '가능', '마감', '휴항', '모름'],
    '확인이 안 된 줄은 올리지 않습니다 — 자리가 있는지 모르는 배로 첫 화면을 덮게 됩니다');
});

test('빈자리 정렬도 날짜를 넘지 않는다', () => {
  const { sortTrips } = sortFns();
  const rows = [
    t({ date: '2026-09-09', boat: '마감', status: 'closed' }),
    t({ date: '2026-09-10', boat: '가능', status: 'open' }),
  ];
  assert.deepEqual(sortTrips(rows, 'default').map((x) => [x.date, x.boat]),
    [['2026-09-09', '마감'], ['2026-09-10', '가능']],
    '날짜 머리글과 쪽 나누기가 날짜 기준이라 하루를 넘겨 끌어올리면 안 됩니다');
});

test('고른 기준보다 빈자리가 먼저다', () => {
  const { sortTrips } = sortFns();
  const rows = [
    t({ boat: '휴항인데많음', status: 'off', seatsLeft: 20 }),
    t({ boat: '빈자리하나', status: 'few', seatsLeft: 1 }),
  ];
  assert.deepEqual(sortTrips(rows, 'seats-desc').map((x) => x.boat), ['빈자리하나', '휴항인데많음'],
    '잔여석 많은순이라도 못 잡는 자리가 위에 오면 안 됩니다');
});

test('정렬 메뉴가 있고 바꾸면 다시 그린다', () => {
  assert.match(html, /<select id="f-sort"/);
  for (const value of ['seats-desc', 'seats-asc', 'price-asc', 'checked-desc']) {
    assert.match(html, new RegExp(`value="${value}"`));
  }
  // 정렬은 보이는 날짜를 바꾸지 않으므로 첫 쪽으로 돌아가지 않습니다(필터와 다른 점).
  assert.match(inline, /\$\('f-sort'\)\.addEventListener\('change', \(\) => refresh\(\)\)/);
});

// 한 날에 표기가 여럿이면 그 날 대부분의 선사가 부르는 이름이 앞에 와야 자기 물때표와
// 맞춰보기 쉽습니다. 소수 표기도 버리지 않습니다 — 어느 쪽도 틀린 게 아닙니다.
test('한 날의 물때는 많이 쓰인 표기부터 보여준다', () => {
  const start = inline.indexOf('function tidesByDate');
  const end = inline.indexOf('function kstParts');
  const src = `function dayLabel(d){return d;}\nfunction isGoodTide(){return false;}\n${inline.slice(start, end)}`;
  const { tidesByDate } = new Function(`${src}\nreturn { tidesByDate };`)();

  const rows = [
    ...Array(3).fill({ date: '2026-09-16', tide: '한객기' }),
    ...Array(5).fill({ date: '2026-09-16', tide: '12물' }),
    { date: '2026-09-16', tide: '13물' },
  ];
  assert.deepEqual([...tidesByDate(rows).get('2026-09-16')], ['12물', '한객기', '13물']);
});
