// 이전 수집 결과와 비교해 "새로 열린 자리"만 골라냅니다.

import { tripKey, STATUS } from './schema.js';

const OPENISH = new Set([STATUS.OPEN, STATUS.FEW]);

/**
 * 알릴 값어치가 있는 변화만 남깁니다.
 *  - 마감이던 배에 자리가 남 (취소석)
 *  - 열려있던 배의 잔여석이 늘어남 (부분 취소)
 * 새로 올라온 일정은 알리지 않습니다. 아무도 예약 안 한 게 당연해서 알림이 안 됩니다.
 * 수집에 실패한 사이트는 통째로 건너뜁니다. 예전 데이터가 남아 오탐이 납니다.
 */
export function findOpenings(prevTrips, nextTrips, failedSiteIds = new Set()) {
  const before = new Map(prevTrips.map((t) => [tripKey(t), t]));
  const out = [];

  for (const trip of nextTrips) {
    if (failedSiteIds.has(trip.siteId)) continue;
    const prev = before.get(tripKey(trip));
    if (!prev) continue;                       // 새 일정 — 알리지 않음
    if (!OPENISH.has(trip.status)) continue;   // 지금 열려있지 않으면 알릴 게 없음

    if (!OPENISH.has(prev.status)) {
      out.push({ ...trip, reason: 'reopened', before: prev.seatsLeft ?? 0 });
      continue;
    }
    if (
      Number.isFinite(trip.seatsLeft) &&
      Number.isFinite(prev.seatsLeft) &&
      trip.seatsLeft > prev.seatsLeft
    ) {
      out.push({ ...trip, reason: 'more-seats', before: prev.seatsLeft });
    }
  }

  return out;
}
