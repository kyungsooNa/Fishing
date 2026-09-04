// 관리 API(serve.js의 /api/*)와 관리 화면(docs/admin.html) 회귀 확인.
//
// 이 API는 registry 파일을 고치고 수집 프로세스를 띄웁니다. 조용히 망가지면
// 사이트가 통째로 꺼지거나, 로컬 서버가 바깥에 열립니다. 임시 파일에 대고 돌립니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp, explainPullFailure } from '../serve.js';

const REG = {
  $comment: '테스트용',
  sites: [
    { id: 'aaa', name: '가나호', adapter: 'sunsang24', url: 'https://a.example', port: '항구', enabled: true },
    { id: 'bbb', name: '다라호', adapter: 'thefishing', url: 'https://b.example', enabled: false },
  ],
};

async function withServer(run, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-'));
  const registry = join(dir, 'registry.json');
  await writeFile(registry, JSON.stringify(REG, null, 2));
  await writeFile(join(dir, 'data.json'), JSON.stringify({
    generatedAt: '2026-09-04T00:00:00.000Z',
    sites: { aaa: { ok: true, count: 12, at: '2026-09-04T00:00:00.000Z', name: '가나호' } },
    trips: [{ date: '2026-09-04' }],
  }));

  const server = createApp({ root: dir, registry, restartable: false, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ base, registry, dir });
  } finally {
    server.close();
  }
}

const admin = (base, path, opt = {}) =>
  fetch(base + path, { ...opt, headers: { 'X-Admin': '1', ...(opt.headers ?? {}) } });

test('사이트 목록에 registry와 수집 결과가 같이 온다', async () => {
  await withServer(async ({ base }) => {
    const d = await admin(base, '/api/sites').then((r) => r.json());
    assert.equal(d.sites.length, 2);
    assert.equal(d.sites[0].id, 'aaa');
    // 계열은 화면이 아니라 core/platform.js가 정합니다.
    assert.equal(d.sites[0].platformLabel, '선상24');
    assert.equal(d.sites[1].platformLabel, '더피싱');
    assert.equal(d.status.aaa.count, 12);
    assert.equal(d.trips, 1);
  });
});

test('표기와 켜짐을 고치면 registry에 남는다', async () => {
  await withServer(async ({ base, registry }) => {
    const res = await admin(base, '/api/sites/bbb', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, name: '새 이름', phone: '010-1234-5678' }),
    });
    assert.equal(res.status, 200);

    const saved = JSON.parse(await readFile(registry, 'utf8'));
    const site = saved.sites.find((s) => s.id === 'bbb');
    assert.equal(site.enabled, true);
    assert.equal(site.name, '새 이름');
    assert.equal(site.phone, '010-1234-5678');
    // 나머지 값은 건드리지 않습니다.
    assert.equal(site.adapter, 'thefishing');
    assert.equal(saved.$comment, '테스트용');
  });
});

test('빈 값은 지웁니다 — 빈 문자열이 남으면 합치기가 오작동합니다', async () => {
  await withServer(async ({ base, registry }) => {
    await admin(base, '/api/sites/aaa', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: '' }),
    });
    const saved = JSON.parse(await readFile(registry, 'utf8'));
    assert.ok(!('port' in saved.sites.find((s) => s.id === 'aaa')));
  });
});

test('고칠 수 없는 값은 거절한다', async () => {
  await withServer(async ({ base, registry }) => {
    const before = await readFile(registry, 'utf8');
    for (const body of [{ url: 'https://evil.example' }, { adapter: '_mock' }, { enabled: 'yes' }]) {
      const res = await admin(base, '/api/sites/aaa', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await readFile(registry, 'utf8'), before, '거절했으면 파일이 그대로여야 합니다');
  });
});

test('없는 id는 404', async () => {
  await withServer(async ({ base }) => {
    const res = await admin(base, '/api/sites/zzz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 404);
  });
});

test('잘못 인코딩된 주소 하나로 서버가 죽지 않는다', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/%')).status, 400);
    assert.equal((await admin(base, '/api/sites')).status, 200);
  });
});

