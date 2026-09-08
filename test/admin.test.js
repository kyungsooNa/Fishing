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
import { createApp, explainPullFailure, apiAccess } from '../serve.js';

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

test('관리 화면: 사이트가 300곳 가까이 되므로 쪽 나눔과 등록 출처 구분이 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');

  // 표가 한 화면에 다 나오면 못 씁니다. 쪽 나눔 조작줄이 있어야 합니다.
  for (const id of ['filter', 'pagesize', 'prev', 'next', 'pageinfo']) {
    assert.ok(html.includes(`id="${id}"`), `쪽 나눔 요소가 없습니다: ${id}`);
  }
  assert.match(html, /<th>등록<\/th>/, '등록 출처 열이 없습니다');

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  // 손으로 넣은 곳(addedBy 없음)과 discover가 찾은 곳을 나눠 봅니다.
  assert.match(inline, /FILTER === 'manual'/);
  assert.match(inline, /FILTER === 'discover'/);
  // 저장 전에 쪽을 넘겼다 돌아와도 고친 표시가 남아야 합니다.
  assert.match(inline, /DIRTY\.has\(site\.id\)/);
});

test('관리 화면: 사이트에 속한 배 이름을 별점 칸에 보여준다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');

  assert.match(html, /className = 'boatlabel'/);
  assert.match(html, /Object\.keys\(site\.boats \?\? \{\}\)/,
    '로컬 registry의 배 이름을 사이트 행에 표시해야 합니다');
  assert.match(html, /function boatsFromTrips/);
  assert.match(html, /source\.siteId/,
    '합쳐진 출조의 모든 출처 사이트에도 배를 돌려줘야 합니다');
  assert.match(html, /boatsBySite\[id\]/,
    '읽기 전용 화면도 data.json 출조에서 배 이름을 복원해야 합니다');
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

test('관리 화면: 항구·전화가 빠진 곳만 추릴 수 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  assert.ok(html.includes('id="missing"'), '빠진 값 필터가 없습니다');
  assert.match(html, /<option value="port">항구 없음<\/option>/);

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const start = inline.indexOf('// 항구는 사이트에 하나로');
  const end = inline.indexOf('function addedTag');
  assert.ok(start >= 0 && end > start, 'visibleSites 부분을 찾지 못했습니다');

  // SITES·FILTER·MISSING만 있으면 도는 부분이라 떼어내 실제로 돌려봅니다.
  const pick = (sites, missing) => new Function('SITES', 'FILTER', 'MISSING',
    `${inline.slice(start, end)}\nreturn visibleSites();`)(sites, 'all', missing);
  const sites = [
    { id: 'a', port: '충남 보령 대천항' },
    { id: 'b' },
    { id: 'c', boats: { '한바다호': { port: '인천 옹진 영흥도' } } },
    { id: 'd', phone: '010-0000-0000' },
  ];
  assert.deepEqual(pick(sites, 'port').map((s) => s.id), ['b', 'd'], '배별로 적어둔 항구도 항구입니다');
  assert.deepEqual(pick(sites, 'phone').map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(pick(sites, 'all').map((s) => s.id), ['a', 'b', 'c', 'd']);
});

test('관리 화면: 즐겨찾기를 글자로 내보내고 합쳐 가져온다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  for (const id of ['favexport', 'favimport', 'favtext', 'favio']) {
    assert.ok(html.includes(`id="${id}"`), `즐겨찾기 옮기기 요소가 없습니다: ${id}`);
  }

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const start = inline.indexOf('// ── 즐겨찾기 옮기기 ──');
  const end = inline.indexOf('// ── 즐겨찾기 옮기기 끝 ──');
  assert.ok(start >= 0 && end > start, '즐겨찾기 옮기기 부분을 찾지 못했습니다');
  const parseFavs = new Function(`${inline.slice(start, end)}\nreturn parseFavs;`)();

  assert.deepEqual(parseFavs('["바하호|충남 태안 구매항","1호|"]'), ['바하호|충남 태안 구매항', '1호|']);
  assert.deepEqual(parseFavs('["같은배|항구","같은배|항구"]'), ['같은배|항구'], '겹친 것은 한 번만');
  assert.deepEqual(parseFavs('["배이름만", 3, null]'), null, '키 꼴이 아니면 버립니다');
  assert.equal(parseFavs('{"a":1}'), null, '배열이 아니면 안 받습니다');
  assert.equal(parseFavs('붙여넣다 만 글자'), null);
  assert.equal(parseFavs('[]'), null);

  // 덮어쓰지 않고 합쳐야 두 기기에서 각각 담아둔 게 안 사라집니다.
  assert.match(inline, /const merged = \[\.\.\.new Set\(\[\.\.\.before, \.\.\.keys\]\)\]/);
});

