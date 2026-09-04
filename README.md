# 낚시 출조 예약 현황판

여러 낚시 예약 사이트를 긁어와 한 페이지에서 빈자리를 확인합니다.
GitHub Actions가 주기적으로 수집해 `docs/data.json`으로 커밋하고, GitHub Pages가 그 페이지를 서빙합니다. 서버는 필요 없습니다.

```
.github/workflows/collect.yml   4시간마다 수집 → data.json 커밋
sites/registry.json             ★ 사이트 목록 (여기만 손대면 됩니다)
adapters/                       사이트 유형별 파서
  sunsang24.js                  sunsang24(산다고) 호스팅 선사 — 서브도메인만 바꾸면 재사용
  thefishing.js                 더피싱(thefishing.kr) 예약모듈 선사
core/schema.js                  통합 스키마 + 표기 정규화
core/fetcher.js                 HTTP / Playwright, 호스트별 요청 간격 제어
core/store.js                   data.json 읽기·쓰기
core/diff.js                    이전 결과와 비교해 새로 난 자리만 추출
core/notify.js                  텔레그램 / 디스코드 알림
core/runner.js                  전체 순회, 실패 격리
test/                           가상 HTML로 파서 회귀 확인 (npm test)
docs/index.html                 화면
docs/data.json                  수집 결과 (지금 든 건 예시 데이터)
```

## 시작하기

1. 새 **공개** 레포를 만들고 이 파일들을 올립니다.
   비공개로 하면 무료 개인 계정에서 스케줄이 안 도는 문제가 있습니다.
2. Settings → Pages → Source를 `main` 브랜치의 `/docs`로 지정합니다.
3. Settings → Actions → General → Workflow permissions를 **Read and write**로 바꿉니다.
   (봇이 `data.json`을 커밋해야 합니다.)
4. `sites/registry.json`에 실제 사이트를 넣고 `enabled: true`로 바꿉니다.
5. Actions 탭 → collect → **Run workflow**로 수동 실행해서 확인합니다.

로컬 확인:

```bash
npm install
npx playwright install chromium   # JS 렌더링 사이트가 있을 때만

node debug.js                     # 등록된 사이트 id 목록
node debug.js akbari              # 한 곳만 돌려보기
node debug.js akbari --dump       # 원본 HTML을 tmp/ 에 저장
node debug.js akbari --peek       # 페이지가 어떻게 생겼는지 요약 (로그로)
node collect.js                   # 전체
npm test                          # 파서 회귀 확인 (네트워크 불필요)
npm run serve                     # http://localhost:8080
```

어댑터를 고칠 때는 `debug.js`가 훨씬 빠릅니다. 파싱 결과를 표로 보여주고,
잔여석이 전부 비었다거나 날짜가 하루뿐이라거나 하는 흔한 증상을 짚어줍니다.

작업 맥락은 `CLAUDE.md`에 정리해뒀습니다. Claude Code로 이어서 작업할 때 그 파일부터 읽히면 됩니다.

## sunsang24 선사 추가하기

`akbari.sunsang24.com`처럼 sunsang24가 호스팅하는 선사는 도메인만 적으면 끝납니다.
같은 사이트에 배가 여러 척이면 전부 한 번에 잡힙니다.

```jsonc
{
  "id": "akbari",
  "name": "구매항 악바리호",
  "adapter": "sunsang24",
  "url": "https://akbari.sunsang24.com",  // 경로는 어댑터가 붙입니다
  "port": "충남 태안 구매항",
  "mode": "static",
  "enabled": true,
  "boats": { "맥가이버호": { "port": "영목항" } }  // 배마다 출항지가 다를 때만
}
```

### 레이아웃이 두 가지입니다

