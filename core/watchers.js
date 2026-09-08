// 감시 목록은 사람마다 다릅니다.
//
// 지금까지는 목록이 한 벌이었습니다. 서버가 내 PC에만 떠 있고 나만 쓰니까 그래도 됐습니다.
// 그런데 상시 감시를 서버에 올리면(DEPLOY.md) 여러 사람이 같은 서버를 봅니다. 목록이
// 한 벌이면 남이 건 감시가 내 화면에 뜨고, 내가 그걸 해제할 수도 있습니다.
//
// 계정은 만들지 않습니다. 즐겨찾기·별점과 같은 급의 개인 기록이라 로그인을 시키면
// 아무도 안 씁니다. 브라우저가 무작위 토큰 하나를 만들어 보관하고, 서버는 **그 토큰의
// 해시**를 열쇠로 목록을 나눠 둡니다. 해시만 두는 이유는 저장 파일이 새더라도 남의
// 감시를 대신 걸거나 지울 수는 없게 하려는 것입니다.
//
// 토큰을 잃으면 그 목록도 잃습니다 — 기기 간 동기화는 별도 과제입니다(TODO 5번).

import { createHash } from 'node:crypto';

/** 한 사람이 걸 수 있는 감시 수. 사람마다 셉니다 — 남이 채워서 내가 못 거는 일이 없게. */
export const MAX_WATCHES = 50;

/**
 * 토큰 → 목록 열쇠. 짧은 토큰은 받지 않습니다 — 찍어 맞히면 남의 목록이 열립니다.
 * 모양이 아니라 길이만 봅니다(브라우저가 randomUUID로 만들지만 다른 것도 되게).
 */
export function watcherId(token) {
  const text = String(token ?? '').trim();
  if (text.length < 16) return null;
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

const isWatch = (w) => Boolean(w && w.siteId && w.boat && w.date);

/**
 * 저장 파일을 읽습니다. 사용자 구분이 없던 파일(`watches` 한 벌)도 그대로 읽어
 * `legacy`로 돌려줍니다 — 주인을 모르는 목록이라 버리지도, 아무에게나 주지도 않습니다.
 */
export function loadWatchers(saved) {
  const watchers = {};
  for (const [id, list] of Object.entries(saved?.watchers ?? {})) {
    if (Array.isArray(list) && list.some(isWatch)) watchers[id] = list.filter(isWatch);
  }
  return { watchers, legacy: (Array.isArray(saved?.watches) ? saved.watches : []).filter(isWatch) };
}

export function listOf(watchers, id) {
  return id && watchers[id] ? watchers[id] : [];
}

/** 수집 스케줄은 **모든 사람의 목록을 합쳐** 정합니다. 한 번 받아 다 같이 나눠 씁니다. */
export function allWatches(watchers, legacy = []) {
  return [...Object.values(watchers).flat(), ...legacy];
}

/** 빈 목록은 남기지 않습니다. 감시를 다 끈 사람의 열쇠가 파일에 남을 이유가 없습니다. */
export function setList(watchers, id, list) {
  const next = { ...watchers };
  if (list.length) next[id] = list;
  else delete next[id];
  return next;
}
