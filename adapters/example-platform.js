// 예약 플랫폼형 어댑터 예시.
// 목록 페이지에 여러 선사가 한 번에 나오는 구조.
// 실제 사이트의 셀렉터로 바꿔 끼우기만 하면 된다.

import { loadHtml } from '../core/fetcher.js';
import { makeTrip, toStatus, toPrice, toDate } from '../core/schema.js';
import { upcomingDates } from '../core/runner.js';

export async function collect(site, { days = 14 } = {}) {
  const trips = [];

  for (const date of upcomingDates(days)) {
    const url = site.url.replace('{date}', date);
    const { $ } = await loadHtml(url, { mode: site.mode ?? 'auto', waitFor: site.waitFor });

    $(site.selectors.row).each((_, el) => {
      const $r = $(el);
      const pick = (key) => (site.selectors[key] ? $r.find(site.selectors[key]).first().text().trim() : '');

      const seatsRaw = pick('seats');
      const seatsLeft = seatsRaw.match(/\d+/) ? Number(seatsRaw.match(/\d+/)[0]) : null;

      try {
        trips.push(
          makeTrip(site, {
            boatName: pick('boat') || site.name,
            port: pick('port') || site.port || null,
            date: toDate(pick('date')) ?? date,
            departTime: normalizeTime(pick('time')),
            status: toStatus(`${pick('status')} ${seatsRaw}`, seatsLeft),
            seatsLeft,
            price: toPrice(pick('price')),
            species: pick('species').split(/[,/·]/).map((s) => s.trim()).filter(Boolean),
            url: absolute($r.find(site.selectors.link).attr('href'), url),
          }),
        );
      } catch {
        // 행 하나가 깨져도 나머지 행은 살린다
      }
    });
  }

  return trips;
}

function normalizeTime(raw) {
  const m = String(raw).match(/(\d{1,2})\s*[:시]\s*(\d{0,2})/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function absolute(href, base) {
  if (!href) return base;
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}