test('X-Admin 헤더가 없으면 전부 403', async () => {
  await withServer(async ({ base, registry }) => {
    // 다른 사이트의 스크립트가 보내는 요청은 이 헤더를 못 붙입니다(프리플라이트에서 막힘).
    for (const [path, opt] of [
      ['/api/sites', {}],
      ['/api/collect', { method: 'POST' }],
      ['/api/restart', { method: 'POST' }],
      ['/api/shutdown', { method: 'POST' }],
      ['/api/sites/aaa', { method: 'PATCH', body: '{"name":"x"}' }],
    ]) {
      const res = await fetch(base + path, opt);
      assert.equal(res.status, 403, path);
    }
    const saved = JSON.parse(await readFile(registry, 'utf8'));
    assert.equal(saved.sites.find((s) => s.id === 'aaa').name, '가나호');
  });
});

test('Host가 localhost가 아니면 거절한다 — DNS 리바인딩', async () => {
  await withServer(async ({ base }) => {
    // fetch는 Host를 못 바꾸므로(금지된 헤더) 직접 요청을 만듭니다.
    const port = Number(new URL(base).port);
    const status = await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/sites', headers: { 'X-Admin': '1', Host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test('수집을 띄우고 로그와 종료 코드를 돌려준다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-job-'));
  const script = join(dir, 'fake-collect.js');
  await writeFile(script, 'console.log("수집 시작"); console.log("끝");');

  await withServer(async ({ base }) => {
    const start = await admin(base, '/api/collect', { method: 'POST' });
    assert.equal(start.status, 202);

    let job;
    for (let i = 0; i < 100 && (job = await admin(base, '/api/collect').then((r) => r.json())).running; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.running, false);
    assert.equal(job.code, 0);
    assert.deepEqual(job.log, ['수집 시작', '끝']);
  }, { collectArgs: [script] });
});

test('수집은 한 번에 하나만 돈다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-busy-'));
  const script = join(dir, 'slow.js');
  await writeFile(script, 'setTimeout(() => {}, 3000);');

  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/api/collect', { method: 'POST' })).status, 202);
    assert.equal((await admin(base, '/api/collect', { method: 'POST' })).status, 409);
  }, { collectArgs: [script] });
});

test('관리 화면 스크립트에 문법 오류가 없고, 쓰는 요소가 다 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  assert.ok(inline.length > 500, '인라인 스크립트를 찾지 못했습니다');
  assert.doesNotThrow(() => new Function(inline));

  const used = [...inline.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], 'id가 바뀌면 그 부분이 조용히 안 돕니다');
});

// --- 최신화(git pull) + 재시작 ---
//
// 진짜 git을 부르면 테스트가 네트워크와 레포 상태를 타므로, 명령을 갈아끼워
// "해시가 바뀌었나 / 실패했나 / 재시작할 수 있나"만 봅니다.

