// 같은 함대 일정표를 여러 주소로 내보내는 선사가 있습니다. 선상24는 배마다 서브도메인을
// 하나씩 주는데, 어느 주소로 들어가든 /ship/schedule_fleet 이 함대 전체를 돌려줍니다.
// 그래서 두 주소를 다 등록해두면 같은 출조가 현황판에 두 줄로 뜹니다.
//
// core/merge.js가 못 막습니다 — 합치려면 이름·출항지·전화번호가 셋 다 있어야 하는데
// 대부분의 사이트에 전화번호가 없습니다. 없는 값을 지어내서 합치느니, 애초에 같은
// 일정표를 두 번 긁지 않는 게 맞습니다. 그래서 여기서는 "합칠까"가 아니라
// "둘 중 하나를 끌 수 있나"를 봅니다.
//
// 판정 기준은 이름이 아니라 값입니다. 겹치는 배들의 출조가 날짜·출항시각·잔여석·정원·어종까지
// 전부 같아야 같은 일정표로 봅니다. 하나라도 다르면 동명이배일 수 있으니 사람에게 넘깁니다.

/** 한 출조를 값으로만 식별합니다. 사이트가 달라도 같은 일정표면 같은 문자열이 나옵니다. */
function tripSig(t) {
  return [t.boat, t.date, t.departAt ?? '', t.seatsLeft ?? '', t.seatsTotal ?? '', t.species ?? ''].join('|');
}

/** 값은 빼고 "같은 배의 같은 자리"만. 값이 갈리는 쌍이 얼마나 겹치는지 세는 데 씁니다. */
function slotKey(t) {
  return [t.boat, t.date, t.departAt ?? ''].join('|');
}

function bySite(trips) {
  const sites = new Map();
  for (const t of trips) {
    if (!t?.siteId || !t.boat || !t.date) continue;
    if (!sites.has(t.siteId)) sites.set(t.siteId, { id: t.siteId, byBoat: new Map(), slots: new Set(), count: 0 });
    const s = sites.get(t.siteId);
    if (!s.byBoat.has(t.boat)) s.byBoat.set(t.boat, new Set());
    s.byBoat.get(t.boat).add(tripSig(t));
    s.slots.add(slotKey(t));
    s.count += 1;
  }
  for (const s of sites.values()) s.boats = new Set(s.byBoat.keys());
  return sites;
}

/**
 * 두 사이트가 같은 일정표를 내보내는지 봅니다.
 * 겹치는 배가 없으면 남남, 겹치는 배의 출조가 전부 같으면 같은 일정표입니다.
 */
export function comparePair(a, b) {
  const shared = [...a.boats].filter((boat) => b.boats.has(boat));
  if (!shared.length) return { shared, same: false, overlap: 0, reason: '겹치는 배가 없습니다' };

  const same = shared.every((boat) => {
    const x = a.byBoat.get(boat);
    const y = b.byBoat.get(boat);
    return x.size === y.size && [...x].every((sig) => y.has(sig));
  });

  return {
    shared,
    same,
    overlap: [...a.slots].filter((k) => b.slots.has(k)).length,
    reason: same ? null : '겹치는 배의 출조 내용이 다릅니다 — 동명이배이거나 한쪽 수집이 낡았습니다',
  };
}

/**
 * 수집 결과에서 같은 일정표를 쓰는 사이트 무리를 찾습니다.
 *
 * - `groups`: 한 곳만 남기고 나머지를 끌 수 있는 무리. 남길 곳의 배가 나머지를 전부 덮습니다.
 * - `reviews`: 값이 갈리거나 서로 고유한 배가 있어 자동으로 못 정하는 무리. 사람이 봐야 합니다.
 */
export function findDuplicates(trips) {
  const sites = [...bySite(trips).values()].sort((x, y) => x.id.localeCompare(y.id));

  // 같은 일정표로 판정된 쌍만 이어 붙여 무리를 만듭니다(A=B, B=C면 A·B·C가 한 무리).
  const parent = new Map(sites.map((s) => [s.id, s.id]));
  const find = (id) => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id)));
  const mismatched = [];

  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const verdict = comparePair(sites[i], sites[j]);
      if (!verdict.shared.length) continue;
      if (verdict.same) parent.set(find(sites[i].id), find(sites[j].id));
      else mismatched.push({
        sites: [sites[i].id, sites[j].id],
        shared: verdict.shared,
        overlap: verdict.overlap,
        reason: verdict.reason,
      });
    }
  }

  const byRoot = new Map();
  for (const s of sites) {
    const root = find(s.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(s);
  }

  const groups = [];
  const reviews = [...mismatched];

  for (const members of byRoot.values()) {
    if (members.length < 2) continue;

    // 배를 가장 많이 주는 곳을 남깁니다. 같으면 출조 수, 그것도 같으면 id 순 — 늘 같은 답이 나오게.
    const keep = [...members].sort((x, y) =>
      y.boats.size - x.boats.size || y.count - x.count || x.id.localeCompare(y.id))[0];
    const drop = members.filter((s) => s !== keep);
    const uncovered = drop.filter((s) => [...s.boats].some((boat) => !keep.boats.has(boat)));

    if (uncovered.length) {
      reviews.push({
        sites: members.map((s) => s.id),
        shared: [...keep.boats].filter((b) => drop.some((s) => s.boats.has(b))),
        overlap: drop.reduce((sum, s) => sum + [...s.slots].filter((k) => keep.slots.has(k)).length, 0),
        reason: `어느 한 곳이 나머지를 다 덮지 못합니다 — ${uncovered.map((s) => s.id).join(', ')}에만 있는 배가 있습니다`,
      });
      continue;
    }

    groups.push({
      keep: keep.id,
      keepBoats: [...keep.boats].sort(),
      drop: drop.map((s) => ({ id: s.id, count: s.count, boats: [...s.boats].sort() })),
      saved: drop.reduce((sum, s) => sum + s.count, 0),
    });
  }

  // 많이 겹치는 쌍부터. 하루 이틀만 겹치는 건 대개 다른 지역의 동명이배입니다.
  groups.sort((x, y) => y.saved - x.saved || x.keep.localeCompare(y.keep));
  reviews.sort((x, y) => y.overlap - x.overlap || x.sites[0].localeCompare(y.sites[0]));
  return { groups, reviews };
}

