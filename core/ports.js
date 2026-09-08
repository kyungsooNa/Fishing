// 항구 좌표. 지도에 찍을 때만 씁니다.
//
// 좌표는 registry가 아니라 따로 둡니다 — 오천항 하나에 선사가 넷이라
// 사이트마다 적으면 같은 값이 네 번 들어갑니다.

import { readFile } from 'node:fs/promises';
import { STATUS } from './schema.js';

export const PORTS_PATH = 'sites/ports.json';

export async function loadPorts(path = PORTS_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed.ports ?? parsed;
  } catch {
    return {};   // 좌표표가 없으면 지도만 비고 나머지는 그대로 돕니다
  }
}

// "○○항"으로 끝난다고 다 항구가 아닙니다. 본문에는 공지사항·주의사항·안전운항처럼
// '항'이 그냥 낱말의 끝 글자인 말이 훨씬 많습니다. 한글에는 `\b` 단어경계가 없어서
// 본문에서 "○○항"을 뽑으면 이것들이 같이 딸려 옵니다 — 뽑은 다음 여기서 걸러냅니다.
//
// 앞 글자를 몇 개까지 붙여 뽑았느냐에 따라 같은 '사항'이 "공지사항"으로도 "변경사항"으로도
// 나옵니다. 그래서 목록과 **같은지**가 아니라 **그 말로 끝나는지**를 봅니다 — 처음에
// 같은지로 재다가 후보의 절반이 헛것이 됐습니다.
const NOT_PORT = ['출항', '입항', '귀항', '회항', '운항', '결항', '휴항', '취항', '사항', '조항', '항항'];

/** 본문에서 주운 "○○항"이 항구 이름으로 보이는지. 값으로 쓸지는 여전히 사람이 정합니다. */
export function looksLikePort(word) {
  const w = String(word ?? '').trim();
  if (w.length < 3 || !/[가-힣]항$/.test(w)) return false;
  return !NOT_PORT.some((no) => w.endsWith(no));
}

const OPENISH = new Set([STATUS.OPEN, STATUS.FEW]);

/**
 * 이번 수집에 실제로 나온 항구만 좌표와 함께 추립니다.
 * 좌표가 없는 항구는 missing으로 돌려줍니다 — 조용히 빠지면 화면에서
 * 그 배들이 사라진 것처럼 보입니다.
 */
export function usedPorts(trips, ports) {
  const places = {};
  const missing = new Set();

  for (const t of trips) {
    if (!t.port) continue;
    const coords = ports[t.port];
    if (!coords) {
      missing.add(t.port);
      continue;
    }
    const place = (places[t.port] ??= { ...coords, trips: 0, open: 0 });
    place.trips += 1;
    if (OPENISH.has(t.status)) place.open += 1;
  }

  return { places, missing: [...missing].sort() };
}
