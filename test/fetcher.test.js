// fetcher는 그동안 테스트가 없었습니다. 네트워크를 타는 부분이라 미뤘는데,
// 그 사이 undici Agent를 잘못 붙여 모든 요청이 깨진 채로 머지된 적이 있습니다
// (UND_ERR_INVALID_ARG). 로컬 서버를 띄우면 바깥 네트워크 없이도 잡을 수 있습니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchHtml, describeError, gapKey } from '../core/fetcher.js';

// 포트를 매번 새로 잡습니다. fetcher가 호스트별로 3초씩 쉬는데, 포트가 다르면
// 다른 호스트로 보므로 테스트가 기다리지 않습니다.
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

test('요청 간격은 호스트가 아니라 서버(도메인) 단위로 센다', () => {
  // 선사 사이트는 대부분 플랫폼 서브도메인이라 호스트만 다르고 서버는 하나입니다.
  // 호스트별로 세다가 더피싱 계열 242곳이 통째로 막힌 적이 있습니다.
  assert.equal(gapKey('https://akbari.sunsang24.com/ship/schedule_fleet'), 'sunsang24.com');
  assert.equal(gapKey('https://ssfish.thefishing.kr/index.php?mid=bk'), 'thefishing.kr');
  assert.equal(gapKey('https://eungabi.sunsang24.com/'), 'sunsang24.com');

  // 자체 도메인끼리는 남남입니다. 서로 기다릴 이유가 없습니다.
  assert.equal(gapKey('https://www.ssfish.kr/a'), 'ssfish.kr');
  assert.equal(gapKey('https://blueseaho.com/reservation'), 'blueseaho.com');
  assert.equal(gapKey('https://a.b.example.co.kr/'), 'example.co.kr');

  // 로컬 서버는 포트까지 봐야 따로 셉니다(테스트가 3초씩 기다리지 않도록).
  assert.equal(gapKey('http://127.0.0.1:3000/'), '127.0.0.1:3000');
  assert.notEqual(gapKey('http://127.0.0.1:3000/'), gapKey('http://127.0.0.1:3001/'));
});

test('받아온 HTML을 그대로 돌려준다', async () => {
  const site = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>운항시간 : 04:00 ~ 17:00</body></html>');
  });
  try {
    const html = await fetchHtml(site.url, { mode: 'static', retries: 0 });
    assert.match(html, /운항시간 : 04:00 ~ 17:00/);
  } finally {
    await site.close();
  }
});

test('EUC-KR 페이지를 한글로 읽는다', async () => {
  // 국내 예약 사이트에 아직 흔합니다. 잘못 읽으면 파싱이 통째로 깨집니다.
  const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // "한글"
  const site = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr' });
    res.end(Buffer.concat([Buffer.from('<html><body>'), eucKr, Buffer.from('</body></html>')]));
  });
  try {
    const html = await fetchHtml(site.url, { mode: 'static', retries: 0 });
    assert.match(html, /한글/);
  } finally {
    await site.close();
  }
});

test('HTTP 오류는 상태코드를 그대로 알려준다', async () => {
  const site = await serve((_, res) => { res.writeHead(403); res.end('nope'); });
  try {
    await assert.rejects(
      fetchHtml(site.url, { mode: 'static', retries: 0 }),
      (err) => describeError(err).includes('HTTP 403'),
    );
  } finally {
    await site.close();
  }
});

test('auto 모드도 본문이 있으면 브라우저를 띄우지 않는다', async () => {
  // 브라우저가 깔려 있지 않은 환경에서도 통과해야 합니다.
  const site = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>' + '출조 일정이 여기에 길게 들어있습니다. '.repeat(30) + '</body></html>');
  });
  try {
    const html = await fetchHtml(site.url, { mode: 'auto', retries: 0 });
    assert.match(html, /출조 일정/);
  } finally {
    await site.close();
  }
});

test('응답이 안 오면 정해둔 시간에 끊고, 얼마나 기다렸는지 알려준다', async () => {
  // 러너는 해외, 상대는 국내 호스트입니다. 기본값(10초)이 빠듯해서 멀쩡한
  // 사이트가 무더기로 떨어진 적이 있습니다. 값을 우리가 정할 수 있어야 합니다.
  const site = await serve(() => { /* 영원히 응답하지 않습니다 */ });
  try {
    const started = Date.now();
    await assert.rejects(
      fetchHtml(site.url, { mode: 'static', retries: 0, timeoutMs: 300 }),
      (err) => /300ms|시간/.test(describeError(err)),
    );
    assert.ok(Date.now() - started < 3000, '기본값(10초)까지 기다리면 안 됩니다');
  } finally {
    await site.close();
  }
});

