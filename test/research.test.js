import test from 'node:test';
import assert from 'node:assert/strict';
import { researchTargets, dueForResearch, inspectPage, researchSite, proposeGuides, researchProposals, researchMarkdown } from '../core/research.js';

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

// 근거만 쌓아두면 읽는 사람이 매번 같은 판단을 다시 합니다. 붙일 초안까지 내되, **값을
// 정해주지는 않습니다** — 막는 것을 안 적으면 작년 공지의 시각이 올해 값으로 남습니다.
const plaza = (over = {}) => ({
  id: 'plaza', checkedAt: '2026-09-16T00:00:00.000Z',
  issues: [{ field: 'departAt', reason: '선사 확인(값 누락)', count: 30 }],
  evidence: [], ...over,
});

test('반영 후보: 막는 것이 없으면 그대로 붙일 초안을 낸다', () => {
  const [p] = proposeGuides(plaza({
    evidence: [{
      kind: 'departure', times: ['06시'],
      quote: '레이디호 2026년 9월 1일부터 10월 31일까지 쭈꾸미 06시 출항',
      source: 'https://plaza.example/n/9', pageTitle: '가을 시즌 안내',
    }],
  }), { boats: { 레이디호: {}, 베니스호: {} } });

  assert.deepEqual(p.missing, [], '기간·배·값이 다 확인되면 막는 것이 없습니다');
  assert.equal(p.boat, '레이디호');
  assert.equal(p.path, 'boats.레이디호.timeGuide', '배가 특정되면 배별로 붙입니다');
  assert.deepEqual(p.draft.timeGuide, {
    departAt: '06:00', validFrom: '2026-09-01', validThrough: '2026-10-31',
    source: 'https://plaza.example/n/9',
    note: '레이디호 2026년 9월 1일부터 10월 31일까지 쭈꾸미 06시 출항',
  });
});

test('반영 후보: 기간·배·값이 확실하지 않으면 그 이유를 적는다', () => {
  const [p] = proposeGuides(plaza({
    evidence: [
      { kind: 'departure-window-or-operation', times: ['05시', '05시 30분'],
        quote: '출항은 05시 에서 05시 30분 사이 출항합니다',
        source: 'https://plaza.example/n/1941669', pageTitle: '25년도 출조 안내' },
      { kind: 'departure', times: ['06시'], quote: '쭈꾸미 06시 출항',
        source: 'https://plaza.example/n/1813991', pageTitle: '24년도 안내' },
    ],
  }), { boats: { 레이디호: {}, 베니스호: {} } });

  assert.deepEqual(p.missing, ['값이 여러 개', '적용 기간(근거는 2025년 공지)', '배 확인(2척)']);
  assert.deepEqual(p.candidates, ['05:00', '06:00'], '갈린 값을 다 보여줘야 사람이 고릅니다');
  // ~ 없이 적은 범위도 읽습니다. 둘째 시각을 returnAt에 넣으면 30분 운항이 됩니다.
  assert.equal(p.draft.timeGuide.departThrough, '05:30');
  assert.equal(p.draft.timeGuide.validFrom, null, '기간을 지어내면 안 됩니다');
});

test('반영 후보: 집결시각은 출항시각이 빈 곳에서만, 출항으로 섞지 않는다', () => {
  const evidence = [{ kind: 'meeting', times: ['04시30분'], quote: '04시30분까지 매장에 도착해주세요',
    source: 'https://ssfish.example/bk', pageTitle: '예약' }];

  const [p] = proposeGuides(plaza({ evidence }), { boats: { 힐링호: {} } });
  assert.equal(p.field, 'meetingAt');
  assert.equal(p.draft.timeGuide.meetingAt, '04:30');
  assert.equal(p.draft.timeGuide.departAt, undefined, '집결을 출항으로 넣으면 배를 놓칩니다');

  // 출항시각이 이미 있는 선사에는 제안하지 않습니다.
  const filled = proposeGuides({ ...plaza({ evidence }), issues: [{ field: 'price', reason: '값 누락', count: 3 }] }, {});
  assert.deepEqual(filled, []);
});

test('반영 후보: registry에서 그 선사의 배 목록을 보고, 보고서에 같이 싣는다', () => {
  const results = [plaza({
    name: '홍원 레이디호', status: 'review-required', pages: [], media: [], remaining: [],
    evidence: [{ kind: 'departure', times: ['06시'], quote: '06시 출항', source: 'https://plaza.example/n/9', pageTitle: '안내' }],
  })];
  const proposals = researchProposals(results, [{ id: 'plaza', boats: { 레이디호: {}, 베니스호: {} } }]);
  assert.equal(proposals.length, 1);
  assert.ok(proposals[0].missing.includes('배 확인(2척)'), 'registry의 배 수를 봐야 압니다');

  const md = researchMarkdown(results, proposals);
  assert.match(md, /## registry 반영 후보/);
  assert.match(md, /막힘: 적용 기간 · 배 확인\(2척\)/);
  assert.match(md, /초안: \{"timeGuide"/);
});
