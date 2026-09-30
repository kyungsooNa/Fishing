#!/usr/bin/env node
// 목록에서 원본 예약처로 얼마나 넘어갔나.
//
//   node usage.js                       기본 기록(tmp/usage.jsonl)
//   node usage.js --from /srv/fishing/usage.jsonl
//   node usage.js --json
//
// 로컬·상시 서버(serve.js)에서 현황판을 쓴 방문만 쌓입니다. GitHub Pages로 본 방문은
// 받을 서버가 없어 안 셉니다. 알림(텔레그램·디스코드)에서 바로 예약처를 연 것도 우리를
// 거치지 않아 안 셉니다 — 화면의 "내가 받은 알림"에서 연 것만 셉니다.

import { readUsage, summarizeUsage, USAGE_PATH } from './core/usage.js';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const path = valueOf('--from') ?? USAGE_PATH;
const { records, broken } = await readUsage(path);
const s = summarizeUsage(records);

if (argv.includes('--json')) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

if (!records.length) {
  console.log(`${path} 에 기록이 없습니다. 로컬 서버(npm run serve)로 현황판을 열면 쌓입니다.`);
  process.exit(0);
}

console.log(`${path} — ${n(s.records)}줄 (${when(s.first)} ~ ${when(s.last)})`);
if (broken) console.log(`  깨진 줄 ${n(broken)}개는 건너뛰었습니다.`);

console.log('\n■ 예약처로 넘어간 방문');
console.log(s.rate == null
  ? '  방문 기록이 없습니다 — 이동만 있고 방문이 없으면 비율을 못 냅니다.'
  : `  ${pct(s.rate)}  (방문 ${n(s.visits)}번 중 ${n(s.convertedVisits)}번이 한 번 이상 예약처를 열었습니다)`);

console.log(`\n■ 이동 ${n(s.outbound)}번`);
if (s.outbound) {
  console.log(`  플랫폼: ${entries(s.byPlatform)}`);
  console.log(`  어디서: ${entries(s.byFrom, { table: '목록', alert: '알림 이력' })}`);
  console.log(`  날짜로 못 가는 링크(일정표): ${n(s.undated)}번 (${pct(s.undated / s.outbound)})`);
  console.log('  많이 연 선사:');
  for (const { siteId, count } of s.bySite.slice(0, 10)) console.log(`    ${n(count).padStart(5)}  ${siteId}`);
}

function entries(counts, labels = {}) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${labels[k] ?? k} ${n(v)}`).join(' · ');
}

function n(value) {
  return Number(value ?? 0).toLocaleString('ko-KR');
}

function pct(ratio) {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : '?';
}

function when(at) {
  const ms = Date.parse(at ?? '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '?';
}
