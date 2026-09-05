import test from 'node:test';
import assert from 'node:assert/strict';
import { monthUrls, parseFleet, parseSimpleDay } from '../adapters/sunsang24.js';
import { parseIndex } from '../adapters/thefishing.js';
import { matchBoatName } from '../adapters/_rows.js';
import { parseRows } from '../adapters/_rows.js';
import { pageUrls } from '../adapters/generic.js';
import { platformOf, needsBrowser } from '../core/platform.js';
import { describeError } from '../core/fetcher.js';
import { parseDetail, indexUrl, detailUrl } from '../adapters/thefishing.js';
import { parseMonth as parseUijihoMonth } from '../adapters/uijiho.js';
import { findOpenings } from '../core/diff.js';
import { mergeDuplicates } from '../core/merge.js';
import { kstDate } from '../core/when.js';
import { toStatus, toDate, toTime, toTimeRange, sessionOf, parseSeats, pickPrice, STATUS } from '../core/schema.js';
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

test('sunsang24: 목록형 — 하루 행 안의 배마다 한 줄씩 나온다', () => {
  const trips = parseFleet(sunsangSite, fx.SUNSANG24_LIST, 'https://x');

  assert.deepEqual(trips.map((t) => `${t.date}/${t.boat}`), [
    '2026-09-04/악바리호',
    '2026-09-04/레드맨호',
    '2026-09-05/맥가이버호',
    '2026-09-05/오후호',
    '2026-09-05/공지많은호',
  ], '시간도 좌석 표기도 없는 껍데기 table은 출조가 아닙니다');

  const [akbari, redman, macgyver] = trips;
  assert.equal(akbari.departAt, '04:00');
  assert.equal(akbari.species, '주꾸미');
  assert.equal(akbari.tide, '조금', '물때는 하루 행에 있고 그 날 배들이 나눠 씁니다');
  assert.equal(akbari.seatsLeft, 0, '예약마감');
  assert.equal(akbari.status, STATUS.CLOSED);
  assert.equal(akbari.price, 100000, '어종별 승선료가 붙는다');

  assert.equal(redman.seatsLeft, 15, '20명 정원에 5명 예약');
  assert.equal(redman.status, STATUS.OPEN);
  assert.equal(redman.tide, '조금');

  assert.equal(macgyver.tide, '1물');
  assert.equal(macgyver.seatsLeft, 1, '20명 정원에 19명 예약');
  assert.equal(macgyver.status, STATUS.FEW);
  assert.equal(macgyver.port, '영목항', '배별 출항지가 사이트 기본값을 덮는다');

  // 시작 시각만 보면 04:00은 오전배 같지만 17시에 들어오는 종일배입니다.
  assert.equal(akbari.returnAt, '17:00');
  assert.equal(akbari.session, '종일');
  assert.equal(akbari.hours, 13);
  assert.equal(macgyver.session, '종일', '06:00~15:00 = 9시간');

  const afternoon = trips.at(-2);
  assert.equal(afternoon.boat, '오후호');
  assert.equal(afternoon.session, '오후');
  assert.equal(afternoon.hours, 5);
});

test('안내문의 "상호"를 배 이름으로 읽지 않는다', () => {
  // 예약 안내에 "상호 : ○○수산", "계좌번호 ..."가 늘 붙어 있어서, 그냥 "○○호"를
  // 잡으면 화면에 "상호"라는 배가 뜹니다. 더피싱 계열 여러 곳에서 실제로 그랬습니다.
  assert.equal(matchBoatName('상호 : 바다수산 예금주 홍길동'), null);
  assert.equal(matchBoatName('계좌번호 123-456 문의번호 010-0000-0000'), null);
  assert.equal(matchBoatName('상호 : 바다수산 / 청룡호 운항시간 05:00'), '청룡호');
  assert.equal(matchBoatName('일출호 예약하기'), '일출호');
});

