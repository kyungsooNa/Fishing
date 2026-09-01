// 더피싱(thefishing.kr) 예약모듈을 쓰는 선사 사이트용 어댑터.
// 예: www.yusungho.kr (오이도 몬스터호)
//
// 특징:
//  - 정적 HTML (Playwright 불필요)
//  - ?mid=bk&year=2026&month=09&day=01 로 요청하면 그 날부터 8일치가 한 번에 온다
//
// 잔여석 처리가 이 사이트의 핵심 문제다.
// "남은자리" 옆 숫자가 HTML에 안 들어있는 경우가 있어서, 대신 입금자/입금대기 명단에 적힌
// 좌석번호를 세서 채워진 자리를 구한다. (13,12,11,8,9,10 → 6자리)
// 대기자·취소자 명단에도 좌석번호가 섞여 있으므로 그 줄은 절대 세지 않는다.

import { loadHtml } from '../core/fetcher.js';
import { makeTrip, STATUS } from '../core/schema.js';

const DATE_RE =
  /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*\(([월화수목금토일])요일\)\s*([^\s]*)?/;
const TIDE_RE = /^(\d{1,2}물|조금|무시|사리|한객기|대객기)$/;
const SEAT_ROWS = ['입금자', '입금대기']; // 이 줄의 좌석번호만 '찬 자리'로 센다

export async function collect(site, { days = 14 } = {}) {
  if ((site.source ?? 'index') === 'index') return collectFromIndex(site, days);
  return collectFromDetail(site, days);
}

/**
 * 메인 페이지의 "선박예약현황" 요약을 읽는다.
 * 요청 한 번에 배 전부 × 4주치가 오고 잔여석 숫자도 그대로 들어있어서 가장 가볍고 정확하다.
 * 대신 어종·물때·출항시간은 없다. 그게 필요하면 source를 "detail"로 바꾼다.
 */
async function collectFromIndex(site, days) {
  const url = site.indexUrl ?? site.url;
  const { $ } = await loadHtml(url, { mode: site.mode ?? 'static' });

  const limit = new Date(Date.now() + 9 * 3600 * 1000);
  limit.setUTCDate(limit.getUTCDate() + days);
  const until = limit.toISOString().slice(0, 10);

  const trips = parseIndex($, site, url).filter((t) => t.date <= until);

  // 메인에 요약이 없는 사이트도 있다. 그러면 예약 페이지를 날짜별로 읽는 방식으로 넘어간다.
  if (trips.length === 0) return collectFromDetail(site, days);
  return trips;
}

const SUMMARY_RE = /^(\d{1,2})\.(\d{1,2})\s*\([일월화수목금토]\)\s*(예약완료|남은자리\s*(\d+)\s*명|.*)$/;

export function parseIndex($, site, pageUrl) {
  const out = [];
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;

  let boat = null;

  const flat = [];
  (function walk(node) {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue;
      flat.push(child);
      walk(child);
    }
  })($.root()[0]);

  for (const node of flat) {
    const $el = $(node);

    // 배 머리글: title="○○호 선박예약/예약현황" 인 링크
    const title = $el.attr('title') ?? '';
    if (/선박예약/.test(title)) {
      boat = norm(title.split('선박예약')[0]);
      continue;
    }
    if (!boat) continue;

    // 날짜 칸: "9.25(금) 남은자리 2명" 을 통째로 가진 가장 안쪽 요소
    const text = norm($el.text());
    const m = text.match(SUMMARY_RE);
    if (!m) continue;
    const deeper = $el.find('*').filter((_, d) => SUMMARY_RE.test(norm($(d).text())));
    if (deeper.length) continue;

    const mo = Number(m[1]);
    const year = mo >= curM ? curY : curY + 1; // 연말에 다음 해로 넘어가는 경우
    const seatsLeft = m[4] != null ? Number(m[4]) : /예약완료/.test(m[3]) ? 0 : null;

    out.push(
      makeTrip(site, {
        boatName: boat,
        port: site.boats?.[boat]?.port ?? site.port ?? null,
        date: `${year}-${pad(mo)}-${pad(m[2])}`,
        status:
          seatsLeft == null
            ? STATUS.UNKNOWN
            : seatsLeft <= 0
              ? STATUS.FULL
              : seatsLeft <= 3
                ? STATUS.FEW
                : STATUS.AVAILABLE,
        seatsLeft,
        seatsTotal: site.boats?.[boat]?.seatsTotal ?? site.seatsTotal ?? null,
        price: lookupPrice(site, boat, []),
        url: site.bookingUrl ?? pageUrl,
      }),
    );
  }

  return out;
}

