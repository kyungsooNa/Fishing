import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrip, toTime, toTimeRange, tripTimeRange } from '../core/schema.js';
import { parseDetail } from '../adapters/thefishing.js';
import { mergeDuplicates } from '../core/merge.js';

const site = { id: 'sample', name: '예시호', seatsTotal: 20 };
const pc = (rows) => `<table>
  <tr><td colspan="3"><span>2026년 09월 06일</span>, 일요일, 1물</td></tr>
  <tr><th>선박명</th><th>예 약 현 황</th><th>남은자리</th></tr>
  ${rows}</table>`;

test('오전·오후·새벽·밤을 범위의 각 시각에 적용하고 시간·시즌 숫자는 제외한다', () => {
  assert.deepEqual(toTimeRange('오전7시~오후2시'), { from: '07:00', to: '14:00' });
  assert.deepEqual(toTimeRange('오후6시~밤12시'), { from: '18:00', to: '00:00' });
  assert.deepEqual(toTimeRange('저녁7시30분～새벽1시'), { from: '19:30', to: '01:00' });
  assert.equal(toTime('24시간 이내 입금, 26시즌 05:30 출항'), '05:30');
  assert.equal(toTime('예약 3시간 이내 입금'), null);
});

test('버스·문의·입금·물때 시각을 출항으로 오인하지 않는다', () => {
  for (const text of ['04:20 리더낚시에서 버스출발합니다', '출항 전날 19시까지 문자',
    '문의 오후 8시 이전', '입금 3시간 이내', '일출 06:08 / 일몰 18:56']) {
    assert.equal(tripTimeRange(text).from, null, text);
  }
  assert.deepEqual(tripTimeRange('버스 04:20 출발\n출항시간 05:30 입항시간 15:00'), { from: '05:30', to: '15:00' });
  assert.deepEqual(tripTimeRange('입항 16시, 출항 새벽 5시30분'), { from: '05:30', to: '16:00' });
});

test('출항·입항이 시각 하나를 두고 다투면 각자 제 표기를 집는다', () => {
  // 예진호가 "5시 출항 3시 입항"인데 출항이 뒤(3시)를, 입항이 앞(3시)을 집어 둘 다 3시였습니다.
  assert.deepEqual(tripTimeRange('예진호 5시 출항 3시 입항'), { from: '05:00', to: '15:00' });
  assert.deepEqual(tripTimeRange('05:30 출항 15:00 입항'), { from: '05:30', to: '15:00' });
  // 라벨 뒤에 적는 판은 그대로여야 합니다 — 앞뒤를 통째로 뒤집는 고침이 아닙니다.
  assert.deepEqual(tripTimeRange('출항 05:00 입항 13:00'), { from: '05:00', to: '13:00' });
  // 시각이 하나뿐이면 출항으로 둡니다. 표가 보여주는 값이 출항입니다.
  assert.deepEqual(tripTimeRange('출항 3시 입항'), { from: '03:00', to: null });
});

test('"출항 15시까지"의 15시는 출항 시각이 아니다', () => {
  // 바다사랑호 공지입니다. 앞에 "05시 30분 출항"이 있는데도 뒤의 마감 시각을 집었습니다.
  assert.deepEqual(
    tripTimeRange('05시 00분 사무실 도착 명부 작성(신분증지참)후 05시 30분 출항 15시까지 출조 합니다'),
    { from: '05:30', to: null },
  );
  // 앞에 붙은 표기가 없으면 마감 시각을 출항으로 지어내지 않고 비웁니다.
  assert.deepEqual(tripTimeRange('출항 15시까지 오세요'), { from: null, to: null });
});

test('오전에 나간 배의 "3시 입항"은 오후로 읽고, 24시 표기와 야간배는 건드리지 않는다', () => {
  assert.equal(tripTimeRange('예진호 6시 출항 4시 입항').to, '16:00');
  // 사이트가 24시 표기로 적었으면 그 말이 맞습니다.
  assert.equal(tripTimeRange('출항 05:00 입항 03:00').to, '03:00');
  // 오후에 나가 새벽에 들어오는 갈치·문어 배는 실제로 그렇습니다.
  assert.equal(tripTimeRange('16:30 출항 7시 입항').to, '07:00');
  assert.equal(tripTimeRange('오후 1시 출항 밤 12시 입항').to, '00:00');
});

test('PC 예약표: 태그 사이에 있는 시간과 서로 다른 배의 운항을 보존한다', () => {
  const html = pc(`<tr><td><span>오로라호</span> 쭈꾸미 &amp; 갑오징어<br>05:30~15:00</td>
    <td>낚시종류 쭈꾸미 <table><tr><td>입금자</td><td>예약자(2명/1,2)</td></tr></table></td><td>18명</td></tr>
    <tr><td>예시2호<br>오후1시~오후5시</td><td>낚시종류 우럭 예약하기</td><td>7명</td></tr>`);
  const rows = parseDetail(site, html);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(t => [t.departAt, t.returnAt]), [['05:30', '15:00'], ['13:00', '17:00']]);
  assert.deepEqual(rows.map(t => t.seatsLeft), [18, 7]);
  assert.equal(rows[0].hours, 9.5);
});