test('더피싱: 메인 요약표를 읽는다 — 표기 사이에 공백이 있어도', () => {
  const site = { id: 'x', name: '테스트', adapter: 'thefishing', url: 'https://x.thefishing.kr/' };

  const plain = parseIndex(site, fx.THEFISHING_INDEX, 'https://x');
  assert.ok(plain.length >= 4, '보통 표기의 요약표는 원래 읽혔습니다');

  // "선박명 예 약 현 황 남은자리"처럼 글자를 띄워 쓰는 사이트가 많습니다.
  // 이걸 놓치면 날짜별로 21번씩 받아오게 됩니다 — 더피싱 99곳이 그래서 한 시간을 넘겼습니다.
  const spaced = parseIndex(site, fx.THEFISHING_INDEX_SPACED, 'https://x');
  assert.ok(spaced.length > 0, '띄어 쓴 표기도 요약표로 알아봐야 합니다');
  assert.equal(spaced[0].boat, '엔젤피싱호');
  assert.equal(spaced[0].seatsLeft, 20);
});

test('sunsang24: 공지사항은 상태·어종 판정에서 뺀다', () => {
  // 공지에 "출조취소"가 들어있다고 그 날 배가 안 뜨는 게 아닙니다. 실제 사이트에서
  // 이것 때문에 자리가 남은 출조까지 전부 휴항으로 잡혔습니다.
  const trips = parseFleet(sunsangSite, fx.SUNSANG24_LIST, 'https://x');
  const noisy = trips.find((t) => t.boat === '공지많은호');

  assert.equal(noisy.seatsLeft, 16, '20명 정원에 4명 예약');
  assert.equal(noisy.status, STATUS.OPEN, '공지의 "출조취소"를 휴항으로 읽으면 안 됩니다');
  assert.equal(noisy.species, '광어', '공지의 "쭈꾸미"가 아니라 어종 칸을 봅니다');
  assert.equal(noisy.departAt, '06:00');
});

test('sunsang24: 달력형 — 날짜가 행 안 첫 칸에 있어도 잡는다', () => {
  const trips = parseRows(sunsangSite, fx.SUNSANG24_CALENDAR, 'https://x');
  assert.equal(trips.length, 1);
  assert.equal(trips[0].date, '2026-09-07');
  assert.equal(trips[0].seatsLeft, 8);
});

