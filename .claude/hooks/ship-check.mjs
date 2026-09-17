#!/usr/bin/env node
// 커밋에서 멈추는 걸 막는 Stop 훅. AGENTS.md "작업 방식"을 기계로 지킵니다.
//
// 지침을 읽었든 잊었든 상관없이 턴 끝에서 git 상태만 봅니다. 끝나도 되는 상태는
// 하나뿐입니다 — 손댄 게 전부 origin/main 에 들어가 있는 것. 그 외에는 종료 코드 2로
// 턴을 막고, 남은 단계를 stderr 로 돌려줍니다.
//
// 일부러 안 막는 경우:
//   - stop_hook_active — 이미 이 훅 때문에 이어붙인 턴입니다. 한 번만 말하고 물러납니다
//     (무한 루프 방지. CI가 빨갛거나 사람 판단이 필요해 정말 멈춰야 할 때의 탈출구이기도 합니다)
//   - SKIP_SHIP_CHECK=1
//   - 커밋이 하나도 안 늘었고 작업본도 깨끗할 때 — 질문만 한 세션은 걸리지 않습니다
//   - fetch 실패 — 네트워크가 없으면 origin/main 과 비교할 수 없습니다. 로컬만으로
//     확실한 것(커밋 안 된 변경)만 보고 나머지는 통과시킵니다
//
// docs/data.json 은 봇도 사람도 씁니다. 다음 수집 때 다시 만들어지는 결과물이라
// "안 끝난 일"로 세지 않습니다(AGENTS.md "알아둘 것", run.bat 의 최신화 단계와 같은 취급).
//
// CI가 빨간 채로 머지하는 건 이 훅이 못 막습니다 — main 에 들어갔는지만 보기 때문입니다.
// 그건 GitHub 브랜치 보호(필수 상태 체크 `test`)가 할 일입니다.

import { spawnSync } from 'node:child_process';

const IGNORED = new Set(['docs/data.json']);
const MAIN = 'main';

// raw 를 켜면 stdout 을 안 다듬습니다. `git status --porcelain` 은 줄 앞 두 칸이 상태라
// 통째로 trim 하면 첫 줄의 상태 문자가 날아가고 경로가 한 글자 잘립니다.
function git(args, { timeout = 10000, raw = false } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout });
  const out = r.stdout || '';
  return { ok: r.status === 0, out: raw ? out : out.trim() };
}

// 빈 문자열은 문단 사이 빈 줄이라 남기고, 조건부로 빠지는 줄(false)만 걷어냅니다.
function block(lines) {
  process.stderr.write(lines.filter((line) => line !== false).join('\n') + '\n');
  process.exit(2);
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let s = '';
    const bail = setTimeout(() => resolve(s), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => { clearTimeout(bail); resolve(s); });
    process.stdin.on('error', () => { clearTimeout(bail); resolve(s); });
  });
}

let input = {};
try { input = JSON.parse(await readStdin()) || {}; } catch { input = {}; }

// 이미 이 훅이 한 번 막아서 이어진 턴이면 물러납니다. 같은 이유로 두 번 막지 않습니다.
if (input.stop_hook_active) process.exit(0);
if (process.env.SKIP_SHIP_CHECK === '1') process.exit(0);
if (!git(['rev-parse', '--is-inside-work-tree']).ok) process.exit(0);

// 1. 커밋 안 된 변경. 받아오지 않아도 확실합니다.
const status = git(['status', '--porcelain'], { raw: true });
if (status.ok && status.out.trim()) {
  const dirty = status.out
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    .filter((path) => path && !IGNORED.has(path));
  if (dirty.length) {
    block([
      '[미완] 커밋 안 된 변경이 ' + dirty.length + '개 남아 있습니다:',
      ...dirty.slice(0, 10).map((path) => '  ' + path),
      dirty.length > 10 && '  ... 외 ' + (dirty.length - 10) + '개',
      '',
      'AGENTS.md "작업 방식": 커밋 → 푸시 → PR → CI 확인 → 머지 → main 최신화까지가 한 덩어리입니다.',
      '일부러 남긴 것이면 무엇 때문에 멈췄는지 말하고 끝내세요.',
    ]);
  }
}

// 2. origin/main 과 비교합니다. 로컬 참조는 오래됐을 수 있으니 반드시 먼저 받아옵니다.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
if (!git(['fetch', 'origin', MAIN], { timeout: 30000 }).ok) process.exit(0);
const ahead = git(['rev-list', '--count', 'origin/' + MAIN + '..HEAD']);
if (!ahead.ok) process.exit(0);
const count = Number(ahead.out);
if (!count) process.exit(0); // main 에 다 들어갔습니다. 끝내도 됩니다.

// 3. 푸시는 됐는지 보고 남은 단계를 그에 맞춰 말합니다.
git(['fetch', 'origin', branch], { timeout: 30000 });
const remote = git(['rev-parse', 'origin/' + branch]);
const pushed = remote.ok && remote.out === git(['rev-parse', 'HEAD']).out;

block([
  '[미완] `' + branch + '` 의 커밋 ' + count + '개가 아직 `' + MAIN + '` 에 없습니다.',
  '',
  pushed
    ? '푸시는 됐습니다. 남은 단계: PR 열기 → CI(ci 워크플로) 초록 확인 → squash 머지 → `git checkout main && git pull origin main`'
    : '푸시부터 안 됐습니다. 남은 단계: `git push -u origin ' + branch + '` → PR 열기 → CI 초록 확인 → squash 머지 → `git checkout main && git pull origin main`',
  '',
  '물어보지 말고 그냥 하세요(AGENTS.md "작업 방식"). CI가 빨갛거나 되돌리기 어려운 변경이라',
  '정말 멈춰야 하면 무엇 때문에 멈췄는지 말하고 끝내세요 — 이 훅은 한 번만 막습니다.',
]);
