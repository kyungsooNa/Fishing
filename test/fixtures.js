// 실제 사이트에 못 붙는 환경에서도 파서 로직은 확인할 수 있게 만든 가상 페이지입니다.
// 실제 마크업이 아니라 "본문 표기"만 흉내 낸 것이라, 이 테스트가 통과해도
// 진짜 사이트에서 되는지는 node debug.js <id> 로 따로 확인해야 합니다.

export const SUNSANG24_LIST = `
<table>
  <tr><td>2026-09-05</td></tr>
  <tr>
    <td>악바리호</td><td>운항시간 05:30</td><td>주꾸미</td><td>12물</td><td>남은자리 4명</td>
  </tr>
  <tr>
    <td>레드맨호</td><td>운항시간 13:00</td><td>갑오징어</td><td>12물</td><td>예약마감</td>
  </tr>
  <tr>
    <td>홍보호</td><td>운항시간 06:00</td><td>우럭</td><td>조금</td><td>전화예약 0명</td>
  </tr>
  <tr><td>2026-09-06</td></tr>
  <tr>
    <td>맥가이버호</td><td>운항시간 06:00</td><td>광어</td><td>조금</td><td>남은자리 1명</td>
  </tr>
</table>`;

export const SUNSANG24_CALENDAR = `
<ul>
  <li><span>2026-09-07</span><span>악바리호</span><span>운항시간 05:00</span><span>우럭</span><span>남은자리 8명</span></li>
</ul>`;

export const THEFISHING_INDEX = `
<table>
  <caption>선박예약현황</caption>
  <tr><th>선박</th><th>9/5</th><th>9/6</th><th>9/7</th></tr>
  <tr><td>몬스터호</td><td>12</td><td>마감</td><td>-</td></tr>
  <tr><td>몬스터2호</td><td>3</td><td>7</td><td>휴항</td></tr>
</table>`;

export const THEFISHING_DETAIL = `
<div>
  <p>2026-09-05</p>
  <p>몬스터호 우럭 05:30 출항 7물</p>
  <p>입금자: 차재수님(6명/13,12,11,8,9,10)</p>
  <p>입금대기: 김철수님(2명/1,2)</p>
  <p>대기자: 박영희님(3명/3,4,5)</p>
  <p>취소: 이민호님(1명/7)</p>
</div>`;

// sunsang24도 더피싱도 아닌 자체 사이트. 표기만 같으면 같은 파서로 읽힙니다.
export const GENERIC_RESERVATION = `
<table>
  <tr><th>날짜</th><th>물때</th><th>선박</th><th>출항</th><th>어종</th><th>잔여</th></tr>
  <tr>
    <td>2026-09-08</td><td>10물</td><td>푸른바다3호</td><td>운항시간 06:00</td><td>쭈꾸미</td><td>남은자리 7명</td>
  </tr>
  <tr>
    <td>2026-09-08</td><td>10물</td><td>은갈매기호</td><td>운항시간 06:30</td><td>광어</td><td>예약마감</td>
  </tr>
</table>`;
