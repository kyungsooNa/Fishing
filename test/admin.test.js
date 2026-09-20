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

test('표기와 켜짐, 메모를 고치면 registry에 남는다', async () => {
  await withServer(async ({ base, registry }) => {
    const res = await admin(base, '/api/sites/bbb', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, name: '새 이름', phone: '010-1234-5678', note: '전화 전 확인할 것' }),
    });
    assert.equal(res.status, 200);

    const saved = JSON.parse(await readFile(registry, 'utf8'));
    const site = saved.sites.find((s) => s.id === 'bbb');
    assert.equal(site.enabled, true);
    assert.equal(site.name, '새 이름');
    assert.equal(site.phone, '010-1234-5678');
    assert.equal(site.note, '전화 전 확인할 것');
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
      ['/api/research', { method: 'POST', body: '{"sites":["aaa"],"pages":8}' }],
      ['/api/collect/aaa', { method: 'POST' }],
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
  await writeFile(script, 'process.send?.({type:"collect-progress",done:1,total:2}); console.log("수집 시작"); process.send?.({type:"collect-progress",done:2,total:2}); console.log("끝");');

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
    assert.deepEqual(job.progress, { done: 2, total: 2, percent: 100 });
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

test('관리 화면에서 선사를 골라 공식 사이트 조사를 띄우고 보고서를 읽는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-research-'));
  const script = join(dir, 'fake-research.js');
  const report = join(dir, 'report.md');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  await writeFile(report, '# 조사 결과\n\n- 출항 05시');

  await withServer(async ({ base }) => {
    const start = await admin(base, '/api/research', {
      method: 'POST',
      body: JSON.stringify({ sites: ['aaa', 'bbb'], pages: 8, force: true }),
    });
    assert.equal(start.status, 202);

    let task;
    for (let i = 0; i < 100; i++) {
      task = await admin(base, '/api/research').then((r) => r.json());
      if (!task.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(task.code, 0);
    assert.match(task.log.join('\n'), /"--sites","aaa,bbb","--pages","8","--force"/);
    assert.match(task.report, /출항 05시/);
  }, { researchArgs: [script], researchReport: report });
});

test('정보 조사는 등록 id와 페이지 상한을 검사한다', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/api/research', {
      method: 'POST', body: JSON.stringify({ sites: ['zzz'], pages: 8 }),
    })).status, 400);
    assert.equal((await admin(base, '/api/research', {
      method: 'POST', body: JSON.stringify({ sites: ['aaa'], pages: 21 }),
    })).status, 400);
  });
});

test('수집과 공식 사이트 조사는 동시에 실행하지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-exclusive-jobs-'));
  const script = join(dir, 'slow.js');
  await writeFile(script, 'setTimeout(() => {}, 3000)');

  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/api/collect', { method: 'POST' })).status, 202);
    assert.equal((await admin(base, '/api/research', {
      method: 'POST', body: JSON.stringify({ sites: ['aaa'], pages: 8 }),
    })).status, 409);
  }, { collectArgs: [script], researchArgs: [script] });

  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/api/research', {
      method: 'POST', body: JSON.stringify({ sites: ['aaa'], pages: 8 }),
    })).status, 202);
    assert.equal((await admin(base, '/api/collect', { method: 'POST' })).status, 409);
  }, { collectArgs: [script], researchArgs: [script] });
});

test('공식 사이트 조사 동안 로컬 자동 수집을 멈췄다가 다시 시작한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-research-monitor-'));
  const script = join(dir, 'research.js');
  await writeFile(script, 'console.log("조사 완료")');
  let stopped = 0;
  let started = 0;
  const monitor = {
    status: () => ({ running: false }),
    stop: async () => { stopped += 1; },
    start: () => { started += 1; },
  };

  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/api/research', {
      method: 'POST', body: JSON.stringify({ sites: ['aaa'], pages: 8 }),
    })).status, 202);
    for (let i = 0; i < 100; i++) {
      const task = await admin(base, '/api/research').then((r) => r.json());
      if (!task.running) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(stopped, 1);
    assert.equal(started, 1);
  }, { researchArgs: [script], monitor });
});

