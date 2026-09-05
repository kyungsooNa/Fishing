// fetcher는 그동안 테스트가 없었습니다. 네트워크를 타는 부분이라 미뤘는데,
// 그 사이 undici Agent를 잘못 붙여 모든 요청이 깨진 채로 머지된 적이 있습니다
// (UND_ERR_INVALID_ARG). 로컬 서버를 띄우면 바깥 네트워크 없이도 잡을 수 있습니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchHtml, describeError } from '../core/fetcher.js';

// 포트를 매번 새로 잡습니다. fetcher가 호스트별로 3초씩 쉬는데, 포트가 다르면
// 다른 호스트로 보므로 테스트가 기다리지 않습니다.
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

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
