// 후보를 모으는 부분은 네트워크를 타지만, 판단하는 부분은 전부 순수 함수입니다.
// 잘못 판단하면 엉뚱한 주소를 등록하거나(요청 낭비) 남의 배를 한 줄로 합칩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { subdomainsFromCrt, hostsFromCdx, linksFrom, adapterPlan, pickPhone, pickPort, idFor, entryFor } from '../discover.js';

test('인증서 로그에서 선사 서브도메인만 추린다', () => {
  const rows = [
    { name_value: 'akbari.sunsang24.com\nwww.akbari.sunsang24.com' },
    { name_value: '*.sunsang24.com' },              // 와일드카드는 이름이 아닙니다
    { name_value: 'mail.sunsang24.com' },           // 플랫폼 설비
    { name_value: 'nature.sunsang24.com' },
    { name_value: 'akbari.sunsang24.com' },         // 인증서를 갱신할 때마다 중복으로 나옵니다
    { name_value: 'sunsang24.com.evil.example' },   // 도메인이 다릅니다
  ];
  assert.deepEqual(subdomainsFromCrt(rows, 'sunsang24.com'), [
    'akbari.sunsang24.com',
    'nature.sunsang24.com',
  ]);
});

test('웹 아카이브가 긁어둔 주소에서 선사 서브도메인만 추린다', () => {
  // 인증서 로그가 와일드카드뿐이라 아무것도 못 줄 때 쓰는 소스입니다.
  // 첫 줄은 머리글이고, 같은 호스트가 수백 줄씩 반복됩니다.
  const rows = [
    ['original'],
    ['http://akbari.sunsang24.com/ship/schedule_fleet'],
    ['https://akbari.sunsang24.com/'],
    ['http://NATURE.sunsang24.com:80/ship/schedule_fleet'],
    ['http://assets.sunsang24.com/css/style.css'],   // 플랫폼 설비
    ['http://sunsang24.com/'],                       // 서브도메인이 아닙니다
    ['http://other.example.com/'],
    ['깨진 주소'],
  ];
  assert.deepEqual(hostsFromCdx(rows, 'sunsang24.com'), [
    'akbari.sunsang24.com',
    'nature.sunsang24.com',
  ]);
});

test('페이지 링크에서 바깥 도메인만 뽑는다', () => {
  const html = `
    <a href="/sub/page">내부</a>
    <a href="https://ssfish.kr/index.php?mid=bk">선사</a>
    <a href="http://blackpigho.kr/">선사</a>
    <a href="https://blog.naver.com/whatever">블로그</a>
    <a href="javascript:void(0)">스크립트</a>`;
  assert.deepEqual(linksFrom(html, 'https://portal.example/list'), [
    'https://blackpigho.kr',
    'https://ssfish.kr',
  ]);
});

test('호스트로 계열을 알면 그 어댑터만 시험한다', () => {
  const plan = adapterPlan('https://nature.sunsang24.com/ship/schedule_fleet');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].adapter, 'sunsang24');
  // 어댑터가 /ship/... 을 알아서 붙이므로 주소는 도메인까지만 넘깁니다.
  assert.equal(plan[0].url, 'https://nature.sunsang24.com');
});

test('계열을 모르면 흔한 순서로 시험한다', () => {
  assert.deepEqual(
    adapterPlan('https://example.kr/').map((p) => p.adapter),
    ['thefishing', 'thefishing', 'generic'],
  );
});

test('전화번호는 하나로 좁혀질 때만 값으로 쓴다', () => {
  assert.equal(pickPhone('예약문의 010-2495-2060 입니다').value, '010-2495-2060');
  // 둘이면 어느 쪽이 이 배 번호인지 모릅니다. 신원을 잘못 채우면 다른 배와 합쳐집니다.
  assert.equal(pickPhone('선장 010-1111-2222 사무실 041-333-4444').value, null);
  assert.deepEqual(pickPhone('선장 010-1111-2222 사무실 041-333-4444').candidates.length, 2);
});

test('출항지는 라벨이 붙어 있을 때만 값으로 쓴다', () => {
  assert.equal(pickPort('출항지 : 남당항 / 오시는길').value, '남당항');
  // 본문에 항 이름이 흩어져 있는 건 후보일 뿐입니다.
  const loose = pickPort('남당항에서 출발해 오천항 앞바다까지 갑니다');
  assert.equal(loose.value, null);
  assert.ok(loose.candidates.includes('남당항'));
});

test('id는 서브도메인에서 뽑고 겹치면 번호를 붙인다', () => {
  assert.equal(idFor('https://nature.sunsang24.com'), 'nature');
  assert.equal(idFor('https://www.ssfish.kr/index.php?mid=bk'), 'ssfish');
  assert.equal(idFor('https://nature.sunsang24.com', new Set(['nature'])), 'nature2');
});

test('배 이름을 못 읽었으면 boats를 비우고 그렇다고 적는다', () => {
  // 어댑터는 배 이름을 못 찾으면 site.name으로 대신합니다. 시험 수집에는 진짜 이름이
  // 없어서, 예전에는 "probe"라는 배가 registry에 실렸습니다.
  const entry = entryFor(
    { source: 'https://x.thefishing.kr', url: 'https://x.thefishing.kr/index.php?mid=bk', adapter: 'thefishing', count: 8, boats: [] },
    { id: 'x' },
  );
  assert.equal(entry.boats, undefined);
  assert.match(entry.note, /배 이름을 페이지에서 못 읽었습니다/);
});

test('등록 조각에는 확인이 필요하다는 표시가 남는다', () => {
  const entry = entryFor(
    { source: 'https://nature.sunsang24.com', url: 'https://nature.sunsang24.com', adapter: 'sunsang24', mode: 'static', count: 12, boats: ['네이처호'] },
    { id: 'nature', phone: { value: null, candidates: ['010-1111-2222', '041-333-4444'] }, port: { value: '남당항', candidates: ['남당항'] } },
  );
  assert.equal(entry.id, 'nature');
  assert.equal(entry.adapter, 'sunsang24');
  assert.equal(entry.addedBy, 'discover', '손으로 넣은 곳과 구분할 수 있어야 합니다');
  assert.equal(entry.port, '남당항');
  assert.equal(entry.phone, undefined);          // 애매한 값은 채우지 않습니다
  assert.deepEqual(Object.keys(entry.boats), ['네이처호']);
  assert.match(entry.note, /전화 후보/);
});
