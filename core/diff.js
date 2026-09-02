// 이전 수집 결과와 비교해 "새로 열린 자리"만 골라냅니다.

import { tripKey, identityKey, STATUS } from './schema.js';

const OPENISH = new Set([STATUS.OPEN, STATUS.FEW]);

/**
 * 알릴 값어치가 있는 변화만 남깁니다.
 *  - 마감이던 배에 자리가 남 (취소석)
 *  - 열려있던 배의 잔여석이 늘어남 (부분 취소)
 * 새로 올라온 일정은 알리지 않습니다. 아무도 예약 안 한 게 당연해서 알림이 안 됩니다.
 * 수집에 실패한 사이트는 통째로 건너뜁니다. 예전 데이터가 남아 오탐이 납니다.
 */
export function findOpenings(prevTrips, nextTrips, failedSiteIds = new Set()) {
  // 합쳐진 줄은 어느 사이트가 본체로 뽑혔는지가 수집마다 바뀔 수 있습니다.
  // 신원(이름·출항지·전화번호)이 확실하면 그걸로 맞춰야 알림이 끊기지 않습니다.
  const keyOf = (t) => identityKey(t) ?? tripKey(t);
  const before = new Map(prevTrips.map((t) => [keyOf(t), t]));
  const out = [];

  for (const trip of nextTrips) {
    if (failedSiteIds.has(trip.siteId)) continue;
    const prev = before.get(keyOf(trip));
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