async function collectFromDetail(site, days) {
  const step = site.windowDays ?? 7; // 한 번에 며칠치가 오는지
  const trips = [];
  const seen = new Set();

  for (const date of everyNth(days, step)) {
    const [y, m, d] = date.split('-');
    const bk = site.bookingUrl ?? site.url;
    const url = `${bk}${bk.includes('?') ? '&' : '?'}year=${y}&month=${m}&day=${d}`;
    const { $ } = await loadHtml(url, { mode: site.mode ?? 'static' });

    for (const t of parsePage($, site, url)) {
      const key = [t.boatName, t.date].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      trips.push(t);
    }
  }

  if (trips.length === 0) throw new Error('출조 행을 못 찾음 — 템플릿이 바뀌었을 수 있음');
  return trips;
}

export function parsePage($, site, pageUrl) {
  const out = [];

  // 문서 순서대로 훑으면서 (날짜 머리글, 배 머리글) 을 만나는 대로 처리한다.
  const flat = [];
  (function walk(node) {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue;
      flat.push(child);
      walk(child);
    }
  })($.root()[0]);

  let cur = null; // { date, tide }

  for (const node of flat) {
    const own = norm(directText(node));
    if (!own) continue;

    const dm = own.match(DATE_RE);
    if (dm) {
      const tail = (dm[5] ?? '').trim();
      cur = {
        date: `${dm[1]}-${pad(dm[2])}-${pad(dm[3])}`,
        tide: TIDE_RE.test(tail) ? tail : null,
      };
      continue;
    }

    // 배 머리글: "몬스터호 (오전배)" 처럼 배 이름만 들어있는 짧은 요소
    if (!cur) continue;
    if (own.length > 30 || !/호(\s|$|\()/.test(own)) continue;

    const $section = sectionOf($, node);
    if (!$section) continue;

    const trip = parseSection($, $section, site, cur, own, pageUrl);
    if (trip) out.push(trip);
  }

  return out;
}

/** 배 머리글 다음에 붙어있는 표(예약 현황)를 찾는다 */
function sectionOf($, headingNode) {
  let $cursor = $(headingNode);
  for (let i = 0; i < 4; i++) {
    const $table = $cursor.nextAll('table').first();
    if ($table.length) return $table;
    $cursor = $cursor.parent();
    if (!$cursor.length) break;
  }
  return null;
}

function parseSection($, $table, site, cur, boatName, pageUrl) {
  const seats = new Set();
  let species = [];

  $table.find('tr').each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.children();
    const label = norm($(cells[0]).text());
    const value = norm($(cells[1] ?? cells[0]).text());

    if (label === '낚시종류') {
      species = value.split(/[\s,·/]+/).filter(Boolean);
      return;
    }
    if (!SEAT_ROWS.includes(label)) return;

    // "차재수님(6명/13,12,11,8,9,10)" 에서 좌석번호만 뽑는다
    for (const m of value.matchAll(/\(\s*\d+\s*명\s*\/\s*([\d,\s]+)\)/g)) {
      for (const n of m[1].split(',')) {
        const v = Number(n.trim());
        if (Number.isInteger(v) && v > 0) seats.add(v);
      }
    }
  });

  const booked = seats.size;
  const conf = site.boats?.[boatName] ?? {};
  const seatsTotal = conf.seatsTotal ?? site.seatsTotal ?? (seats.size ? Math.max(...seats) : null);
  const seatsLeft = seatsTotal != null ? Math.max(seatsTotal - booked, 0) : null;

  // 좌석번호가 하나도 없으면 빈 배인지 파싱 실패인지 구분이 안 된다. 확정하지 않는다.
  const status =
    seatsLeft == null || (booked === 0 && seatsTotal == null)
      ? STATUS.UNKNOWN
      : seatsLeft <= 0
        ? STATUS.FULL
        : seatsLeft <= 3
          ? STATUS.FEW
          : STATUS.AVAILABLE;

  return makeTrip(site, {
    boatName,
    port: conf.port ?? site.port ?? null,
    date: cur.date,
    tide: cur.tide,
    departTime: conf.departTime ?? null,
    status,
    seatsLeft,
    seatsTotal,
    price: lookupPrice(site, boatName, species),
    species,
    url: pageUrl,
  });
}

function lookupPrice(site, boatName, species) {
  const boat = site.boats?.[boatName] ?? {};
  for (const s of species) if (boat.prices?.[s] != null) return boat.prices[s];
  if (boat.price != null) return boat.price;
  for (const s of species) if (site.prices?.[s] != null) return site.prices[s];
  return site.price ?? null;
}

/** 한 번에 여러 날이 오므로 step일 간격으로만 요청한다 */
function everyNth(days, step) {
  const out = [];
  const base = new Date(Date.now() + 9 * 3600 * 1000); // 러너는 UTC
  for (let i = 0; i < days; i += step) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function directText(node) {
  return (node.children ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.data)
    .join(' ');
}
