import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../adapters/sunsang24.js';
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
