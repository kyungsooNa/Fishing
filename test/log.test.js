import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('docs/log.html', 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

test('출조기록 화면 스크립트에 문법 오류가 없다', () => {
  assert.ok(inline.length > 500);
  assert.doesNotThrow(() => new Function(inline));
});

test('출조기록 스크립트가 쓰는 요소가 화면에 다 있다', () => {
  const used = [...inline.matchAll(/\$\('([\w-]+)'\)/g)].map((match) => match[1]);
  const missing = [...new Set(used)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

function logFunctions() {
  const start = inline.indexOf('function cleanLogs');
  const end = inline.indexOf('let LOGS =');
  assert.ok(start >= 0 && end > start);
  return new Function(`${inline.slice(start, end)}\nreturn { cleanLogs, backupPayload, logsFromBackup, calculatedTide, tideForDate, calendarMark, tidesByDate };`)();
}

test('달력 표기는 마릿수 1/마릿수 2 형식이다', () => {
  const { calendarMark } = logFunctions();
  assert.equal(calendarMark({ count1: 34, count2: 10 }), '34/10');
  assert.equal(calendarMark({ count1: 0, count2: 2 }), '0/2');
  assert.equal(calendarMark({ count1: null, count2: 10 }), '-/10');
  assert.equal(calendarMark({ count1: null, count2: null, memo: '채비 메모' }), '기록');
});

test('물때는 음력 날짜에서 자동 계산하고 수집값을 우선한다', () => {
  const { calculatedTide, tideForDate } = logFunctions();
  assert.equal(calculatedTide('2026-09-18'), '조금');
  assert.equal(calculatedTide('2026-09-19'), '무시');
  assert.equal(tideForDate('2026-09-18', null, new Map([['2026-09-18', '14물']])), '14물');
  assert.equal(tideForDate('2026-09-18', { tide: '조금' }, new Map()), '조금',
    '저장된 과거 기록의 물때가 사라지면 안 됩니다');
});

test('수집 물때는 그날 가장 많이 쓰인 표기를 기본값으로 삼는다', () => {
  const { tidesByDate } = logFunctions();
  const tides = tidesByDate([
    { date: '2026-10-08', tide: '10물' },
    { date: '2026-10-08', tide: '10물' },
    { date: '2026-10-08', tide: '아홉물' },
  ]);
  assert.equal(tides.get('2026-10-08'), '10물');
});

test('저장 기록은 날짜·마릿수·길이를 검증한다', () => {
  const { cleanLogs } = logFunctions();
  assert.deepEqual(cleanLogs({
    '2026-10-08': { count: '34', tide: '10물', memo: '문어' },
    wrong: { count: 3 },
    '2026-10-09': { count1: -1, count2: '10', tide: '조금', memo: 7 },
  }), {
    '2026-10-08': { count1: 34, count2: null, tide: '10물', memo: '문어' },
    '2026-10-09': { count1: null, count2: 10, tide: '조금', memo: '7' },
  });
});

test('출조기록은 서버가 아니라 브라우저 개인 저장소에 둔다', () => {
  assert.match(inline, /LOG_KEY = 'fishing:trip-log'/);
  assert.match(inline, /localStorage\.setItem\(LOG_KEY/);
  assert.doesNotMatch(inline, /fetch\([^)]*api\//);
});

test('연월 표기를 눌러 연도와 월을 한 번에 바꾼다', () => {
  for (const id of ['month-label', 'month-jump', 'jump-year', 'jump-month', 'jump-go']) {
    assert.ok(html.includes(`id="${id}"`), `${id}가 없습니다`);
  }
  assert.match(inline, /function toggleMonthJump/);
  assert.match(inline, /function jumpToMonth/);
  assert.match(inline, /MONTH = `\$\{year\}-\$\{month\}`/);
  assert.match(inline, /\$\('month-label'\)\.addEventListener\('click'/);
});

test('출조기록을 버전 있는 JSON 백업으로 내보내고 검증해 읽는다', () => {
  const { backupPayload, logsFromBackup } = logFunctions();
  const logs = { '2026-10-07': { count1: 34, count2: 10, tide: '3물', memo: '문어' } };
  const payload = backupPayload(logs, '2026-10-07T00:00:00.000Z');
  assert.equal(payload.type, 'fishing-trip-log');
  assert.equal(payload.version, 1);
  assert.deepEqual(logsFromBackup(payload), logs);
  assert.equal(logsFromBackup({ ...payload, version: 2 }), null, '모르는 버전을 잘못 읽으면 안 됩니다');
  assert.equal(logsFromBackup({ type: '다른 파일', version: 1, logs }), null);
});

test('백업 버튼은 JSON 파일을 받고 같은 날짜를 가져온 기록으로 합친다', () => {
  for (const id of ['backup-export', 'backup-import', 'backup-auto', 'backup-file', 'backup-status']) {
    assert.ok(html.includes(`id="${id}"`), `${id}가 없습니다`);
  }
  assert.match(html, /accept="application\/json,.json"/);
  assert.match(inline, /const next = \{ \.\.\.LOGS, \.\.\.imported \};/);
  assert.match(inline, /link\.download = `출조기록-\$\{kstToday\(\)\}\.json`/);
  assert.match(inline, /if \(!saveLogs\(next\)\)/, '저장 실패를 성공처럼 보여주면 안 됩니다');
});

test('자동 백업은 기본으로 켜지고 저장·삭제 뒤 최신 전체 기록을 받는다', () => {
  assert.match(inline, /AUTO_BACKUP_KEY = 'fishing:trip-log-auto-backup'/);
  assert.match(inline, /localStorage\.getItem\(AUTO_BACKUP_KEY\) !== '0'/,
    '아무 설정도 없는 첫 화면에서는 자동 백업이 켜져야 합니다');
  assert.match(inline, /\$\('backup-auto'\)\.checked = loadAutoBackup\(\)/);
  assert.equal(inline.split('  autoBackup();').length - 1, 2, '저장과 삭제 뒤 각각 백업해야 합니다');
  assert.match(inline, /if \(\$\('backup-auto'\)\.checked\) exportBackup\(true\)/);
});