const fakeCmd = (out, code = 0) => ({
  file: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(out)}); process.exit(${code});`],
});

test('최신화: 해시가 바뀌면 changed', async () => {
  await withServer(async ({ base }) => {
    const d = await admin(base, '/api/update', { method: 'POST' }).then((r) => r.json());
    assert.equal(d.ok, true);
    assert.equal(d.changed, true);
    assert.equal(d.log, '한 파일 바뀜');
    // run.bat으로 띄운 게 아니면 재시작은 안 합니다.
    assert.equal(d.restartable, false);
    assert.equal(d.willRestart, false);
  }, {
    updateCmd: fakeCmd('한 파일 바뀜'),
    // 앞뒤로 다른 해시를 돌려줍니다.
    revisionCmd: { file: process.execPath, args: ['-e', 'process.stdout.write(String(Date.now()) + Math.random())'] },
  });
});

test('최신화: 해시가 그대로면 changed=false', async () => {
  await withServer(async ({ base }) => {
    const d = await admin(base, '/api/update', { method: 'POST' }).then((r) => r.json());
    assert.equal(d.ok, true);
    assert.equal(d.changed, false, '"이미 최신"을 문구가 아니라 해시로 판단해야 합니다');
    assert.equal(d.willRestart, false);
  }, { updateCmd: fakeCmd('Already up to date.'), revisionCmd: fakeCmd('abc123') });
});

test('최신화: git이 실패하면 500과 로그', async () => {
  await withServer(async ({ base }) => {
    const res = await admin(base, '/api/update', { method: 'POST' });
    assert.equal(res.status, 500);
    const d = await res.json();
    assert.equal(d.ok, false);
    assert.equal(d.changed, false);
    assert.match(d.log, /빨리감기가 안 됩니다/);
    assert.equal(d.error.reason, 'diverged');
  }, { updateCmd: fakeCmd('빨리감기가 안 됩니다', 1), revisionCmd: fakeCmd('abc123') });
});

test('최신화: main upstream이 엉뚱하면 이유를 따로 알려준다', async () => {
  await withServer(async ({ base }) => {
    const res = await admin(base, '/api/update', { method: 'POST' });
    assert.equal(res.status, 500);
    const d = await res.json();
    assert.equal(d.ok, false);
    assert.equal(d.upstream, 'origin/claude/code-review-d0f4jm');
    assert.equal(d.error.reason, 'wrong-upstream');
    assert.match(d.error.message, /origin\/claude\/code-review-d0f4jm/);
    assert.match(d.error.hint, /origin\/main/);
  }, {
    updateCmd: fakeCmd('fatal: Not possible to fast-forward, aborting.', 1),
    revisionCmd: fakeCmd('abc123'),
    branchCmd: fakeCmd('main'),
    upstreamCmd: fakeCmd('origin/claude/code-review-d0f4jm'),
  });
});

test('최신화 실패 이유를 로그 문구로 분류한다', () => {
  assert.equal(explainPullFailure('fatal: Not possible to fast-forward, aborting.').reason, 'diverged');
  assert.equal(explainPullFailure('error: Your local changes to the following files would be overwritten').reason, 'local-changes');
  assert.equal(explainPullFailure('CONFLICT (add/add): Merge conflict in package.json').reason, 'merge-conflict');
  assert.equal(explainPullFailure('fatal: unable to access https://example: Could not resolve host').reason, 'network-or-auth');
});

test('최신화: X-Admin이 없으면 403', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(base + '/api/update', { method: 'POST' })).status, 403);
  });
});

test('restartable이면 사이트 목록에 그렇게 나온다', async () => {
  await withServer(async ({ base }) => {
    const d = await admin(base, '/api/sites').then((r) => r.json());
    assert.equal(d.restartable, true, '화면이 버튼 문구를 이걸로 정합니다');
  }, { restartable: true });
});

test('앱 재실행: run.bat이 아니면 거절한다', async () => {
  await withServer(async ({ base }) => {
    const res = await admin(base, '/api/restart', { method: 'POST' });
    assert.equal(res.status, 409);
    const d = await res.json();
    assert.equal(d.ok, false);
    assert.equal(d.restartable, false);
    assert.match(d.error, /run\.bat/);
  });
});

test('앱 재실행: restartable이면 종료 코드 75로 내려간다', async () => {
  let exitCode = null;
  await withServer(async ({ base }) => {
    const res = await admin(base, '/api/restart', { method: 'POST' });
    assert.equal(res.status, 202);
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.equal(d.willRestart, true);

    for (let i = 0; i < 20 && exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(exitCode, 75);
  }, {
    restartable: true,
    restartDelayMs: 0,
    exitProcess: (code) => { exitCode = code; },
  });
});
