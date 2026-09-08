#!/usr/bin/env node
// 값이 얼마나 비어 있고, 무엇부터 채워야 하나.
//
//   node quality.js                    현재 수집 결과(docs/data.json)
//   node quality.js --from tmp/x.json  다른 수집 결과로
//   node quality.js --json             기계가 읽을 형식
//   node quality.js --sites port       그 항목이 빠진 사이트 id 전부
//   node quality.js --all              합치기가 막힌 배를 12개만 말고 전부
//
// 비어 있는 칸을 한 덩어리로 세면 "8,854개"가 나오는데 그 숫자로는 무엇부터 손볼지
// 못 고릅니다. 그래서 (1) 합치기를 막는 신원과 화면 표시를 나누고, (2) 고치는 곳이
// registry냐 어댑터냐로 나눠 보여줍니다.

import { collectQuality, sitesMissing, FIELDS } from './core/quality.js';
import { load, DATA_PATH } from './core/store.js';
import { loadRegistry, REGISTRY_PATH } from './core/runner.js';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const [registry, data] = await Promise.all([
  loadRegistry(valueOf('--registry') ?? REGISTRY_PATH),
  load(valueOf('--from') ?? DATA_PATH),
]);
const q = collectQuality(registry, data);

if (argv.includes('--json')) {
  console.log(JSON.stringify(q, null, 2));
  process.exit(0);
}

const wanted = valueOf('--sites');
if (wanted) {
  if (!FIELDS.some((f) => f.key === wanted)) {
    console.error(`'${wanted}'는 세는 항목이 아닙니다. 있는 것: ${FIELDS.map((f) => f.key).join(', ')}`);
    process.exit(1);
  }
  console.log(sitesMissing(q, wanted).join('\n'));
  process.exit(0);
}

const { identity } = q;
console.log(`수집 결과: ${q.generatedAt ?? '없음'} — 출조 ${n(q.trips)}건 · 배 ${n(identity.boats)}척`);

console.log('\n■ 합치기 신원 — 이름·항구·전화번호가 셋 다 있어야 다른 사이트의 같은 배와 합칩니다');
console.log(`  갖춘 배 ${n(identity.complete)} / ${n(identity.boats)}`
  + ` · 항구 없음 ${n(identity.portMissing)} · 전화번호 없음 ${n(identity.phoneMissing)} · 둘 다 없음 ${n(identity.bothMissing)}`);

if (identity.blocked.length) {
  console.log(`\n  같은 이름으로 여러 사이트에 올라와 있는데 신원이 없어 못 합치는 배 ${n(identity.blocked.length)}척`);
  console.log('  — 지금 현황판에 두 줄로 뜨고 있는 것들입니다. 여기부터 registry에 채우면 됩니다.');
  for (const b of identity.blocked.slice(0, argv.includes('--all') ? Infinity : 12)) {
    const where = b.sites.map((s) => `${s.siteId}(${missingMark(s)})`).join(' · ');
    console.log(`    ${b.boat}  ${n(b.trips)}건  ${where}`);
  }
  if (!argv.includes('--all') && identity.blocked.length > 12) {
    console.log(`    … 외 ${n(identity.blocked.length - 12)}척 (--all 로 전부)`);
  }
} else {
  console.log('\n  여러 사이트에 걸친 배 중 합치기가 막힌 것은 없습니다.');
}

// 항구가 빈 사이트는 수백 곳인데, 지금 당장 두 줄로 뜨게 만드는 곳은 그중 일부입니다.
// 거기부터 채우면 화면이 바로 좋아집니다. 후보는 discover가 페이지에서 주운 글자라
// **확인 전에는 값이 아닙니다** — 라벨 글자("공지사항", "출조항")가 섞여 있습니다.
if (q.portHints.length) {
  console.log(`\n■ 항구를 채우면 합쳐지는 곳 ${n(q.portHints.length)}곳 — 페이지를 열어 확인하세요`);
  const width = Math.max(...q.portHints.map((h) => h.siteId.length));
  for (const row of q.portHints.slice(0, argv.includes('--all') ? Infinity : 12)) {
    console.log(`  ${row.siteId.padEnd(width)}  후보: ${row.hints.join(' · ')}`);
  }
  if (!argv.includes('--all') && q.portHints.length > 12) {
    console.log(`  … 외 ${n(q.portHints.length - 12)}곳 (--all 로 전부)`);
  }
  console.log('  국내 도메인이 막혀 있으면 Actions 탭 → peek → Run workflow 에 id를 넣으세요.');
}

console.log('\n■ 빈 칸 (출조 기준)');
printTable(
  ['항목', '고칠 곳', '빠짐', '비율', '선사'],
  q.fields.map((f) => [
    f.label + (f.identity ? ' *' : ''),
    f.where === 'registry' ? 'registry' : '어댑터',
    n(f.missing), pct(f.rate), n(f.sites),
  ]),
);
console.log('  * 신원 — 비면 화면에서 안 보이는 데 그치지 않고 같은 배가 두 줄로 뜹니다.');

console.log('\n■ 어댑터별 — 파서 하나를 고치면 몇 건이 채워지나');
printTable(
  ['어댑터', '출조', ...FIELDS.filter((f) => f.where === 'adapter').map((f) => f.label)],
  q.adapters.map((row) => [
    row.key, n(row.trips),
    ...FIELDS.filter((f) => f.where === 'adapter').map((f) => n(row.missing[f.key])),
  ]),
);

console.log('\n■ 손볼 선사 — 빠진 항목이 많은 순, 출조가 많은 곳부터');
const worst = q.sites
  .map((site) => ({ ...site, gaps: FIELDS.reduce((sum, f) => sum + site.missing[f.key], 0) }))
  .filter((site) => site.gaps > 0)
  .sort((a, b) => b.gaps - a.gaps || b.trips - a.trips)
  .slice(0, argv.includes('--all') ? Infinity : 12);
printTable(
  ['id', '선사', '계열', '출조', ...FIELDS.map((f) => f.label)],
  worst.map((site) => [
    site.key, site.name, site.platform, n(site.trips),
    ...FIELDS.map((f) => (site.missing[f.key] ? n(site.missing[f.key]) : '·')),
  ]),
);

function n(value) {
  return Number(value ?? 0).toLocaleString('ko-KR');
}

function pct(rate) {
  return rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;
}

function missingMark(site) {
  const gaps = [!site.port && '항구', !site.phone && '전화'].filter(Boolean);
  return gaps.length ? `${gaps.join('·')} 없음` : '갖춤';
}

/** 한글은 터미널에서 두 칸입니다. 그냥 padEnd로 맞추면 표가 어긋납니다. */
function width(text) {
  return [...String(text)].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 2 : 1), 0);
}

function printTable(head, rows) {
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  // 숫자 칸만 오른쪽으로 붙입니다. 자릿수가 맞아야 어디가 큰지 눈으로 잡힙니다.
  const numeric = head.map((_, i) => rows.every((r) => /^[\d,.·%-]*$/.test(String(r[i]))));
  const line = (cells) => cells
    .map((c, i) => {
      const space = ' '.repeat(Math.max(0, widths[i] - width(c)));
      return numeric[i] ? space + String(c) : String(c) + space;
    })
    .join('  ');
  console.log(`  ${line(head)}`);
  console.log(`  ${line(widths.map((w) => '-'.repeat(w)))}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}
