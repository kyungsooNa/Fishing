// 후보를 모으는 부분은 네트워크를 타지만, 판단하는 부분은 전부 순수 함수입니다.
// 잘못 판단하면 엉뚱한 주소를 등록하거나(요청 낭비) 남의 배를 한 줄로 합칩니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { subdomainsFromCrt, hostsFromCdx, linksFrom, adapterPlan, pickPhone, pickPort, idFor, entryFor, portTargets, applyPorts } from '../discover.js';

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

// 본문에는 "○○항"으로 끝나는 말이 항구보다 훨씬 많습니다. 이걸 못 거르면 후보 목록이
// 공지사항·주의사항으로 덮여, 페이지를 열 곳을 좁혀주는 목록이 아니게 됩니다.
test('"항"으로 끝나기만 하는 말은 후보로 안 준다', () => {
  const found = pickPort('공지사항 주의사항입니다. 안전운항 하겠습니다. 출조항 안내 — 홍원항에서 뜹니다.');
  assert.deepEqual(found.candidates, ['홍원항']);
  assert.equal(found.value, null, '라벨이 없으면 후보일 뿐입니다');
});

// 라벨로 찾은 값은 registry에 그대로 실려 신원이 됩니다(core/merge.js).
// 잘못 실리면 다른 배가 한 줄로 붙으므로 여기서도 한 번 더 봅니다.
test('라벨이 붙었어도 항구가 아니면 값으로 안 쓴다', () => {
  const found = pickPort('출항지 : 안전운항');
  assert.equal(found.value, null);
  assert.deepEqual(found.candidates, []);
});

test('id는 서브도메인에서 뽑고 겹치면 번호를 붙인다', () => {
  assert.equal(idFor('https://nature.sunsang24.com'), 'nature');
  assert.equal(idFor('https://www.ssfish.kr/index.php?mid=bk'), 'ssfish');
  assert.equal(idFor('https://nature.sunsang24.com', new Set(['nature'])), 'nature2');
});

test('더피싱은 처음부터 detail로 적는다 — 요약표가 정적 요청에는 안 보입니다', () => {
  const entry = entryFor(
    { source: 'https://x.thefishing.kr', url: 'https://x.thefishing.kr/index.php?mid=bk', adapter: 'thefishing', count: 8, boats: ['엔젤피싱호'] },
    { id: 'x' },
  );
  assert.equal(entry.source, 'detail', '안 적으면 수집마다 헛된 요청이 한 번씩 더 갑니다');

  // 선상24는 해당 없습니다 — 목록형이 요청 한 번으로 한 달치를 줍니다.
  const sunsang = entryFor(
    { source: 'https://y.sunsang24.com', url: 'https://y.sunsang24.com', adapter: 'sunsang24', count: 26, boats: ['가나호'] },
    { id: 'y' },
  );
  assert.equal(sunsang.source, undefined);
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

// ── 항구 다시 읽기 ──────────────────────────────────────────────────────────
// 항구가 빈 선사가 239곳입니다. 어디부터 보느냐가 이 기능의 거의 전부입니다 — id 순으로
// 훑으면 지금 당장 두 줄로 뜨고 있는 곳이 뒤에 묻힙니다.
const quality = {
  portHints: [{ siteId: 'blocked2', hints: [] }, { siteId: 'blocked1', hints: ['오천항'] }],
  sites: [{ key: 'busy', trips: 300 }, { key: 'quiet', trips: 5 }, { key: 'blocked1', trips: 10 }],
};

test('두 줄로 뜨는 곳부터, 그다음은 출조가 많은 곳부터 본다', () => {
  const registry = [
    { id: 'quiet', url: 'https://q.example' },
    { id: 'busy', url: 'https://b.example' },
    { id: 'blocked1', url: 'https://b1.example' },
    { id: 'blocked2', url: 'https://b2.example' },
  ];

  assert.deepEqual(portTargets(registry, quality).map((t) => t.id), ['blocked2', 'blocked1', 'busy', 'quiet'],
    'quality가 매긴 순서를 그대로 씁니다 — 거기가 지금 손해를 세는 곳입니다');
  assert.deepEqual(portTargets(registry, quality).map((t) => t.blocked), [true, true, false, false]);
});

test('채워져 있거나 끈 곳, 주소 없는 곳은 보지 않는다', () => {
  const registry = [
    { id: 'has', url: 'https://a.example', port: '홍원항' },
    { id: 'off', url: 'https://b.example', enabled: false },
    { id: 'nourl', port: null },
    // 배마다 항구를 적어둔 곳은 사이트에 port가 없어도 채워진 것입니다(core/schema.js의 pickPort).
    { id: 'perboat', url: 'https://c.example', boats: { '가호': { port: '오천항' } } },
    { id: 'todo', url: 'https://d.example' },
  ];
  assert.deepEqual(portTargets(registry, null).map((t) => t.id), ['todo']);
});

test('수집 결과가 없어도 돌긴 돈다 — 순서만 거칠어집니다', () => {
  const registry = [{ id: 'b', url: 'https://b.example' }, { id: 'a', url: 'https://a.example' }];
  assert.deepEqual(portTargets(registry, null).map((t) => t.id), ['a', 'b']);
});

test('registry에는 라벨로 찾은 값만, 빈 곳에만 채운다', () => {
  const parsed = { sites: [{ id: 'a' }, { id: 'b', port: '이미있음' }, { id: 'c' }] };
  const filled = applyPorts(parsed, [
    { id: 'a', port: '오천항' },
    { id: 'b', port: '남당항' },      // 사람이 적어둔 값을 덮어쓰면 안 됩니다
    { id: 'c', port: null },          // 후보만 있는 곳은 값이 아닙니다
    { id: 'ghost', port: '홍원항' },  // registry에 없는 id
  ]);

  assert.deepEqual(filled, ['a']);
  assert.equal(parsed.sites[0].port, '오천항');
  assert.match(parsed.sites[0].note, /출항지 오천항 — 페이지의 라벨에서 읽었습니다/);
  assert.equal(parsed.sites[1].port, '이미있음');
  assert.equal(parsed.sites[2].port, undefined);
});

test('registry가 배열로 적혀 있어도 채운다', () => {
  const parsed = [{ id: 'a' }];
  assert.deepEqual(applyPorts(parsed, [{ id: 'a', port: '오천항' }]), ['a']);
  assert.equal(parsed[0].port, '오천항');
});
