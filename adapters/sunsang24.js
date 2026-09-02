// sunsang24(산다고) 호스팅 선사. 서브도메인만 바꾸면 그대로 재사용합니다.
//
// 클래스명이 아니라 "운항시간 / 남은자리 / 예약마감" 같은 본문 표기로 파싱합니다.
// 템플릿이 개편돼도 표기가 남아있는 한 버팁니다.
//
// 레이아웃 두 가지
//   schedule_fleet             — 월 페이지 하나에 한 달치 목록. 요청 1~2번이면 끝.
//   schedule_fleet_simple_top  — 달력 + 그 아래 하루치 목록(JS). 날짜별로 한 번씩 받아옵니다.

import * as cheerio from 'cheerio';
import { fetchHtml } from '../core/fetcher.js';
import { makeTrip, toDate, toTime, toTide, parseSeats } from '../core/schema.js';

const SPECIES = [
  '주꾸미', '쭈꾸미', '갑오징어', '한치', '문어', '광어', '우럭', '참돔', '감성돔', '돌돔',
  '농어', '삼치', '부시리', '방어', '고등어', '갈치', '대구', '열기', '볼락', '백조기',
  '민어', '침선', '눈볼대', '가자미', '숭어', '전어', '학꽁치', '오징어', '아나고',
];

const CALENDAR_PATH = 'schedule_fleet_simple_top';

export async function collect(site) {
  const path = site.path ?? 'schedule_fleet';
  return path === CALENDAR_PATH ? collectByDay(site) : collectByMonth(site);
}

// ── 목록형: 한 달치를 요청 한 번에. 2주를 보려고 14번 요청하지 않습니다. ──────────
async function collectByMonth(site) {
  const trips = [];

  for (const [i, url] of monthUrls(site).entries()) {
    try {
      const html = await fetchHtml(url, { mode: site.mode ?? 'static', waitFor: site.waitFor });
      trips.push(...parseRows(site, html, url));
    } catch (err) {
      // 첫 페이지가 죽으면 그 사이트는 못 읽는 겁니다. 다음 달 페이지가 없는 건 흔합니다.
      if (i === 0) throw err;
    }
  }

  if (!trips.length) throw new Error('출조 행을 못 찾았습니다 — 레이아웃이 바뀌었는지 확인하세요 (--dump)');
  return trips;
}

/**
 * 받아올 주소 목록.
 *
 * 실제 사이트들이 쓰는 주소는 `/ship/schedule_fleet` 하나뿐이고, 뒤에 숫자가 붙은
 * 경우(`/ship/schedule_fleet/1359`, `/0`)도 연월이 아니라 배 번호로 보입니다.
 * 그래서 월을 임의로 붙이지 않고 경로 하나만 부릅니다 — 요청도 한 번이면 끝납니다.
 *
 * 다음 달 일정까지 주소로 넘길 수 있는 사이트를 찾으면 registry에 monthPath를 적으세요.
 * ({ym}=202609, {year}=2026, {month}=09)
 * 배가 여러 척이라 배별 페이지를 봐야 하면 path에 번호까지 적으면 됩니다
 * (예: "path": "schedule_fleet/1359").
 */
export function monthUrls(site, now = new Date()) {
  const path = site.path ?? 'schedule_fleet';
  if (!site.monthPath) return [joinUrl(site.url, `/ship/${path}`)];

  return monthsInRange(site.days ?? 21, now).map((ym) =>
    joinUrl(site.url, site.monthPath.replace('{ym}', ym).replace('{year}', ym.slice(0, 4)).replace('{month}', ym.slice(4))),
  );
}

// ── 달력형: 페이지에 선택된 하루치만 나오므로 주소로 날짜를 바꿔가며 받습니다. ────
async function collectByDay(site) {
  const days = site.days ?? 10;   // 날짜 수만큼 브라우저를 띄웁니다. 짧게 잡으세요.
  const template = site.dayPath ?? `/ship/${CALENDAR_PATH}/{ymd}`;
  const trips = [];
  const seenDates = new Set();

  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() + i * 86400e3);
    const url = joinUrl(site.url, fillDate(template, day));
    const html = await fetchHtml(url, { mode: site.mode ?? 'js', waitFor: site.waitFor });
    const rows = parseRows(site, html, url);
    trips.push(...rows);

    // 돌아온 페이지에 적힌 날짜를 그대로 쓰기 때문에, 주소가 날짜를 반영하지 않으면
    // 같은 날이 반복될 뿐 엉뚱한 날짜가 붙지는 않습니다. 그 상태를 여기서 잡습니다.
    const before = seenDates.size;
    for (const t of rows) seenDates.add(t.date);
    if (i === 1 && seenDates.size === before) {
      throw new Error(
        `dayPath가 날짜를 안 바꾸는 것 같습니다 (${[...seenDates].join(', ')}만 반복). dayPath 설정을 확인하세요`,
      );
    }
  }

  if (!trips.length) throw new Error('출조 행을 못 찾았습니다 — waitFor/dayPath를 확인하세요 (--dump)');
  return trips;
}

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
        departAt: toTime(after(text, '운항시간') ?? text),
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
const BOAT_NAME = /([가-힣A-Za-z0-9]{1,12}호)(?![가-힣])/;

function pickBoat(site, cells, text) {
  const known = Object.keys(site.boats ?? {});
  const hit = known.find((b) => text.includes(b));
  if (hit) return hit;
  // registry에 안 적힌 배는 "○○호" 표기를 그대로 씁니다. 한 사이트에 배가 여럿이어도 잡힙니다.
  const m = (cells.join(' ') + ' ' + text).match(BOAT_NAME);
  return m ? m[1] : site.name ?? null;
}

function after(text, marker) {
  const i = text.indexOf(marker);
  return i < 0 ? null : text.slice(i + marker.length, i + marker.length + 20);
}

// ── 잡동사니 ────────────────────────────────────────────────────────────────
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function monthsInRange(days, now = new Date()) {
  const out = [];
  const cur = new Date(now);
  const end = new Date(now.getTime() + days * 86400e3);
  while (cur <= end) {
    out.push(`${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setDate(1);
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function fillDate(template, day) {
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, '0');
  const d = String(day.getDate()).padStart(2, '0');
  return template.replace('{ymd}', `${y}${m}${d}`).replace('{date}', `${y}-${m}-${d}`);
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}
