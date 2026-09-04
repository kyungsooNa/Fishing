import test from 'node:test';
import assert from 'node:assert/strict';
import { monthUrls } from '../adapters/sunsang24.js';
import { parseRows } from '../adapters/_rows.js';
import { pageUrls } from '../adapters/generic.js';
import { platformOf, needsBrowser } from '../core/platform.js';
import { describeError } from '../core/fetcher.js';
import { parseDetail, indexUrl, detailUrl } from '../adapters/thefishing.js';
import { findOpenings } from '../core/diff.js';
import { mergeDuplicates } from '../core/merge.js';
import { toStatus, toDate, toTime, parseSeats, pickPrice, STATUS } from '../core/schema.js';
import * as fx from './fixtures.js';

const sunsangSite = {
  id: 'akbari', name: '악바리', adapter: 'sunsang24', url: 'https://akbari.sunsang24.com',
  port: '구매항',
  boats: { 악바리호: { prices: { 주꾸미: 100000 } }, 맥가이버호: { port: '영목항' } },
};

test('schema: 표기 정규화', () => {
  assert.equal(toStatus('예약마감'), STATUS.CLOSED);
  assert.equal(toStatus('남은자리 5명', 5), STATUS.OPEN);
  assert.equal(toStatus('남은자리 1명', 1), STATUS.FEW);
  assert.equal(toStatus('휴항', 9), STATUS.OFF, '휴항은 잔여석보다 우선');
  assert.equal(toDate('9월 5일', new Date('2026-09-01')), '2026-09-05');
  assert.equal(toTime('오후 1시 출항'), '13:00');
  assert.equal(parseSeats('남은자리 3명'), 3);
  assert.equal(parseSeats('예약마감'), 0);
});

test('schema: 승선료는 배별 → 사이트 공통 순으로 고른다', () => {
  assert.equal(pickPrice(sunsangSite, '악바리호', '주꾸미'), 100000);
  assert.equal(pickPrice(sunsangSite, '악바리호', '광어'), null);
  assert.equal(pickPrice({ ...sunsangSite, price: 80000 }, '맥가이버호', '광어'), 80000);
});

test('sunsang24: 목록형 — 날짜 머리글이 뒤따르는 행에 붙는다', () => {
  const trips = parseRows(sunsangSite, fx.SUNSANG24_LIST, 'https://x');
  const key = (t) => `${t.date}/${t.boat}`;

  assert.deepEqual(trips.map(key), [
    '2026-09-05/악바리호',
    '2026-09-05/레드맨호',
    '2026-09-06/맥가이버호',
  ], '전화예약 0명 행은 버려야 한다');

  const [akbari, redman, macgyver] = trips;
  assert.equal(akbari.seatsLeft, 4);
  assert.equal(akbari.departAt, '05:30');
  assert.equal(akbari.species, '주꾸미');
  assert.equal(akbari.tide, '12물');
  assert.equal(akbari.price, 100000);
  assert.equal(akbari.status, STATUS.OPEN);

  assert.equal(redman.seatsLeft, 0);
  assert.equal(redman.status, STATUS.CLOSED);

  assert.equal(macgyver.port, '영목항', '배별 출항지가 사이트 기본값을 덮는다');
  assert.equal(macgyver.status, STATUS.FEW);
});

test('sunsang24: 달력형 — 날짜가 행 안 첫 칸에 있어도 잡는다', () => {
  const trips = parseRows(sunsangSite, fx.SUNSANG24_CALENDAR, 'https://x');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].date, '2026-09-07');
  assert.equal(trips[0].seatsLeft, 8);
});

test('thefishing: detail — 입금 명단의 좌석번호를 세서 잔여석을 구한다', () => {
  const site = { id: 'monster', name: '몬스터', seatsTotal: 20, url: 'https://x?mid=bk' };
  const [trip] = parseDetail(site, fx.THEFISHING_DETAIL, 'https://x');

  // 입금 6 + 입금대기 2 = 8석. 대기자·취소자 줄의 좌석번호는 세지 않는다.
  assert.equal(trip.seatsLeft, 12);
  assert.equal(trip.seatsTotal, 20);
  assert.equal(trip.date, '2026-09-05');
  assert.equal(trip.boat, '몬스터호');
  assert.equal(trip.species, '우럭');
});

