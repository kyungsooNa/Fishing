// 더피싱(thefishing.kr) 예약모듈을 쓰는 선사. `?mid=bk` 형태의 예약 페이지입니다.
//
// 수집 방식 두 가지
//   source:"index"  (기본) 메인의 "선박예약현황" 요약을 읽습니다. 요청 한 번에
//                   배 전부 × 4주치가 오고 잔여석 숫자가 그대로 들어있습니다.
//                   대신 어종·물때·출항시간은 없습니다.
//   source:"detail" 예약 페이지를 날짜별로 읽습니다. 어종·물때가 필요할 때.
//
// 메인에 요약이 없으면 자동으로 detail로 넘어갑니다.

import * as cheerio from 'cheerio';
import { fetchHtml } from '../core/fetcher.js';
import { makeTrip, toDate, tripTimeRange, toTide } from '../core/schema.js';
import { matchBoatName, speciesIn } from './_rows.js';
import { kstDate } from '../core/when.js';

export async function collect(site) {
  if ((site.source ?? 'index') === 'index') {
    try {
      const trips = await collectFromIndex(site);
      if (trips.length) return trips;
      console.warn(`  ${site.id}: 메인에 예약현황 요약이 없어 detail 방식으로 넘어갑니다`);
    } catch (err) {
      console.warn(`  ${site.id}: index 방식 실패(${err.message}) — detail로 넘어갑니다`);
    }
  }
  return collectFromDetail(site);
}

// ── index: 메인 페이지의 "선박예약현황" 요약 ────────────────────────────────
async function collectFromIndex(site) {
  const url = indexUrl(site.url);
  const html = await fetchHtml(url, { mode: site.mode ?? 'static' });
  return parseIndex(site, html, url);
}

/** 메인 요약표 파싱. 네트워크를 안 타므로 실제 표기로 회귀 확인이 됩니다. */
export function parseIndex(site, html, url) {
  const $ = cheerio.load(html);
  const trips = [];

  $('table').each((_, table) => {
    const $t = $(table);
    // 표기 사이에 공백을 넣는 사이트가 많습니다("선박명 예 약 현 황 남은자리").
    // 공백을 남겨둔 채 찾다가 요약표를 놓치고, 날짜별로 21번씩 받아오고 있었습니다
    // (더피싱 99곳이 그래서 한 바퀴에 한 시간을 넘겼습니다).
    if (!/예약현황|선박예약|선상예약/.test(squash($t.text()).replace(/\s/g, ''))) return;

    // 머리행에서 날짜를, 각 행 첫 칸에서 배 이름을 읽습니다.
    const rows = $t.find('tr').toArray().map((tr) => $(tr).find('th, td').map((__, c) => squash($(c).text())).get());
    const headerIdx = rows.findIndex((cells) => cells.filter((c) => toDate(c)).length >= 2);
    if (headerIdx < 0) return;

    const dates = rows[headerIdx].map((c) => toDate(c));

    for (const cells of rows.slice(headerIdx + 1)) {
      const boat = cells[0];
      if (!boat || toDate(boat)) continue;

      cells.forEach((cell, i) => {
        const date = dates[i];
        if (!date || i === 0) return;
        const seatsLeft = cellSeats(cell);
        if (seatsLeft === null && !/휴항|결항|마감/.test(cell)) return;   // 빈칸 = 일정 없음
        trips.push(makeTrip(site, { boat, date, status: cell, seatsLeft, url }));
      });
    }
  });

  return trips;
}

// 요약표 칸은 "12", "마감", "휴항", "-" 처럼 짧습니다.
function cellSeats(cell) {
  const t = squash(cell);
  if (!t || t === '-' || t === '·') return null;
  if (/휴항|결항/.test(t)) return null;
  if (/마감|만석/.test(t)) return 0;
  const m = t.match(/^(\d{1,3})\s*(명|석|자리)?$/) ?? t.match(/(?:잔여|남은자리)\D{0,3}(\d{1,3})/);
  return m ? Number(m[1]) : null;
}