// 손으로 눌러야만 도는 기능은 아무도 안 누릅니다. 수집이 한가할 때 스스로 몇 곳씩 봅니다.
test('서버가 주기적으로 스스로 조사한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-auto-'));
  const script = join(dir, 'fake-research.js');
  const report = join(dir, 'report.md');
  await writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  await writeFile(report, '# 자동 조사 결과');

  await withServer(async ({ base }) => {
    let task;
    for (let i = 0; i < 200; i++) {
      task = await admin(base, '/api/research').then((r) => r.json());
      if (task.code === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // 스스로 돌 때는 선사를 고르지 않고 우선순위 상위 몇 곳을 봅니다(--limit).
    assert.match(task.log.join('\n'), /"--pages","4","--limit","2"/);
    assert.ok(!task.log.join('\n').includes('--sites'), '스스로 돌 때는 선사를 지정하지 않습니다');
    assert.equal(task.auto, true, '손으로 누른 것과 구분돼야 화면이 그렇게 적습니다');
    assert.match(task.report, /자동 조사 결과/);
    assert.equal(task.autoResearch.everyHours > 0, true);
    assert.ok(task.autoResearch.lastAt, '언제 봤는지 남아야 화면이 적을 수 있습니다');
  }, { researchArgs: [script], researchReport: report,
       autoResearch: { everyMs: 30, limit: 2, pages: 4 } });
});

// 같은 예약 플랫폼을 두 프로세스가 동시에 두드리면 안 됩니다. 기다렸다 끼어들지 않고 거릅니다.
test('수집이 도는 중이면 자동 조사는 그 차례를 건너뛴다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-auto-busy-'));
  const slow = join(dir, 'slow.js');
  const script = join(dir, 'fake-research.js');
  await writeFile(slow, 'setTimeout(() => {}, 400);');
  await writeFile(script, 'console.log("조사함")');

  await withServer(async ({ base }) => {
    assert.equal((await admin(base, '/api/collect', { method: 'POST' })).status, 202);
    await new Promise((r) => setTimeout(r, 150));
    const task = await admin(base, '/api/research').then((r) => r.json());
    assert.equal(task.running, false, '수집 중에는 조사를 시작하면 안 됩니다');
    assert.equal(task.autoResearch.lastAt, null);
  }, { collectArgs: [slow], researchArgs: [script],
       autoResearch: { everyMs: 30, limit: 2, pages: 4 } });
});

test('자동 조사는 끌 수 있다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admin-auto-off-'));
  const script = join(dir, 'fake-research.js');
  await writeFile(script, 'console.log("조사함")');

  await withServer(async ({ base }) => {
    await new Promise((r) => setTimeout(r, 120));
    const task = await admin(base, '/api/research').then((r) => r.json());
    assert.equal(task.running, false);
    assert.equal(task.autoResearch.everyHours, 0, '0이면 화면이 "꺼짐"이라고 적습니다');
    assert.equal(task.autoResearch.lastAt, null);
  }, { researchArgs: [script], autoResearch: { everyMs: 0, limit: 3, pages: 6 } });
});

test('관리 화면 스크립트에 문법 오류가 없고, 쓰는 요소가 다 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  assert.ok(inline.length > 500, '인라인 스크립트를 찾지 못했습니다');
  assert.doesNotThrow(() => new Function(inline));

  const used = [...inline.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], 'id가 바뀌면 그 부분이 조용히 안 돕니다');
  assert.match(inline, /job\.progress\?\.percent/, '수집 중에는 버튼에 진행률을 보여줍니다');
  assert.match(html, /id="research-sites"[\s\S]*?id="research-pages"[\s\S]*?id="research"/,
    '공식 사이트 조사 대상과 페이지 수를 고르는 버튼이 있어야 합니다');
});

