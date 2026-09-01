// sunsang24(산다고) 호스팅 템플릿용 어댑터.
// akbari.sunsang24.com 처럼 서브도메인만 다른 선사 사이트 전부에 쓸 수 있다.
//
// 이 템플릿에는 일정표 레이아웃이 두 가지 있다.
//  1) schedule_fleet            — 한 달치 출조 목록이 페이지에 다 들어있다 (요청 1번/월)
//  2) schedule_fleet_simple_top — 달력만 있고, 날짜를 눌러야 그 날 배 목록을 따로 불러온다
//
// (1)이면 registry에 아무것도 더 안 적어도 되고,
// (2)면 날짜별 목록을 주는 주소를 dayPath에 적어줘야 한다.
//
// 클래스명에 의존하지 않고 본문 텍스트 패턴으로 파싱한다.
// 템플릿이 개편돼도 "운항시간 / 남은자리" 같은 표기만 남아있으면 계속 동작한다.

import { loadHtml } from '../core/fetcher.js';
import { makeTrip, STATUS } from '../core/schema.js';

const DATE_RE = /(\d{1,2})월\s*(\d{1,2})일\s*\(([일월화수목금토])\)/;
const TIDE_RE = /(\d{1,2}물|조금|무시|사리|한객기|대객기)/;
const HAS_ROW = /운항시간/;
const HAS_SEATS = /남은자리|예약마감|전화예약|예약대기/;

export async function collect(site, { days = 14 } = {}) {
  const base = site.url.replace(/\/+$/, '');
  const path = site.path ?? 'schedule_fleet';
  const trips = [];

  for (const ym of monthsFor(days)) {
    const url = `${base}/ship/${path}/${ym}`;
    const { $ } = await loadHtml(url, { mode: site.mode ?? 'static' });
    parseMonth($, site, ym, url, trips);
  }

  // 달력형이라 월 페이지에 목록이 없으면 날짜별로 받아온다
  if (trips.length === 0 && site.dayPath) {
    return collectByDay(site, base, days);
  }

  if (trips.length === 0) {
    throw new Error(
      site.dayPath
        ? '출조 행을 못 찾음 — dayPath 주소를 확인하세요'
        : '출조 행을 못 찾음 — 달력형(simple_top) 사이트라면 registry에 dayPath가 필요합니다',
    );
  }
  return trips;
}

/**
 * 달력형(simple_top) 사이트: 페이지에는 기본 선택 날짜의 목록만 그려진다.
 * 다른 날짜를 보려면 날짜별 주소를 하루씩 부른다.
 *   dayPath 예: "/ship/schedule_fleet_simple_top/{ymd}"  ({ymd}=20260905, {date}=2026-09-05)
 *
 * 중요: 요청한 날짜를 그대로 믿지 않고, 돌아온 페이지에 적힌 날짜 머리글을 그대로 쓴다.
 * 주소가 날짜를 반영하지 않으면 같은 날이 반복해서 올 뿐, 엉뚱한 날짜가 붙지는 않는다.
 */
async function collectByDay(site, base, days) {
  const out = [];
  const seen = new Set();

  for (const date of upcoming(days)) {
    const url =
      base +
      site.dayPath.replace('{ymd}', date.replace(/-/g, '')).replace('{date}', date);
    const { $ } = await loadHtml(url, { mode: site.mode ?? 'js', waitFor: site.waitFor });

    const batch = [];
    parseMonth($, site, date.slice(0, 4) + date.slice(5, 7), url, batch);

    let added = 0;
    for (const t of batch) {
      const key = [t.boatName, t.date, t.departTime].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      added++;
    }

    // 첫 두 번을 불렀는데 새 날짜가 하나도 안 늘면 주소가 날짜를 안 받는 것이다
    if (out.length && added === 0 && seen.size && date === upcoming(days)[1]) {
      throw new Error('dayPath가 날짜를 반영하지 않습니다 — 주소 형식을 확인하세요');
    }
  }

  if (out.length === 0) throw new Error('dayPath에서도 출조 행을 못 찾음 — 주소를 확인하세요');
  return out;
}

/** 운항시간과 잔여석 표기를 둘 다 가진 가장 안쪽 요소들 = 출조 행 */
function findRows($) {
  const rows = [];
  $('*').each((_, node) => {
    const $el = $(node);
    const text = norm($el.text());
    if (!HAS_ROW.test(text) || !HAS_SEATS.test(text)) return;
    const deeper = $el.find('*').filter((_, d) => {
      const t = norm($(d).text());
      return HAS_ROW.test(t) && HAS_SEATS.test(t);
    });
    if (deeper.length === 0) rows.push($el);
  });
  return rows;
}