- **`schedule_fleet`** — 한 페이지에 출조 목록이 다 들어있습니다. 위 설정 그대로 쓰면 됩니다. (예: 악바리호)

  주소는 `/ship/schedule_fleet` **하나만** 부릅니다. 뒤에 숫자가 붙은 주소(`/ship/schedule_fleet/1359`)도
  있는데 연월이 아니라 배 번호라, 월을 임의로 붙이지 않습니다. 배별 페이지를 봐야 하면
  `"path": "schedule_fleet/1359"`처럼 번호까지 적으세요. 다음 달 일정을 주소로 넘길 수 있는
  사이트를 찾으면 `"monthPath": "/ship/schedule_fleet/{ym}"`을 적으면 달을 넘겨가며 받습니다.
- **`schedule_fleet_simple_top`** — 달력이 위에 있고 아래에 하루치 목록이 **JS로** 그려집니다. (예: 피싱게이트)

달력형은 세 가지를 더 적어야 합니다.

```jsonc
{
  "path": "schedule_fleet_simple_top",
  "mode": "js",                                        // JS 렌더링 필수
  "waitFor": "text=운항시간",                            // 목록이 그려질 때까지 대기
  "dayPath": "/ship/schedule_fleet_simple_top/{ymd}"   // {ymd}=20260905, {date}=2026-09-05
}
```

페이지에는 선택된 하루치만 나오므로 `dayPath`로 날짜를 바꿔가며 받아옵니다. 돌아온 페이지에
적힌 날짜 머리글을 그대로 쓰기 때문에, 주소가 날짜를 반영하지 않으면 같은 날이 반복될 뿐
엉뚱한 날짜가 붙지는 않습니다. 두 번째 요청에서 새 날짜가 안 늘면 오류로 알려줍니다.

날짜 수만큼 브라우저를 띄우므로 이런 사이트를 붙이면 `DAYS`를 7~10 정도로 줄이세요.

- 이 어댑터는 클래스명이 아니라 "운항시간 / 남은자리 / 예약마감" 같은 본문 표기로 파싱하므로, 템플릿이 개편돼도 잘 버팁니다.
- 목록형은 요청 한 번으로 끝납니다. 2주치를 보려고 14번 요청하지 않습니다.
- 날짜 위치도 자동으로 가립니다. 목록형은 날짜 머리글이 행 앞에 따로 있고, 달력형은 행 안 첫 칸에 들어있는데 둘 다 처리합니다.
- "전화예약 0명"으로 뜨는 홍보성 행은 버립니다 (`skipPhoneOnly: false`로 끄면 포함).
- **일정표에도 선박소개에도 승선료가 없습니다.** 예약창을 열어야 나오는데, 배·날짜마다 한 번씩 열어야 해서 요청 수가 수십 배로 늘고 차단 위험도 커집니다. 대신 registry에 적어두세요. 승선료는 어종·시즌 단위라 자주 안 바뀝니다.

  ```jsonc
  "boats": {
    "악바리호": { "prices": { "주꾸미": 100000, "갑오징어": 100000, "광어": 150000 } },
    "레드맨호": { "price": 90000 },                        // 어종 관계없이 고정가
    "맥가이버호": { "port": "영목항" }                      // 모르면 비워두면 됩니다
  },
  "prices": { "우럭": 80000 }                              // 사이트 전체 공통값
  ```

  그 날 어종에 맞는 가격을 붙이고, 못 찾으면 비워둡니다. 화면에서는 가격칸이 비어 보입니다.
- 물때(12물, 조금, 무시)도 같이 가져와 목록에 보여줍니다.

## 더피싱(thefishing.kr) 선사 추가하기

`?mid=bk` 형태의 예약 페이지를 쓰는 선사입니다. 한 요청에 8일치가 오므로 요청이 아주 적습니다.

```jsonc
{
  "id": "monster",
  "name": "오이도 몬스터호",
  "adapter": "thefishing",
  "url": "http://www.yusungho.kr/m/index.php?mid=bk",  // year/month/day는 어댑터가 붙입니다
  "port": "경기 시흥 시화방조제 중간선착장",
  "windowDays": 7,      // 한 요청에 며칠치가 오는지
  "seatsTotal": 20,     // ★ 정원
  "enabled": true
}
```

### 두 가지 수집 방식

