// Actions 러너는 해외(UTC)에서 돕니다. 날짜를 러너 기준으로 세면 한국시간과
// 최대 9시간 어긋나서, 새벽 수집 때 "오늘"이 어제가 됩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { kstDate, kstYm } from '../core/when.js';
import { pageUrls } from '../adapters/generic.js';
import { monthUrls } from '../adapters/sunsang24.js';
import { toDate } from '../core/schema.js';
import { pruneOld } from '../core/runner.js';

// 한국시간 2026-09-04 06:10 = UTC 2026-09-03 21:10 (워크플로의 첫 수집 시각)
const 새벽수집 = new Date('2026-09-03T21:10:00Z');

test('kstDate: UTC 러너에서도 한국 날짜를 센다', () => {
  assert.equal(kstDate(0, 새벽수집), '2026-09-04');
  assert.equal(kstDate(1, 새벽수집), '2026-09-05');
  assert.equal(kstDate(-1, 새벽수집), '2026-09-03');
});

test('kstYm: 달도 한국 기준으로', () => {
  assert.equal(kstYm(0, new Date('2026-08-31T21:00:00Z')), '202609', '한국시간으론 이미 9월');
});

test('지난 날짜 정리는 한국 날짜를 기준으로 한다', () => {
  const trips = ['2026-09-03', '2026-09-04', '2026-09-05'].map((date) => ({ date }));
  const kept = pruneOld(trips, 21, 새벽수집).map((t) => t.date);
  assert.deepEqual(kept, ['2026-09-04', '2026-09-05'], '한국시간으로 지난 9/3은 떨어져야 한다');
});

test('날짜별로 받는 사이트도 한국 날짜부터 시작한다', () => {
  const urls = pageUrls(
    { url: 'https://www.blueseaho.com/reservation', datePath: '/reservation?date={date}', days: 2 },
    새벽수집,
  );
  assert.deepEqual(urls, [
    'https://www.blueseaho.com/reservation?date=2026-09-04',
    'https://www.blueseaho.com/reservation?date=2026-09-05',
  ]);
});

test('월 페이지도 한국 기준 달로 넘어간다', () => {
  // UTC로는 아직 8/31, 한국시간으론 이미 9/1
  const urls = monthUrls(
    { url: 'https://akbari.sunsang24.com', monthPath: '/ship/schedule_fleet/{ym}', days: 1 },
    new Date('2026-08-31T21:00:00Z'),
  );
  assert.deepEqual(urls, ['https://akbari.sunsang24.com/ship/schedule_fleet/202609']);
});

test('연도 없는 날짜의 연도 추론도 한국 기준', () => {
  // 한국시간 2027-01-01 08:00. UTC로는 아직 2026-12-31
  assert.equal(toDate('1월 3일', new Date('2026-12-31T23:00:00Z')), '2027-01-03');
});
