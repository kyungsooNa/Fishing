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
