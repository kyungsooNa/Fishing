#!/usr/bin/env node
// 지금 무엇을 얼마나 보고 있나 — 계열별 커버리지와 실패 비율.
//
//   node status.js                          현재 수집 결과(docs/data.json)
//   node status.js --from tmp/monitor.json  로컬 수집 결과로 보기
//   node status.js --json                   기계가 읽을 형식(추이를 기록할 때)
//   node status.js --sites 선상24           그 계열의 사이트 id 전부
//
// "선상24 밖도 검색된다"가 제품의 존재 이유인데(PRODUCT.md) 선상24가 몇 %인지 물으면
// registry와 data.json을 손으로 맞춰봐야 했습니다. 그걸 한 명령으로 만든 것입니다.

import { load, DATA_PATH } from './core/store.js';
import { summarize } from './core/status.js';
import { loadRegistry } from './core/runner.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const dataPath = valueOf('--from') ?? DATA_PATH;
const data = await load(dataPath);
const now = new Date();
const s = summarize({ registry: await loadRegistry(), data, now });

if (has('--json')) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const wanted = valueOf('--sites');
if (wanted) {
  const hit = s.platforms.find((p) => p.label === wanted || p.id === wanted);
  if (!hit) {
    console.error(`'${wanted}' 계열이 없습니다. 있는 것: ${s.platforms.map((p) => p.label).join(', ')}`);
    process.exit(1);
  }
  console.log(hit.siteIds.join('\n'));
  process.exit(0);
}

const { sites, trips } = s.totals;
console.log(`${dataPath} — ${when(s.generatedAt, now)} 수집`);
console.log('');
console.log('■ 전체');
console.log(`  사이트 ${num(sites.registered)}곳 등록 · ${num(sites.tracked)}곳 집계 (꺼짐 ${num(sites.disabled)})`);
console.log(`  출조 ${num(trips)}건${s.merged.trips ? ` (합쳐진 줄 ${num(s.merged.trips)}건, 그중 계열이 다른 것 ${num(s.merged.crossPlatform)}건)` : ''}`);
console.log(`  마지막 수집: 성공 ${num(sites.ok)} · 실패 ${num(sites.failed)} · 보류 ${num(sites.skipped)} · 기록 없음 ${num(sites.never)}`);
console.log(`  요청한 곳 성공률 ${pct(s.totals.successRate)} · 이번에 값을 새로 받은 곳 ${pct(s.totals.freshRate)}`);

console.log('\n■ 계열별');
const head = ['계열', '사이트', '성공', '실패', '보류', '기록없음', '성공률', '최신', '출조'];
const rows = s.platforms.map((p) => [
  p.label, num(p.sites.tracked), num(p.sites.ok), num(p.sites.failed),
  num(p.sites.skipped), num(p.sites.never), pct(p.successRate), pct(p.freshRate), num(p.trips),
]);
const share = (n) => (trips ? `  (전체의 ${(n / trips * 100).toFixed(1)}%)` : '');
printTable(head, rows, s.platforms.map((p) => share(p.trips)));

console.log('\n■ 마지막으로 값을 확인한 때 (실패한 곳은 직전 성공 시각)');
for (const b of s.freshness) {
  if (b.count) console.log(`  ${pad(b.label, 14)} ${String(b.count).padStart(4)}곳`);
}

if (s.failures.length) {
  console.log(`\n■ 최신이 아닌 곳 ${s.failures.length}곳 — 직전 결과를 그대로 쓰는 중 (오래된 순)`);
  for (const f of s.failures.slice(0, has('--all') ? Infinity : 12)) {
    const mark = f.state === 'skipped' ? '보류' : '실패';
    console.log(`  ${pad(f.id, 16)} ${pad(f.platform, 12)} ${mark} · ${when(f.lastOkAt, now)} 값 ${num(f.count)}건`);
    console.log(`    ${String(f.error ?? '').slice(0, 150)}`);
  }
  if (!has('--all') && s.failures.length > 12) console.log(`  … 외 ${s.failures.length - 12}곳 (--all 로 전부)`);
}

// 한 계열이 통째로 죽는 건 그 계열 공통 원인입니다(AGENTS.md). 사이트별 실패 목록에
// 111줄로 흩어지면 오히려 안 보여서, 계열 단위로 한 줄 더 적어줍니다.
const down = s.platforms.filter((p) => p.sites.ok === 0 && p.sites.tracked > 1);
if (down.length) {
  console.log('\n■ 한 계열이 통째로 최신이 아닙니다 — 사이트별 원인이 아니라 공통 원인부터 보세요');
  for (const p of down) {
    const why = p.sites.skipped === p.sites.tracked ? '전부 백오프 보류'
      : p.sites.failed === p.sites.tracked ? '전부 실패'
      : `실패 ${num(p.sites.failed)} · 보류 ${num(p.sites.skipped)} · 기록 없음 ${num(p.sites.never)}`;
    console.log(`  ${p.label} ${num(p.sites.tracked)}곳 — ${why}`);
  }
}

function num(n) {
  return Number(n ?? 0).toLocaleString('ko-KR');
}

function pct(rate) {
  return rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;
}

/** 한글은 터미널에서 두 칸을 먹습니다. 그냥 padEnd로 맞추면 표가 어긋납니다. */
function width(text) {
  let w = 0;
  for (const ch of String(text)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}

function pad(text, to) {
  return String(text) + ' '.repeat(Math.max(0, to - width(text)));
}

function padStart(text, to) {
  return ' '.repeat(Math.max(0, to - width(text))) + String(text);
}

function printTable(head, rows, suffixes = []) {
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((c, i) => (i ? padStart(c, widths[i]) : pad(c, widths[0]))).join('  ');
  console.log(`  ${line(head)}`);
  rows.forEach((r, i) => console.log(`  ${line(r)}${suffixes[i] ?? ''}`));
}

/** "23분 전"처럼. 절대 시각은 대개 안 궁금하고 얼마나 낡았는지가 궁금합니다. */
function when(at, now) {
  const ms = Date.parse(at ?? '');
  if (!Number.isFinite(ms)) return '확인된 적 없음';
  const mins = Math.max(0, Math.round((Number(now) - ms) / 60000));
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`;
}
