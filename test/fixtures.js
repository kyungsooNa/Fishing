// 실제 사이트에 못 붙는 환경에서도 파서 로직은 확인할 수 있게 만든 가상 페이지입니다.
// 실제 마크업이 아니라 "본문 표기"만 흉내 낸 것이라, 이 테스트가 통과해도
// 진짜 사이트에서 되는지는 node debug.js <id> 로 따로 확인해야 합니다.

// 실제 sunsang24 목록형 구조입니다(peek으로 확인).
//   바깥 tr = 하루   (첫 칸 날짜, 둘째 칸 물때)
//   그 안의 table.ship_unit = 출조 하나
// 한 출조의 정보가 여러 조각(li)으로 쪼개져 있어서, 행을 "잎 노드"로 잡으면 다 놓칩니다.
export const SUNSANG24_LIST = `
<table>
  <tr>
    <td>9월 4일(금)</td>
    <td>조금</td>
    <td class="ships_warp">
      <table class="ship_unit_ship_no_1976 ship_unit"><tbody><tr>
        <td>악바리호 <a>대기하기</a></td>
        <td>
          <ul class="list-unstyled reservation_detail no-read">
            <li>공지사항 : 쭈꾸미 나오면 안나올때까지</li>
            <li>어종 : 주꾸미 / 루어</li>
            <li class="shiptime"><div class="title"><strong>운항시간 :</strong></div> 04:00 ~ 17:00</li>
            <li>예약완료 입금대기 취소대기 취소완료 예약대기 출조대기</li>
          </ul>
        </td>
        <td>예약마감 21명 예약/21명</td>
      </tr></tbody></table>

      <table class="ship_unit_ship_no_1977 ship_unit"><tbody><tr>
        <td>레드맨호 <a>예약하기</a></td>
        <td>
          <ul class="list-unstyled reservation_detail">
            <li>어종 : 갑오징어</li>
            <li class="shiptime"><div class="title"><strong>운항시간 :</strong></div> 05:30 ~ 16:00</li>
          </ul>
        </td>
        <td>5명 예약/20명</td>
      </tr></tbody></table>
    </td>
  </tr>

  <tr>
    <td>9월 5일(토)</td>
    <td>1물</td>
    <td class="ships_warp">
      <table class="ship_unit"><tbody><tr>
        <td>맥가이버호</td>
        <td><ul><li>어종 : 광어</li><li class="shiptime">운항시간 : 06:00 ~ 15:00</li></ul></td>
        <td>19명 예약/20명</td>
      </tr></tbody></table>

      <table class="ship_unit"><tbody><tr>
        <td>오후호</td>
        <td><ul><li>어종 : 갑오징어</li><li class="shiptime">운항시간 : 13:00 ~ 18:00</li></ul></td>
        <td>3명 예약/15명</td>
      </tr></tbody></table>

      <!-- 공지에 "기상악화 출조취소", "쭈꾸미" 같은 말이 늘 들어있습니다. 날짜별 상태와는
           상관없는 문구인데, 이걸 같이 읽으면 자리가 남아도 휴항으로 잡힙니다 -->
      <table class="ship_unit"><tbody><tr>
        <td>공지많은호</td>
        <td><ul>
          <li>공지사항 : 기상악화시 출조취소될 수 있습니다. 미입금시 자동취소 처리됩니다. 쭈꾸미 시즌 오픈!</li>
          <li>어종 : 광어</li>
          <li class="shiptime">운항시간 : 06:00 ~ 14:00</li>
        </ul></td>
        <td>4명 예약/20명</td>
      </tr></tbody></table>

      <!-- 시간도 좌석 표기도 없는 껍데기. 실제 페이지에 날마다 하나씩 있습니다 -->
      <table class="ship_unit"><tbody><tr><td>맥가이버호 예약마감</td></tr></tbody></table>
    </td>
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

// 실제 사이트 상당수가 표기 사이에 공백을 넣습니다(peek으로 확인: angel.thefishing.kr).
// 이걸 못 알아보면 요약표를 놓치고 날짜별로 21번씩 받아오게 됩니다.
export const THEFISHING_INDEX_SPACED = `
<table>
  <tr><th>선박명</th><th>예 약 현 황</th><th>남은자리</th></tr>
  <tr><th>선박</th><th>9/5</th><th>9/6</th><th>9/7</th></tr>
  <tr><td>엔젤피싱호</td><td>20</td><td>3</td><td>마감</td></tr>
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