test('관리 화면은 현황판과 한눈에 구분되는 관리 전용 머리글을 쓴다', async () => {
  const [admin, board] = await Promise.all([
    readFile('docs/admin.html', 'utf8'),
    readFile('docs/index.html', 'utf8'),
  ]);
  assert.match(admin, /<header class="adminhead">[\s\S]*?<span class="adminbadge">관리 전용<\/span>/);
  assert.match(admin, /\.adminhead \{[^}]*border-left: 6px solid var\(--accent\)/s);
  assert.match(admin, /--accent: #a64f0b/, '현황판의 파란색과 다른 관리 화면 구분색이 필요합니다');
  assert.ok(!board.includes('class="adminhead"'), '현황판까지 관리 전용 모양이면 다시 헷갈립니다');
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

// registry에 사람이 적어둔 표기와 수집이 읽은 이름이 갈리는 배가 있습니다(raraho는
// "라라호" ↔ "오천항 라라호"). 현황판은 수집 이름으로만 별점을 찾으므로, registry 표기에
// 매긴 별점은 영원히 안 보입니다. 매길 수 있는데 안 보이는 것이 가장 나쁩니다.
test('관리 화면: 현황판이 못 읽는 배 이름에는 별을 달지 않는다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  assert.match(inline, /OBSERVED = boatsFromTrips\(/,
    '수집이 읽은 이름을 알아야 매길 수 있는 이름인지 가릅니다');
  assert.match(inline, /const shown = new Set\(Object\.keys\(OBSERVED\[site\.id\] \?\? \{\}\)\.map\(boatId\)\);/);
  assert.match(inline, /if \(!shown\.has\(boatId\(boat\)\)\) \{|if \(!shown\.has\(boat\)\) \{/);
  assert.match(inline, /if \(!shown\.has\(boat\)\) \{/, '못 읽는 이름에도 별이 달립니다');

  // 못 받은 것과 이름이 다른 것은 고칠 곳이 달라서 다르게 적습니다.
  assert.match(inline, /'수집 이름 아님' : '수집 결과 없음'/);
});

// 규칙이 생기기 전에 registry 표기로 매긴 별점은 현황판에 영영 안 뜹니다. 저장된 점수는
// 멀쩡하니 버리지 않고 옮길 수 있어야 합니다 — 안 그러면 "별점이 안 보인다"가 그대로 남습니다.
// 오전배·오후배를 한 배로 보는 규칙은 저장 형식의 일부입니다. 두 화면이 갈리면 관리
// 화면에서 매긴 별점을 현황판이 못 찾습니다.
test('관리 화면과 현황판이 배 이름을 같은 규칙으로 줄인다', async () => {
  const [admin, board] = await Promise.all([
    readFile('docs/admin.html', 'utf8'),
    readFile('docs/index.html', 'utf8'),
  ]);
  const pick = (html) => html.match(/const SESSION_TAIL = [^\n]*\nconst boatId = [^\n]*/)?.[0];
  assert.ok(pick(admin), '관리 화면에 boatId가 없습니다');
  assert.equal(pick(admin), pick(board), '두 화면의 규칙이 갈렸습니다');
});

test('관리 화면: 현황판에 안 보이는 별점을 모아 옮기거나 지운다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  for (const id of ['lostrows', 'lostmeta', 'lostempty']) {
    assert.ok(html.includes(`id="${id}"`), `되살리기 칸이 없습니다: ${id}`);
  }
  assert.match(inline, /function lostRates\(\)/);
  assert.match(inline, /!Object\.keys\(OBSERVED\[siteId\] \?\? \{\}\)\.some\(\(name\) => boatId\(name\) === boat\)/,
    '수집 이름에 없는 키만 골라야 합니다(오전배·오후배는 줄인 이름으로 맞춥니다)');

  // 옮기기는 지우기와 저장이 한 번에. 저장이 막히면 점수를 잃습니다.
  const move = inline.match(/function moveRate\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(move, /const before = \{ \.\.\.RATES \};/);
  assert.match(move, /RATES = before;/, '저장이 막혔으면 없던 일로 돌려야 합니다');
  assert.match(inline, /renderLostRates\(\);/);
});

// 꺼져 있는 이유가 둘(고친 값 없음 / 읽기 전용)인데 버튼만 보면 고장과 구별이 안 됩니다.
test('관리 화면: [변경 저장]이 꺼져 있는 이유를 버튼이 말한다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  const paint = inline.match(/function paintSave\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(paint, /save\.disabled = !LOCAL \|\| DIRTY\.size === 0;/);
  assert.match(paint, /읽기 전용입니다/, '읽기 전용이라 못 쓰는 경우');
  assert.match(paint, /고친 값이 없습니다/, '고친 값이 없어 할 일이 없는 경우');
  assert.match(paint, /변경 저장 \(\$\{DIRTY\.size\}곳\)/);

  // 상태가 바뀌는 곳마다 같이 고쳐 그려야 합니다. 한 군데라도 빠지면 다시 어긋납니다.
  assert.equal(inline.split('paintSave()').length - 1 >= 4, true,
    '고친 곳·저장 뒤·읽기 전용·로컬 확인 네 자리에서 다시 그려야 합니다');
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

  // SITES·필터 값만 있으면 도는 부분이라 떼어내 실제로 돌려봅니다.
  const pick = (sites, missing) => new Function('SITES', 'FILTER', 'MISSING', 'SORT', 'SEARCH', 'FAVKEYS', 'FAVSET', 'RATES', 'rateOf', 'rateKey',
    `${inline.slice(start, end)}\nreturn visibleSites();`)(sites, 'all', missing, 'reg', '', {}, new Set(), {}, () => 0, () => '');
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

// 항구는 사람이 손으로 채우는 값이고, 그 일은 지역 단위로 몰아서 합니다 — id 순으로
// 널뛰면 같은 지역 페이지를 몇 번씩 다시 찾습니다. 항구를 모르는 곳이 앞에 오면 정렬을
// 켜자마자 빈 줄이 첫 쪽을 덮어서, 지역별로 보려던 것을 정작 못 봅니다.
test('관리 화면: 항구를 지역별로 모아 볼 수 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  assert.ok(html.includes('id="sort"'), '정렬 고르는 칸이 없습니다');
  assert.match(html, /<option value="port">항구 지역순<\/option>/);

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const start = inline.indexOf('// 항구는 사이트에 하나로');
  const end = inline.indexOf('function portCell');
  assert.ok(start >= 0 && end > start, '정렬 부분을 찾지 못했습니다');

  const pick = (sites, sort) => new Function('SITES', 'FILTER', 'MISSING', 'SORT', 'SEARCH', 'FAVKEYS', 'FAVSET', 'RATES', 'rateOf', 'rateKey',
    `${inline.slice(start, end)}\nreturn visibleSites();`)(sites, 'all', 'all', sort, '', {}, new Set(), {}, () => 0, () => '');
  const sites = [
    { id: 'a', port: '충남 보령 대천항' },
    { id: 'b' },
    { id: 'c', boats: { '한바다호': { port: '인천 옹진 영흥도' } } },
    { id: 'd', port: '충남 보령 오천항' },
    { id: 'e', port: '충남 태안 신진도항' },
  ];
  assert.deepEqual(pick(sites, 'port').map((s) => s.id), ['c', 'a', 'd', 'e', 'b'],
    '지역 → 항구 차례로 모이고, 항구를 모르는 곳은 뒤로 갑니다');
  assert.deepEqual(pick(sites, 'reg').map((s) => s.id), ['a', 'b', 'c', 'd', 'e'],
    '등록순은 registry 순서 그대로여야 합니다');
  assert.deepEqual(sites.map((s) => s.id), ['a', 'b', 'c', 'd', 'e'],
    'SITES를 제자리에서 섞으면 등록순으로 못 돌아옵니다');

  // 배별로만 적힌 항구로 줄을 세우면, 왜 거기 있는지 표에 적혀 있어야 합니다.
  assert.match(inline, /function portCell\(site\)/);
  assert.match(inline, /className = 'porthint'/);
});

test('관리 화면: 즐겨찾기·별점 정렬과 선사 검색이 있다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  assert.match(html, /<option value="fav">즐겨찾기 우선<\/option>/);
  assert.match(html, /<option value="rate">별점 높은순<\/option>/);
  assert.match(html, /id="search"/, '선사 검색칸이 없습니다');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const start = inline.indexOf('// 항구는 사이트에 하나로');
  const end = inline.indexOf('function portCell');
  const pick = (sites, sort, search, favs, rates) => new Function(
    'SITES', 'FILTER', 'MISSING', 'SORT', 'SEARCH', 'FAVKEYS', 'FAVSET', 'RATES', 'rateOf', 'rateKey',
    `${inline.slice(start, end)}\nreturn visibleSites();`,
  )(sites, 'all', 'all', sort, search, {
    a: { '가나호': new Set(['가나호|항구']) }, b: { '다라호': new Set(['다라호|항구']) },
  }, new Set(favs), rates, (map, key) => Number(map[key]) || 0, (id, boat) => `${id}|${boat}`);
  const sites = [
    { id: 'a', name: '가나선사', boats: { '가나호': {} } },
    { id: 'b', name: '다라피싱', boats: { '다라호': {} } },
    { id: 'c', name: '마바사', boats: { '마바호': {} } },
  ];
  assert.deepEqual(pick(sites, 'fav', '', ['다라호|항구'], {}).map((s) => s.id), ['b', 'a', 'c']);
  assert.deepEqual(pick(sites, 'rate', '', [], { 'a|가나호': 3, 'b|다라호': 5 }).map((s) => s.id), ['b', 'a', 'c']);
  assert.deepEqual(pick(sites, 'reg', '다라', [], {}).map((s) => s.id), ['b']);
  assert.deepEqual(pick(sites, 'reg', '마바호', [], {}).map((s) => s.id), ['c'], '배 이름으로도 찾습니다');
  assert.match(inline, /\$\('search'\)\.addEventListener\('input'/, '검색할 때 바로 다시 그립니다');
});

// 정렬·필터·쪽 넘김은 표를 통째로 다시 그립니다. 저장 전에 고친 값은 DIRTY에만 있어서,
// site를 그대로 읽어 그리면 방금 친 글자가 사라진 것처럼 보입니다 — 값은 저장되는데
// 화면만 옛 값이라, 고친 사람은 지워진 줄 알고 다시 칩니다.
test('관리 화면: 표를 다시 그려도 저장 전에 고친 값이 그대로 보인다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  const start = inline.indexOf('const editedValue');
  const end = inline.indexOf('function textCell');
  assert.ok(start >= 0 && end > start, 'editedValue를 찾지 못했습니다');
  const edited = new Function('DIRTY',
    `${inline.slice(start, end)}\nreturn editedValue;`)(new Map([['a', { port: '충남 보령 오천항', enabled: false }]]));

  assert.equal(edited({ id: 'a', port: '' }, 'port'), '충남 보령 오천항');
  assert.equal(edited({ id: 'a', enabled: true }, 'enabled'), false, '켜짐도 고친 쪽이 먼저입니다');
  assert.equal(edited({ id: 'b', port: '인천 옹진 영흥도' }, 'port'), '인천 옹진 영흥도',
    '안 고친 곳은 registry 값 그대로입니다');

  assert.match(inline, /input\.value = editedValue\(site, key\) \?\? '';/);
  assert.match(inline, /const on = editedValue\(site, 'enabled'\) !== false;/);
});

// 관리 화면에서 "충남 보령"으로 묶어 채운 것이 현황판 지역 필터에서는 다른 묶음이면,
// 채우는 사람은 자기가 뭘 묶었는지 모르는 채로 채웁니다.
test('관리 화면과 현황판이 항구에서 지역을 같은 규칙으로 읽는다', async () => {
  const [admin, board] = await Promise.all([
    readFile('docs/admin.html', 'utf8'),
    readFile('docs/index.html', 'utf8'),
  ]);
  const pick = (html) => html.match(/function regionOf\(port\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(pick(admin), '관리 화면에 regionOf가 없습니다');
  assert.equal(pick(admin), pick(board), '두 화면의 규칙이 갈렸습니다');
  assert.match(admin, /const NO_PORT = '\(항구 미상\)';/, 'regionOf가 쓰는 값입니다');
});

// 숨기는 것은 현황판에서 하지만, 그 패널은 숨긴 것이 있을 때만 열립니다. "그 선사가 왜 안
// 뜨지" 하고 관리 화면부터 여는 사람이 무엇을 숨겼는지 보고 되돌릴 수 있어야 합니다.
test('관리 화면: 숨긴 것을 모아 보고 되돌린다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  for (const id of ['mutemeta', 'muterows', 'muteempty', 'muteclear']) {
    assert.ok(html.includes(`id="${id}"`), `숨긴 것 표의 요소가 없습니다: ${id}`);
  }

  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const start = inline.indexOf('// ── 숨긴 것 ──');
  const end = inline.indexOf('// ── 숨긴 것 끝 ──');
  assert.ok(start >= 0 && end > start, '숨긴 것 부분을 찾지 못했습니다');

  const store = new Map();
  const localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const m = new Function('localStorage',
    `${inline.slice(start, end)}\nreturn { MUTE_KEY, MUTE_KINDS, loadMutes, saveMutes, setMute, unmute };`,
  )(localStorage);

  assert.deepEqual(m.loadMutes(), { site: [], boat: [], port: [], region: [] },
    '아무것도 없을 때도 네 종류가 다 있어야 뒤에서 안 터집니다');

  store.set('fishing:muted', JSON.stringify({
    site: ['가나선사', '가나선사', ''], boat: ['만선호|강원 고성 대진항'],
    port: ['충남 보령 오천항'], region: ['강원 고성'],
  }));
  assert.deepEqual(m.loadMutes().site, ['가나선사'], '겹친 것과 빈 값은 버립니다');

  assert.equal(m.setMute('site', '마바선사', true), true, '거는 것도 같은 문을 지납니다');
  assert.deepEqual(m.loadMutes().site, ['가나선사', '마바선사']);
  assert.equal(m.setMute('site', '마바선사', true), true);
  assert.deepEqual(m.loadMutes().site, ['가나선사', '마바선사'], '두 번 걸어도 한 번만 들어갑니다');
  assert.equal(m.setMute('site', '마바선사', false), true);
  assert.equal(m.setMute('없는종류', '가나선사', true), false, '모르는 종류는 걸지 않습니다');
  assert.equal(m.setMute('site', '', true), false, '빈 키는 걸지 않습니다');

  assert.equal(m.unmute('site', '가나선사'), true);
  assert.deepEqual(m.loadMutes().site, [], '푼 것은 저장까지 빠집니다');
  assert.deepEqual(m.loadMutes().boat, ['만선호|강원 고성 대진항'], '다른 종류는 안 건드립니다');
  assert.equal(m.unmute('없는종류', '가나선사'), false, '모르는 종류는 저장하지 않습니다');

  store.set('fishing:muted', '망가진 JSON');
  assert.deepEqual(m.loadMutes(), { site: [], boat: [], port: [], region: [] }, '읽다 죽지 않습니다');
  store.set('fishing:muted', '{"site":"글자"}');
  assert.deepEqual(m.loadMutes().site, [], '배열이 아니면 안 받습니다');

  // 저장이 막히면 지운 척하면 안 됩니다 — 화면만 바뀌면 되돌린 줄 알고 창을 닫습니다.
  assert.match(inline, /if \(!unmute\(kind, key\)\) return toast\('브라우저가 저장을 막고 있습니다'\);/);
});

// 숨기고 싶은 배를 만나는 자리는 배 이름 목록입니다. 거기서 바로 못 걸면 현황판으로 건너가
// 그 배를 다시 찾아야 하고, 그러면 아예 안 걸게 됩니다.
test('관리 화면: 배 이름 옆에서 바로 숨기고 되돌린다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const cell = inline.slice(inline.indexOf('function boatRatesCell'), inline.indexOf('// 항구는 사이트에'));

  // 숨김 키는 즐겨찾기와 **같은 키**입니다(`이름|항구`). 갈리면 여기서 건 것이 현황판에서
  // 안 숨고, 그건 "숨기기가 안 먹는다"로 보입니다.
  assert.ok(cell.includes('MUTESET.has(favEntry)'), '즐겨찾기와 같은 키로 숨겨야 합니다');
  assert.ok(cell.includes('toggleBoatMute(favEntry'), '거는 곳도 같은 키를 넘깁니다');
  assert.ok(!cell.includes('LOCAL'), '숨기기는 로컬 서버가 없어도 됩니다');
  assert.ok(cell.indexOf('MUTESET.has(favEntry)') > cell.indexOf('shown.has(boat)'),
    '수집에 없는 이름에는 ✕ 를 달지 않습니다 — 걸어도 현황판에서 안 숨습니다');

  // 걸어놓고 푸는 길을 못 찾는 것이 가장 나쁩니다. 같은 자리에서 바로 되돌아와야 합니다.
  assert.match(cell, /hide\.textContent = off \? '↩' : '✕';/, '숨긴 배는 그 자리에서 되돌립니다');
  assert.match(cell, /hide\.setAttribute\('aria-pressed', String\(off\)\);/);

  const toggle = inline.slice(inline.indexOf('function toggleBoatMute'), inline.indexOf('// ── 즐겨찾기 옮기기 ──'));
  assert.match(toggle, /if \(!setMute\('boat', key, on\)\) return toast\('브라우저가 저장을 막고 있습니다'\);/,
    '저장이 막히면 없던 일로 둡니다');
  assert.match(toggle, /render\(\);/, '표의 ✕ 를 다시 칠해야 합니다');
  assert.match(toggle, /renderMutes\(TRIPS\);/, '숨긴 것 목록도 같이 바뀌어야 합니다');

  // 숨긴 것 표에서 되돌려도 위 표의 ✕ 가 같이 돌아와야 합니다. 한쪽만 바뀌면 어느 쪽이
  // 맞는지 알 수 없습니다.
  const panel = inline.slice(inline.indexOf('function renderMutes'), inline.indexOf('function staticMode'));
  assert.match(panel, /if \(!unmute\(kind, key\)\) return toast\('브라우저가 저장을 막고 있습니다'\);\n\s*render\(\);/);
  assert.ok(html.includes('배별 칸 ✕(배)'), '숨긴 것이 없을 때 어디서 거는지 알려줘야 합니다');
});

// 선사를 숨기려면 현황판 필터 메뉴까지 건너가야 했습니다. 관리 화면의 이 표가 선사 목록인데
// 거기서 못 걸면, 표를 훑다가 "안 갈 곳"을 만나도 그냥 지나칩니다.
test('관리 화면: 선사 이름 옆에서 바로 숨기고 되돌린다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  // 현황판은 선사를 **이름으로** 숨깁니다(id가 아니라 `t.siteName`). 바로 옆이 그 표기를
  // 고치는 칸이라, registry 표기로 걸면 현황판에서 안 숨는 것을 걸어두게 됩니다.
  const names = new Function(
    `${inline.slice(inline.indexOf('function siteNamesFromTrips'), inline.indexOf('async function load()'))}
     return siteNamesFromTrips;`,
  )();
  const found = names([
    { siteId: 'a', siteName: '가나선사' },
    { siteId: 'a', siteName: '가나선사' },
    // 합쳐진 출조는 출처마다 이름이 따로 붙습니다.
    { siteId: 'b', siteName: '다라선사', sources: [{ siteId: 'b', siteName: '다라선사' }, { siteId: 'c', siteName: '마바선사' }] },
    { siteId: 'd' },
  ]);
  assert.deepEqual([...found.a], ['가나선사'], '같은 이름은 한 번만');
  assert.deepEqual([...found.b], ['다라선사']);
  assert.deepEqual([...found.c], ['마바선사'], '출처마다 자기 이름으로 담깁니다');
  assert.equal(found.d, undefined, '이름이 없으면 걸 수 없습니다');

  const cell = inline.slice(inline.indexOf('function siteNameCell'), inline.indexOf('// ── 별점 ──'));
  assert.ok(cell.includes('SITENAMES[site.id]'), '수집이 쓴 이름으로 걸어야 합니다');
  assert.match(cell, /if \(!names\.length\) return td;/, '수집된 출조가 없으면 ✕ 를 안 답니다');
  assert.ok(!cell.includes('LOCAL'), '숨기기는 로컬 서버가 없어도 됩니다');
  assert.match(cell, /hide\.textContent = off \? '↩' : '✕';/, '같은 자리에서 되돌립니다');

  // 이름이 여럿이면 반만 걸렸을 때가 가장 나쁩니다 — 현황판에서는 안 숨는데 표에는 걸린
  // 것처럼 보입니다. 걸림 표시도 "모두 걸렸을 때"만입니다.
  assert.match(cell, /const off = names\.every\(\(name\) => MUTED_SITES\.has\(name\)\);/);
  const toggle = inline.slice(inline.indexOf('function toggleSiteMute'), inline.indexOf('// ── 즐겨찾기 옮기기 ──'));
  assert.match(toggle, /for \(const name of names\) \{\n\s*if \(!setMute\('site', name, on\)\) return toast\('브라우저가 저장을 막고 있습니다'\);/);
  assert.match(toggle, /render\(\);/, '표의 ✕ 를 다시 칠해야 합니다');
  assert.match(toggle, /renderMutes\(TRIPS\);/, '숨긴 것 목록도 같이 바뀌어야 합니다');
  assert.ok(html.includes('선사 이름 옆 ✕(선사)'), '숨긴 것이 없을 때 어디서 거는지 알려줘야 합니다');
});

test('관리 화면: 선사 메모는 버튼으로 열고 기존 변경 저장 흐름에 넣는다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  assert.match(html, /<th>전화<\/th><th>메모<\/th>/, '메모 칸이 선사 표에 있어야 합니다');
  assert.match(html, /id="memodialog"/, '메모 버튼은 내용을 열 대화창이 필요합니다');
  const memo = inline.slice(inline.indexOf('function memoCell'), inline.indexOf('// ── 별점 ──'));
  assert.match(memo, /button\.textContent = note \? '메모 보기' : '메모';/);
  assert.match(memo, /button\.addEventListener\('click', \(\) => openMemo\(site\)\);/);
  assert.match(memo, /markDirty\(MEMO_SITE\.id, 'note', \$\('memotext'\)\.value\.trim\(\)\);/,
    '메모도 저장 전 변경 목록에 넣어야 합니다');
  assert.match(memo, /\$\('memodialog'\)\.showModal\(\);/, '클릭하면 내용이 보이는 대화창을 엽니다');
});

