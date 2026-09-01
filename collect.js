import { readFileSync } from 'node:fs';
import { loadSites, runAll } from './core/runner.js';
import { openStore } from './core/store.js';
import { findOpenings, notify } from './core/notify.js';

// systemd는 EnvironmentFile로 넣어주지만, 로컬에서 그냥 실행할 때를 위해 .env도 읽는다
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // .env 없어도 정상
}

const DAYS = Number(process.env.DAYS ?? 14);

const sites = await loadSites();
if (sites.length === 0) {
  console.error('활성화된 사이트가 없습니다. sites/registry.json 에서 enabled: true 로 바꾸세요.');
  process.exit(1);
}

const store = await openStore();

// 사이트마다 부담이 다르다. 메인 요약 한 번이면 끝나는 곳은 자주 봐도 되지만,
// 날짜마다 브라우저를 띄우는 곳을 5분마다 때리면 상대 서버에도 내 서버에도 무리다.
// registry의 intervalMinutes로 사이트별 최소 간격을 준다.
const now = Date.now();
const due = sites.filter((s) => {
  const gap = s.intervalMinutes;
  if (!gap) return true;
  const last = store.lastRun(s.id);
  if (!last) return true;
  return now - new Date(last).getTime() >= gap * 60_000;
});

const skipped = sites.length - due.length;
const report = await runAll(due, store, { days: DAYS, concurrency: 3 });
const total = await store.flush();

// 수집이 성공한 사이트만 비교한다.
// 실패한 사이트는 예전 데이터가 그대로 남아있어서 비교해봐야 의미가 없다.
const ok = new Set(report.filter((r) => r.ok).map((r) => r.id));
const openings = findOpenings(
  store.before.filter((t) => ok.has(t.siteId)),
  store.rows.filter((t) => ok.has(t.siteId)),
);
const alert = await notify(openings);

for (const r of report) {
  console.log(r.ok ? `  OK   ${r.id}  ${r.count}건 (${r.ms}ms)` : `  FAIL ${r.id}  ${r.error}`);
}
console.log(
  `\n총 ${total}건 저장 · 성공 ${report.filter((r) => r.ok).length}/${report.length}` +
    (skipped ? ` · 주기 안 됨 ${skipped}곳 건너뜀` : ''),
);

if (openings.length) {
  console.log(`\n자리 남 ${openings.length}건` + (alert.sent ? ` · ${alert.via} 발송` : ` · 미발송(${alert.reason})`));
  for (const o of openings.slice(0, 10)) console.log('  ' + o.date, o.boatName, o.before + '→' + o.seatsLeft);
}

// 전부 실패하면 워크플로를 빨갛게 만들어 알아차리게 한다.
if (report.length && report.every((r) => !r.ok)) process.exit(1);
