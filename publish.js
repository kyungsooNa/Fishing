#!/usr/bin/env node
// 국내 PC에서 더피싱·국내 전용 선사를 받아 공개 현황판(main의 docs/data.json)에 올립니다.
//
// Actions 러너는 해외 IP라 더피싱이 통째로 막힙니다(2026-10-05부터 매 실행 0곳). 로컬 모니터는
// 받아도 그 값이 이 PC의 tmp/에만 남아 Pages에는 안 갑니다. 이 명령이 그 사이를 잇습니다.
//
//   node publish.js                 받고 → main 최신 파일 위에 조립 → 커밋 → push
//   node publish.js --dry-run       받고 조립까지만. push하지 않습니다
//   node publish.js --from-monitor  새로 받지 않고 로컬 서버가 받아둔 값만 올립니다
//                                   (로컬 서버가 켜져 있으면 자동으로 이쪽입니다)
//
// 작업 트리와 현재 브랜치는 건드리지 않습니다. origin/main의 파일을 임시 폴더로 꺼내 조립하고,
// 임시 인덱스로 커밋을 만들어 바로 main에 push합니다. 손대던 파일이 있어도 안전합니다.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAll, loadRegistry, collectSite } from './core/runner.js';
import { load, save } from './core/store.js';
import { MONITOR_PATH } from './core/monitor.js';
import { acquireCollectorLock } from './core/collector-lock.js';
import {
  createRecorder, domesticTargets, fetchedOk, monitorSource, stampFetchTimes,
} from './core/publish.js';

const run = promisify(execFile);
const git = async (args, env) =>
  (await run('git', args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

const dryRun = process.argv.includes('--dry-run');
const days = Number(process.env.DAYS ?? 21);
const horizonDays = Number(process.env.HORIZON_DAYS ?? 90);
const WORK = resolve('tmp/publish');
const FILES = {
  data: 'docs/data.json',
  future: 'docs/future.json',
  registry: 'sites/registry.json',
  ports: 'sites/ports.json',
};

// origin/main의 최신 파일을 꺼냅니다. 작업 트리의 data.json은 쓰지 않습니다 — run.bat이
// 켤 때 버리고 받는 파일이라 몇 시간 묵었을 수 있습니다.
async function snapshot() {
  await git(['fetch', '--quiet', 'origin', 'main']);
  const sha = await git(['rev-parse', 'origin/main']);
  const dir = join(WORK, sha.slice(0, 12));
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'sites'), { recursive: true });
  const paths = {};
  for (const [name, file] of Object.entries(FILES)) {
    paths[name] = join(dir, file);
    await writeFile(paths[name], await git(['show', `${sha}:${file}`]) + '\n');
  }
  return { sha, dir, paths };
}

const assemble = (paths, ids, collectFn, now) => runAll({
  onlyIds: ids,
  days,
  horizonDays,
  now,
  registryPath: paths.registry,
  dataPath: paths.data,
  futureDataPath: paths.future,
  portsPath: paths.ports,
  dryRun: true,
  collectFn,
  // 이 PC는 국내라 국내 전용 선사도 받고, Actions가 쌓은 timeout 백오프에도 묶이지 않습니다.
  overseas: false,
  timeoutBackoffHours: 0,
  runId: null,
  runUrl: null,
});

// 작업 트리 대신 임시 인덱스로 커밋을 만듭니다. 부모는 방금 꺼낸 origin/main입니다.
async function commitOnto(sha, files, message) {
  const env = { GIT_INDEX_FILE: join(WORK, 'index') };
  await git(['read-tree', sha], env);
  for (const [path, local] of files) {
    const blob = await git(['hash-object', '-w', local]);
    await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], env);
  }
  const tree = await git(['write-tree'], env);
  if (tree === await git(['rev-parse', `${sha}^{tree}`])) return null;
  return git(['commit-tree', tree, '-p', sha, '-m', message]);
}