test('관리 화면: 배마다 별점을 매긴다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  assert.match(html, /<th>선사 표기<\/th><th>배별 별점<\/th>/, '배별 별점 칸이 표에 없습니다');
  assert.ok(html.includes('id="ratemeta"'), '별점이 어디 저장되는지 알려주는 줄이 없습니다');

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const start = inline.indexOf('// ── 별점 ──');
  const end = inline.indexOf('// ── 별점 끝 ──');
  assert.ok(start >= 0 && end > start, '별점 부분을 찾지 못했습니다');

  // localStorage만 가짜로 넣으면 그대로 돌아갑니다.
  const store = new Map();
  const localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const m = new Function('localStorage',
    `${inline.slice(start, end)}\nreturn { RATE_KEY, rateKey, loadRates, saveRates, rateOf, setRate };`,
  )(localStorage);

  const rates = m.loadRates();
  assert.deepEqual(rates, {}, '처음에는 아무것도 안 매겨져 있습니다');

  const aura = m.rateKey('fishinggate', '아우라호');
  const black = m.rateKey('fishinggate', '블랙펄호');
  assert.equal(aura, 'fishinggate|아우라호');
  assert.notEqual(aura, m.rateKey('other', '아우라호'), '다른 선사의 동명 배는 섞이면 안 됩니다');
  assert.equal(m.setRate(rates, aura, 4), 4);
  assert.equal(m.setRate(rates, black, 2), 2);
  assert.equal(m.rateOf(rates, aura), 4);

  // 같은 별을 다시 누르면 지웁니다. 0점을 남기면 "안 매김"과 구별이 안 됩니다.
  assert.equal(m.setRate(rates, aura, 4), 0);
  assert.ok(!(aura in rates), '지운 별점은 값이 남으면 안 됩니다');
  assert.equal(m.rateOf(rates, aura), 0);
  // 다른 별을 누르면 그 점수로 바뀝니다.
  assert.equal(m.setRate(rates, black, 5), 5);

  assert.ok(m.saveRates(rates));
  assert.equal(m.RATE_KEY, 'fishing:boat-ratings', '현황판이 이 키를 읽습니다');
  assert.deepEqual(JSON.parse(store.get('fishing:boat-ratings')), { [black]: 5 });
  assert.deepEqual(m.loadRates(), { [black]: 5 }, '다시 열어도 남아 있어야 합니다');

  // 저장이 막힌 브라우저(시크릿 창 등)에서도 화면이 죽으면 안 됩니다.
  const blocked = new Function('localStorage',
    `${inline.slice(start, end)}\nreturn { loadRates, saveRates };`,
  )({ getItem: () => { throw new Error('막힘'); }, setItem: () => { throw new Error('막힘'); } });
  assert.deepEqual(blocked.loadRates(), {});
  assert.equal(blocked.saveRates({ a: 1 }), false, '실패를 알려줘야 화면이 안내할 수 있습니다');
});

test('관리 화면: 별점은 읽기 전용 모드에서도 매길 수 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  // 별점은 registry가 아니라 브라우저에 남습니다. LOCAL 여부로 잠그면 Pages에서 못 씁니다.
  const cell = inline.slice(inline.indexOf('function boatRatesCell'), inline.indexOf('// 항구는 사이트에'));
  assert.ok(cell.length > 100, 'boatRatesCell을 찾지 못했습니다');
  assert.ok(!cell.includes('LOCAL'), '별점은 로컬 서버가 없어도 매길 수 있어야 합니다');
  assert.match(inline, /별점과 즐겨찾기는 브라우저에 저장되는 값이라 여기서도 됩니다/);
});

