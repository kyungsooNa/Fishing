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
