#!/usr/bin/env node
// docs/ 를 그대로 띄웁니다. http://localhost:8080
//
// 관리 페이지(docs/admin.html)가 쓰는 /api/* 도 같이 답합니다. registry를 고치고
// 수집 프로세스를 띄우는 입구라 **로컬 전용**입니다. GitHub Pages에는 이 서버가
// 없으므로 관리 페이지는 거기선 읽기 전용으로 돕니다.
//
// 종료 코드 75는 "최신 코드로 다시 띄워달라"는 뜻입니다. run.bat이 이 코드를 보고
// 서버를 다시 실행합니다. 자기 자신을 새로 spawn하지 않는 건, 그러면 run.bat 창이
// 주인을 잃고 서버만 백그라운드에 남기 때문입니다.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platformOf, effectiveMode } from './core/platform.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// 관리 페이지에서 고칠 수 있는 값. 표기와 켜짐/꺼짐만입니다.
// url·adapter·seatsTotal처럼 잘못 넣으면 수집이 통째로 죽는 값은 registry에서 직접 고칩니다.
const EDITABLE = { enabled: 'boolean', name: 'string', port: 'string', phone: 'string', note: 'string' };

export const RESTART_EXIT_CODE = 75;

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * /api/* 를 받아줄지. 이 API는 파일을 고치고 프로세스를 띄우므로 세 겹으로 막습니다.
 *
 * 1. 루프백에서 온 요청만 — 서버 자체도 기본이 127.0.0.1 바인딩입니다.
 * 2. Host가 localhost 계열일 때만 — 공격자 도메인이 127.0.0.1을 가리키게 하는
 *    DNS 리바인딩을 막습니다.
 * 3. X-Admin 헤더가 있을 때만 — 다른 사이트의 스크립트가 보내면 커스텀 헤더 때문에
 *    프리플라이트가 뜨고, CORS 헤더를 안 주므로 브라우저가 막습니다(CSRF).
 */
function adminAllowed(req) {
  if (!LOOPBACK.includes(req.socket.remoteAddress ?? '')) return false;
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTS.includes(host)) return false;
  return req.headers['x-admin'] === '1';
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 64 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('요청이 너무 큽니다');
  }
  return raw ? JSON.parse(raw) : {};
}