export function parseMonth($, site, ym, pageUrl, out) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));

  // 문서를 앞에서부터 훑으면서 각 태그의 위치와 자기 하위 범위를 기록한다.
  // (하위 범위를 알아야 "이 행 안에 들어있는 날짜"와 "이 행보다 앞에 나온 날짜"를 구분할 수 있다)
  const nodes = [];
  (function walk(node) {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue;
      const entry = { node: child, start: nodes.length, end: 0 };
      nodes.push(entry);
      walk(child);
      entry.end = nodes.length - 1;
    }
  })($.root()[0]);

  const marks = []; // { idx, date, tide }
  const rows = [];  // { start, end, $el }

  nodes.forEach((entry, idx) => {
    const { node } = entry;

    // 날짜 머리글: 자기 자신이 직접 가진 텍스트에 "9월 1일(화)" 가 있는 요소
    const own = directText(node);
    const dm = own.match(DATE_RE);
    if (dm) {
      const m = Number(dm[1]);
      // 12월 페이지에 1월이 섞여 나오는 경우를 대비해 연도를 보정한다
      const y = m === month ? year : m < month ? year + 1 : year - 1;
      marks.push({
        idx,
        date: `${y}-${pad(m)}-${pad(dm[2])}`,
        tide: (own.match(TIDE_RE) ?? [])[1] ?? null,
      });
      return;
    }

    // 출조 행: 운항시간과 잔여석 표기를 "둘 다" 가진 가장 안쪽 요소
    const $el = $(node);
    const text = norm($el.text());
    if (!HAS_ROW.test(text) || !HAS_SEATS.test(text)) return;
    const deeper = $el.find('*').filter((_, d) => {
      const t = norm($(d).text());
      return HAS_ROW.test(t) && HAS_SEATS.test(t);
    });
    if (deeper.length === 0) rows.push({ start: entry.start, end: entry.end, $el });
  });

  for (const { start, end, $el } of rows) {
    // 사이트마다 날짜 위치가 다르다.
    //  - 목록형(akbari): 날짜 머리글이 행보다 앞에 따로 있다
    //  - 달력형(fishinggate): 날짜가 행 안의 첫 칸에 들어있다
    // 행 안에 날짜가 있으면 그게 우선이다. 앞의 것을 쓰면 날짜가 바뀌는 지점에서 하나씩 밀린다.
    const inner = marks.find((m) => m.idx > start && m.idx <= end);
    let mark = inner ?? null;
    if (!mark) {
      for (const m of marks) {
        if (m.idx < start) mark = m;
        else break;
      }
    }
    if (!mark) continue;

    const trip = parseRow($, $el, site, mark, pageUrl);
    if (trip) out.push(trip);
  }
}

function parseRow($, $el, site, mark, pageUrl) {
  const text = norm($el.text());

  // 배 이름은 공지사항/어종 앞부분에 있다. 달력형은 그 앞에 날짜가 붙어있으므로 떼어낸다.
  const head = text
    .split(/공지사항|어종\s*:/)[0]
    .replace(DATE_RE, '')
    .replace(/바로예약|대기하기|전화예약/g, '')
    .trim();
  const boatName = (head.match(/([^\s]{1,14}호)/) ?? [])[1] ?? head.split(/\s+/)[0];
  if (!boatName || boatName.length > 14) return null;

  // 버튼 문구가 가장 정확한 상태 신호다
  const action = (text.match(/바로예약|대기하기|전화예약/) ?? [])[0];

  const left = (text.match(/남은자리\s*(\d+)\s*명/) ?? [])[1];
  const booked = (text.match(/예약\s*\/\s*(\d+)\s*명/) ?? [])[1];
  const capacity = (text.match(/예약마감\s*(\d+)\s*명/) ?? [])[1];

  // "전화예약 0명" 짜리 행은 홍보용 안내라 기본적으로 버린다
  if (action === '전화예약' && site.skipPhoneOnly !== false) return null;

  const seatsLeft = left != null ? Number(left) : capacity != null ? 0 : null;
  const seatsTotal =
    capacity != null
      ? Number(capacity)
      : left != null && booked != null
        ? Number(left) + Number(booked)
        : left != null
          ? Number(left)
          : null;

  const status =
    action === '바로예약' && seatsLeft > 0
      ? seatsLeft <= 3
        ? STATUS.FEW
        : STATUS.AVAILABLE
      : action === '대기하기' || capacity != null
        ? STATUS.FULL
        : STATUS.UNKNOWN;

  const speciesRaw = (text.match(/어종\s*:\s*([^:]*?)\s*(?:운항시간|예약완료|$)/) ?? [])[1] ?? '';
  const departTime = (text.match(/운항시간\s*:\s*(\d{1,2}:\d{2})/) ?? [])[1] ?? null;

  const species = speciesRaw
    .split('/')[0]
    .split(/[,·]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return makeTrip(site, {
    boatName,
    port: site.boats?.[boatName]?.port ?? site.port ?? null,
    date: mark.date,
    tide: mark.tide,
    departTime,
    status,
    seatsLeft,
    seatsTotal,
    price: lookupPrice(site, boatName, species),
    species,
    url: absolute($el.find('a[href]').first().attr('href'), pageUrl),
  });
}

/**
 * 일정표에 승선료가 없어서 registry에 적어둔 값을 쓴다.
 * 어종별 가격 → 배 고정가 → 사이트 공통 어종별 가격 → 사이트 고정가 순으로 찾는다.
 * 아무것도 없으면 null (화면에서 가격칸이 비어 보인다).
 */
function lookupPrice(site, boatName, species) {
  const boat = site.boats?.[boatName] ?? {};
  for (const s of species) {
    if (boat.prices?.[s] != null) return boat.prices[s];
  }
  if (boat.price != null) return boat.price;
  for (const s of species) {
    if (site.prices?.[s] != null) return site.prices[s];
  }
  return site.price ?? null;
}

/** 앞으로 n일을 덮는 데 필요한 달들 (['202609','202610']) */
function monthsFor(days) {
  const set = new Set();
  const base = new Date(Date.now() + 9 * 3600 * 1000); // 러너는 UTC
  for (let i = 0; i <= days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    set.add(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`);
  }
  return [...set];
}

/** 앞으로 n일치 날짜 (KST) */
function upcoming(days) {
  const out = [];
  const base = new Date(Date.now() + 9 * 3600 * 1000);
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 자식 요소를 뺀, 그 요소가 직접 들고 있는 텍스트 */
function directText(node) {
  return norm(
    (node.children ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.data)
      .join(' '),
  );
}

function absolute(href, base) {
  if (!href || href.startsWith('#') || href.startsWith('tel:')) return base;
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}
