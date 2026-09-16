import test from 'node:test';
import assert from 'node:assert/strict';
import { researchTargets, dueForResearch, inspectPage, researchSite } from '../core/research.js';

test('빈칸, 확인 문구, 만료 근거를 찾고 0석과 휴항의 빈 좌석은 제외한다', () => {
  const registry = [{ id: 'a', url: 'https://a.example', timeGuide: { source: 'https://a.example/notice', validFrom: '2025-01-01', validThrough: '2025-12-31' } }];
  const t = { siteId: 'a', date: '2026-09-16', departAt: '전화 문의', returnAt: '별도 안내', port: '홍원항', phone: '010-1234-5678', price: 0, species: '주꾸미', seatsLeft: 0 };
  const rows = researchTargets(registry, { trips: [t, { ...t, seatsLeft: null, status: 'off' }, { ...t, date: '2025-01-01' }] }, '2026-09-16');
  assert.equal(rows[0].trips, 2);
  assert.ok(rows[0].issues.some(i => i.reason === '전화 문의'));
  assert.ok(rows[0].issues.some(i => i.reason === '적용 기간 지남'));
  assert.ok(!rows[0].issues.some(i => ['seatsLeft', 'price'].includes(i.field)));
});

test('일부 배에 guide가 있어도 다른 배의 미확인 시각은 조사한다', () => {
  const registry = [{ id: 'a', url: 'https://a.example', boats: { 가호: { timeGuide: { departAt: '05:00' } } } }];
  assert.equal(researchTargets(registry, { trips: [{ siteId: 'a', boat: '나호', date: '2026-09-16', session: '오전' }] }, '2026-09-16').length, 1);
});

test('확인 이력이 그대로면 쉬고 새 항목 또는 실패 재시도 시 다시 본다', () => {
  const now = Date.parse('2026-09-16T10:00:00Z');
  const previous = { fingerprint: 'a', checkedAt: '2026-09-16T02:00:00Z', status: 'not-found-in-checked-pages' };
  assert.equal(dueForResearch({ fingerprint: 'a' }, previous, now), false);
  assert.equal(dueForResearch({ fingerprint: 'b' }, previous, now), true);
  assert.equal(dueForResearch({ fingerprint: 'a' }, { ...previous, status: 'failed' }, now), true);
});

test('집결과 출항 범위를 구분하고 첨부와 공식 공지 링크만 남긴다', () => {
  const page = inspectPage(`<p>04시30분까지 매장에 도착해주세요.</p>
    <p>출항은 <b>05시</b>에서 05시30분 사이 출항합니다.</p>
    <p>입항 15시</p><p>예약확정 홍길동(2) 출항 05시</p>
    <a href="/notice/1">출항시간 안내</a><a href="https://other.example/notice">공지</a>
    <img src="/uploads/20250903.jpg"><img src="/logo.png">`, 'https://a.example/');
  assert.ok(page.evidence.some(e => e.kind === 'meeting'));
  assert.ok(page.evidence.some(e => e.kind === 'departure-window-or-operation'));
  assert.ok(page.evidence.some(e => e.kind === 'return'));
  assert.ok(!page.evidence.some(e => e.quote.includes('홍길동')));
  assert.ok(page.evidence.every(e => !('returnAt' in e)));
  assert.equal(page.links.length, 1);
  assert.equal(page.media.length, 1);
});

test('공지 상세를 따라가며 부분 실패와 미방문을 보존한다', async () => {
  const target = { url: 'https://a.example/', samples: [{ url: 'https://a.example/bk' }] };
  const visited = [];
  const result = await researchSite(target, { maxPages: 3, readPage: async url => {
    visited.push(url);
    if (url.endsWith('/bk')) throw new Error('timeout');
    if (url.endsWith('/notice')) return '<p>출항 05시</p><a href="/guide">승선 안내</a>';
    return '<a href="/notice">공지</a>';
  } });
  assert.equal(visited.length, 3);
  assert.equal(result.status, 'review-required');
  assert.equal(result.pages[1].status, 'failed');
  assert.equal(result.evidence[0].source, 'https://a.example/notice');
  assert.equal(result.remaining[0].url, 'https://a.example/guide');
});

test('다운로드 주소는 본문으로 읽지 않고 첨부로 남기며 같은 게시물을 중복 요청하지 않는다', async () => {
  const target = { url: 'https://a.example/', samples: [] };
  const visited = [];
  const result = await researchSite(target, { maxPages: 6, readPage: async url => {
    visited.push(url);
    return `<a href="/index.php?mid=notice&mode=view&wr_uid=12">출항 공지</a>
      <a href="/index.php?mid=notice&page=1&mode=view&wr_uid=12">출항 공지</a>
      <a href="/action.download.php?bf_uid=123">레이디출항지.jpg</a>`;
  } });
  assert.equal(visited.length, 2);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].status, 'visual-review-required');
});
