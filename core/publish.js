// 국내 PC에서 받은 값을 공개 현황판(docs/data.json)에 얹는 데 쓰는 순수 함수들.
// git과 네트워크는 publish.js가 맡고, 여기는 테스트할 수 있는 부분만 둡니다.
//
// 왜 두 번 조립하나: 더피싱 108곳을 받는 데 20분 넘게 걸리고, 그 사이 Actions가 선상24를
// 5분마다 커밋합니다. 처음 받은 data.json 위에 조립해 그대로 올리면 그 사이 선상24 값과
// 회전 위치를 되돌립니다. 그래서 받은 응답을 기록해 두고, 올리기 직전 main의 최신 파일 위에
// 같은 runAll을 **네트워크 없이** 한 번 더 돌려 조립합니다. 합치는 규칙을 새로 짜지 않습니다.

/** 국내에서만 제대로 받히는 선사. 더피싱(러너 IP 차단)과 `domesticOnly` 선사입니다. */
export function domesticTargets(registry) {
  return registry
    .filter((s) => s.enabled !== false && (s.adapter === 'thefishing' || s.domesticOnly))
    .map((s) => s.id);
}

// 키 순서가 달라도 같은 요청이면 같은 열쇠가 나와야 다시 쓸 수 있습니다.
function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * collectFn을 감싸 응답(출조 또는 오류)과 처음 요청한 시각을 남깁니다. `replay`는 같은 요청에
 * 같은 답을 돌려주고, 기록에 없는 요청(그 사이 커서가 바뀐 경우 등)만 실제로 받습니다.
 */
export function createRecorder(collectFn, clock = () => new Date()) {
  const answers = new Map();
  const times = new Map();
  const record = async (site) => {
    if (!times.has(site.id)) times.set(site.id, clock().toISOString());
    const key = stableKey(site);
    try {
      const trips = await collectFn(site);
      answers.set(key, { trips });
      return trips;
    } catch (err) {
      answers.set(key, { err });
      throw err;
    }
  };
  const replay = async (site) => {
    const answer = answers.get(stableKey(site));
    if (!answer) return record(site);
    if (answer.err) throw answer.err;
    return answer.trips;
  };
  return { record, replay, times };
}

/**
 * 다시 조립하면 상태의 `at`이 조립한 시각이 됩니다. 실제로 받은 선사는 받은 시각으로
 * 되돌립니다 — 현황판의 "값을 확인한 때"가 실제보다 새것처럼 보이면 안 됩니다.
 * 보류(요청 안 함)는 조립 시각 그대로 둡니다.
 */
export function stampFetchTimes(data, times) {
  for (const [id, at] of times) {
    const status = data.sites?.[id];
    if (!status || status.skipped) continue;
    if (status.lastSelectedAt === status.at) status.lastSelectedAt = at;
    status.at = at;
  }
  return data;
}

/** 받은 선사 중 성공한 곳 수. 0이면 국내에서도 막힌 것이라 올리지 않습니다. */
export function fetchedOk(data, times) {
  return [...times.keys()].filter((id) => data.sites?.[id]?.ok).length;
}

// 그 값이 언제 본 것인가. 실패한 상태의 `at`은 시도한 시각이라 값의 나이가 아닙니다.
const seenAt = (status) => Date.parse(status?.ok ? status.at : status?.keptFrom) || 0;

/**
 * 로컬 서버가 켜져 있으면 그 서버가 이미 받아둔 값(tmp/monitor.json)을 씁니다. 같은 선사를
 * 한 번 더 두들기지 않습니다. main에 있는 값보다 **새로 받은 선사만** 고릅니다 — 묵은 로컬
 * 값으로 Actions가 받은 새 값을 덮으면 안 됩니다(AGENTS.md의 헌터호).
 */
export function monitorSource(state, base, ids) {
  const records = state?.records ?? {};
  const picked = ids.filter((id) => records[id]?.status?.ok
    && seenAt(records[id].status) > seenAt(base?.sites?.[id]));
  const times = new Map(picked.map((id) => [id, records[id].status.at]));
  const collect = async (site) => {
    // 먼 일정 창. runner가 그 창 날짜만 골라 갈아끼웁니다.
    if (site.startDay) return (state?.futureTrips ?? []).filter((t) => t.siteId === site.id);
    const record = records[site.id];
    if (!record?.status?.ok) throw new Error('이 PC가 받아둔 값이 없습니다');
    return record.trips ?? [];
  };
  return { ids: picked, times, collect };
}
