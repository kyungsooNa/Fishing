// 값이 얼마나 비어 있나. 비어 있는 칸은 두 가지로 나뉩니다.
//
//   1) 화면에서 안 보이는 것 — 승선료가 없으면 표의 그 칸이 비고, 그걸로 끝입니다.
//   2) 합치기를 막는 것 — 항구·전화번호는 다른 사이트에 올라온 같은 배를 알아보는
//      신원입니다(core/merge.js). 비면 같은 출조가 현황판에 두 줄로 뜹니다.
//
// 둘을 한 표에 넣으면 "채워야 할 칸 8,854개" 같은 숫자가 나오는데, 그 숫자로는 무엇부터
// 손볼지 못 고릅니다. 그래서 신원을 따로 세고, **실제로 합치기가 막힌 배**까지 셉니다 —
// 이름이 겹치는 배가 없으면 항구가 비어도 지금 당장 손해는 없습니다.
//
// 고치는 곳이 어디냐도 같이 냅니다. 항구·전화번호·승선료는 registry에 사람이 적는 값이고,
// 출항시각·정원은 어댑터가 페이지에서 읽어오는 값입니다. 섞어 세면 registry를 고칠 일과
// 파서를 고칠 일이 한 줄에 붙어버립니다.
//
// 어댑터가 읽는 값이라고 다 파서로 채워지는 것도 아닙니다. 출항시각은 **예약판에 아예
// 안 적힌 곳**이 대부분이라 파서를 고쳐도 안 채워집니다. 그건 선사 공지에서 확인해
// registry의 timeGuide에 적는 값입니다 — 그래서 빈 이유를 따로 갈라 셉니다(timeGaps).

import { platformOf } from './platform.js';
import { normPhone } from './schema.js';
import { looksLikePort } from './ports.js';

/** `where`는 이 값을 어디서 고치느냐입니다 — registry(사람이 적음) / adapter(페이지에서 읽음). */
export const FIELDS = [
  { key: 'port', label: '항구', where: 'registry', identity: true },
  { key: 'phone', label: '전화번호', where: 'registry', identity: true },
  { key: 'departAt', label: '출항시각', where: 'adapter' },
  // 승선료를 넘기는 어댑터는 하나도 없습니다 — 값은 전부 registry의 priceGuides·prices·price에서 옵니다
  // (core/schema.js의 pickPrice). "어댑터"로 세는 동안 파서를 고치면 채워질 것처럼 보였는데,
  // 예약판에 적힌 금액은 10,043건 중 259건뿐이고 그나마 "예약금 3만원"·"1인 추가 5만원"처럼
  // 선비가 아닌 금액이 섞여 있습니다. 읽어서 채우면 틀린 값이 됩니다.
  { key: 'price', label: '승선료', where: 'registry' },
  { key: 'seatsTotal', label: '정원', where: 'adapter' },
  { key: 'url', label: '원본 링크', where: 'adapter' },
];

const has = (trip, key) => (key === 'phone' ? normPhone(trip.phone) !== null : trip[key] !== null && trip[key] !== undefined && trip[key] !== '');
const boatKey = (name) => (name ? String(name).replace(/\s+/g, '') : '');

