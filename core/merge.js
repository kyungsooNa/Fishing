// 중복 정리. 두 단계입니다.
//
//   1) 같은 사이트에서 같은 출조가 두 번 들어온 경우 — 한 줄로 줄입니다.
//   2) 서로 다른 사이트에 올라온 같은 배 — 한 줄로 합칩니다.
//
// 2번이 위험한 쪽입니다. 배 이름만 같다고 합치면 다른 지역의 동명이배가 섞입니다.
// 그래서 이름·출항지·전화번호가 셋 다 있고 셋 다 같을 때만 합칩니다.
// 셋 중 하나라도 비면 안 합치고 두 줄로 둡니다 — 합쳐서 틀리는 것보다 낫습니다.
// 세 값 모두 registry에서 오므로, 합치고 싶으면 두 사이트에 같은 문자열을 적으면 됩니다.

import { tripKey, identityKey, toStatus, STATUS } from './schema.js';

export function mergeDuplicates(trips) {
  return mergeAcrossSites(dedupeSameSite(trips));
}

function dedupeSameSite(trips) {
  const byKey = new Map();
  for (const t of trips) {
    const k = tripKey(t);
    const cur = byKey.get(k);
    if (!cur || score(t) > score(cur)) byKey.set(k, t);
  }
  return [...byKey.values()];
}

function mergeAcrossSites(trips) {
  const groups = new Map();
  const out = [];

  for (const t of trips) {
    const k = identityKey(t);
    if (!k) { out.push(t); continue; }   // 신원이 확실하지 않으면 손대지 않습니다
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }

  for (const group of groups.values()) {
    out.push(group.length === 1 ? group[0] : mergeGroup(group));
  }
  return out;
}

function mergeGroup(group) {
  // 정보가 가장 많은 쪽을 본체로 삼고, 나머지는 출처로만 답니다.
  const primary = [...group].sort((a, b) => score(b) - score(a))[0];

  const seats = group.map((t) => t.seatsLeft).filter(Number.isFinite);
  // 플랫폼마다 배정된 좌석이 다를 수 있어 숫자가 갈립니다. 어디든 자리가 있으면
  // 잡을 수 있으므로 큰 쪽을 씁니다. 사이트별 숫자는 sources에 그대로 남깁니다.
  const seatsLeft = seats.length ? Math.max(...seats) : null;

  // 한 곳이라도 휴항이라고 하면 배가 안 뜹니다. 잔여석보다 우선합니다.
  const off = group.some((t) => t.status === STATUS.OFF);

  return {
    ...primary,
    seatsLeft,
    status: off ? STATUS.OFF : toStatus(primary.statusText, seatsLeft),
    sources: group.map((t) => ({
      siteId: t.siteId,
      siteName: t.siteName,
      url: t.url,
      seatsLeft: t.seatsLeft ?? null,
    })),
  };
}

// 어느 쪽이 더 쓸모 있는 줄인지. 잔여석이 가장 중요합니다.
function score(t) {
  return (
    (Number.isFinite(t.seatsLeft) ? 4 : 0) +
    (t.species ? 2 : 0) +
    (t.departAt ? 1 : 0) +
    (t.tide ? 1 : 0) +
    (t.price != null ? 1 : 0)
  );
}