// ── detail: 예약 페이지를 날짜 창 단위로 ────────────────────────────────────
async function collectFromDetail(site) {
  const days = site.days ?? 21;
  const windowDays = site.windowDays ?? 7;    // 한 요청에 며칠치가 오는지
  const trips = [];

  for (let offset = 0; offset < days; offset += windowDays) {
    const day = new Date(Date.now() + offset * 86400e3);
    const url = detailUrl(site.url, day);
    const html = await fetchHtml(url, { mode: site.mode ?? 'static' });
    trips.push(...parseDetail(site, html, url));
  }

  if (!trips.length) {
    throw new Error('예약 페이지에서 출조를 못 찾았습니다 — mid=bk 주소가 맞는지 확인하세요 (--dump)');
  }
  return trips;
}

/**
 * 이 사이트는 "남은자리" 숫자가 HTML에 없습니다. 대신 입금자·입금대기 명단에
 * 좌석번호가 적혀 있어서(`차재수님(6명/13,12,11,8,9,10)`) 그 번호를 세서
 * `정원 - 찬 자리`로 구합니다. 대기자·취소자 줄에도 좌석번호가 섞여 있지만 세지 않습니다.
 */
export function parseDetail(site, html, url) {
  const $ = cheerio.load(html);
  const trips = [];

  // 상태도 명단 라벨도 글자가 아니라 이미지인 예약판이 많습니다. 특히 잔여석이
  // `<img alt="남은자리 8명">` 하나에만 들어 있는 곳이 있어서, 이걸 버리면 명단을
  // 세서 지어내는 수밖에 없었습니다(어울림호가 8자리인데 2/2로 나왔습니다).
  // 라벨(입금자·대기자)도 이미지라 누가 자리를 차지했는지도 구분이 안 됐습니다.
  $('img[alt]').each((_, el) => {
    const label = squash($(el).attr('alt'));
    const seats = label.match(/^남은자리\s*(\d{1,3})\s*[명석자리]*$/);
    // 피싱위너는 빈 명단을 열 때 정원값 이미지(21명)를 보내기도 하지만, 실제 화면에는
    // 숫자 없이 "예약가능"만 보이는 때가 있습니다. 확정 숫자로 노출하지 않도록 그 사이트가
    // 지정한 값은 예약 명단이 없을 때 상태 표기로만 남깁니다. 다른 숫자와 다른 선사는 그대로입니다.
    if (seats && Number(seats[1]) === site.emptySeatImagePlaceholder) {
      const rowText = squash($(el).closest('tr').text());
      if (!/\(\s*\d+/.test(rowText)) {
        $(el).replaceWith($('<span>').text('예약가능'));
        return;
      }
    }
    if (ALT_LABEL.test(label)) $(el).replaceWith($('<span>').text(label));
  });

  // 날짜 머리글로 페이지를 하루씩 끊습니다. 오전배·오후배는 별개 출조로 잡힙니다.
  for (const block of splitByDate($)) {
    const { date, text } = block;
    // 모바일판은 공지사항도 배와 같은 res_box/h2 구조입니다. registry 정원이 있으면
    // 공지의 "20시 안내문자"가 출항 20:00인 빈 배 20석으로 바뀌므로 배 이름 단계에서 버립니다.
    if (/^(?:공지사항?|안내사항?)$/.test(squash(block.boat))) continue;
    if (!date || !/남은자리|잔여|여석|입금|예약확정|휴항|결항|출조취소|개인사정/.test(text)) continue;

    const mode = site.seatCount ?? seatMode(text);
    const filled = countTakenSeats(text, mode);
    const explicit = detailSeats(text);
    const seatsTotal = site.seatsTotal ?? guessTotal(text, mode, explicit, filled, site.seatCount);
    const boat = pickBoat(site, block.boat ?? text);
    if (site.excludeBoats?.includes(boat)) continue;

    const time = tripTimeRange(text);
    const species = speciesIn(text);
    // 위에서 정원 이미지를 "예약가능"으로 낮춘 행은 그 표기가 긴 공지 뒤에 있어
    // 200자 상태 요약에서 잘릴 수 있습니다. 숫자는 모르더라도 예약 가능 상태는 보존합니다.
    const statusText = site.emptySeatImagePlaceholder && /예약가능/.test(text)
      ? `예약가능 ${text}` : text;
    let seatsLeft = explicit;
    if (seatsLeft === null && Number.isFinite(seatsTotal)) seatsLeft = Math.max(0, seatsTotal - filled);
    // 어종·승선료를 적은 상시 공지도 날짜 표 안에 매일 반복됩니다. 좌석이나 예약 상태가
    // 하나도 없으면 실제 출조 행으로 만들지 않습니다(야야호의 나로호 독배 안내).
    if (seatsLeft === null && seatsTotal === null &&
      !/예약하기|예약완료|예약마감|마감|만석|휴항|결항|출조취소|개인사정|입금|예약확정/.test(text)) {
      continue;
    }

    trips.push(
      makeTrip(site, {
        boat,
        date,
        departAt: time.from,
        returnAt: time.to,
        species,
        // 날짜 머리글에서 집은 물때가 먼저입니다 — 본문에는 다른 날 물때가 섞일 수 있습니다.
        tide: block.tide ?? toTide(text),
        status: statusText.slice(0, 200),
        seatsLeft,
        seatsTotal,
        // 한 요청에 일주일치가 오는데(windowDays) 받아온 주소를 그대로 붙이면 그 주의 첫
        // 날짜로 갑니다 — 9월 8일 출조를 눌렀는데 9월 7일 예약판이 열렸습니다.
        // 이 사이트는 주소에 날짜를 넣을 수 있으니 출조마다 제 날짜로 답니다.
        url: dayUrl(site, date) ?? url,
        urlDated: Boolean(dayUrl(site, date)),
      }),
    );
  }

  return trips;
}

// 글자로 남는 라벨 + 이미지로만 있던 라벨. 잔여석("남은자리 8명")도 이미지라 같이 살립니다.
const ALT_LABEL = /^(남은자리\s*\d{1,3}\s*[명석자리]*|예약완료|예약마감|마감|만석|매진|예약하기|대기하기|개인사정|휴항|결항|출조취소|입금자|입금대기|예약자|대기자|취소자)$/;

// 연·월 선택기의 "2026년 1월 2월"을 2026-01-02로 읽지 않도록 한국식 날짜는 '일'까지 봅니다.
const DATE_HEADING = /^(?:20\d{2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{1,2}|20\d{2}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*(?:[-./]\s*\d{1,2}|월\s*\d{1,2}\s*일))/;

// 입금자·입금대기 명단만 셉니다. 대기자·취소자는 자리를 차지하지 않습니다.
const TAKEN_LINE = /(입금|예약확정|확정|^예약자)/;
const SKIP_LINE = /(대기자|취소|환불)/;

// 좌석번호를 적는 예약판인지("6명/13,12,11"), 인원만 적는 예약판인지("(2)") 가릅니다.
// 인원만 적힌 곳에서 숫자를 좌석번호로 보면 정원이 "가장 큰 일행 수"가 됩니다.
function seatMode(text) {
  return /\(\s*\d+\s*명\s*\/|\(\s*\d+\s*,/.test(text) ? 'seatNumbers' : 'people';
}

function countTakenSeats(text, mode = 'seatNumbers') {
  const seats = new Set();
  let people = 0;
  // 라벨이 이미지라서 이름과 다른 칸에 있는 예약판이 있습니다. 줄마다 라벨을 찾는 대신
  // 마지막에 본 라벨을 이어서 씁니다 — "입금자" 다음 줄들은 찬 자리, "대기자" 다음은 아닙니다.
  // 인원만 적는 예약판은 라벨 없이 명단만 있는 곳이 많아 일단 세고, 대기자를 만나면 멈춥니다.
  let taking = mode === 'people';
  for (const part of text.split(/(?=입금대기|입금자|예약확정|대기자|취소자|환불)/)) {
    if (SKIP_LINE.test(part)) {
      taking = false;
      continue;
    }
    if (TAKEN_LINE.test(part)) taking = true;
    if (!taking) continue;
    for (const m of part.matchAll(/\((?:(\d+)명\s*\/\s*)?([\d,\s]*)\)/g)) {
      if (mode === 'people') {
        const n = Number(m[1] ?? m[2].trim());
        if (Number.isFinite(n)) people += n;
        continue;
      }
      for (const n of m[2].split(',')) {
        const v = Number(n.trim());
        if (Number.isFinite(v) && v > 0) seats.add(v);
      }
    }
  }
  return mode === 'people' ? people : seats.size;
}

/**
 * registry에 정원을 안 적었을 때. 지어내지 않는 게 원칙이라 근거가 있을 때만 돌려줍니다.
 *   남은자리가 적혀 있으면  → 남은자리 + 찬 자리 (어울림호 9/9: 8 + 6 = 14, 실제 정원과 같습니다)
 *   좌석번호식 예약판이면    → 가장 큰 좌석번호
 *   people을 registry에 박아둔 곳은 마감일 때 예약 인원 합계 (청광호)
 * 그 밖에는 null입니다. 인원 명단의 최대값을 정원으로 쓰면 "2/2" 같은 헛것이 나옵니다.
 */
function guessTotal(text, mode, explicit, filled, configured) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit + filled;
  if (mode === 'seatNumbers') return maxSeatNumber(text);
  if (configured === 'people' && explicit === 0) return filled;
  return null;
}

function detailSeats(text) {
  if (!/남은자리|잔여|여석|잔여석/.test(text)) return null;
  const compact = text.replace(/\s+/g, '');
  if (/(?:남은자리|잔여|여석|잔여석)[:：]?(?:★)?(?:독배)?(?:예약완료|예약마감|마감|만석|매진)/.test(compact)) return 0;
  // 일부 예약판은 머리글의 "남은자리"와 상태 이미지가 멀리 떨어져 있습니다.
  if (/(?:남은자리|잔여|여석|잔여석)[\s\S]{0,3000}(?:예약완료|예약마감)/.test(text)) return 0;
  const m = text.match(/(?:남은자리|잔여|여석|잔여석)\s*[:：]?\s*(\d{1,3})(?:\s*(?:명|석|자리)|(?=\s|$))/);
  return m ? Number(m[1]) : null;
}

// seatsTotal을 안 적었을 때의 추정값. 배가 안 찼으면 틀리므로 registry에 적는 게 맞습니다.
function maxSeatNumber(text) {
  let max = null;
  for (const m of text.matchAll(/\((?:\d+명\s*\/\s*)?([\d,\s]+)\)/g)) {
    for (const n of m[1].split(',')) {
      const v = Number(n.trim());
      if (Number.isFinite(v)) max = Math.max(max ?? 0, v);
    }
  }
  return max;
}

function splitByDate($) {
  // PC 예약판은 하루 표 안의 각 행이 배·항차 하나입니다. 공지/좌석을 서로 섞지 않습니다.
  const rows = [];
  let foundDatedSeatTable = false;
  $('table').each((_, table) => {
    const direct = $(table).children('tr').add($(table).children('tbody,thead').children('tr'));
    let seatsColumn = -1;
    if (!direct.toArray().some((r) => {
      const labels = $(r).children('th,td').map((__, c) => squash($(c).text())).get();
      if (labels.includes('선박명')) seatsColumn = labels.indexOf('남은자리');
      return labels.includes('선박명') && labels.includes('남은자리');
    })) return;
    let date = null;
    let tideText = '';
    for (const row of direct.toArray()) {
      const cells = $(row).children('th,td');
      const heading = squash(cells.first().text());
      if (heading.length <= 40 && /^20\d{2}/.test(heading)) {
        date = toDate(heading);
        foundDatedSeatTable ||= Boolean(date);
        tideText = heading;
        continue;
      }
      if (!date || cells.length < 2 || cells.first().is('th')) continue;
      // 공지 전용 행에 입금 안내가 있으면 출조 표기처럼 보입니다. 배가 아닌 첫 칸에서
      // 거르는 편이 안전합니다 — 실제 배 행의 공지 문구는 그대로 읽습니다.
      if (/^(?:공지사항?|안내사항?)$/.test(heading)) continue;
      const text = textWithBreaks($, row);
      if (!/공지|낚시종류|입금|예약하기|예약완료|대기하기|휴항|결항|출조취소|개인사정/.test(text)) continue;
      rows.push({ date, boat: heading, text: tideText + '\n' + text + '\n남은자리 ' + squash(cells.eq(seatsColumn).text()) });
    }
  });
  // 예약 표가 비어 있는 날은 0건입니다. 모바일 파서로 다시 훑으면 주소·입금 안내를
  // 그 날의 출조 한 건으로 잘못 만들 수 있습니다(만석낚시의 빈 일정표).
  if (foundDatedSeatTable) return rows;

  const blocks = [];
  let cur = null;
  function visit(el) {
    if (el.type === 'text') { if (cur) cur.text += el.data; return; }
    if (/^(script|style|noscript)$/.test(el.name)) return;
    const text = squash($(el).text());
    // 예약판 위 날짜 선택 버튼도 "2026년 9월 13일"처럼 생겼습니다. 이걸 하루 머리글로
    // 잡으면 달력·공지를 한 출조로 묶고, registry 정원에서 0명을 빼 가짜 만석(20/20)을
    // 만듭니다(오이도 몬스터호). 링크와 날짜선택 UI는 일정 머리글이 아닙니다.
    const dateLike = text.length <= 40 && DATE_HEADING.test(text);
    const dateControl = dateLike && (el.name === 'a' || $(el).closest('a').length
      || $(el).children('a').length || /날짜선택/.test(text));
    const asDate = dateLike && !dateControl ? toDate(text) : null;
    if (asDate && !/예약|입금|공지/.test(text)) {
      // 물때는 날짜 머리글 옆에 붙는데, 붙는 방식이 판마다 다릅니다.
      //   PC판   : <span>2026년 09월 09일</span>, 수요일, 4물   ← 요소 없는 텍스트
      //   모바일판: <span>2026년 09월 07일 (월요일)</span><span>2물</span>  ← 형제 요소
      // 그래서 둘 다 담고 있는 부모 전체 글자에서 집습니다. 하나만 보다가 두 번 틀렸습니다
      // (#94는 텍스트 쪽, 모바일 /m/ 11곳은 형제 요소 쪽이라 237건이 통째로 비었습니다).
      cur = { date: asDate, text: '', tide: toTide(squash($(el).parent().text())) };
      blocks.push(cur);

      const nodes = $(el).parent().contents().toArray();
      const tail = squash(nodes.slice(nodes.indexOf(el) + 1)
        .filter((n) => n.type === 'text')
        .map((n) => $(n).text())
        .join(' '));
      if (tail) cur.text += tail + '\n';
      return;
    }
    // 모바일 예약판의 항차 머리글. <h2>몬스터호<br>(오전배)</h2>도 보존합니다.
    const boatHeading = cur && /^h[1-6]$/.test(el.name)
      && (/호|오전배|오후배/.test(text) || $(el).closest('.res_box_header').length);
    if (boatHeading) {
      if (cur.boat) {
        // 빈 공지 카드도 다음 배와 경계를 나눕니다. 안 나누면 앞 카드의 배 이름과
        // 뒤 카드의 예약완료가 합쳐져 가짜 출조가 됩니다(팀한프로 → 흑돼지호).
        cur = { date: cur.date, tide: cur.tide, text: '' }; blocks.push(cur);
      }
      // 배 이름 앞의 머리말은 버리지만 물때는 cur.text 밖에 있어 살아남습니다.
      if (!cur.boat) cur.text = '';
      cur.boat = text;
    }
    for (const child of el.children ?? []) visit(child);
    if (cur && /^(br|p|div|li|tr|td|h[1-6])$/.test(el.name)) cur.text += '\n';
  }
  visit($('body')[0]);

  return blocks.filter((b) => b.text.trim());
}

function textWithBreaks($, el) {
  const copy = $(el).clone();
  copy.find('script,style').remove();
  copy.find('br').replaceWith('\n');
  copy.find('p,div,li,tr,td,th').append('\n');
  return copy.text();
}

function pickBoat(site, text) {
  const known = Object.keys(site.boats ?? {});
  const hit = known.find((b) => text.includes(b));
  const half = text.match(/(오전배|오후배|1부|2부)/);
  if (hit) return half ? `${hit} (${half[1]})` : hit;
  // "상호" 같은 안내문 낱말은 배로 치지 않습니다(matchBoatName).
  const named = matchBoatName(text);
  if (named) return half ? `${named} (${half[1]})` : named;
  // 오전배·오후배만 구분되는 사이트는 그 표기를 배 이름 대신 씁니다.
  return half ? `${site.name ?? site.id} ${half[1]}` : site.name ?? site.id;
}

// ── 주소 ────────────────────────────────────────────────────────────────────
export function indexUrl(bookingUrl) {
  const u = new URL(bookingUrl);
  u.search = '';
  u.pathname = u.pathname.replace(/index\.php$/, '');
  return u.toString();
}

/**
 * 그 날짜의 예약 화면 주소. `day`는 Date이거나 "2026-09-09" 꼴 문자열입니다.
 *
 * 문자열을 그대로 받는 이유: 출조에 붙는 날짜는 이미 "2026-09-09" 꼴이라, Date로 바꿨다가
 * 다시 읽으면 시간대 때문에 하루가 밀 수 있습니다(`new Date('2026-09-09')`는 UTC 자정입니다).
 */
export function detailUrl(bookingUrl, day) {
  const u = new URL(bookingUrl);
  const [year, month, date] = typeof day === 'string'
    ? day.split('-').map(Number)
    : [day.getFullYear(), day.getMonth() + 1, day.getDate()];
  // 선사 홈페이지 주소를 그대로 복사해오면 mid=index(메인)인 경우가 많습니다.
  // 예약 페이지는 mid=bk라, 여기서 맞춰줍니다.
  u.searchParams.set('mid', 'bk');
  u.searchParams.set('year', String(year));
  u.searchParams.set('month', String(month));
  u.searchParams.set('day', String(date));
  return u.toString();
}

/** 주소가 이상해서 못 만들면(테스트 fixture 등) 조용히 포기하고 받아온 주소를 씁니다. */
function dayUrl(site, date) {
  if (!site.url || !date) return null;
  try {
    return detailUrl(site.url, date);
  } catch {
    return null;
  }
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 이 어댑터가 실제로 받아오는 주소. index 방식이 기본이라 메인 요약이 먼저입니다.
 *
 * 날짜가 붙은 주소를 **오늘과 일주일 뒤 두 개** 보여줍니다. 이 사이트의 예약판은 요청한
 * 날짜부터 며칠치를 이어서 그리는데, peek으로 둘을 견줘 보면 주소의 날짜가 실제로 판을
 * 옮기는지 바로 보입니다 — 출조마다 제 날짜 주소를 붙이는 근거가 그것입니다.
 */
export function targets(site) {
  return [indexUrl(site.url), detailUrl(site.url, kstDate(0)), detailUrl(site.url, kstDate(7))];
}