test('sunsang24: simple_day 조각은 table.ship_unit 단위로 읽는다', () => {
  const html = `
    <table id="d2026-09-04" class="shipsinfo_daywarp">
      <tr>
        <td class="date_info2">조금</td>
        <td class="ships_warp">
          <table class="ship_unit">
            <tr>
              <td class="ship_info"><div class="title">피싱게이트 선단</div></td>
              <td><ul class="reservation_detail" data-sdate="2026-09-04"><li>공지사항 남은자리 0명</li></ul></td>
            </tr>
          </table>
          <table class="ship_unit">
            <tr>
              <td class="ship_info"><div class="title">아우라호</div></td>
              <td>
                <ul class="reservation_detail" data-sdate="2026-09-04">
                  <li class="fishspecies"><strong>어종 : </strong><div>주꾸미,시즌어종</div></li>
                  <li class="shiptime"><strong>운항시간 : </strong><div>06:00 ~ 15:00</div></li>
                </ul>
              </td>
              <td class="ship_info2"><span class="shipping_status">예약마감</span><br><span>21명</span> 예약/<span>21명</span></td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;

  const trips = parseSimpleDay(
    { ...sunsangSite, boats: { 아우라호: {} } },
    html,
    'https://fishinggate.sunsang24.com/ship/schedule_fleet/2026-09-04/0/simple_day',
  );

  assert.equal(trips.length, 1, '공지용 선단 행은 버립니다');
  assert.equal(trips[0].boat, '아우라호');
  assert.equal(trips[0].date, '2026-09-04');
  assert.equal(trips[0].departAt, '06:00');
  assert.equal(trips[0].returnAt, '15:00');
  assert.equal(trips[0].species, '주꾸미');
  assert.equal(trips[0].tide, '조금');
  assert.equal(trips[0].seatsLeft, 0);
  assert.equal(trips[0].seatsTotal, 21);
});

test('uijiho: 월별 예약현황의 날짜 행과 정원을 읽는다', () => {
  const html = `
    <h2>2026년 9월 예약인원현황</h2>
    <table><tr><td>1</td><td>화</td><td>11물</td><td>
      공지사항 쭈꾸미,갑오징어 출조
      의지호[정원:15명] 마감 모집종료
    </td></tr>
    <tr><td>3</td><td>목</td><td>13물</td><td>
      의지호[정원:15명] 1명가능 박정후님1분
    </td></tr></table>`;
  const trips = parseUijihoMonth({ id: 'uijiho', name: '의지호', port: '충남 서천 홍원항' }, html, 'https://uijiho.com');
  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map((t) => [t.date, t.seatsLeft, t.seatsTotal, t.status]), [
    ['2026-09-01', 0, 15, 'closed'],
    ['2026-09-03', 1, 15, 'few'],
  ]);
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

test('thefishing: 청광호는 등록된 21석을 사용하고 예약완료를 마감으로 읽는다', () => {
  const site = { id: 'chungkwang', name: '영목항 청광호', seatsTotal: 21 };
  const html = `
    <h3>2026년 09월 06일(일요일)</h3>
    <div>남은자리 청광호 쭈갑출조합니다 예약 강가현님(3) / 윤진형님(2)
      / 김프로님(2) / 임성현님(4) / 김태훈님(4) / 조성범님(4)
      / 윤석희님(1) / 강병진님(1) 예약완료</div>`;
  const [trip] = parseDetail(site, html, 'https://x');
  assert.equal(trip.seatsLeft, 0);
  assert.equal(trip.seatsTotal, 21);
  assert.equal(trip.status, STATUS.CLOSED);
});

test('thefishing: 플랫폼 이름은 배로 등록하지 않는다', () => {
  const site = {
    id: 'ssfish', name: '무창포 선상낚시', excludeBoats: ['무창포 선상낚시'],
  };
  const html = `
    <h3>2026년 09월 05일(토요일)</h3>
    <div>운항시간 23:00 예약하기 무창포 선상낚시 쭈꾸미</div>`;
  assert.deepEqual(parseDetail(site, html, 'https://x'), []);
});

test('thefishing: detail — 남은자리 예약완료는 시즌 숫자를 잔여석으로 보지 않는다', () => {
  const site = { id: 'mansu', name: '영흥도 만수피싱', seatsTotal: 22, url: 'https://x?mid=bk' };
  const html = `
    <h3>2026년 09월 19일(토요일) 무시</h3>
    <div>만수피싱</div>
    <div>남은자리: 예약완료</div>
    <div>26시즌 쭈꾸미+갑오징어</div>
    <div>입금자 Y*H님(6명/5,6,7,8,9,10) / P*S님(5명/1,2,3,19,20)</div>
  `;
  const [trip] = parseDetail(site, html, 'https://x');

  assert.equal(trip.seatsLeft, 0);
  assert.equal(trip.seatsTotal, 22);
  assert.equal(trip.status, STATUS.CLOSED);
});

test('thefishing: detail — 이미지로 표시한 예약완료도 잔여 0석이다', () => {
  const site = { id: 'mansu', name: '영흥도 만수피싱', seatsTotal: 22 };
  const html = `
    <div>2026-09-19</div><div>날짜선택 닫기</div><div>26시즌 쭈꾸미 승선비</div>
    <h1>2026년 09월 19일(토요일) 무시</h1>
    <h2>만수피싱</h2>
    <p><span>남은자리:&nbsp;</span><img src="/r_x_0.gif" alt="예약완료"></p>
    <table><tr><td><span>26시즌 쭈꾸미+갑오징어</span></td></tr>
    <tr><td><img alt="입금자"></td><td>A님(6명/<font>5,6,7,8,9,10</font>)</td></tr></table>
  `;
  const trips = parseDetail(site, html, 'https://x');
  assert.equal(trips.length, 1);
  const [trip] = trips;
  assert.equal(trip.seatsLeft, 0);
  assert.equal(trip.status, STATUS.CLOSED);
});

test('thefishing: detail — 머리글과 예약완료 이미지가 떨어져 있어도 마감으로 읽는다', () => {
  const site = { id: 'jstar', name: '전곡항 스타피싱', seatsTotal: 20 };
  const html = `
    <h1>2026년 09월 06일(일요일) 1물</h1>
    <table><tr><th>선박명</th><th>예 약 현 황</th><th>남은자리</th></tr>
      <tr><td>스타피싱</td><td>예약자 A님(1명/4) B님(1명/5)</td>
      <td><img src="/r_x_0.gif" alt="예약완료"></td></tr></table>`;
  const [trip] = parseDetail(site, html, 'https://x');
  assert.equal(trip.seatsLeft, 0);
  assert.equal(trip.seatsTotal, 20);
  assert.equal(trip.status, STATUS.CLOSED);
});

test('thefishing: detail — 남은자리 예약하기 뒤 시즌 숫자는 잔여석이 아니다', () => {
  const site = { id: 'mansu', name: '영흥도 만수피싱', seatsTotal: 22, url: 'https://x?mid=bk' };
  const html = `
    <h3>2026년 09월 20일(일요일) 1물</h3>
    <div>만수피싱</div>
    <div>남은자리: 예약하기</div>
    <div>26시즌 쭈꾸미+갑오징어</div>
    <div>입금자 A님(5명/1,2,3,4,5)</div>
  `;
  const [trip] = parseDetail(site, html, 'https://x');

  assert.equal(trip.seatsLeft, 17);
  assert.equal(trip.seatsTotal, 22);
  assert.equal(trip.status, STATUS.OPEN);
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
  assert.deepEqual(sunsang.targets({
    url: 'https://fishinggate.sunsang24.com',
    path: 'schedule_fleet_simple_top',
    dayPath: '/ship/schedule_fleet/{date}/0/simple_day',
    // 날짜를 박아두면 그 날이 지나는 순간 테스트가 저절로 깨집니다. 어댑터와 같은 기준으로 셉니다.
  }), [`https://fishinggate.sunsang24.com/ship/schedule_fleet/${kstDate(0)}/0/simple_day`]);

  const fishing = await import('../adapters/thefishing.js');
  const t = fishing.targets({ url: 'https://raraho.kr/m/index.php?mid=bk' });
  assert.equal(t[0], 'https://raraho.kr/m/', 'index 방식은 메인 요약을 본다');
  assert.match(t[1], /mid=bk&year=/, 'detail 방식 주소도 같이 보여준다');

  const generic = await import('../adapters/generic.js');
  assert.deepEqual(generic.targets({ url: 'http://uijiho.com/' }), ['http://uijiho.com/']);
});

