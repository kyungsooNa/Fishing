// 목록에서 원본 예약처로 얼마나 넘어갔나 — PRODUCT.md "성공을 보는 지표"의 마지막 줄입니다.
//
// 이 제품은 예약을 받지 않습니다. 사람이 여기서 배를 찾고 **원본 예약처로 넘어가야** 할 일을
// 한 것입니다. 출조 건수는 중복 수집으로도 늘지만, 넘어간 비율은 실제로 쓸모가 있었을 때만
// 오릅니다. 그래서 방문(페이지를 연 번) 대비 한 번이라도 예약처를 연 방문의 비율을 셉니다.
//
// **사람을 알아볼 수 있는 것은 적지 않습니다.** 방문 id는 페이지를 열 때마다 새로 뽑는 난수라
// 다음 방문과 이어지지 않고, 감시 토큰(X-Watcher)도 적지 않습니다. 어느 배·날짜를 눌렀는지도
// 안 적습니다 — 선사 id와 플랫폼만 있으면 "어느 예약처로 넘어가나"는 셀 수 있고, 그 이상은
// 누가 어느 배를 노리는지 드러냅니다(감시 목록을 사람마다 나눈 이유와 같습니다).
//
// 형식은 alerts.jsonl과 같은 JSON Lines입니다. 경로는 USAGE_PATH(기본 tmp/usage.jsonl).
// 정적 호스팅(GitHub Pages)에는 받을 서버가 없어 **로컬·상시 서버에서만** 쌓입니다.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const USAGE_PATH = process.env.USAGE_PATH ?? 'tmp/usage.jsonl';

const VISIT_ID = /^[A-Za-z0-9-]{8,64}$/;
const SITE_ID = /^[\w.-]{1,80}$/;
const FROM = new Set(['table', 'alert']);

/**
 * 화면이 보낸 것을 기록 한 줄로 줄입니다. 모르는 모양이면 null — 적지 않습니다.
 * 받은 것을 그대로 적지 않고 **아는 칸만 골라 새로 만듭니다.** 밖에 열린 길이라(WATCH_PUBLIC)
 * 누가 무엇을 보내든 파일에는 이 모양만 남아야 합니다.
 */
export function usageRecord(body, { at = new Date() } = {}) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.visit !== 'string' || !VISIT_ID.test(body.visit)) return null;
  const base = { at: new Date(at).toISOString(), visit: body.visit };

  if (body.kind === 'visit') return { ...base, kind: 'visit' };
  if (body.kind !== 'outbound') return null;
  if (typeof body.siteId !== 'string' || !SITE_ID.test(body.siteId)) return null;
  return {
    ...base,
    kind: 'outbound',
    siteId: body.siteId,
    platform: typeof body.platform === 'string' && body.platform.length <= 20 ? body.platform : null,
    from: FROM.has(body.from) ? body.from : 'table',
    urlDated: body.urlDated === true,
  };
}

export async function appendUsage(record, path = USAGE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
}

/** 깨진 줄은 버리고 나머지를 씁니다(readAlerts와 같은 이유). */
export async function readUsage(path = USAGE_PATH) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { records: [], broken: 0 };
  }
  const records = [];
  let broken = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { broken += 1; }
  }
  return { records, broken };
}

/**
 * 방문 대비 넘어간 비율. 분모는 **방문 기록이 있는 방문**만 셉니다 — 방문 기록 없이 이동만
 * 있는 id(서버가 도중에 켜졌거나 줄이 깨진 경우)를 분자에만 넣으면 비율이 100%를 넘습니다.
 */
export function summarizeUsage(records) {
  const visits = new Set();
  const outboundVisits = new Set();
  const outbound = [];
  for (const r of records) {
    if (r.kind === 'visit') visits.add(r.visit);
    else if (r.kind === 'outbound') { outbound.push(r); outboundVisits.add(r.visit); }
  }
  const converted = [...outboundVisits].filter((id) => visits.has(id)).length;

  return {
    records: records.length,
    first: records.length ? records[0].at : null,
    last: records.length ? records[records.length - 1].at : null,
    visits: visits.size,
    convertedVisits: converted,
    rate: visits.size ? converted / visits.size : null,
    outbound: outbound.length,
    byPlatform: count(outbound, (r) => r.platform),
    byFrom: count(outbound, (r) => r.from),
    // 날짜로 못 가는 링크(일정표)로 넘어간 비율. 높으면 사람이 거기서 날짜를 다시 찾고 있습니다.
    undated: outbound.filter((r) => !r.urlDated).length,
    bySite: Object.entries(count(outbound, (r) => r.siteId))
      .sort((a, b) => b[1] - a[1])
      .map(([siteId, n]) => ({ siteId, count: n })),
  };
}

function count(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item) ?? '미상';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
