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
import { makeTrip, toDate, toTime, toTide } from '../core/schema.js';
import { matchBoatName } from './_rows.js';

const SPECIES = [
  '주꾸미', '쭈꾸미', '갑오징어', '한치', '문어', '광어', '우럭', '참돔', '감성돔',
  '농어', '삼치', '부시리', '방어', '고등어', '갈치', '대구', '열기', '볼락', '백조기',
  '민어', '침선', '눈볼대', '가자미', '쭈갑',
];

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
  const $ = cheerio.load(html);
  const trips = [];

  $('table').each((_, table) => {
    const $t = $(table);
    if (!/예약현황|선박예약/.test(squash($t.text()))) return;

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

  // 예약 상태를 글자 대신 이미지로 표시하는 예약판도 있습니다.
  $('img[alt]').each((_, el) => {
    const label = squash($(el).attr('alt'));
    if (/^(예약완료|예약마감|마감|만석|매진|예약하기)$/.test(label)) {
      $(el).replaceWith($('<span>').text(label));
    }
  });

  // 날짜 머리글로 페이지를 하루씩 끊습니다. 오전배·오후배는 별개 출조로 잡힙니다.
  for (const block of splitByDate($)) {
    const { date, text } = block;
    if (!date || !/남은자리|잔여|여석|입금|예약확정/.test(text)) continue;

    const filled = countTakenSeats(text);
    const seatsTotal = site.seatsTotal ?? maxSeatNumber(text);
    const explicit = detailSeats(text);
    const boat = pickBoat(site, text);
    if (site.excludeBoats?.includes(boat)) continue;

    let seatsLeft = explicit;
    if (seatsLeft === null && Number.isFinite(seatsTotal)) seatsLeft = Math.max(0, seatsTotal - filled);

    trips.push(
      makeTrip(site, {
        boat,
        date,
        departAt: toTime(text),
        species: SPECIES.find((s) => text.includes(s)) ?? null,
        tide: toTide(text),
        status: text.slice(0, 200),
        seatsLeft,
        seatsTotal,
        url,
      }),
    );
  }

  return trips;
}

// 입금자·입금대기 줄의 좌석번호만 셉니다. 대기자·취소자 줄은 자리를 차지하지 않습니다.
const TAKEN_LINE = /(입금|예약확정|확정)/;
const SKIP_LINE = /(대기자|취소|환불)/;

function countTakenSeats(text) {
  const seats = new Set();
  for (const line of text.split(/[\n·|]|(?<=\))\s+/)) {
    if (!TAKEN_LINE.test(line)) continue;
    if (SKIP_LINE.test(line) && !/입금대기/.test(line)) continue;
    for (const m of line.matchAll(/\((?:\d+명\s*\/\s*)?([\d,\s]+)\)/g)) {
      for (const n of m[1].split(',')) {
        const v = Number(n.trim());
        if (Number.isFinite(v) && v > 0) seats.add(v);
      }
    }
  }
  return seats.size;
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
  const blocks = [];
  let cur = null;

  $('body').find('*').each((_, el) => {
    const $el = $(el);
    if ($el.children().length) return;                 // 잎 노드만
    const text = squash($el.text());
    if (!text) return;

    const asDate = text.length <= 30 ? toDate(text) : null;
    if (asDate) {
      cur = { date: asDate, text: '' };
      blocks.push(cur);
      return;
    }
    if (cur) cur.text += text + '\n';
  });

  return blocks.filter((b) => b.text.trim());
}

function pickBoat(site, text) {
  const known = Object.keys(site.boats ?? {});
  const hit = known.find((b) => text.includes(b));
  if (hit) return hit;
  // "상호" 같은 안내문 낱말은 배로 치지 않습니다(matchBoatName).
  const named = matchBoatName(text);
  if (named) return named;
  // 오전배·오후배만 구분되는 사이트는 그 표기를 배 이름 대신 씁니다.
  const half = text.match(/(오전배|오후배|1부|2부)/);
  return half ? `${site.name ?? site.id} ${half[1]}` : site.name ?? site.id;
}

// ── 주소 ────────────────────────────────────────────────────────────────────
export function indexUrl(bookingUrl) {
  const u = new URL(bookingUrl);
  u.search = '';
  u.pathname = u.pathname.replace(/index\.php$/, '');
  return u.toString();
}

export function detailUrl(bookingUrl, day) {
  const u = new URL(bookingUrl);
  // 선사 홈페이지 주소를 그대로 복사해오면 mid=index(메인)인 경우가 많습니다.
  // 예약 페이지는 mid=bk라, 여기서 맞춰줍니다.
  u.searchParams.set('mid', 'bk');
  u.searchParams.set('year', String(day.getFullYear()));
  u.searchParams.set('month', String(day.getMonth() + 1));
  u.searchParams.set('day', String(day.getDate()));
  return u.toString();
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 이 어댑터가 실제로 받아오는 주소. index 방식이 기본이라 메인 요약이 먼저입니다. */
export function targets(site) {
  return [indexUrl(site.url), detailUrl(site.url, new Date())];
}