test('리다이렉트를 따라간다', async () => {
  const target = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>운항시간 : 06:00 ~ 15:00</body></html>');
  });
  const entry = await serve((_, res) => { res.writeHead(302, { Location: target.url }); res.end(); });
  try {
    const html = await fetchHtml(entry.url, { mode: 'static', retries: 0 });
    assert.match(html, /운항시간/);
  } finally {
    await entry.close();
    await target.close();
  }
});

test('Location이 주소로 안 읽히면 그 사이트만 실패한다 — 프로세스가 죽지 않는다', async () => {
  // 한글 도메인으로 넘기면서 헤더를 인코딩 안 한 사이트가 실제로 있습니다.
  // 예전에는 응답 콜백 안에서 new URL이 던져 수집 전체가 통째로 죽었습니다.
  const site = await serve((_, res) => {
    res.writeHead(302, { Location: 'http://' });   // 호스트가 없는 주소
    res.end();
  });
  try {
    await assert.rejects(
      () => fetchHtml(site.url, { mode: 'static', retries: 0 }),
      /리다이렉트 주소를 읽을 수 없습니다/,
    );
  } finally {
    await site.close();
  }
});

test('리다이렉트가 끝없이 돌면 포기한다', async () => {
  let self;
  const site = await serve((_, res) => { res.writeHead(302, { Location: self }); res.end(); });
  self = site.url;
  try {
    await assert.rejects(fetchHtml(site.url, { mode: 'static', retries: 0 }), /리다이렉트/);
  } finally {
    await site.close();
  }
});

test('연결이 안 되면 재시도하지 않는다', async () => {
  // 붙지도 않는 곳에 세 번 매달리면 수집이 몇 분씩 길어지고, 상대에겐 그저
  // 두들기는 셈입니다. 한 번 안 되면 접습니다.
  const site = await serve(() => { /* 영원히 응답하지 않습니다 */ });
  try {
    const started = Date.now();
    await assert.rejects(fetchHtml(site.url, { mode: 'static', retries: 2, timeoutMs: 400 }));
    const spent = Date.now() - started;
    assert.ok(spent < 1200, `한 번만 시도해야 합니다 (${spent}ms 걸림)`);
  } finally {
    await site.close();
  }
});

test('일시적인 오류(HTTP 500)는 재시도한다', async () => {
  let hits = 0;
  const site = await serve((_, res) => {
    hits += 1;
    if (hits < 2) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>운항시간 : 05:00 ~ 12:00</body></html>');
  });
  try {
    const html = await fetchHtml(site.url, { mode: 'static', retries: 2, paceKey: 'test-500' });
    assert.match(html, /운항시간/);
    assert.equal(hits, 2, '한 번 실패하고 다시 시도해서 받아옵니다');
  } finally {
    await site.close();
  }
});

// 2026-09-17 08시부터 선상24가 IP당 요청량을 막으며 `HTTP 405`를 주기 시작했는데, 그걸
// 세 번씩 다시 물었습니다 — 126곳이 한 실행에 378번. 한 곳당 4.0초가 10.7초가 됐고,
// 이미 거절한 서버를 22분 더 두들겼습니다. 그러면 차단이 풀릴 일도 없습니다.
test('거절(4xx)은 다시 묻지 않는다 — 같은 요청에 같은 답입니다', async () => {
  for (const status of [400, 403, 404, 405]) {
    let hits = 0;
    const site = await serve((_, res) => { hits += 1; res.writeHead(status); res.end(); });
    try {
      await assert.rejects(
        fetchHtml(site.url, { mode: 'static', retries: 2 }),
        (err) => {
          assert.equal(err.status, status, '상태코드가 오류에 그대로 달려 있어야 합니다');
          assert.match(err.message, new RegExp(`HTTP ${status}`));
          return true;
        },
      );
      assert.equal(hits, 1, `HTTP ${status}는 한 번만 물어야 합니다 (${hits}번 물었습니다)`);
    } finally {
      await site.close();
    }
  }
});

