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
//
// 항구의 **갈래**를 가리키는 말도 뺍니다(국가어항·지방어항·연안항·무역항). 이건 항구
// 이름이 아니라 등급인데, 이름으로 남겨두면 "모르는 항구가 같이 적혀 있다"로 읽혀
// 아래 `pickPort`의 자동 입력을 공연히 막습니다.
const NOT_PORT = ['출항', '입항', '귀항', '회항', '운항', '결항', '휴항', '취항', '사항', '조항', '항항',
  '어항', '연안항', '무역항'];

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

// ── 항구 이름을 ports.json 열쇠로 맞추기 ────────────────────────────────────
//
// registry의 `port`는 두 가지 일을 겸합니다. 다른 사이트의 같은 배를 알아보는 신원이고
// (core/merge.js), 지도 핀을 찍는 열쇠입니다(sites/ports.json). 그래서 값은 "남당항"이
// 아니라 "충남 홍성 남당항"이어야 합니다 — 맨 이름으로 적으면 좌표를 못 찾아 그 배들이
// 지도에서만 조용히 사라집니다(test/ports.test.js가 막는 그 상황입니다).
//
// 그런데 선사 페이지는 항구를 "남당항"이라고만 적습니다. 시·도와 시·군은 옆에 있는
// 주소에 있습니다 — "오시는길 : 충남 홍성군 서부면 남당항로 213". 그래서 라벨 붙은
// 주소에서 시·군을 읽어 이미 아는 항구 목록과 맞춰봅니다.

const PROVINCE = new Map([
  ['서울특별시', '서울'], ['서울시', '서울'], ['서울', '서울'],
  ['부산광역시', '부산'], ['부산시', '부산'], ['부산', '부산'],
  ['대구광역시', '대구'], ['대구시', '대구'], ['대구', '대구'],
  ['인천광역시', '인천'], ['인천시', '인천'], ['인천', '인천'],
  ['광주광역시', '광주'], ['광주시', '광주'], ['광주', '광주'],
  ['대전광역시', '대전'], ['대전시', '대전'], ['대전', '대전'],
  ['울산광역시', '울산'], ['울산시', '울산'], ['울산', '울산'],
  ['세종특별자치시', '세종'], ['세종시', '세종'], ['세종', '세종'],
  ['경기도', '경기'], ['경기', '경기'],
  ['강원특별자치도', '강원'], ['강원도', '강원'], ['강원', '강원'],
  ['충청북도', '충북'], ['충북', '충북'],
  ['충청남도', '충남'], ['충남', '충남'],
  ['전북특별자치도', '전북'], ['전라북도', '전북'], ['전북', '전북'],
  ['전라남도', '전남'], ['전남', '전남'],
  ['경상북도', '경북'], ['경북', '경북'],
  ['경상남도', '경남'], ['경남', '경남'],
  ['제주특별자치도', '제주'], ['제주도', '제주'], ['제주', '제주'],
]);

// 주소가 어디에 적혀 있는지. 라벨 없는 본문에서 시·군을 주우면 조황글의 "통영 갔다가"까지
// 주소로 읽습니다. 값으로 쓸 것이므로 라벨이 붙은 것만 봅니다.
const ADDRESS_LABEL =
  /(?:오시는\s*길|찾아오시는\s*길|출조점\s*위치|출조점\s*주소|출조점|집결지|승선\s*장소|승선지|사업장\s*소재지|소재지|도로명\s*주소|네비\s*주소|매장\s*주소|주소)\s*[:：]?\s*([^\n|ㅣ]{4,80})/g;

/** "충남 태안 신진도항" → { region: '충남 태안', name: '신진도항' }. 형식이 다르면 null. */
export function splitPortKey(key) {
  const parts = String(key ?? '').trim().split(/\s+/);
  if (parts.length < 3) return null;      // "영목항"처럼 시·군이 없는 옛 열쇠는 건너뜁니다
  return { region: parts.slice(0, -1).join(' '), name: parts.at(-1) };
}

