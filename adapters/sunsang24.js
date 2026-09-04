// sunsang24(산다고) 호스팅 선사. 서브도메인만 바꾸면 그대로 재사용합니다.
//
// 클래스명이 아니라 "운항시간 / 남은자리 / 예약마감" 같은 본문 표기로 파싱합니다.
// 템플릿이 개편돼도 표기가 남아있는 한 버팁니다.
//
// 레이아웃 두 가지
//   schedule_fleet             — 월 페이지 하나에 한 달치 목록. 요청 1~2번이면 끝.
//   schedule_fleet_simple_top  — 달력 + 그 아래 하루치 목록(JS). 날짜별로 한 번씩 받아옵니다.

import { fetchHtml } from '../core/fetcher.js';
import { parseRows } from './_rows.js';
import { kstDate, kstYm } from '../core/when.js';

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
    const url = joinUrl(site.url, fillDate(template, kstDate(i)));
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

// ── 잡동사니 ────────────────────────────────────────────────────────────────
function monthsInRange(days, now = new Date()) {
  const last = kstDate(days, now).slice(0, 7).replace('-', '');
  const out = [];
  for (let i = 0; i < 12; i++) {
    const ym = kstYm(i, now);
    out.push(ym);
    if (ym >= last) break;
  }
  return out;
}

// date는 "2026-09-04" 꼴입니다.
function fillDate(template, date) {
  return template.replace('{ymd}', date.replaceAll('-', '')).replace('{date}', date);
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/** 이 어댑터가 실제로 받아오는 주소. debug.js가 같은 페이지를 보도록 씁니다. */
export function targets(site) {
  const path = site.path ?? 'schedule_fleet';
  if (path !== CALENDAR_PATH) return monthUrls(site);
  const template = site.dayPath ?? `/ship/${CALENDAR_PATH}/{ymd}`;
  return [joinUrl(site.url, fillDate(template, kstDate(0)))];
}