// ── 밖에 열어도 되는 길과 아닌 길 ───────────────────────────────────────────
// 상시 감시 서버는 밖에 둡니다(DEPLOY.md). 그때 감시 목록은 밖에서도 쓸 수 있어야 하지만,
// registry를 고치고 프로세스를 띄우는 관리 API는 그대로 루프백에만 있어야 합니다.
const req = ({ ip = '127.0.0.1', host = 'localhost:8080', headers = {} } = {}) =>
  ({ socket: { remoteAddress: ip }, headers: { host, ...headers } });

test('관리 API는 밖에서 못 부른다 — 켜든 안 켜든', () => {
  for (const watchPublic of [false, true]) {
    assert.equal(apiAccess(req({ ip: '203.0.113.9', headers: { 'x-admin': '1' } }), '/api/sites', { watchPublic }), 'deny');
    assert.equal(apiAccess(req({ ip: '203.0.113.9', headers: { 'x-admin': '1', 'x-watcher': 'token-0123456789abcdef' } }),
      '/api/collect', { watchPublic }), 'deny', '감시 토큰이 관리 권한이 되면 안 됩니다');
  }
});

test('감시 API는 켰을 때만 밖에서 열린다', () => {
  const outside = req({ ip: '203.0.113.9', host: 'fishing.example', headers: { 'x-watcher': 'token-0123456789abcdef' } });
  assert.equal(apiAccess(outside, '/api/monitor', { watchPublic: false }), 'deny', '기본은 닫혀 있습니다');
  assert.equal(apiAccess(outside, '/api/monitor', { watchPublic: true }), 'watch');
});

// 커스텀 헤더가 없으면 다른 사이트의 폼이 그냥 쏠 수 있습니다(CSRF).
test('밖에서 온 감시 요청은 토큰 헤더가 있어야 받는다', () => {
  const outside = req({ ip: '203.0.113.9', host: 'fishing.example' });
  assert.equal(apiAccess(outside, '/api/monitor', { watchPublic: true }), 'deny');
});

test('로컬 관리자는 예전 그대로 세 겹을 다 통과해야 한다', () => {
  assert.equal(apiAccess(req({ headers: { 'x-admin': '1' } }), '/api/sites'), 'admin');
  assert.equal(apiAccess(req({}), '/api/sites'), 'deny', 'X-Admin이 없으면 안 됩니다');
  assert.equal(apiAccess(req({ host: 'evil.example' , headers: { 'x-admin': '1' } }), '/api/sites'), 'deny',
    'Host가 다르면 DNS 리바인딩입니다');
  assert.equal(apiAccess(req({ ip: '::1', headers: { 'x-admin': '1' } }), '/api/sites'), 'admin');
});

// 알림 이력 API도 사람마다 나뉩니다. 관리 API와 달리 밖에서도 열 수 있는 길이라
// (WATCH_PUBLIC) 특히 남의 것이 새지 않아야 합니다.
test('알림 이력은 내 감시가 잡은 것만 준다', async () => {
  const alerts = [
    // 'token-0123456789abcdef'의 해시입니다(core/watchers.js).
    { at: '2026-09-08T03:00:00.000Z', boat: '내배', watchers: ['3282c594dbdb33e245d995adcdafee3e'] },
    { at: '2026-09-08T03:00:00.000Z', boat: '남의배', watchers: ['다른사람'] },
  ];
  await withServer(async ({ base, dir }) => {
    const mine = await fetch(base + '/api/alerts', {
      headers: { 'X-Admin': '1', 'X-Watcher': 'token-0123456789abcdef' },
    }).then((r) => r.json());
    assert.deepEqual(mine.alerts.map((a) => a.boat), ['내배']);

    const stranger = await fetch(base + '/api/alerts', {
      headers: { 'X-Admin': '1', 'X-Watcher': 'another-token-0123456789' },
    }).then((r) => r.json());
    assert.deepEqual(stranger.alerts, [], '남의 이력은 안 줍니다');

    const anonymous = await fetch(base + '/api/alerts', { headers: { 'X-Admin': '1' } }).then((r) => r.json());
    assert.deepEqual(anonymous.alerts, []);
    void dir;
  }, { alertsPath: await writeAlerts(alerts) });
});

async function writeAlerts(records) {
  const dir = await mkdtemp(join(tmpdir(), 'alerts-api-'));
  const path = join(dir, 'alerts.jsonl');
  await writeFile(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}