test('diff: 취소석과 자리 늘어남만 알린다', () => {
  const base = { siteId: 's', boat: '가호', date: '2026-09-05', departAt: '05:00' };
  const prev = [
    { ...base, status: STATUS.CLOSED, seatsLeft: 0 },
    { ...base, boat: '나호', status: STATUS.OPEN, seatsLeft: 3 },
    { ...base, boat: '다호', status: STATUS.OPEN, seatsLeft: 5 },
  ];
  const next = [
    { ...base, status: STATUS.OPEN, seatsLeft: 2 },                    // 취소석
    { ...base, boat: '나호', status: STATUS.OPEN, seatsLeft: 6 },       // 자리 늘어남
    { ...base, boat: '다호', status: STATUS.OPEN, seatsLeft: 4 },       // 줄어듦 — 알림 없음
    { ...base, boat: '라호', status: STATUS.OPEN, seatsLeft: 9 },       // 새 일정 — 알림 없음
  ];

  const openings = findOpenings(prev, next);
  assert.deepEqual(openings.map((o) => [o.boat, o.reason]), [
    ['가호', 'reopened'],
    ['나호', 'more-seats'],
  ]);

  assert.equal(findOpenings(prev, next, new Set(['s'])).length, 0, '수집 실패한 사이트는 비교에서 뺀다');
});

test('thefishing: 예약 주소에서 메인 요약과 날짜별 주소를 만든다', () => {
  const bk = 'https://www.eugeneho.kr/m/index.php?mid=bk';
  assert.equal(indexUrl(bk), 'https://www.eugeneho.kr/m/', 'index 방식은 예약모듈이 아니라 메인 요약을 봅니다');
  assert.equal(
    detailUrl(bk, new Date(2026, 8, 5)),
    'https://www.eugeneho.kr/m/index.php?mid=bk&year=2026&month=9&day=5',
  );
});

// ── 중복 합치기 ────────────────────────────────────────────────────────────
const 은가비 = { boat: '은가비호', port: '충남 홍성 남당항', phone: '010-2495-2060' };

const trip = (over) => ({
  siteId: 'a', siteName: 'A', date: '2026-09-05', departAt: '05:30',
  status: STATUS.OPEN, statusText: '남은자리 3명', seatsLeft: 3,
  species: null, tide: null, price: null, url: 'https://a',
  ...은가비, ...over,
});

test('merge: 이름·출항지·전화번호가 다 같으면 한 줄로 합친다', () => {
  const merged = mergeDuplicates([
    trip({ siteId: 'sunsang', siteName: '선상24', seatsLeft: 3, url: 'https://s' }),
    trip({ siteId: 'thefishing', siteName: '더피싱', seatsLeft: 5, species: '광어', url: 'https://t' }),
  ]);

  assert.equal(merged.length, 1);
  const [m] = merged;
  assert.equal(m.species, '광어', '정보가 많은 쪽이 본체가 된다');
  assert.equal(m.seatsLeft, 5, '플랫폼마다 배정이 다를 수 있어 큰 쪽을 쓴다');
  assert.deepEqual(m.sources.map((s) => [s.siteName, s.seatsLeft]), [['선상24', 3], ['더피싱', 5]]);
});

test('merge: 이름이 같아도 지역이나 전화번호가 다르면 남남이다', () => {
  const 다른지역 = mergeDuplicates([
    trip({ siteId: 'a' }),
    trip({ siteId: 'b', port: '경남 통영항' }),
  ]);
  assert.equal(다른지역.length, 2, '다른 지역의 같은 이름 배는 합치면 안 된다');

  const 다른번호 = mergeDuplicates([
    trip({ siteId: 'a' }),
    trip({ siteId: 'b', phone: '010-9999-0000' }),
  ]);
  assert.equal(다른번호.length, 2);
});