/**
 * 라벨 붙은 주소에서 시·군까지. 답이 하나가 아니면 null입니다 — 한 페이지가 여러 지역을
 * 적어두는 곳(출조점이 둘, 셔틀 안내)에서 아무거나 고르면 신원이 틀립니다.
 *
 * ports.json의 표기가 한 가지가 아니라("전남 여수"인데 "제주 제주시") 시·군은 끝의
 * 시/군/구를 뗀 쪽과 안 뗀 쪽을 둘 다 돌려주고, 아는 항구 목록에 있는 쪽을 씁니다.
 */
export function regionsFromAddress(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(ADDRESS_LABEL)) {
    const addr = m[1].replace(/\s+/g, ' ').trim();
    // 라벨 **바로 뒤**가 주소인 페이지는 드뭅니다. "오시는길 찾아오시는길 출조점 : 충남
    // 서천군 …"처럼 라벨이 겹쳐 있거나 안내 문구가 먼저 오는 곳이 훨씬 많아서, 앞에서
    // 끊어 읽으면 주소를 통째로 놓칩니다 — 그러면 지역 근거가 없는 채로 판정하게 되고,
    // 같은 이름의 다른 데 항구를 거르는 관문이 열려버립니다.
    for (const hit of addr.matchAll(/([가-힣]{2,7}(?:특별자치시|특별자치도|특별시|광역시|도|시)?)\s*([가-힣]{2,6}(?:시|군|구))/g)) {
      const province = PROVINCE.get(hit[1]);
      if (!province) continue;
      found.add(`${province} ${hit[2]}`);
      found.add(`${province} ${hit[2].replace(/[시군구]$/, '')}`);
    }
  }
  return found;
}

/**
 * 페이지가 적은 항구 이름을 ports.json 열쇠로 올립니다. 근거가 한 곳으로 모일 때만
 * 값을 돌려줍니다 — 애매하면 null이고, 그러면 부르는 쪽이 비운 채 후보만 남깁니다.
 *
 *   이름이 아는 항구 중 하나뿐이면            → 그 열쇠 ("방포항"은 하나뿐입니다)
 *   여럿이면 주소의 시·군과 맞는 것이 하나일 때 → 그 열쇠 (같은 이름의 항구가 여럿입니다)
 *
 * `requireRegion`은 라벨 없이 본문에서 주운 이름에 씁니다. 그때는 이름이 아는 항구 중
 * 하나뿐이어도 부족합니다 — 조황글의 "오천항 앞바다까지 갑니다"가 출항지가 돼버립니다.
 * 주소의 시·군과 맞아야 근거가 한 곳으로 모인 것입니다.
 */
/**
 * 이 이름의 항구를 **어디에 있는 것이든** 알고 있는지. `qualifyPort`는 "이 지역의 그
 * 항구"를 묻는데, 모르는 이름을 거를 때는 그것만으로 부족합니다 — 목록에 아예 없는
 * 이름은 다른 지역 것이라서 빠진 게 아니라 우리가 모르는 것이고, 같은 지역일 수도
 * 있습니다. 회변항이 그랬습니다(`discover.js`의 `pickPort`).
 */
export function portNameKnown(name, ports) {
  const target = String(name ?? '').trim();
  if (!target) return false;
  return Object.keys(ports ?? {}).some((key) => splitPortKey(key)?.name === target);
}

export function qualifyPort(name, regions, ports, { requireRegion = false } = {}) {
  const target = String(name ?? '').trim();
  if (!target) return null;

  const keys = Object.keys(ports ?? {})
    .map((key) => ({ key, ...(splitPortKey(key) ?? {}) }))
    .filter((row) => row.name === target);

  if (!keys.length) return null;

  const inRegion = keys.filter((row) => regions?.has(row.region));
  if (inRegion.length === 1) return inRegion[0].key;
  if (inRegion.length > 1) return null;
  if (requireRegion) return null;

  // 주소를 읽었는데 그 시·군에 이 이름의 항구가 없으면, 같은 이름의 **다른 데 항구**입니다.
  // 아는 항구 중 이름이 하나뿐이라는 이유로 고르면 안 됩니다 — 스텔론1호·베테랑피싱은
  // 주소가 전남 여수 돌산읍인데 "인천 옹진 진두항"이 들어갔습니다(여수 돌산에도 진두항이
  // 있지만 ports.json에 없었습니다). 여수 배가 인천에 핀이 찍히고 인천 배와 합쳐집니다.
  if (regions?.size) return null;

  return keys.length === 1 ? keys[0].key : null;
}
