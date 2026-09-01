# CLAUDE.md

낚시 예약 사이트 통합 현황판. 여러 선사 사이트를 긁어 한 페이지에서 빈자리를 확인하고,
자리가 나면 알림을 보낸다.

## 지금 상태 — 여기부터 읽을 것

**어댑터는 실제 사이트에 대고 한 번도 돌려본 적이 없다.**
지금까지의 검증은 전부 손으로 만든 픽스처 HTML로만 했다. 실제 HTML은 구조가 다를 수 있다.

첫 할 일은 사이트별로 하나씩 돌려보고 깨지는 곳을 고치는 것이다.

```bash
npm install
node debug.js                 # 등록된 사이트 id 목록
node debug.js akbari          # 하나만 돌려보기
node debug.js akbari --dump   # 실패하면 원본 HTML을 tmp/ 에 저장
node collect.js               # 전체 (일부 실패해도 나머지는 진행됨)
```

`mode: "js"` 사이트(피싱게이트)를 테스트하려면 `npx playwright install chromium` 이 먼저 필요하다.

### 사이트별 검증 수준

| id | 어댑터 | 실제 페이지 구조 확인 | 파서 검증 |
|---|---|---|---|
| akbari | sunsang24 | 확인함 | 픽스처만 |
| oceanparty | sunsang24 | 같은 계열로 추정 | 안 함 |
| fishinggate | sunsang24 | 확인함 (JS 렌더링) | 픽스처만 |
| monster | thefishing (detail) | 확인함 | 픽스처만 |
| chungnam | thefishing (index) | 확인함 | 픽스처만 |
| chungkwang | thefishing (index) | 확인함 | 픽스처만 |
| eoulim / winner / punycode-bk / joeunfish | thefishing | 안 함 | 안 함 |

`punycode-bk`는 선사 이름을 몰라서 `name`이 임시값이다. 확인해서 고칠 것.

### 미해결 항목

1. **fishinggate의 `dayPath`가 추측값이다.** `/ship/schedule_fleet_simple_top/{ymd}`가 날짜를 받는지
   확인 안 됐다. 안 받으면 같은 날만 반복해서 온다(엉뚱한 날짜가 붙지는 않게 막아뒀다).
   브라우저에서 달력 날짜를 클릭했을 때 주소가 어떻게 바뀌는지 보고 고치면 된다.
2. **monster의 정원 20은 사용자가 확인해준 값이다.** 다른 배를 추가하면 정원을 다시 확인해야 한다.
3. 알림은 로직만 검증했고 실제 발송은 안 해봤다.

## 구조

```
collect.js        진입점. registry 읽고 → 수집 → data.json → 알림
debug.js          사이트 하나만 돌려보는 도구 (어댑터 고칠 때 이걸 쓴다)
serve.js          docs/ 정적 서버 (의존성 없음)
sites/registry.json  ★ 사이트 목록. 대부분의 작업은 여기서 끝난다
adapters/
  sunsang24.js    sunsang24(산다고) 호스팅 선사
  thefishing.js   더피싱(thefishing.kr) 모듈 선사
core/
  schema.js       통합 스키마 + 표기 정규화 (toStatus/toPrice/toDate)
  fetcher.js      HTTP/Playwright, 호스트당 최소 요청 간격
  store.js        data.json 읽기·쓰기, 이전 스냅샷 보관
  runner.js       전체 순회, 실패 격리
  notify.js       이전 대비 새로 열린 자리 감지 + 텔레그램/디스코드
docs/index.html   화면 (data.json을 fetch)
deploy/           systemd 유닛 + 설치 스크립트
```

어댑터는 `collect(site, { days })` 하나만 내보내고, `makeTrip()`으로 만든 배열을 반환한다.
어떤 사이트든 결과는 같은 스키마로 맞춰진다.

## 작업할 때 지킬 것

**파싱은 클래스명보다 본문 텍스트 패턴을 우선한다.** 이 사이트들은 호스팅 업체 템플릿이라
클래스명이 자주 바뀐다. `운항시간`, `남은자리`, `예약마감` 같은 표기가 훨씬 오래 간다.
기존 어댑터가 그렇게 짜여 있으니 같은 방식을 유지할 것.

**0건은 성공이 아니라 실패로 처리한다.** 조용히 0건을 반환하면 "자리가 없는 것"과
"파서가 깨진 것"을 구분할 수 없다. 어댑터는 0건이면 throw 한다.

**한 사이트 실패가 전체를 막지 않는다.** 실패한 사이트는 이전 데이터를 그대로 두고
`stale` 표시만 한다. 이 동작을 깨지 말 것.

**요청 간격을 줄이지 말 것.** `core/fetcher.js`의 `MIN_GAP_MS`(호스트당 3초)와
registry의 `intervalMinutes`는 상대 서버를 배려하는 장치다. 영세한 선사 사이트들이다.

**개인정보를 저장하지 않는다.** thefishing 사이트의 예약자 명단에 실명과 전화번호가 노출돼
있는데, 어댑터는 좌석 번호만 세고 이름은 읽지도 저장하지도 않는다. 이 선을 유지할 것.

**`.env`는 커밋하지 않는다.** `.gitignore`에 있다. 알림 토큰이 들어간다.

## 흔한 실패와 대응

| 증상 | 원인 | 대응 |
|---|---|---|
| `출조 행을 못 찾음` | 텍스트 패턴 불일치 | `--dump`로 HTML 받아서 실제 표기 확인 |
| 날짜가 하루만 나옴 | dayPath가 날짜를 안 받음 | 주소 형식 확인 |
| 잔여석이 전부 비어있음 | 숫자가 JS로 그려짐 | `mode: "js"` 또는 index 방식으로 전환 |
| 배 이름이 이상하게 김 | 파싱 범위가 행 밖까지 감 | 가장 안쪽 행을 찾는 조건 확인 |
| 전부 timeout | 해외 IP 차단 | 국내 IP 서버에서 시도 |

## 하지 말 것

- **예약 자동화를 임의로 붙이지 말 것.** 사용자와 논의 중인 사안이고, 환불 규정(선사에 따라
  출조 7일 전 이후 환불 불가)과 선사와의 관계 때문에 조건을 못 박는 설계가 먼저 필요하다.
- 수집 주기를 5분 아래로 내리지 말 것.
- 어댑터를 사이트마다 새로 만들지 말 것. 대부분 registry 항목 추가로 끝난다.
  두 호스팅 업체가 국내 선사 사이트의 상당수를 차지한다.