/**
 * registry 텍스트에서 사이트 하나를 끕니다.
 *
 * JSON을 통째로 다시 쓰지 않고 줄만 고칩니다 — 다시 쓰면 손으로 한 줄에 적어둔 배열이
 * 여러 줄로 풀리면서, 이번 변경과 상관없는 자리가 diff에 섞입니다.
 */
export function disableInRegistry(text, id, note) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === `"id": "${id}",` || l.trim() === `"id": "${id}"`);
  if (at < 0) throw new Error(`registry에 '${id}'가 없습니다`);

  // 이 사이트 객체가 어디서 끝나는지 — 여는 중괄호와 같은 깊이의 닫는 중괄호까지.
  const indent = lines[at].match(/^\s*/)[0].slice(0, -2);
  let end = at;
  while (end < lines.length && !new RegExp(`^${indent}\\}`).test(lines[end])) end++;
  if (end >= lines.length) throw new Error(`'${id}' 항목이 어디서 끝나는지 못 찾았습니다`);

  const enabledAt = lines.findIndex((l, i) => i > at && i < end && /^\s*"enabled":/.test(l));
  if (enabledAt < 0) throw new Error(`'${id}'에 enabled가 없습니다`);
  lines[enabledAt] = lines[enabledAt].replace(/"enabled":\s*(true|false)/, '"enabled": false');

  const body = JSON.stringify(note);
  const noteAt = lines.findIndex((l, i) => i > at && i < end && /^\s*"note":/.test(l));
  if (noteAt >= 0) {
    lines[noteAt] = `${indent}  "note": ${body}${lines[noteAt].trimEnd().endsWith(',') ? ',' : ''}`;
  } else {
    lines[end - 1] = `${lines[end - 1].replace(/,\s*$/, '')},`;
    lines.splice(end, 0, `${indent}  "note": ${body}`);
  }
  return lines.join('\n');
}

/**
 * 이미 꺼둔 사이트의 출조는 뺍니다.
 *
 * 수집 결과는 그때 켜져 있던 사이트를 그대로 담고 있어서, 끄고 나서 아직 수집이 안 돌면
 * 껐던 곳이 결과에 남아 있습니다. 그대로 두면 이미 끈 곳을 또 끄라고 하고, `--disable`을
 * 다시 돌리면 note가 겹쳐 쌓입니다.
 */
export function activeTrips(trips, sites) {
  const off = new Set(sites.filter((s) => s.enabled === false).map((s) => s.id));
  const stale = new Set();

  const kept = trips.filter((t) => {
    if (!off.has(t?.siteId)) return true;
    stale.add(t.siteId);
    return false;
  });

  return { trips: kept, skipped: [...stale].sort() };
}

// 값이 갈려 자동으로 못 정하는 쌍은 사람이 봐야 합니다. 그때 알아야 하는 건
// "다르다"가 아니라 "어디가 어떻게 다르냐"입니다. seatsTotal만 어긋나면 한쪽 파싱이
// 덜 된 같은 배이고, seatsLeft·어종이 죽 다르면 다른 지역의 동명이배입니다.
const COMPARED = ['seatsLeft', 'seatsTotal', 'status', 'species', 'tide', 'departAt', 'returnAt'];

/** 두 사이트의 같은 자리를 필드별로 맞춰 봅니다. */
export function explainPair(trips, idA, idB) {
  const pick = (id) => {
    const rows = new Map();
    for (const t of trips) {
      if (t?.siteId === id && t.boat && t.date) rows.set(slotKey(t), t);
    }
    return rows;
  };

  const a = pick(idA);
  const b = pick(idB);
  if (!a.size) throw new Error(`수집 결과에 '${idA}'가 없습니다`);
  if (!b.size) throw new Error(`수집 결과에 '${idB}'가 없습니다`);

  const shared = [...a.keys()].filter((k) => b.has(k));
  const diffs = [];

  for (const k of shared) {
    for (const field of COMPARED) {
      const x = a.get(k)[field] ?? null;
      const y = b.get(k)[field] ?? null;
      if (x !== y) diffs.push({ slot: k, field, a: x, b: y });
    }
  }

  const byField = {};
  for (const d of diffs) byField[d.field] = (byField[d.field] ?? 0) + 1;

  return {
    slots: shared.length,
    onlyA: a.size - shared.length,
    onlyB: b.size - shared.length,
    boats: [...new Set(shared.map((k) => k.split('|')[0]))].sort(),
    byField,
    diffs,
  };
}