- **`"source": "index"` (기본)** — 메인 페이지의 "선박예약현황" 요약을 읽습니다. **요청 한 번에 배 전부 × 4주치**가 오고 잔여석 숫자가 그대로 들어있습니다. 가장 가볍고 정확합니다. 다만 어종·물때·출항시간은 없습니다.
- **`"source": "detail"`** — 예약 페이지(`?mid=bk`)를 날짜별로 읽습니다. 어종·물때가 필요할 때 씁니다.

메인에 요약이 없는 사이트면 자동으로 detail 방식으로 넘어가므로, 잘 모르겠으면 기본값 그대로 두면 됩니다.

**detail 방식의 잔여석 계산이 다릅니다.** 이 사이트는 "남은자리" 숫자가 HTML에 안 들어있습니다.
대신 입금자·입금대기 명단에 좌석번호가 적혀 있어서(`차재수님(6명/13,12,11,8,9,10)`),
그 번호를 세서 `정원 - 찬 자리`로 구합니다. 대기자·취소자 명단에도 좌석번호가 섞여 있지만
그 줄은 세지 않습니다.

그래서 **`seatsTotal`이 정확해야 잔여석이 맞습니다.** 처음 한 번은 사이트와 대조해보세요.
안 적으면 명단에 나온 가장 큰 좌석번호를 정원으로 추정하는데, 배가 안 찼을 때 틀립니다.

오전배·오후배는 별개 출조로 잡힙니다.

## 자체 사이트 추가하기 (generic)

sunsang24도 더피싱도 아닌 선사 홈페이지는 `generic` 어댑터로 주소만 적어보면 됩니다.
파싱을 클래스명이 아니라 "운항시간 / 남은자리 / 예약마감" 같은 본문 표기로 하기 때문에,
표기가 흔한 형태면 그대로 읽힙니다.

```jsonc
{
  "id": "blueseaho",
  "name": "오천항 푸른바다낚시",
  "adapter": "generic",
  "url": "https://www.blueseaho.com/reservation",   // 예약 목록이 있는 주소
  "port": "충남 보령 오천항",
  "phone": "010-5402-0521",
  "enabled": true
}
```

목록이 여러 장으로 나뉘어 있으면 둘 중 하나를 더 적습니다.

```jsonc
"pages": ["/reservation", "/reservation?type=2"],   // 정해진 몇 장
"datePath": "/reservation?date={date}"              // 날짜별 ({date}=2026-09-05, {ymd}=20260905)
```

`node debug.js <id>`로 0건이 나오면 표기가 다른 사이트입니다. `--dump`로 원본을 보고
`adapters/`에 전용 파일을 하나 만드는 게 맞습니다.

## 그 밖의 사이트 추가하는 법

대부분은 `registry.json`에 한 덩어리만 추가하면 끝납니다.

```jsonc
{
  "id": "goodboat",              // 고유값, 아무거나
  "name": "○○호 예약",
  "adapter": "example-platform", // 재사용할 파서
  "url": "https://.../list?date={date}",
  "mode": "auto",                // auto | static | js
  "enabled": true,
  "selectors": { "row": "...", "boat": "...", "seats": "..." }
}
```

셀렉터는 브라우저에서 F12 → 원하는 요소 우클릭 → Copy → Copy selector로 뽑고, 목록 전체에 적용되게 마지막 인덱스(`:nth-child(3)` 등)만 지워주면 됩니다.

구조가 아예 다른 사이트라면 `adapters/`에 파일을 하나 만들고 `collect(site)` 하나만 내보내면 됩니다. `_mock.js`가 가장 짧은 예시입니다.

```js
export async function collect(site) {
  // ... 파싱 ...
  return [makeTrip(site, { date, status, seatsLeft, price, ... })];
}
```

`toStatus()`가 "예약가능 / ○ / 잔여3 / 마감 / 휴항" 같은 제각각인 표기를 하나로 정리해주므로, 원문 텍스트와 숫자만 그대로 넘기면 됩니다.