test('모바일 예약표: 혼합 텍스트를 읽고 오전·오후 항차를 합치지 않는다', () => {
  const html = `<div><p>2026-09-06</p>
    <h2>예시호<br>(오전배)</h2><p>남은자리 18명</p>
    <p>출항시간 <b>05:30</b>, 입항시간 <b>11:30</b></p>
    <p>입금자</p><p>예약자(2명/1,2)</p>
    <h2>예시호<br>(오후배)</h2><p>남은자리 20명</p>
    <p>공지 09:30 리더낚시에서 버스출발합니다.</p>
    </div>`;
  const rows = mergeDuplicates(parseDetail(site, html));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].boat, '예시호 (오전배)');
  assert.equal(rows[0].departAt, '05:30');
  assert.equal(rows[0].returnAt, '11:30');
  assert.equal(rows[1].boat, '예시호 (오후배)');
  assert.equal(rows[1].departAt, null);
});

test('태그로 분리된 예약자 명단을 보존하고 대기자·취소자는 좌석에서 제외한다', () => {
  const html = `<p>2026-09-06</p><h2>예시호</h2><p>남은자리 예약하기</p>
    <p>출항시간 <b>05:30</b></p>
    <div>입금자</div><div>예약자(2명/1,2)</div>
    <div>입금대기</div><div>예약자(1명/3)</div>
    <div>대기자</div><div>예약자(2명/4,5)</div>
    <div>취소자</div><div>예약자(1명/6)</div>`;
  const [row] = parseDetail(site, html);
  assert.equal(row.seatsLeft, 17);
  assert.equal(row.departAt, '05:30');
});

// 공지가 어종을 안 가리는 곳이 있습니다 — 52fish는 배로만 갈리고("오전배 : 5시 출항"),
// 바다사랑호는 어종 없이 "05시 30분 출항"이라고만 적습니다. 어종을 적으라고 우기면
// 공지에 없는 어종을 우리가 지어내야 합니다.
test('어종을 안 적은 공지는 그 선사의 모든 출조에 걸린다', () => {
  const guideSite = { ...site, timeGuide: { departAt: '05:30',
    validFrom: '2026-01-01', validThrough: '2026-12-31', source: 'https://example.com' } };
  const fields = { boat: '예시호', date: '2026-09-06' };

  assert.equal(makeTrip(guideSite, { ...fields, species: '주꾸미' }).departAt, '05:30');
  assert.equal(makeTrip(guideSite, { ...fields, species: '농어' }).departAt, '05:30');
  // 어종을 아예 못 읽은 출조에도 걸립니다 — 그런 예약판이라 공지에 기댑니다.
  assert.equal(makeTrip(guideSite, fields).departAt, '05:30');
  assert.equal(makeTrip(guideSite, fields).timeSource, 'notice');
  // 유효기간은 그대로 필수입니다. 어종을 안 적었다고 아무 때나 걸리면 안 됩니다.
  assert.equal(makeTrip(guideSite, { ...fields, date: '2027-01-01' }).departAt, null);
  const noRange = { ...site, timeGuide: { departAt: '05:30', source: 'https://example.com' } };
  assert.equal(makeTrip(noRange, fields).departAt, null);
  // 배별로 적으면 그 배만입니다.
  const perBoat = { ...site, boats: { '가호': { timeGuide: { departAt: '10:30',
    validFrom: '2026-01-01', validThrough: '2026-12-31', source: 'https://example.com' } } } };
  assert.equal(makeTrip(perBoat, { ...fields, boat: '가호' }).departAt, '10:30');
  assert.equal(makeTrip(perBoat, { ...fields, boat: '나호' }).departAt, null);
});

test('선사 공지 보완은 유효기간·어종을 지키고 개별 예약 시각을 우선한다', () => {
  const guideSite = { ...site, timeGuide: { departAt: '05:30', species: ['쭈꾸미'],
    validFrom: '2026-01-01', validThrough: '2026-12-31', source: 'https://example.com' } };
  const fields = { boat: '예시호', date: '2026-09-06', species: '쭈꾸미' };
  const t = makeTrip(guideSite, fields);
  assert.equal(t.departAt, '05:30');
  assert.equal(t.timeSource, 'notice');
  const aliasGuideSite = { ...site, timeGuide: { ...guideSite.timeGuide, species: ['주꾸미·갑오징어'] } };
  const alias = makeTrip(aliasGuideSite, { ...fields, species: '쭈갑' });
  assert.equal(alias.departAt, '05:30');
  assert.equal(alias.species, '주꾸미·갑오징어');
  assert.equal(makeTrip(guideSite, { ...fields, date: '2027-01-01' }).departAt, null);
  assert.equal(makeTrip(guideSite, { ...fields, species: '우럭' }).departAt, null);
  const individual = makeTrip(guideSite, { ...fields, rawTime: '06:00~16:00' });
  assert.equal(individual.departAt, '06:00');
  assert.equal(individual.timeSource, undefined);
});
