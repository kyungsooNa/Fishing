// 홍원항 의지호의 월별 예약현황 표입니다.

import * as cheerio from 'cheerio';
import { fetchHtml } from '../core/fetcher.js';
import { makeTrip, toTide } from '../core/schema.js';
import { kstDate } from '../core/when.js';

const SPECIES = ['주꾸미', '쭈꾸미', '갑오징어'];

export async function collect(site) {
  const html = await fetchHtml(site.url, { mode: site.mode ?? 'static' });
  const trips = parseMonth(site, html, site.url);
  if (!trips.length) throw new Error('월별 예약현황에서 출조 행을 못 찾았습니다 (--dump)');
  return trips;
}

export function parseMonth(site, html, url) {
  const $ = cheerio.load(html);
  const { year, month } = pageMonth($.root().text());
  const trips = [];

  $('tr').each((_, row) => {
    const cells = $(row).children('td, th');
    if (cells.length !== 4 || !/^\d{1,2}$/.test(squash(cells.eq(0).text()))) return;

    const day = Number(squash(cells.eq(0).text()));
    const text = squash(cells.eq(3).text());
    const boat = text.match(/([가-힣A-Za-z0-9]{1,12}호)(?![가-힣])/)?.[1];
    if (!boat || !/정원\s*:\s*\d+명/.test(text)) return;

    const total = Number(text.match(/정원\s*:\s*(\d+)명/)?.[1]);
    const left = text.match(/(\d+)명\s*(?:예약)?가능/)?.[1];
    const seatsLeft = /마감|모집종료/.test(text) ? 0 : left == null ? null : Number(left);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    trips.push(makeTrip(site, {
      boat,
      date,
      species: SPECIES.find((s) => text.includes(s)) ?? null,
      tide: toTide(cells.eq(2).text()),
      status: text,
      seatsLeft,
      seatsTotal: total,
      url,
    }));
  });

  return trips;
}

function pageMonth(text) {
  const m = text.match(/(20\d{2})년\s*(\d{1,2})월/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  const today = kstDate(0).split('-').map(Number);
  return { year: today[0], month: today[1] };
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function targets(site) {
  return [site.url];
}