## 같은 배가 여러 사이트에 올라와 있을 때

한 선사가 예약 사이트를 두 개 쓰는 일이 흔합니다(예: 은가비호는 sunsang24와 더피싱 양쪽).
그대로 두면 같은 출조가 두 줄로 보이므로, **이름·출항지·전화번호가 셋 다 같을 때만** 한 줄로 합칩니다.

```jsonc
{ "id": "eungabi",  "name": "남당항 은가비호", "port": "충남 홍성 남당항", "phone": "010-2495-2060" },
{ "id": "eungabi2", "name": "은가비호 예약",   "port": "충남 홍성 남당항", "phone": "010-2495-2060" }
```

- **배 이름만으로는 안 합칩니다.** 다른 지역에 같은 이름의 배가 있습니다. 출항지나 전화번호가
  다르면 남남으로 둡니다.
- **셋 중 하나라도 비어 있으면 안 합칩니다.** 합쳐서 틀리는 것보다 두 줄로 보이는 게 낫습니다.
  합치고 싶으면 두 사이트 항목에 `port`와 `phone`을 같은 값으로 적어주세요.
- 전화번호는 표기가 달라도(`010-1234-5678` / `010.1234.5678`) 숫자만 비교합니다.
- 합쳐진 줄은 화면의 선사 칸에 **두 사이트가 다 링크로** 걸립니다. 어디서 잡든 상관없으니까요.
- 잔여석이 사이트마다 다르면 **큰 쪽**을 씁니다(플랫폼별로 배정된 좌석이 다를 수 있습니다).
  사이트별 숫자는 링크에 마우스를 올리면 보입니다.
- 한 곳이라도 휴항이라고 하면 휴항으로 봅니다. 자리가 남아도 배가 안 뜹니다.
- 배별로 연락처가 다르면 `boats: { "○○호": { "phone": "..." } }`로 적으면 됩니다.

## 즐겨찾기

배 왼쪽 **☆** 를 누르면 즐겨찾기에 들어가고, 위쪽 **★ 즐겨찾기만** 을 켜면 그 배들만 봅니다.
지도도 같이 좁혀집니다.

- **배 이름 + 출항지**로 기억합니다. 이름만으로 하면 다른 지역의 같은 이름 배가 같이 걸립니다
  (같은 배 합치기와 같은 이유입니다).
- 브라우저에만 저장합니다(`localStorage`). 서버가 없으니 **기기마다 따로** 남고,
  시크릿 창이나 사이트 데이터를 지우면 사라집니다.
- 저장이 막힌 브라우저에서도 화면은 그대로 돌아갑니다. 그 세션에서만 유지될 뿐입니다.

## 지도에서 보기

화면 위 **[표] [지도]** 로 바꿉니다. 지도는 Leaflet + OpenStreetMap이라 **API 키가 필요 없고**
GitHub Pages에서 그대로 돕니다.

- 마커 하나가 항구 하나입니다. 크기와 색이 **빈자리 있는 출조 수**를 따라갑니다.
- 마커를 누르면 그 항구만 걸러서 봅니다. 어종·날짜 필터를 걸면 지도도 같이 좁혀집니다.
- 좌표는 `sites/ports.json` 한 파일에 있습니다. 선사가 아니라 **항구 단위**입니다 —
  오천항 하나에 선사가 넷이라 사이트마다 적으면 같은 값이 네 번 들어갑니다.

```jsonc
"ports": {
  "충남 보령 오천항": { "lat": 36.41, "lng": 126.50, "approx": true }
}
```

**`approx: true`는 눈대중으로 넣은 값입니다.** 실제 선착장과 몇 km 어긋날 수 있으니
지도 보고 고쳐주세요. 좌표를 고치면 `approx`를 지우면 됩니다.

registry에 있는데 `ports.json`에 없는 항구는 지도에서 빠지고, 수집 로그가
`좌표 없는 항구: ○○` 로 알려줍니다. 표에는 그대로 나옵니다.

## 자리 났을 때 알림 받기

