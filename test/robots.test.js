// robots.txt 해석. 잘못 읽으면 두 가지로 틀립니다 — 받아도 되는 것을 안 받거나(커버리지가
// 줄고), 받지 말라는 것을 받거나(그쪽이 더 나쁩니다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, groupFor, isAllowed } from '../core/robots.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36';

test('그룹과 사이트맵을 읽는다', () => {
  const r = parseRobots(`
    # 주석
    User-agent: *
    Disallow: /admin
    Allow: /admin/public
    Crawl-delay: 5

    Sitemap: https://x.example/sitemap.xml
  `);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].agents, ['*']);
  assert.equal(r.groups[0].crawlDelay, 5);
  assert.deepEqual(r.sitemaps, ['https://x.example/sitemap.xml']);
});

test('연달아 적힌 User-agent는 한 그룹이다', () => {
  const r = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x\n\nUser-agent: c\nDisallow: /y');
  assert.equal(r.groups.length, 2);
  assert.deepEqual(r.groups[0].agents, ['a', 'b']);
  assert.deepEqual(r.groups[1].agents, ['c']);
});

// 섞어 적용하면 안 됩니다. 이름이 맞는 그룹 하나만 봅니다.
test('이름이 가장 길게 맞는 그룹 하나만 적용한다', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: chrome\nDisallow: /admin');
  assert.deepEqual(groupFor(r, UA).agents, ['chrome']);
  assert.equal(isAllowed(r, UA, '/ship/schedule').allowed, true, '내 그룹에는 그 금지가 없습니다');
  assert.equal(isAllowed(r, '다른봇', '/ship/schedule').allowed, false, '이름이 안 맞으면 * 그룹입니다');
});

test('경로가 긴 규칙이 이기고, 같으면 Allow가 이긴다', () => {
  const r = parseRobots('User-agent: *\nDisallow: /ship\nAllow: /ship/schedule_fleet');
  assert.equal(isAllowed(r, UA, '/ship/schedule_fleet').allowed, true);
  assert.equal(isAllowed(r, UA, '/ship/other').allowed, false);

  const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a');
  assert.equal(isAllowed(tie, UA, '/a').allowed, true);
});

test('빈 Disallow는 전부 허용이다', () => {
  const r = parseRobots('User-agent: *\nDisallow:');
  assert.equal(isAllowed(r, UA, '/무엇이든').allowed, true);
});

test('*와 $를 읽는다', () => {
  const star = parseRobots('User-agent: *\nDisallow: /*.pdf$');
  assert.equal(isAllowed(star, UA, '/a/b.pdf').allowed, false);
  assert.equal(isAllowed(star, UA, '/a/b.pdf?x=1').allowed, true, '$는 끝을 뜻합니다');
  assert.equal(isAllowed(star, UA, '/a/bpdf').allowed, true);
});

test('규칙이 하나도 안 맞으면 허용이다 — robots는 금지 목록입니다', () => {
  const r = parseRobots('User-agent: *\nDisallow: /admin');
  assert.equal(isAllowed(r, UA, '/ship/schedule_fleet').allowed, true);
  assert.equal(isAllowed(r, UA, '/ship/schedule_fleet').rule, null);
});

test('판단의 근거를 같이 돌려준다 — 문서에 그대로 적으려고요', () => {
  const r = parseRobots('User-agent: *\nDisallow: /admin\nCrawl-delay: 10');
  const got = isAllowed(r, UA, '/admin/x');
  assert.equal(got.allowed, false);
  assert.deepEqual(got.rule, { allow: false, path: '/admin' });
  assert.equal(got.crawlDelay, 10);
});

test('빈 파일·이상한 줄에도 죽지 않는다', () => {
  for (const bad of ['', null, undefined, '아무 말\n:::\nDisallow: /x']) {
    const r = parseRobots(bad);
    assert.equal(isAllowed(r, UA, '/').allowed, true, '그룹이 없으면 제한도 없습니다');
  }
});
