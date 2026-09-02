// sunsang24도 더피싱도 아닌 자체 사이트용.
//
// 주소만 registry에 적으면 됩니다. 파싱은 클래스명이 아니라
// "운항시간 / 남은자리 / 예약마감" 같은 본문 표기로 하므로, 표기가 흔한 형태면
// 그대로 읽힙니다. 안 읽히면 node debug.js <id> --dump 로 원본을 보고
// 그 사이트 전용 어댑터를 따로 만드는 게 맞습니다.
//
//   { "adapter": "generic", "url": "https://www.blueseaho.com/reservation" }
//
// 페이지가 여러 장이면 pages에 적고, 날짜별로 나뉜 사이트면 datePath를 적습니다.
//
//   "pages": ["/reservation", "/reservation?type=2"]
//   "datePath": "/reservation?date={date}"        // {date}=2026-09-05, {ymd}=20260905

import { fetchHtml } from '../core/fetcher.js';
import { parseRows } from './_rows.js';
import { kstDate } from '../core/when.js';

export async function collect(site) {
  const trips = [];

  for (const [i, url] of pageUrls(site).entries()) {
    try {
      const html = await fetchHtml(url, { mode: site.mode ?? 'auto', waitFor: site.waitFor });
      trips.push(...parseRows(site, html, url));
    } catch (err) {
      if (i === 0) throw err;   // 첫 페이지가 죽으면 그 사이트는 못 읽는 겁니다
    }
  }

  if (!trips.length) {
    throw new Error('출조 행을 못 찾았습니다 — 예약 목록이 있는 주소가 맞는지 확인하세요 (--dump)');
  }
  return trips;
}

export function pageUrls(site, now = new Date()) {
  if (site.datePath) {
    return Array.from({ length: site.days ?? 14 }, (_, i) =>
      absolute(site.url, fillDate(site.datePath, kstDate(i, now))),
    );
  }
  if (site.pages?.length) return site.pages.map((p) => absolute(site.url, p));
  return [site.url];
}

// date는 "2026-09-04" 꼴입니다.
function fillDate(template, date) {
  return template.replace('{ymd}', date.replaceAll('-', '')).replace('{date}', date);
}

const absolute = (base, path) => (/^https?:\/\//.test(path) ? path : new URL(path, base).toString());
