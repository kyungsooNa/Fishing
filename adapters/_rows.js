// 출조 목록 한 줄을 읽는 부분. 사이트에 얽힌 게 없어서 어댑터들이 같이 씁니다.
//
// 클래스명이 아니라 "운항시간 / 남은자리 / 예약마감" 같은 본문 표기로 읽습니다.
// 템플릿이 개편돼도 표기가 남아있는 한 버팁니다.

import * as cheerio from 'cheerio';
import { makeTrip, toDate, toTide, parseSeats } from '../core/schema.js';

export const SPECIES = [
  '주꾸미', '쭈꾸미', '갑오징어', '한치', '문어', '광어', '우럭', '참돔', '감성돔', '돌돔',
  '농어', '삼치', '부시리', '방어', '고등어', '갈치', '대구', '열기', '볼락', '백조기',
  '민어', '침선', '눈볼대', '가자미', '숭어', '전어', '학꽁치', '오징어', '아나고',
];

// ── 파싱 ────────────────────────────────────────────────────────────────────
export function parseRows(site, html, url) {
  const $ = cheerio.load(html);
  const trips = [];
  let headerDate = null;   // 목록형은 날짜 머리글이 행 앞에 따로 나옵니다

  $('tr, li, .row, .list_item').each((_, el) => {
    const $el = $(el);
    if ($el.find('tr, li').length) return;      // 바깥 컨테이너는 건너뜁니다

    const text = squash($el.text());
    if (!text) return;

    // 날짜만 있는 머리글 행: 이후 행들의 기준 날짜가 됩니다.
    const onlyDate = text.length <= 24 && toDate(text) && !hasTripMarker(text);
    if (onlyDate) {
      headerDate = toDate(text);
      return;
    }

    if (!hasTripMarker(text)) return;

    // 달력형은 날짜가 행 안 첫 칸에 들어있습니다. 둘 다 처리합니다.
    const cells = $el.find('td, th, .cell').map((__, c) => squash($(c).text())).get();
    const inlineDate = toDate(cells[0] ?? '') ?? toDate(text.slice(0, 24));
    const date = inlineDate ?? headerDate;
    if (!date) return;

    // "전화예약 0명"으로 뜨는 홍보성 행은 버립니다.
    if (site.skipPhoneOnly !== false && /전화예약/.test(text) && /(^|\D)0\s*명/.test(text)) return;

    const boat = pickBoat(site, cells, text);
    const seatsLeft = /예약마감|마감|만석/.test(text) ? 0 : parseSeats(text);

    trips.push(
      makeTrip(site, {
        boat,
        date,
        rawTime: after(text, '운항시간') ?? text,
        species: SPECIES.find((s) => text.includes(s)) ?? null,
        tide: toTide(text),
        status: text,
        seatsLeft,
        url,
      }),
    );
  });

  return trips;
}

const TRIP_MARKERS = ['운항시간', '남은자리', '예약마감', '출항', '잔여', '예약하기', '전화예약'];
const hasTripMarker = (text) => TRIP_MARKERS.some((m) => text.includes(m));

// 한글에는 \b 단어경계가 없습니다. "○○호" 뒤에 한글이 이어지지 않는 것으로 끊습니다.
export const BOAT_NAME = /([가-힣A-Za-z0-9]{1,12}호)(?![가-힣])/;

/**
 * "○○호"로 끝나지만 배가 아닌 낱말. 예약 안내문에 늘 붙어 있습니다.
 * 안 거르면 화면에 "상호"라는 배가 뜹니다 — 실제로 더피싱 계열 여러 곳에서 그랬습니다.
 */
const NOT_BOAT = /^(상호|기호|신호|구호|암호|번호|[가-힣]{0,6}번호)$/;

/** 본문에서 배 이름으로 볼 만한 첫 "○○호". 안내문 낱말은 건너뜁니다. */
export function matchBoatName(text) {
  for (const m of String(text ?? '').matchAll(/([가-힣A-Za-z0-9]{1,12}호)(?![가-힣])/g)) {
    if (!NOT_BOAT.test(m[1])) return m[1];
  }
  return null;
}

function pickBoat(site, cells, text) {
  // "마성호"가 "뉴마성호" 안에서 먼저 잡히지 않도록 긴 이름부터 봅니다.
  const known = Object.keys(site.boats ?? {}).sort((a, b) => b.length - a.length);
  const hit = known.find((b) => text.includes(b));
  if (hit) return hit;
  // registry에 안 적힌 배는 "○○호" 표기를 그대로 씁니다. 한 사이트에 배가 여럿이어도 잡힙니다.
  return matchBoatName(`${cells.join(' ')} ${text}`) ?? site.name ?? null;
}

function after(text, marker) {
  const i = text.indexOf(marker);
  return i < 0 ? null : text.slice(i + marker.length, i + marker.length + 20);
}

export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
