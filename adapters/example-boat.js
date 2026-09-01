// 개별 선사 홈페이지형 어댑터 예시.
// 배 한 척, 달력 위젯에서 날짜별 상태만 긁어오는 단순한 구조.
// JS로 그려지는 경우가 많아 mode: 'js' 를 쓴다.

import { loadHtml } from '../core/fetcher.js';
import { makeTrip, toStatus, toPrice, toDate } from '../core/schema.js';

export async function collect(site) {
  const { $ } = await loadHtml(site.url, {
    mode: site.mode ?? 'js',
    waitFor: site.waitFor ?? site.selectors.cell,
  });

  const trips = [];

  $(site.selectors.cell).each((_, el) => {
    const $c = $(el);
    // 달력 셀은 보통 data-date 같은 속성이나 셀 안 숫자에 날짜가 들어있다
    const rawDate = $c.attr('data-date') || $c.find(site.selectors.day).first().text();
    const date = toDate(rawDate);
    if (!date) return;

    const label = $c.text().replace(/\s+/g, ' ').trim();
    const seatsMatch = label.match(/잔여\s*(\d+)|(\d+)\s*석/);
    const seatsLeft = seatsMatch ? Number(seatsMatch[1] ?? seatsMatch[2]) : null;

    trips.push(
      makeTrip(site, {
        boatName: site.boatName ?? site.name,
        port: site.port ?? null,
        date,
        departTime: site.departTime ?? null,
        status: toStatus(label, seatsLeft),
        seatsLeft,
        seatsTotal: site.seatsTotal ?? null,
        price: toPrice(label) || site.defaultPrice || null,
        species: site.species ?? [],
        url: site.bookingUrl ?? site.url,
      }),
    );
  });

  if (trips.length === 0) {
    // 셀렉터가 바뀌었을 가능성이 높다. 조용히 0건 반환하면 눈치 못 채므로 실패시킨다.
    throw new Error('달력 셀을 하나도 못 찾음 — 셀렉터 확인 필요');
  }
  return trips;
}