export function collectQuality(registry, data) {
  const trips = data.trips ?? [];
  const siteById = new Map(registry.map((site) => [site.id, site]));

  const fields = FIELDS.map((field) => {
    const missing = trips.filter((trip) => !has(trip, field.key));
    return {
      ...field,
      missing: missing.length,
      rate: trips.length ? missing.length / trips.length : null,
      sites: new Set(missing.map((trip) => trip.siteId)).size,
    };
  });

  const identity = identityGaps(trips);
  // 항구를 채워야 하는 사이트가 어디를 보면 되는지. 막힌 배에 얽힌 곳만 추립니다 —
  // 항구가 빈 사이트는 256곳인데 지금 당장 손해를 보는 것은 그중 일부입니다.
  const blockedSites = new Set(identity.blocked.flatMap((b) => b.sites.filter((s) => !s.port).map((s) => s.siteId)));
  // 후보가 없다고 목록에서 빼지 않습니다 — 채워야 할 곳은 그대로고, 오히려 페이지를
  // 직접 열어야 하는 곳입니다. 후보가 있는 곳을 앞에 둬서 손이 덜 가는 것부터 잡습니다.
  const hints = [...blockedSites]
    .map((id) => ({ siteId: id, hints: portHints(siteById.get(id)) }))
    .sort((a, b) => (b.hints.length ? 1 : 0) - (a.hints.length ? 1 : 0) || a.siteId.localeCompare(b.siteId));

  return {
    generatedAt: data.generatedAt ?? null,
    trips: trips.length,
    fields,
    portHints: hints,
    identity,
    time: timeGaps(trips),
    adapters: groupBy(trips, (trip) => siteById.get(trip.siteId)?.adapter ?? '미등록'),
    sites: groupBy(trips, (trip) => trip.siteId).map((row) => {
      const site = siteById.get(row.key);
      return {
        ...row,
        name: site?.name ?? data.sites?.[row.key]?.name ?? row.key,
        platform: site ? platformOf(site).label : (data.sites?.[row.key]?.platform ?? '미등록'),
      };
    }),
  };
}

/**
 * 출항시각이 왜 비었나. 한 숫자로 세면 "3,565건 빔"이 되는데, 그 숫자로는 파서를 고칠지
 * 선사에 확인할지를 못 고릅니다. 실제로 둘은 섞여 있습니다.
 *
 *   전부 있음   그 사이트는 다 읽고 있습니다.
 *   전부 없음   예약판에 시각이 없는 곳입니다. 파서를 고쳐도 안 채워집니다 — 선사 공지에서
 *               확인해 registry의 timeGuide(유효기간·어종·출처까지)에 적어야 합니다.
 *   섞임        같은 사이트인데 갈립니다. 다시 둘로 나눕니다.
 *     배마다     그 배만 시각을 안 적어둔 것. 다른 배는 읽히고 있으니 파서 문제가 아닙니다.
 *     날짜마다   같은 배인데 어느 날은 읽히고 어느 날은 안 읽힙니다. **파서를 의심할 곳은
 *                여기뿐입니다.** 다만 지금까지 열어본 열 곳은 전부 그 날 예약판에 시각 줄
 *                자체가 없었습니다 — 의심할 곳과 고칠 곳은 다릅니다.
 */
export function timeGaps(trips) {
  const sites = new Map();
  for (const trip of trips) {
    if (!sites.has(trip.siteId)) sites.set(trip.siteId, { trips: 0, have: 0, boats: new Map() });
    const site = sites.get(trip.siteId);
    site.trips += 1;
    const key = boatKey(trip.boat);
    if (!site.boats.has(key)) site.boats.set(key, { trips: 0, have: 0 });
    const boat = site.boats.get(key);
    boat.trips += 1;
    if (has(trip, 'departAt')) { site.have += 1; boat.have += 1; }
  }

  const full = [], none = [], byBoat = [], byDate = [];
  for (const [id, site] of sites) {
    if (site.have === site.trips) { full.push(id); continue; }
    if (site.have === 0) { none.push({ id, missing: site.trips }); continue; }
    // 배마다 갈리는 것과 한 배 안에서 갈리는 것은 손볼 곳이 다릅니다.
    const perBoat = [...site.boats.values()].every((boat) => boat.have === 0 || boat.have === boat.trips);
    (perBoat ? byBoat : byDate).push({ id, missing: site.trips - site.have });
  }
  const total = (rows) => rows.reduce((sum, row) => sum + row.missing, 0);
  const bySize = (a, b) => b.missing - a.missing || a.id.localeCompare(b.id);

  return {
    sites: sites.size,
    full: full.sort(),
    none: none.sort(bySize),
    byBoat: byBoat.sort(bySize),
    byDate: byDate.sort(bySize),
    missing: { none: total(none), byBoat: total(byBoat), byDate: total(byDate) },
  };
}