// 두 화면이 같은 값을 쓰는데 열쇠나 종류가 갈리면, 관리 화면에서 되돌린 것이 현황판에서
// 안 풀립니다. 그건 "되돌리기가 안 먹는다"로 보이고 고장과 구별이 안 됩니다.
test('관리 화면과 현황판이 숨김을 같은 자리에 적는다', async () => {
  const [admin, board] = await Promise.all([
    readFile('docs/admin.html', 'utf8'),
    readFile('docs/index.html', 'utf8'),
  ]);
  for (const html of [admin, board]) {
    assert.match(html, /const MUTE_KEY = 'fishing:muted';/);
    assert.match(html, /const MUTE_KINDS = \['site', 'boat', 'port', 'region'\];/);
  }
  // 배 키는 즐겨찾기와 같은 키입니다. 여기가 갈리면 관리 화면이 엉뚱한 배를 되돌립니다.
  const favKey = (html) => html.match(/const favKey = .*/)?.[0];
  assert.ok(favKey(admin), '관리 화면에 favKey가 없습니다');
  assert.equal(favKey(admin), favKey(board), '배 키가 갈렸습니다');
});

// 담는 자리가 현황판에만 있어서, 선사 표를 훑다가 담고 싶으면 현황판으로 건너가 그 배를
// 다시 찾아야 했습니다. 관리 화면의 배별 칸에서도 담습니다 — 다만 **현황판과 같은 키**여야
// 하고, 그 키의 항구는 registry가 아니라 **수집 결과**에서 와야 합니다(별점이 겪은 일입니다).
test('관리 화면: 배별 칸에서 즐겨찾기를 담는다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  const keys = new Function('favKey', 'boatId',
    `${inline.slice(inline.indexOf('function favKeysFromTrips'), inline.indexOf('async function load()'))}
     return favKeysFromTrips;`,
  )((t) => `${t.boat}|${t.port ?? ''}`, (b) => b);

  const found = keys([
    { siteId: 'a', boat: '만선호', port: '강원 고성 대진항' },
    // 합쳐진 출조는 모든 출처에 답니다 — 어느 선사 줄에서 담아도 현황판의 그 배에 붙습니다.
    { siteId: 'b', boat: '무적호', port: '충남 보령 오천항',
      sources: [{ siteId: 'b' }, { siteId: 'c' }] },
    { siteId: 'd', boat: '', port: '충남 태안 구매항' },
  ]);
  assert.deepEqual([...found.a['만선호']], ['만선호|강원 고성 대진항']);
  assert.deepEqual([...found.b['무적호']], ['무적호|충남 보령 오천항']);
  assert.deepEqual([...found.c['무적호']], ['무적호|충남 보령 오천항'], '출처마다 다 달립니다');
  assert.equal(found.d, undefined, '이름 없는 배는 담을 길이 없습니다');

  // 한 배가 여러 항구에서 뜨면 즐겨찾기도 항구마다 따로입니다(현황판의 키가 그렇습니다).
  const two = keys([
    { siteId: 'a', boat: '만선호', port: '강원 고성 대진항' },
    { siteId: 'a', boat: '만선호', port: '충남 보령 오천항' },
  ]);
  assert.equal(two.a['만선호'].size, 2, '항구가 다르면 다른 즐겨찾기입니다');

  // 별점처럼 registry 표기가 아니라 수집이 읽은 이름·항구를 씁니다. 그래서 ☆ 는 `shown`을
  // 지난 배에만 답니다 — 못 찾을 키로 담아두면 현황판에서 영원히 안 보입니다.
  const cell = inline.slice(inline.indexOf('function boatRatesCell'), inline.indexOf('// 항구는 사이트에'));
  assert.ok(cell.includes('FAVKEYS[site.id]?.[boat]'), '수집에서 온 키로 담아야 합니다');
  assert.ok(!cell.includes('LOCAL'), '즐겨찾기는 로컬 서버가 없어도 담을 수 있어야 합니다');
  assert.ok(cell.indexOf('FAVKEYS[site.id]') > cell.indexOf("shown.has(boat)"),
    '수집에 없는 이름에는 ☆ 를 달지 않습니다');

  // 담고 빼는 곳이 둘이라 값을 고치는 곳은 하나여야 합니다. 갈리면 표의 ☆ 와 아래 목록이
  // 어긋나고, 저장이 막혔을 때 한쪽만 되돌아갑니다.
  const toggle = inline.slice(inline.indexOf('function toggleFav'), inline.indexOf('// ── 즐겨찾기 옮기기 ──'));
  assert.match(toggle, /if \(!saveFavs\(.*\)\) \{\n\s*return toast\('브라우저가 저장을 막고 있습니다'\);/,
    '저장이 막히면 없던 일로 둡니다');
  assert.match(toggle, /render\(\);/, '표의 ☆ 를 다시 칠해야 합니다');
  assert.match(toggle, /renderFavs\(TRIPS\);/, '아래 목록도 같이 바뀌어야 합니다');
  assert.match(inline, /btn\.addEventListener\('click', \(\) => toggleFav\(key, boat \|\| key\)\);/,
    '목록에서 지우는 것도 같은 문을 지나야 합니다');
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
  assert.match(html, /<th>선사 표기<\/th><th>배별 즐겨찾기·별점·숨기기<\/th>/, '배별 칸이 표에 없습니다');
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
  assert.match(inline, /별점·즐겨찾기·숨긴 것은 브라우저에 저장되는 값이라 여기서도 됩니다/);
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

// 정렬 칸은 표 위에 있는데, 사람은 칸 머리글을 눌러 정렬하려 듭니다 — 실제로 그렇게 찾다가
// "정렬이 없다"는 말이 나왔습니다. 두 문이 같은 정렬을 열되, 값을 정하는 곳은 하나여야
// 합니다. 갈리면 머리글로 정렬해 놓고 정렬 칸에는 "등록순"이라고 적혀 있게 됩니다.
test('관리 화면: 항구 머리글을 눌러도 정렬되고, 정렬 칸과 같은 상태를 본다', async () => {
  const html = await readFile('docs/admin.html', 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  assert.ok(html.includes('id="sort-port"'), '누를 수 있는 항구 머리글이 없습니다');
  assert.match(html, /<th id="th-port" aria-sort="none">/, '정렬 상태를 읽어주는 표시가 필요합니다');

  // 상태를 정하는 곳이 하나인지 — 둘 다 setSort를 부릅니다.
  assert.match(inline, /\$\('sort'\)\.addEventListener\('change', \(\) => setSort\(\$\('sort'\)\.value\)\);/);
  assert.match(inline, /\$\('sort-port'\)\.addEventListener\('click', \(\) => setSort\(SORT === 'port' \? 'reg' : 'port'\)\);/,
    '한 번 더 누르면 등록순으로 돌아와야 합니다');

  const setSort = inline.match(/function setSort\(next\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(setSort, /\$\('sort'\)\.value = next;/, '정렬 칸 표시가 갈리면 안 됩니다');
  assert.match(setSort, /aria-sort', next === 'port' \? 'ascending' : 'none'/);
  assert.match(setSort, /PAGE = 0;/, '정렬이 바뀌면 보던 쪽의 줄이 통째로 달라집니다');
  assert.match(setSort, /render\(\);/);
});
