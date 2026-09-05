#!/usr/bin/env node
// 전체 수집 → docs/data.json 갱신 → 새로 난 자리만 알림.

import { runAll } from './core/runner.js';
import { notify } from './core/notify.js';
import { acquireCollectorLock } from './core/collector-lock.js';

const days = Number(process.env.DAYS ?? 21);

console.log(`수집 시작 (앞으로 ${days}일)`);
const release = await acquireCollectorLock();
try {
  const { data, openings, failed } = await runAll({ days });

  const ok = Object.values(data.sites).filter((s) => s.ok).length;
  console.log(`\n출조 ${data.trips.length}건 / 사이트 ${ok}곳 성공, ${failed.length}곳 실패`);

  if (openings.length) {
    console.log(`새로 난 자리 ${openings.length}건`);
    const res = await notify(openings);
    if (res.skipped === 'no-credentials') console.log('알림 채널이 없어 발송은 건너뜁니다.');
  }

  // 사이트가 몇 곳 실패해도 워크플로는 성공으로 끝냅니다. data.json은 이미 저장됐고,
  // 실패는 화면 하단 "수집 상태"에 남습니다. 전부 실패했을 때만 빨간불을 켭니다.
  if (failed.length && ok === 0) {
    console.error('모든 사이트가 실패했습니다.');
    process.exitCode = 1;
  }
} finally {
  await release();
}