/**
 * 합치기 신원은 **배마다** 봅니다. 사이트가 아니라요 — 한 사이트가 배 10척을 내보내는데
 * `boats`에 배별 항구를 적어둔 곳이 있어서(core/schema.js의 pickPort), 사이트 단위로 세면
 * 반쯤 채워진 곳이 통째로 채워졌거나 통째로 빈 것으로 잡힙니다.
 */
function identityGaps(trips) {
  const boats = new Map();
  for (const trip of trips) {
    const key = `${trip.siteId}|${boatKey(trip.boat)}`;
    if (!boats.has(key)) boats.set(key, { siteId: trip.siteId, boat: trip.boat, port: false, phone: false, trips: 0 });
    const row = boats.get(key);
    row.trips += 1;
    row.port ||= has(trip, 'port');
    row.phone ||= has(trip, 'phone');
  }

  const rows = [...boats.values()];
  const complete = (row) => row.port && row.phone;

  // 이름이 여러 사이트에 걸쳐 있는 배만 지금 당장 손해입니다. 하나뿐인 배는 항구가 비어도
  // 합칠 상대가 없습니다. 여기 뜬 배부터 registry에 항구·전화번호를 채우면 됩니다.
  const byName = new Map();
  for (const row of rows) {
    const key = boatKey(row.boat);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }

  const blocked = [...byName.values()]
    .filter((group) => new Set(group.map((row) => row.siteId)).size > 1 && !group.every(complete))
    .map((group) => ({
      boat: group[0].boat,
      trips: group.reduce((sum, row) => sum + row.trips, 0),
      sites: group.map((row) => ({ siteId: row.siteId, port: row.port, phone: row.phone })),
    }))
    .sort((a, b) => b.trips - a.trips || a.boat.localeCompare(b.boat, 'ko'));

  return {
    boats: rows.length,
    complete: rows.filter(complete).length,
    portMissing: rows.filter((row) => !row.port && row.phone).length,
    phoneMissing: rows.filter((row) => row.port && !row.phone).length,
    bothMissing: rows.filter((row) => !row.port && !row.phone).length,
    blocked,
  };
}

/** 같은 키(어댑터·사이트)로 묶어 항목별 빈 칸을 셉니다. 큰 것부터. */
function groupBy(trips, keyOf) {
  const groups = new Map();
  for (const trip of trips) {
    const key = keyOf(trip);
    if (!groups.has(key)) {
      groups.set(key, { key, trips: 0, missing: Object.fromEntries(FIELDS.map((f) => [f.key, 0])) });
    }
    const row = groups.get(key);
    row.trips += 1;
    for (const field of FIELDS) if (!has(trip, field.key)) row.missing[field.key] += 1;
  }
  return [...groups.values()].sort((a, b) => b.trips - a.trips || String(a.key).localeCompare(String(b.key)));
}

/**
 * `discover`가 note에 적어둔 출항지 후보. 값으로 채우지 못한 것들이라 **후보일 뿐입니다** —
 * 진짜 항구가 그 안에 없을 수도 있습니다. 그래서 여기서 registry를 고치지 않습니다.
 * 사람이 페이지를 열어볼 때 어디를 볼지만 좁혀줍니다.
 *
 * 이미 registry에 적힌 note에는 "공지사항"·"출조항"처럼 항구가 아닌 말이 섞여 있습니다
 * (`discover.js`의 `pickPort`가 낱말을 정확히 비교하다 놓친 것들입니다). 그걸 고쳐도
 * 옛 note는 그대로라, 읽는 쪽에서도 한 번 거릅니다.
 */
export function portHints(site) {
  const found = /출항지 후보:\s*([^:]*?)(?:\s+전화 후보:|$)/.exec(site?.note ?? '');
  if (!found) return [];
  return found[1].split(/[,·]/).map((s) => s.trim()).filter((s) => looksLikePort(s));
}

/** 그 항목이 빠진 사이트 id — 다음에 손볼 곳을 그대로 집어낼 수 있게. */
export function sitesMissing(quality, key) {
  return quality.sites.filter((site) => site.missing[key] > 0).map((site) => site.key);
}