// "지금은 말고 이따가"는 거절과 다릅니다. 기다렸다 다시 묻는 것이 맞는 답입니다.
test('408·429는 기다렸다 다시 묻는다', async () => {
  for (const status of [408, 429]) {
    let hits = 0;
    const site = await serve((_, res) => {
      hits += 1;
      if (hits < 2) { res.writeHead(status); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>운항시간 : 05:00 ~ 12:00</body></html>');
    });
    try {
      const html = await fetchHtml(site.url, { mode: 'static', retries: 2 });
      assert.match(html, /운항시간/);
      assert.equal(hits, 2, `HTTP ${status}는 다시 물어야 합니다`);
    } finally {
      await site.close();
    }
  }
});

// times 실행(run 35103670154)에서 58곳이 "30000ms 안에 응답이 없습니다"로 죽었는데
// 실제로는 한 곳당 2초대였습니다. 30초를 기다린 것과 2초 만에 끊긴 것은 손쓸 데가
// 완전히 다른데 메시지만으로는 그 둘이 같아 보입니다 — 걸린 시간을 같이 남깁니다.
test('실패한 원인에 얼마나 걸려서 실패했는지가 같이 남는다', async () => {
  const site = await serve((_, res) => { res.writeHead(503); res.end(); });
  try {
    await assert.rejects(
      fetchHtml(site.url, { mode: 'static', retries: 0 }),
      (err) => {
        assert.ok(Number.isFinite(err.elapsedMs), '걸린 시간이 붙어야 합니다');
        assert.match(describeError(err), /HTTP 503/);
        assert.match(describeError(err), /초 만에/);
        return true;
      },
    );
  } finally {
    await site.close();
  }
});

// req.setTimeout이 던지면(문자열 msecs 등) 그 뒤에 달던 'error' 리스너가 안 달려서,
// 소켓 오류를 아무도 안 받고 **프로세스가 통째로 죽었습니다**. 사이트 하나 때문에
// 수집 전체가 날아가는 경로라, timeoutMs는 숫자로 맞추고 리스너를 먼저 답니다.
test('timeoutMs에 문자열이 와도 그 요청만 실패하고 프로세스는 산다', async () => {
  const site = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>운항시간 : 05:00 ~ 12:00 자리 넉넉합니다 예약 받습니다</body></html>');
  });
  try {
    // 워크플로 입력은 문자열로 옵니다(LIMIT: '60'처럼). 숫자로 맞춰 그대로 받아옵니다.
    const html = await fetchHtml(site.url, { mode: 'static', retries: 0, timeoutMs: '3000' });
    assert.match(html, /운항시간/);
  } finally {
    await site.close();
  }

  // 숫자로 못 읽는 값도 기본값으로 물러섭니다 — 던지고 죽는 쪽이 제일 나쁩니다.
  const odd = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>운항시간 : 05:00 ~ 12:00 자리 넉넉합니다 예약 받습니다</body></html>');
  });
  try {
    // 같은 서버에 여러 번 붙으면 3초씩 쉬므로(pace) 한 값만 봅니다.
    const html = await fetchHtml(odd.url, { mode: 'static', retries: 0, timeoutMs: 'abc' });
    assert.match(html, /운항시간/);
  } finally {
    await odd.close();
  }
});

// times 실행(run 35105080153)에서 10곳이 전부 "30000ms 안에 응답이 없습니다 — 5.0초 만에"
// 였습니다. Node 19부터 globalAgent가 `keepAlive: true, timeout: 5000`으로 오는데, 그
// 5초가 소켓에 걸리면 우리가 건 30초는 무시됩니다. 더 나쁘게는 `req.setTimeout(30000, cb)`의
// **cb는 그대로 불려서** 5초 만에 끊긴 것을 30초 기다린 것처럼 보고합니다.
// 해외 러너에서 국내 호스트에 붙는 데는 5초가 모자랍니다 — 기본 agent를 안 씁니다.
test('기본 agent(5초 timeout)에 안 얹힌다', async () => {
  const { globalAgent } = await import('node:http');
  assert.equal(globalAgent.options.timeout, 5000, '이 시험이 막는 게 바로 이 기본값입니다');

  const site = await serve((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>운항시간 : 05:00 ~ 12:00 자리 넉넉합니다 예약 받습니다</body></html>');
  });
  try {
    await fetchHtml(site.url, { mode: 'static', retries: 0 });
    // 기본 agent를 탔다면 여기에 소켓이 남습니다(keepAlive라 풀에 들어갑니다).
    const pooled = [...Object.values(globalAgent.sockets), ...Object.values(globalAgent.freeSockets)];
    assert.equal(pooled.length, 0, '기본 agent를 타면 그쪽 5초 timeout이 우리 값을 덮습니다');
  } finally {
    await site.close();
  }
});
