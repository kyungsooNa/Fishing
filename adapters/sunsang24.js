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

const DATE_RE = /(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*\(([일월화수목금토])\)/;
const TIDE_RE = /(\d{1,2}물|조금|무시|사리|한객기|대객기)/;
const HAS_ROW = /운항시간/;
const HAS_SEATS = /남은자리|예약마감|전화예약|예약대기/;

export async function collect(site, { days = 14 } = {}) {
  const base = site.url.replace(/\/+$/, '');
  const path = site.path ?? 'schedule_fleet';
  const trips = [];

  let found = { rows: 0, marks: 0 };

  for (const ym of monthsFor(days)) {
    const url = `${base}/ship/${path}/${ym}`;
    const { $ } = await loadHtml(url, { mode: site.mode ?? 'static' });
    const seen = parseMonth($, site, ym, url, trips);
    found.rows += seen.rows;
    found.marks += seen.marks;
  }

  // 달력형이라 월 페이지에 목록이 없으면 날짜별로 받아온다
  if (trips.length === 0 && site.dayPath) {
    return collectByDay(site, base, days);
  }

  if (trips.length === 0) {
    // 행은 찾았는데 0건이면 원인이 다르다. 뭉뚱그리면 엉뚱한 데를 고치게 된다.
    if (found.rows > 0 && found.marks === 0) {
      throw new Error(`출조 행 ${found.rows}개는 찾았지만 날짜 머리글을 못 읽었습니다 — 날짜 표기를 확인하세요`);
    }
    if (found.rows > 0) {
      throw new Error(`출조 행 ${found.rows}개 · 날짜 ${found.marks}개를 찾았지만 짝지어지지 않았습니다`);
    }
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

export function parseMonth($, site, ym, pageUrl, out) {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(4, 6));

  // 문서를 앞에서부터 훑으면서 각 태그의 위치와 자기 하위 범위를 기록한다.
  // (하위 범위를 알아야 "이 행 안에 들어있는 날짜"와 "이 행보다 앞에 나온 날짜"를 구분할 수 있다)
  const nodes = [];
  const entryOf = new Map(); // 확장한 행 요소를 다시 위치로 되돌리기 위해
  (function walk(node) {
    for (const child of node.children ?? []) {
      if (child.type !== 'tag') continue;
      const entry = { node: child, start: nodes.length, end: 0 };
      nodes.push(entry);
      entryOf.set(child, entry);
      walk(child);
      entry.end = nodes.length - 1;
    }
  })($.root()[0]);

  const marks = [];          // { idx, date, tide }
  const rowNodes = new Set(); // 확장 결과가 겹칠 수 있어 노드 기준으로 모은다

  nodes.forEach((entry, idx) => {
    const { node } = entry;
    const $el = $(node);
    const text = norm($el.text());

    // 날짜 머리글: 날짜 표기를 가진 "가장 안쪽" 요소.
    // 직접 텍스트만 보면 안 된다 — 이 템플릿은 숫자와 단위를 태그로 쪼개 놓는다:
    //   <div class="date2">9<span>월</span><div>1<span>일</span><span>(화)</span></div></div>
    // 직접 텍스트는 "9" 뿐이라 날짜가 하나도 안 잡힌다.
    if (DATE_RE.test(text)) {
      const deeperDate = $el.find('*').filter((_, d) => DATE_RE.test(norm($(d).text())));
      if (deeperDate.length === 0) {
        const dm = text.match(DATE_RE);
        const m = Number(dm[1]);
        // 12월 페이지에 1월이 섞여 나오는 경우를 대비해 연도를 보정한다
        const y = m === month ? year : m < month ? year + 1 : year - 1;
        marks.push({ idx, date: `${y}-${pad(m)}-${pad(dm[2])}`, tide: findTide($, $el) });
        return;
      }
    }

    // 출조 행: '운항시간'을 가진 가장 안쪽 요소를 찾은 뒤, 그 배 한 척이
    // 온전히 들어올 때까지 위로 확장한다.
    // 잔여석 표기까지 "둘 다" 가진 요소를 찾는 방식은 못 쓴다. 이 템플릿은
    // 배 이름 · 운항시간 · 잔여석을 각각 다른 <td>에 나눠 담고, 가운데 칸에
    // '예약대기' 같은 범례 라벨이 있어서 이름도 숫자도 없는 칸이 행으로 잡힌다.
    if (!HAS_ROW.test(text)) return;
    if ($el.find('*').filter((_, d) => HAS_ROW.test(norm($(d).text()))).length) return;
    const $row = expandRow($, $el);
    if ($row) rowNodes.add($row[0]);
  });

  const rows = [...rowNodes]
    .map((n) => entryOf.get(n))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
    .map((e) => ({ start: e.start, end: e.end, $el: $(e.node) }));

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

  return { rows: rows.length, marks: marks.length };
}

/**
 * '운항시간' 한 번만 든 가장 안쪽 요소에서 출발해, 배 이름과 잔여석까지
 * 한 덩어리로 들어오도록 위로 올라간다.
 *
 * 멈추는 조건은 둘이다.
 *   - 다른 배가 섞인다 (운항시간이 2개 이상) → 그 날의 배 목록 전체를 삼키는 것
 *   - 날짜 머리글을 먹는다 → 하루 블록 전체를 삼키는 것
 * 그래서 배가 하루에 한 척뿐인 날도, 날짜가 행 안에 들어있는 달력형도 같이 처리된다.
 */
function expandRow($, $el) {
  let $best = $el;
  let $cur = $el.parent();
  for (let i = 0; i < 12 && $cur.length && $cur[0].type === 'tag'; i++) {
    const t = norm($cur.text());
    if ((t.split('운항시간').length - 1) !== 1) break;
    if (DATE_RE.test(t)) break;
    $best = $cur;
    $cur = $cur.parent();
  }
  // 잔여석 표기가 끝내 안 들어오면 출조 행이 아니다 (안내문 등)
  return HAS_SEATS.test(norm($best.text())) ? $best : null;
}

/**
 * 물때는 날짜와 같은 요소에 있기도 하고(달력형), 옆 칸에 따로 있기도 하다:
 *   <td class="date_info">9월 1일(화)</td><td class="date_info2">11물</td>
 * 날짜 요소에서 위로 올라가며 찾되, 공지사항 같은 출조 행 본문까지 끌어오지 않도록
 * 첫 '운항시간' 앞부분만 본다. 날짜 블록 밖까지 올라가면 그만둔다.
 */
function findTide($, $el) {
  let $cur = $el;
  for (let i = 0; i < 6 && $cur.length; i++) {
    const head = norm($cur.text()).split('운항시간')[0];
    if (head.length > 400) break;
    const m = head.match(TIDE_RE);
    if (m) return m[1];
    $cur = $cur.parent();
  }
  return null;
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

function absolute(href, base) {
  if (!href || href.startsWith('#') || href.startsWith('tel:')) return base;
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}