수집할 때마다 이전 결과와 비교해서 **새로 열린 자리만** 골라 알려줍니다.

- 마감이던 배에 자리가 남 (취소석)
- 열려있던 배의 잔여석이 늘어남 (부분 취소)

새로 올라온 일정은 알리지 않습니다. 아직 아무도 예약 안 한 게 당연해서 알림으로서 값어치가 없습니다.
수집에 실패한 사이트도 비교 대상에서 빠집니다. 예전 데이터가 남아있어 오탐이 나기 때문입니다.

텔레그램은 [@BotFather](https://t.me/BotFather)로 봇을 만들고 토큰을, 봇과 대화를 한 번 시작한 뒤
`https://api.telegram.org/bot<토큰>/getUpdates`에서 chat id를 확인하면 됩니다.

레포 Settings → Secrets and variables → Actions 에 넣으세요.

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

디스코드를 쓰면 `DISCORD_WEBHOOK` 하나만 넣으면 됩니다. 둘 다 안 넣으면 알림만 건너뛰고
수집은 정상 동작합니다. 알림 발송이 실패해도 수집 결과는 그대로 저장됩니다.

**주기 얘기.** 취소석은 몇 분 단위 경쟁입니다. GitHub Actions cron은 최소 5분이지만 실제로는
10~30분씩 밀리므로, 알림을 진지하게 쓸 거면 상시 서버(Oracle Cloud 등)에서 5분 주기로 돌리는 게 맞습니다.

## 사이트 계열

각 사이트가 어느 계열인지는 어댑터에서 자동으로 붙습니다 — **선상24 / 더피싱 / 자체**.
`node debug.js` 목록과 화면 하단 "수집 상태"에 같이 나옵니다.

```
✓ akbari         구매항 악바리호           [선상24]
✓ eugeneho       오천항 유진호             [더피싱]
✓ blueseaho      오천항 푸른바다낚시        [자체]
```

새 주소를 받았을 때 어느 계열인지 매번 따지게 되는데, 한 번 정한 답이 그대로 남습니다.
수집이 실패했을 때 **한 계열이 통째로 죽은 건지 그 사이트만 죽은 건지**도 바로 보입니다.

더피싱은 `"source": "detail"`이면 `더피싱(상세)`로 구분됩니다. 요청 수가 크게 다르기 때문입니다.
generic으로 잡았지만 실은 알려진 솔루션이면 `"platform": "서로피싱"`처럼 직접 적어도 됩니다.

## 지금 등록된 사이트

| id | 선사 | 어댑터 | 상태 |
|---|---|---|---|
| `akbari` | 구매항 악바리호 | sunsang24 | 켜짐 |
| `sunsang24ho` | 선상24호 | sunsang24 | 켜짐 |
| `eungabi` | 남당항 은가비호 | sunsang24 | 켜짐 — 레이아웃(목록형/달력형) 미확인 |
| `ocpro` | 오천항 프로낚시 | sunsang24 | 켜짐 — 전화번호 미확인 |
| `supernova` | 인천 팀슈퍼노바 | sunsang24 | 켜짐 — 선상24 파서 수리 대기 |
| `monster` | 오이도 몬스터호 | thefishing (index) | 켜짐 |
| `ssfish` | 무창포 선상낚시 | thefishing (index) | 켜짐 |
| `hifishing` | 대천항 하이피싱 | thefishing (index) | 켜짐 |
| `eugeneho` | 오천항 유진호 | thefishing (index) | 켜짐 — 20인승, 승선료 registry에 기록 |
| `mansu` | 영흥도 만수피싱 | thefishing (index) | 켜짐 — 만수피싱.kr, 정원 미확인 |
| `lureschool` | 오천항 루어스쿨 발키리호 | thefishing (index) | 켜짐 — 정원 미확인 |
| `jstar` | 전곡항 스타피싱 | thefishing (index) | 켜짐 — 더피싱 서브도메인 |
| `blueseaho` | 오천항 푸른바다낚시 | generic | 켜짐 — 자체 사이트, 파싱 미확인 |
| `raraho` | 오천항 라라호 | thefishing (index) | 켜짐 |
| `chungma` | 영종도 청마피싱 | thefishing (index) | 켜짐 — 배 5척 |
| `uijiho` | 의지호 | generic | 켜짐 — 계열·출항지 미확인 |
| `seohae` | 평택항 서해피싱 | thefishing | 꺼짐 — 예약모듈 형식 미확인 |
| `mock` | 예시 데이터 | _mock | 꺼짐 — 네트워크 없이 확인용 |

**이 목록은 국내 IP에서 검증되지 않았습니다.** 개발 환경에서 해당 도메인이 전부 차단돼
실제 HTML을 못 봤습니다. 처음 켤 때 `node debug.js <id>`로 한 번씩 대조하세요.
안 맞으면 그 사이트만 "갱신 실패"로 뜨고 나머지는 정상 동작합니다.

## 붙일 만한 후보

개별 선사를 하나씩 넣는 것보다, 여러 선사가 한 페이지에 모이는 곳이 값쌉니다.

| 후보 | 성격 | 예상 난이도 |
|---|---|---|
| [더피싱 예약검색](https://thefishing.kr/reservation/list.php) | 더피싱 계열 통합 목록. `?page=N`, `?sa[]=지역` | 중 — 목록에 잔여석 숫자가 있는지부터 확인 |
| [선상24 통합 검색](https://www.sunsang24.com/) | 제휴 1,000척+ | 중 — JS 렌더링/로그인 여부 확인 필요 |
| [물반고기반](https://www.moolban.com/), [어바웃피싱](https://booking.aboutfishing.kr/), [어신](https://us-in.io/) | 앱 우선 플랫폼 | 상 — 웹이 SPA일 가능성. 앱 API를 찾으면 오히려 깔끔 |
| [피싱고](https://fishingogo.com/), [낚시앱](https://www.fishapp.co.kr/) | 예약 플랫폼 | 미확인 |
| 서로피싱 등 솔루션 고객사 | 템플릿 하나로 여러 선사 | sunsang24처럼 어댑터 하나로 다 붙습니다 |

통합 플랫폼은 개별 선사 사이트보다 봇 차단이 빡빡할 가능성이 높습니다. 요청 간격을 넉넉히 잡으세요.

## 고칠 때

변경 하나마다 브랜치를 따고, 푸시한 다음 바로 PR을 엽니다. `main`에 직접 밀지 않습니다.
GitHub Pages가 `main`의 `/docs`를 보기 때문에 PR이 머지돼야 화면이 바뀝니다.

```bash
git checkout -b add-<사이트id>
node debug.js <사이트id>      # 파싱 확인
npm test
git commit -m "feat: ○○ 추가" && git push -u origin add-<사이트id>
```

## 알아둘 것

- **러너 IP는 해외 데이터센터**입니다. 국내 사이트가 차단하면 그 사이트만 국내 서버(Oracle Cloud 서울 리전 등)로 옮기면 됩니다.
- 워크플로는 브라우저가 필요한 사이트가 있을 때만 playwright를 받습니다(`npm run needs-browser`).
  registry가 전부 `static`이 되면 저절로 건너뛰어져서 1~2분 빨라집니다. `"js"`뿐 아니라
  `"auto"`도 본문이 비면 브라우저로 넘어가므로 같이 셉니다.
- 셀렉터가 바뀌면 해당 사이트만 0건이 됩니다. 페이지 하단 "수집 상태"와 목록의 "갱신 실패" 표시로 확인할 수 있고, 그 사이의 데이터는 지워지지 않고 남습니다.
- 요청 간격은 호스트당 3초로 잡혀 있습니다(`core/fetcher.js`의 `MIN_GAP_MS`). 사이트가 민감하면 늘리세요.
- 수집 주기는 `collect.yml`의 cron에서 바꿉니다. 현재 한국시간 06:10 / 12:10 / 18:10 / 21:10입니다.
# Fishing