export function createApp({
  root = 'docs',
  registry = 'sites/registry.json',
  collectArgs = ['collect.js'],
  // 최신화에 쓸 명령. 테스트에서 갈아끼웁니다.
  updateCmd = { file: 'git', args: ['pull', '--ff-only'] },
  revisionCmd = { file: 'git', args: ['rev-parse', 'HEAD'] },
  // run.bat처럼 종료 코드를 보고 다시 띄워주는 실행기가 있을 때만 재시작이 됩니다.
  restartable = process.env.RESTARTABLE === '1',
} = {}) {
  // 수집 작업은 한 번에 하나만. 로그는 화면에서 보려고 들고 있습니다.
  let job = null;

  // 명령 하나를 돌리고 출력과 종료 코드를 돌려줍니다.
  const run = ({ file, args }) => new Promise((resolve) => {
    const child = spawn(file, args, { env: process.env });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', (err) => resolve({ code: -1, out: `${file} 실행 실패: ${err.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });

  const readRegistry = async () => JSON.parse(await readFile(registry, 'utf8'));

  async function handleApi(req, res, path) {
    if (!adminAllowed(req)) {
      return json(res, 403, { error: '로컬에서만 쓸 수 있습니다' });
    }

    if (path === '/api/sites' && req.method === 'GET') {
      const [reg, data] = await Promise.all([
        readRegistry(),
        readFile(join(root, 'data.json'), 'utf8').then(JSON.parse).catch(() => ({ sites: {}, trips: [] })),
      ]);
      return json(res, 200, {
        // 계열·수집방식은 화면에서 다시 따지지 않게 여기서 붙입니다(core/platform.js와 같은 답).
        sites: reg.sites.map((s) => ({ ...s, platformLabel: platformOf(s).label, mode: effectiveMode(s) })),
        status: data.sites ?? {},
        generatedAt: data.generatedAt ?? null,
        trips: data.trips?.length ?? 0,
        restartable,
      });
    }

    const patch = path.match(/^\/api\/sites\/([\w-]+)$/);
    if (patch && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const reg = await readRegistry();
      const site = reg.sites.find((s) => s.id === patch[1]);
      if (!site) return json(res, 404, { error: '그런 id가 없습니다' });

      for (const [key, value] of Object.entries(body)) {
        if (!(key in EDITABLE)) return json(res, 400, { error: `고칠 수 없는 값입니다: ${key}` });
        if (typeof value !== EDITABLE[key] && value !== null) {
          return json(res, 400, { error: `${key}는 ${EDITABLE[key]}여야 합니다` });
        }
        // 빈 문자열은 지운 것으로 봅니다. 빈 값이 남으면 합치기(merge)가 오작동합니다.
        if (value === '' || value === null) delete site[key];
        else site[key] = value;
      }
      await writeFile(registry, JSON.stringify(reg, null, 2) + '\n', 'utf8');
      return json(res, 200, { site });
    }

    if (path === '/api/collect' && req.method === 'POST') {
      if (job?.running) return json(res, 409, { error: '이미 수집 중입니다' });
      job = { running: true, startedAt: new Date().toISOString(), log: [], code: null };
      const child = spawn(process.execPath, collectArgs, { env: process.env });
      const push = (buf) => {
        for (const line of String(buf).split('\n')) if (line.trim()) job.log.push(line);
        // 로그가 무한정 쌓이지 않게 뒤쪽만 남깁니다.
        if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (err) => { push(`실행 실패: ${err.message}`); job.running = false; job.code = -1; });
      child.on('close', (code) => { job.running = false; job.code = code; });
      return json(res, 202, { started: true });
    }

    if (path === '/api/collect' && req.method === 'GET') {
      return json(res, 200, job ?? { running: false, log: [], code: null, startedAt: null });
    }

    if (path === '/api/update' && req.method === 'POST') {
      // 커밋 해시를 앞뒤로 비교합니다. "Already up to date" 문구는 로케일마다 달라서 못 믿습니다.
      const before = (await run(revisionCmd)).out.trim();
      const pull = await run(updateCmd);
      const after = (await run(revisionCmd)).out.trim();
      const ok = pull.code === 0;
      const changed = ok && before !== after && after !== '';
      const willRestart = changed && restartable;

      json(res, ok ? 200 : 500, { ok, changed, willRestart, restartable, log: pull.out.trim(), before, after });
      if (willRestart) {
        // 응답이 나간 뒤에 내려갑니다. run.bat이 75를 보고 새 코드로 다시 띄웁니다.
        setTimeout(() => process.exit(RESTART_EXIT_CODE), 100).unref();
      }
      return;
    }

    if (path === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { bye: true });
      // 응답이 나간 뒤에 내려갑니다.
      setTimeout(() => process.exit(0), 100).unref();
      return;
    }

    return json(res, 404, { error: '없는 API입니다' });
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');

    if (rel.startsWith('/api/')) {
      try {
        await handleApi(req, res, rel);
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    const path = join(root, rel === '/' || rel === '\\' ? 'index.html' : rel);
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    }
  });
}

// 직접 실행했을 때만 띄웁니다. 테스트는 createApp을 가져다 씁니다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.env.PORT ?? 8080);
  // 기본은 루프백입니다. /api/*가 파일을 고치고 프로세스를 띄우므로 밖에 열지 않습니다.
  const HOST = process.env.HOST ?? '127.0.0.1';
  createApp().listen(PORT, HOST, () => {
    console.log(`현황판  http://localhost:${PORT}`);
    console.log(`관리    http://localhost:${PORT}/admin.html`);
  });
}