// ── 오전/오후/종일 구분과 운항 시간 ────────────────────────────────────────
test('toTimeRange: 시작과 끝을 같이 읽는다', () => {
  assert.deepEqual(toTimeRange('운항시간 : 04:00 ~ 17:00'), { from: '04:00', to: '17:00' });
  assert.deepEqual(toTimeRange('05:30~16:00 출항'), { from: '05:30', to: '16:00' });
  assert.deepEqual(toTimeRange('오전 5시 출항'), { from: '05:00', to: null }, '끝이 없으면 시작만');
  assert.deepEqual(toTimeRange('안내문자 발송'), { from: null, to: null });
});

test('sessionOf: 몇 시간짜리 어떤 배인지', () => {
  assert.deepEqual(sessionOf('04:00', '17:00'), { session: '종일', hours: 13 });
  assert.deepEqual(sessionOf('05:30', '11:30'), { session: '오전', hours: 6 });
  assert.deepEqual(sessionOf('13:00', '18:00'), { session: '오후', hours: 5 });
  assert.deepEqual(sessionOf('05:00', '12:30'), { session: '오전', hours: 7.5 }, '30분도 센다');
});

test('sessionOf: 밤에 나가는 배는 야간, 자정을 넘겨도 시간이 맞는다', () => {
  assert.deepEqual(sessionOf('20:00', '04:00'), { session: '야간', hours: 8 });
  assert.deepEqual(sessionOf('19:00', null), { session: '야간', hours: null });
});

test('sessionOf: 끝 시각이 없으면 시작으로만 가른다', () => {
  assert.deepEqual(sessionOf('05:30', null), { session: '오전', hours: null });
  assert.deepEqual(sessionOf('13:00', null), { session: '오후', hours: null });
  assert.deepEqual(sessionOf(null, null), { session: null, hours: null });
});
