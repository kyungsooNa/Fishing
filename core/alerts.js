// 취소석을 얼마나 빨리 잡았고 알림이 실제로 갔는지 — 나중에 세려면 그때 남겨야 합니다.
//
// **자리가 실제로 언제 났는지는 아무도 안 알려줍니다.** 사이트는 지금 잔여석만 보여줍니다.
// 우리가 아는 건 "직전에 확인했을 때는 없었고 이번에 확인하니 있더라"는 구간뿐입니다.
// 그래서 이 기록의 시간은 지연이 아니라 **지연 상한**입니다(`delayMaxMs = at - since`).
// 3분마다 확인하면 상한이 3분이고, 한 시간마다면 한 시간입니다 — 감시 주기를 줄일지
// 말지를 이 숫자로 정합니다. 실제 지연을 아는 척하는 필드는 두지 않습니다.
//
// 형식은 JSON Lines입니다. 한 줄이 한 건이라 append만 하면 되고, 수집이 중간에 죽어도
// 앞줄은 멀쩡합니다. 어디에 쌓을지(러너는 매번 새 컨테이너라 tmp/는 사라집니다)는
// 상시 감시 배포와 함께 정할 일이라 경로만 열어뒀습니다(ALERTS_PATH).

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ALERTS_PATH = process.env.ALERTS_PATH ?? 'tmp/alerts.jsonl';

/**
 * 알림거리 하나를 기록 한 줄로. `since`는 그 사이트를 직전에 확인한 시각입니다 —
 * 없으면(첫 수집) 지연을 계산할 수 없으므로 null로 두고 분포에서도 뺍니다.
 */
export function alertRecords({ openings = [], at = new Date(), since = {}, result = null } = {}) {
  const atIso = new Date(at).toISOString();
  const notify = notifyOf(result);

  return openings.map((opening) => {
    const before = since[opening.siteId] ?? null;
    const gap = before ? Date.parse(atIso) - Date.parse(before) : NaN;
    return {
      at: atIso,
      since: before ?? null,
      delayMaxMs: Number.isFinite(gap) && gap >= 0 ? gap : null,
      siteId: opening.siteId ?? null,
      siteName: opening.siteName ?? null,
      boat: opening.boat ?? null,
      date: opening.date ?? null,
      departAt: opening.departAt ?? null,
      reason: opening.reason ?? null,
      before: opening.before ?? null,
      after: opening.seatsLeft ?? null,
      url: opening.url ?? null,
      notify,
    };
  });
}

/** notify()가 돌려준 채널별 결과를 기록용으로 줄입니다. 발송을 아예 안 한 이유도 남깁니다. */
function notifyOf(result) {
  if (!result) return { attempted: [], sent: [], failed: [], skipped: 'not-attempted' };
  return {
    attempted: result.attempted ?? [],
    sent: result.sent ?? [],
    failed: result.failed ?? [],
    ...(result.skipped ? { skipped: result.skipped } : {}),
  };
}

export async function appendAlerts(records, path = ALERTS_PATH) {
  if (!records.length) return 0;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return records.length;
}

/** 깨진 줄은 버리고 나머지를 씁니다 — 한 줄이 잘렸다고 이력 전체를 못 읽으면 안 됩니다. */
export async function readAlerts(path = ALERTS_PATH) {
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
 * 기록만 보고 "얼마나 빨리 잡았나 / 알림이 실제로 갔나"를 계산합니다.
 * 지연은 상한이므로 평균 대신 분위수로 냅니다 — 한 건이 하루 묵으면 평균이 통째로 흔들립니다.
 */
export function summarizeAlerts(records) {
  const delays = records.map((r) => r.delayMaxMs).filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  const failures = new Map();
  let sent = 0;
  let failed = 0;
  let unsent = 0;

  for (const record of records) {
    const notify = record.notify ?? {};
    if (notify.sent?.length) sent += 1;
    if (notify.failed?.length) failed += 1;
    if (!notify.attempted?.length) unsent += 1;
    for (const f of notify.failed ?? []) {
      const key = `${f.channel}: ${f.error}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  }

  return {
    records: records.length,
    first: records.length ? records[0].at : null,
    last: records.length ? records[records.length - 1].at : null,
    reasons: count(records, (r) => r.reason),
    delayMaxMs: {
      measured: delays.length,
      unknown: records.length - delays.length,
      p50: quantile(delays, 0.5),
      p90: quantile(delays, 0.9),
      max: delays.length ? delays[delays.length - 1] : null,
    },
    notify: {
      sent,
      failed,
      unsent,
      byChannel: count(records.flatMap((r) => r.notify?.sent ?? []), (channel) => channel),
      failures: [...failures.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, count: n })),
    },
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

/** 가장 가까운 값으로. 건수가 적을 때 보간하면 있지도 않은 값이 나옵니다. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