test('merge: 전화번호가 없으면 합치지 않는다', () => {
  const out = mergeDuplicates([
    trip({ siteId: 'a', phone: null }),
    trip({ siteId: 'b', phone: null }),
  ]);
  assert.equal(out.length, 2, '확신이 없으면 두 줄로 두는 쪽이 안전하다');
});

test('merge: 표기가 달라도 전화번호는 숫자로 맞춘다', () => {
  const out = mergeDuplicates([
    trip({ siteId: 'a', phone: '010-2495-2060' }),
    trip({ siteId: 'b', phone: '010.2495.2060' }),
  ]);
  assert.equal(out.length, 1);
});

test('merge: 한 곳이라도 휴항이면 휴항이다', () => {
  const [m] = mergeDuplicates([
    trip({ siteId: 'a', seatsLeft: 4 }),
    trip({ siteId: 'b', status: STATUS.OFF, statusText: '기상악화 휴항', seatsLeft: null }),
  ]);
  assert.equal(m.status, STATUS.OFF, '자리가 남아도 배가 안 뜨면 휴항');
});

test('merge: 같은 사이트에서 두 번 들어온 출조는 정보가 많은 쪽만 남는다', () => {
  const out = mergeDuplicates([
    trip({ seatsLeft: null, statusText: '예약가능' }),
    trip({ seatsLeft: 3, species: '우럭' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seatsLeft, 3);
});

test('diff: 본체 사이트가 바뀌어도 알림이 끊기지 않는다', () => {
  const prev = [trip({ siteId: 'sunsang', status: STATUS.CLOSED, seatsLeft: 0 })];
  const next = [trip({ siteId: 'thefishing', status: STATUS.OPEN, seatsLeft: 2 })];
  const [opening] = findOpenings(prev, next);
  assert.equal(opening?.reason, 'reopened', '신원이 같으면 같은 배로 본다');
});

// ── sunsang24 월 페이지 주소 ────────────────────────────────────────────────
test('sunsang24: 기본은 경로 하나만 부른다', () => {
  // 실제 사이트들이 쓰는 주소는 /ship/schedule_fleet 입니다. 뒤에 붙는 숫자는
  // 연월이 아니라 배 번호로 보여서, 월을 임의로 붙이지 않습니다.
  const urls = monthUrls({ url: 'https://akbari.sunsang24.com', days: 21 }, new Date(2026, 8, 2));
  assert.deepEqual(urls, ['https://akbari.sunsang24.com/ship/schedule_fleet']);
});

test('sunsang24: monthPath를 적어준 사이트만 달을 넘겨가며 받는다', () => {
  const site = {
    url: 'https://akbari.sunsang24.com',
    monthPath: '/ship/schedule_fleet/{ym}',
    days: 40,
  };
  assert.deepEqual(monthUrls(site, new Date(2026, 8, 2)), [
    'https://akbari.sunsang24.com/ship/schedule_fleet/202609',
    'https://akbari.sunsang24.com/ship/schedule_fleet/202610',
  ]);
});

test('sunsang24: path에 배 번호를 붙여도 그대로 따른다', () => {
  const urls = monthUrls({ url: 'https://seojin.sunsang24.com', path: 'schedule_fleet/1359' }, new Date(2026, 8, 2));
  assert.deepEqual(urls, ['https://seojin.sunsang24.com/ship/schedule_fleet/1359']);
});

// ── 자체 사이트(generic) ───────────────────────────────────────────────────
test('generic: 표기만 같으면 자체 사이트도 같은 파서로 읽는다', () => {
  const site = {
    id: 'blueseaho', name: '오천항 푸른바다낚시', url: 'https://www.blueseaho.com/reservation',
    port: '충남 보령 오천항', phone: '010-5402-0521',
    boats: { 푸른바다3호: {}, 은갈매기호: {} },
  };
  const trips = parseRows(site, fx.GENERIC_RESERVATION, site.url);

  assert.deepEqual(trips.map((t) => [t.boat, t.seatsLeft, t.status]), [
    ['푸른바다3호', 7, STATUS.OPEN],
    ['은갈매기호', 0, STATUS.CLOSED],
  ]);
  assert.equal(trips[0].date, '2026-09-08');
  assert.equal(trips[0].departAt, '06:00');
  assert.equal(trips[0].tide, '10물');
  assert.equal(trips[0].phone, '010-5402-0521', '합치기용 신원이 실려야 한다');
});

test('generic: 주소만 적으면 그 한 장, 날짜별 사이트면 날짜만큼', () => {
  const base = 'https://www.blueseaho.com/reservation';
  assert.deepEqual(pageUrls({ url: base }), [base]);

  assert.deepEqual(pageUrls({ url: base, pages: ['/reservation', '/reservation?type=2'] }), [
    'https://www.blueseaho.com/reservation',
    'https://www.blueseaho.com/reservation?type=2',
  ]);

  assert.deepEqual(pageUrls({ url: base, datePath: '/reservation?date={date}', days: 2 }, new Date(2026, 8, 5)), [
    'https://www.blueseaho.com/reservation?date=2026-09-05',
    'https://www.blueseaho.com/reservation?date=2026-09-06',
  ]);
});

// ── 플랫폼 종류 ────────────────────────────────────────────────────────────
test('platform: 어댑터에서 계열을 알아본다', () => {
  assert.deepEqual(platformOf({ adapter: 'sunsang24' }), { id: 'sunsang24', label: '선상24' });
  assert.deepEqual(platformOf({ adapter: 'thefishing' }), { id: 'thefishing', label: '더피싱' });
  assert.deepEqual(platformOf({ adapter: 'generic' }), { id: 'generic', label: '자체' });
});

test('platform: 더피싱은 수집 방식까지 구분한다', () => {
  // index는 메인 요약 한 번, detail은 날짜별. 요청 수가 달라서 구분이 값어치 있습니다.
  assert.equal(platformOf({ adapter: 'thefishing' }).label, '더피싱');
  assert.equal(platformOf({ adapter: 'thefishing', source: 'detail' }).label, '더피싱(상세)');
});

test('platform: registry에 적어둔 값이 있으면 그걸 따른다', () => {
  // generic으로 잡아뒀지만 실은 알려진 솔루션이더라 하는 경우.
  assert.deepEqual(platformOf({ adapter: 'generic', platform: '서로피싱' }), {
    id: 'generic', label: '서로피싱',
  });
});

test('platform: 모르는 어댑터는 이름을 그대로 쓴다', () => {
  assert.deepEqual(platformOf({ adapter: 'newsite' }), { id: 'newsite', label: 'newsite' });
});

test('파서가 바깥 컨테이너까지 두 번 잡아도 중복 정리가 접는다', () => {
  // 사이트마다 마크업이 달라서 li 안에 div.row 가 또 있는 식이면 같은 행이 두 번 나옵니다.
  // 파서를 사이트마다 좁히는 대신, 중복 정리에 맡깁니다.
  const html = '<ul><li><div class="row">2026-09-05 악바리호 운항시간 05:30 남은자리 4명</div></li></ul>';
  const trips = parseRows({ id: 'akbari', name: '악바리' }, html, 'https://x');

  assert.equal(trips.length, 2, '파서 단계에서는 두 번 잡힌다');
  assert.equal(mergeDuplicates(trips).length, 1, '정리 후에는 한 줄');
});

// ── 브라우저가 필요한 사이트가 있는지 ──────────────────────────────────────
test('needsBrowser: mode에 따라 브라우저 설치가 필요한지 가른다', () => {
  assert.equal(needsBrowser([{ adapter: 'sunsang24', mode: 'static' }]), false);
  assert.equal(needsBrowser([{ adapter: 'thefishing' }]), false, 'thefishing 기본은 static');
  assert.equal(needsBrowser([{ adapter: 'sunsang24', mode: 'js' }]), true);
  assert.equal(needsBrowser([{ adapter: 'generic' }]), true, 'generic 기본은 auto — 본문이 비면 브라우저로 넘어간다');
  assert.equal(needsBrowser([{ adapter: 'sunsang24', path: 'schedule_fleet_simple_top' }]), true, '달력형 기본은 js');
});

test('needsBrowser: 꺼둔 사이트는 세지 않는다', () => {
  assert.equal(needsBrowser([{ adapter: 'generic', enabled: false }, { adapter: 'thefishing' }]), false);
});

test('thefishing: 예약모듈이 아닌 주소를 적어도 예약 페이지를 본다', () => {
  // 선사 홈페이지를 복사해오면 mid=index(메인)인 경우가 많습니다.
  // 그대로 두면 detail 방식이 메인을 날짜별로 긁어 조용히 0건이 됩니다.
  const main = 'http://www.xn--2s2b21pgpc0m80y16e.com/m/index.php?mid=index';
  assert.equal(indexUrl(main), 'http://www.xn--2s2b21pgpc0m80y16e.com/m/');
  assert.equal(
    detailUrl(main, new Date(2026, 8, 5)),
    'http://www.xn--2s2b21pgpc0m80y16e.com/m/index.php?mid=bk&year=2026&month=9&day=5',
  );
});

// ── 수집 실패 원인 ─────────────────────────────────────────────────────────
test('describeError: fetch failed 뒤에 숨은 진짜 원인을 꺼낸다', () => {
  // Node의 fetch는 DNS·TLS·연결 거부를 전부 "fetch failed"로 감쌉니다.
  // 그 한 줄만 남기면 수집 상태 화면에서 손쓸 방법이 없습니다.
  const dns = new TypeError('fetch failed');
  dns.cause = Object.assign(new Error('getaddrinfo ENOTFOUND uijiho.com'), { code: 'ENOTFOUND' });
  assert.equal(describeError(dns), 'fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND uijiho.com)');

  const tls = new TypeError('fetch failed');
  tls.cause = Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' });
  assert.match(describeError(tls), /CERT_HAS_EXPIRED/);
});

test('describeError: 원인이 없으면 메시지를 그대로 둔다', () => {
  assert.equal(describeError(new Error('HTTP 403 Forbidden')), 'HTTP 403 Forbidden');
});

test('describeError: 원인이 겹겹이 쌓여 있어도 따라간다', () => {
  const inner = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' });
  const mid = Object.assign(new Error('socket hang up'), { cause: inner });
  const outer = Object.assign(new TypeError('fetch failed'), { cause: mid });
  const out = describeError(outer);
  assert.match(out, /socket hang up/);
  assert.match(out, /ECONNREFUSED/);
});

// ── 어댑터가 실제로 받는 주소 ──────────────────────────────────────────────
test('targets: 진단 도구가 어댑터와 같은 주소를 본다', async () => {
  // --dump가 site.url을 받으면 sunsang24는 일정이 없는 메인만 저장됩니다.
  const sunsang = await import('../adapters/sunsang24.js');
  assert.deepEqual(sunsang.targets({ url: 'https://akbari.sunsang24.com' }),
    ['https://akbari.sunsang24.com/ship/schedule_fleet']);

  const fishing = await import('../adapters/thefishing.js');
  const t = fishing.targets({ url: 'https://raraho.kr/m/index.php?mid=bk' });
  assert.equal(t[0], 'https://raraho.kr/m/', 'index 방식은 메인 요약을 본다');
  assert.match(t[1], /mid=bk&year=/, 'detail 방식 주소도 같이 보여준다');

  const generic = await import('../adapters/generic.js');
  assert.deepEqual(generic.targets({ url: 'http://uijiho.com/' }), ['http://uijiho.com/']);
});
