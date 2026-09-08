#!/usr/bin/env node
// 취소석을 얼마나 빨리 잡았고, 알림이 실제로 갔나.
//
//   node alerts.js                      기본 이력(tmp/alerts.jsonl)
//   node alerts.js --from docs/alerts.jsonl
//   node alerts.js --last 20            최근 20건을 줄로
//   node alerts.js --json
//
// 감지 지연은 **상한**입니다. 자리가 실제로 언제 났는지는 아무도 안 알려주고, 우리가
// 아는 건 "직전에 확인했을 때는 없었다"는 것뿐이라 그 구간의 폭이 상한입니다.
// 그래서 이 숫자를 줄이는 방법은 하나뿐입니다 — 더 자주 확인하는 것.

import { readAlerts, summarizeAlerts, ALERTS_PATH } from './core/alerts.js';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const path = valueOf('--from') ?? ALERTS_PATH;
const { records, broken } = await readAlerts(path);
const s = summarizeAlerts(records);

if (argv.includes('--json')) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

if (!records.length) {
  console.log(`${path} 에 기록이 없습니다. 수집이 한 번이라도 자리를 잡으면 쌓입니다 — npm run collect`);
  process.exit(0);
}

console.log(`${path} — ${n(s.records)}건 (${when(s.first)} ~ ${when(s.last)})`);
if (broken) console.log(`  깨진 줄 ${n(broken)}개는 건너뛰었습니다.`);
console.log(`  종류: ${Object.entries(s.reasons).map(([k, v]) => `${label(k)} ${n(v)}`).join(' · ')}`);

console.log('\n■ 감지 지연 (상한 — 자리는 직전 확인과 이번 확인 사이 어딘가에서 났습니다)');
const d = s.delayMaxMs;
if (d.measured) {
  console.log(`  중앙값 ${dur(d.p50)} · p90 ${dur(d.p90)} · 최대 ${dur(d.max)}  (${n(d.measured)}건 기준)`);
  console.log('  이 값을 줄이는 방법은 하나뿐입니다 — 그 사이트를 더 자주 확인하는 것.');
} else {
  console.log('  잴 수 있는 건이 없습니다 — 직전 확인 시각을 모르는 기록뿐입니다.');
}
if (d.unknown) console.log(`  직전 확인 시각을 모르는 기록 ${n(d.unknown)}건 (첫 수집이면 정상입니다)`);

console.log('\n■ 알림');
console.log(`  보냄 ${n(s.notify.sent)} · 실패 ${n(s.notify.failed)} · 발송 시도조차 못 함 ${n(s.notify.unsent)}`);
if (Object.keys(s.notify.byChannel).length) {
  console.log(`  채널별 성공: ${Object.entries(s.notify.byChannel).map(([k, v]) => `${k} ${n(v)}`).join(' · ')}`);
}
if (s.notify.failures.length) {
  console.log('  실패한 이유:');
  for (const f of s.notify.failures.slice(0, 5)) console.log(`    ${n(f.count)}건  ${f.reason}`);
}
if (s.notify.unsent) {
  console.log('  * 채널이 없거나(토큰 미설정) 발송 전에 막힌 건입니다. 알림을 진지하게 쓸 거면 먼저 이걸 0으로.');
}

const last = Number(valueOf('--last') ?? 0);
if (last > 0) {
  console.log(`\n■ 최근 ${n(Math.min(last, records.length))}건`);
  for (const r of records.slice(-last)) {
    const gone = r.notify?.sent?.length ? `→ ${r.notify.sent.join(',')}` : (r.notify?.failed?.length ? '→ 실패' : '→ 못 보냄');
    console.log(`  ${when(r.at)}  ${r.boat ?? '-'} ${r.date ?? ''} ${r.departAt ?? ''}  ${label(r.reason)} ${r.before ?? '-'}→${r.after ?? '-'}  지연≤${dur(r.delayMaxMs)}  ${gone}`);
  }
}

function n(value) {
  return Number(value ?? 0).toLocaleString('ko-KR');
}

function label(reason) {
  return reason === 'reopened' ? '취소석' : reason === 'more-seats' ? '자리 늘어남' : String(reason ?? '미상');
}

function dur(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}분`;
  return `${(ms / 3600_000).toFixed(1)}시간`;
}

function when(at) {
  const ms = Date.parse(at ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '?';
}
