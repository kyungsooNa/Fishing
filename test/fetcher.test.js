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