// 로컬 서버가 켜져 있으면 잠금을 그 서버가 쥐고 있습니다. 그때는 새로 받지 않고 그 서버가
// 받아둔 값을 올립니다 — 같은 선사를 두 군데서 동시에 두들기지 않으려고 둔 잠금입니다.
let release = null;
if (!process.argv.includes('--from-monitor')) {
  try { release = await acquireCollectorLock(); }
  catch (err) {
    if (!/이미 실행 중/.test(err.message)) throw err;
    console.log('로컬 서버가 켜져 있어 새로 받지 않고, 그 서버가 받아둔 값을 올립니다.');
  }
}

async function readMonitor() {
  try { return JSON.parse(await readFile(MONITOR_PATH, 'utf8')); }
  catch { return null; }
}

try {
  const first = await snapshot();
  const all = domesticTargets(await loadRegistry(first.paths.registry));
  const now = new Date();
  let source;
  if (release) {
    console.log(`국내 수집 시작 — 더피싱·국내 전용 ${all.length}곳 (가까운 일정 ${days}일 · 장기 ${horizonDays}일)`);
    const recorder = createRecorder(collectSite);
    const { data: probe } = await assemble(first.paths, all, recorder.record, now);
    const { failed, skipped } = probe.collection;
    const ok = fetchedOk(probe, recorder.times);
    console.log(`\n받은 결과: 성공 ${ok}곳 · 실패 ${failed}곳 · 보류 ${skipped}곳`);
    if (!ok) console.error('한 곳도 받지 못했습니다. 이 PC에서도 막혔거나 사이트가 내려가 있습니다 — 올리지 않습니다.');
    source = ok && (() => ({ ids: all, times: recorder.times, collect: recorder.replay, ok }));
  } else {
    const state = await readMonitor();
    if (!state) console.error(`${MONITOR_PATH}가 없습니다. 로컬 서버가 한 바퀴 돈 뒤 다시 실행하세요.`);
    // main이 바뀌면 "어느 쪽이 새것인가"도 바뀌니 조립할 때마다 다시 고릅니다.
    source = state && ((base) => {
      const picked = monitorSource(state, base, all);
      return { ...picked, ok: picked.ids.length };
    });
  }

  if (!source) {
    process.exitCode = 1;
  } else {
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      // 받는 동안 Actions가 main을 몇 번 커밋했습니다. 그 최신 파일 위에 다시 조립합니다.
      const snap = attempt === 1 && !release ? first : await snapshot();
      const { ids, times, collect, ok } = source(await load(snap.paths.data));
      if (!ids.length) {
        console.log('main에 있는 값보다 새로 받은 더피싱·국내 전용 선사가 없습니다 — 올릴 것이 없습니다.');
        done = true;
        break;
      }
      const { data, future } = await assemble(snap.paths, ids, collect, now);
      stampFetchTimes(data, times);
      if (dryRun) {
        console.log(`--dry-run이라 올리지 않습니다 (올릴 선사 ${ok}곳).`);
        done = true;
        break;
      }
      await save(data, snap.paths.data);
      await save(future, snap.paths.future);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const commit = await commitOnto(snap.sha, [
        [FILES.data, snap.paths.data],
        [FILES.future, snap.paths.future],
      ], `chore: 국내 PC 수집 ${stamp} UTC (${ok}곳)`);
      if (!commit) {
        console.log('main과 달라진 게 없어 커밋하지 않습니다.');
        done = true;
        break;
      }
      try {
        await git(['push', '--quiet', 'origin', `${commit}:refs/heads/main`]);
        console.log(`main에 올렸습니다 (${commit.slice(0, 7)}, ${ok}곳). Pages 반영까지 1~2분 걸립니다.`);
        done = true;
      } catch (err) {
        console.warn(`push가 거부됐습니다(${attempt}/3) — main을 다시 받아 얹습니다: ${err.stderr?.trim() || err.message}`);
      }
    }
    if (!done) {
      console.error('세 번 시도했지만 push하지 못했습니다.');
      process.exitCode = 1;
    }
  }
} finally {
  await release?.();
  await rm(WORK, { recursive: true, force: true }).catch(() => {});
}
