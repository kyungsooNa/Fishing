#!/usr/bin/env node
// 선사를 손으로 찾아 등록하는 대신, 후보 주소를 자동으로 모아 시험 수집까지 해봅니다.
//
//   node discover.js ct sunsang24.com          인증서 로그(crt.sh)에서 서브도메인 후보를 뽑습니다
//   node discover.js wayback sunsang24.com     웹 아카이브가 긁어둔 주소에서 서브도메인을 뽑습니다
//   node discover.js links <주소>               페이지의 바깥 링크에서 후보 도메인을 뽑습니다
//                                              (플랫폼 고객사 목록·지역 낚시 포털에 씁니다)
//   node discover.js probe <주소...>            후보를 어댑터로 실제 돌려보고 등록 조각을 만듭니다
//   node discover.js probe --from tmp/candidates.json
//   node discover.js probe --from ... --add     통과한 후보를 sites/registry.json에 붙입니다
//
// 왜 이렇게 나눠뒀냐: "주소 목록을 어디서 얻느냐"는 소스마다 다르고 자주 바뀌지만,
// "이 주소가 우리 어댑터로 읽히느냐"는 어디서 왔든 똑같습니다. 뒷부분만 확실하면
// 앞부분은 아무거나 갖다 붙여도 됩니다.
//
// 자동으로 채운 값을 그대로 믿지 않습니다. 특히 port/phone은 배를 합치는 신원이라
// (core/merge.js) 틀리면 다른 배가 한 줄로 붙습니다. 그래서 라벨이 붙어 명확할 때만
// 채우고, 애매하면 note에 후보만 적어 사람이 고르게 둡니다.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { fetchHtml, closeBrowser, describeError } from './core/fetcher.js';
import { loadRegistry, collectSite, REGISTRY_PATH } from './core/runner.js';
import { looksLikePort } from './core/ports.js';
import { tripTimeRange, toSpecies } from './core/schema.js';
import { SPECIES } from './adapters/_rows.js';

const CANDIDATES_PATH = 'tmp/candidates.json';

// ── 후보 모으기: 인증서 로그 ────────────────────────────────────────────────
//
// 선상24처럼 선사마다 서브도메인을 하나씩 파주는 플랫폼은, 인증서를 발급할 때마다
// 그 이름이 공개 로그에 남습니다. 그래서 "이 플랫폼에 올라탄 선사 전부"를 사이트를
// 긁지 않고도 받아올 수 있습니다. 와일드카드 인증서만 쓰는 플랫폼에는 안 통합니다.
const CRT_URL = (domain) => `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;

// 선사가 아니라 플랫폼 자기 설비인 이름들. 시험 수집을 아껴줍니다.
const INFRA = /^(www|mail|smtp|pop|imap|webmail|ftp|ns\d*|dns\d*|cpanel|whm|admin|test|dev|stage|staging|api|app|service|cdn|static|assets|files|upload|media|img|image|vpn|autodiscover|_)/;

// 선사 하나에 해당하는 서브도메인인지. 소스가 뭐든 같은 잣대로 거릅니다.
function isShipHost(host, domain) {
  if (!host.endsWith(`.${domain}`) || host.includes('*') || host.includes(' ')) return false;
  const label = host.slice(0, -(domain.length + 1));
  return Boolean(label) && !label.includes('.') && !INFRA.test(label);
}

export function subdomainsFromCrt(rows, domain) {
  const out = new Set();
  for (const row of rows ?? []) {
    for (const raw of String(row?.name_value ?? '').split('\n')) {
      const host = raw.trim().toLowerCase().replace(/\.$/, '');
      if (isShipHost(host, domain)) out.add(host);
    }
  }
  return [...out].sort();
}

// ── 후보 모으기: 웹 아카이브 ────────────────────────────────────────────────
//
// 인증서 로그는 플랫폼이 와일드카드 인증서(*.sunsang24.com) 하나만 쓰면 아무것도
// 못 줍니다 — 실제로 선상24가 그렇습니다(후보 3곳, 전부 플랫폼 설비였습니다).
// 웹 아카이브는 인증서가 아니라 "실제로 돌아다닌 주소"를 모아두기 때문에, 같은
// 플랫폼이라도 선사 서브도메인이 그대로 남아 있습니다. 국내 도메인이 막힌 데서도
// archive.org는 닿습니다.
const CDX_URL = (domain) =>
  `https://web.archive.org/cdx/search/cdx?url=*.${encodeURIComponent(domain)}` +
  '&output=json&fl=original&collapse=urlkey&limit=50000';

// CDX는 첫 줄이 머리글인 배열의 배열입니다: [["original"], ["http://akbari.sunsang24.com/..."], ...]
export function hostsFromCdx(rows, domain) {
  const out = new Set();
  for (const row of rows ?? []) {
    const raw = Array.isArray(row) ? row[0] : row;
    if (!raw || raw === 'original') continue;      // 머리글
    let host;
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (isShipHost(host, domain)) out.add(host);
  }
  return [...out].sort();
}

async function fromWayback(domain) {
  // 아카이브는 붐비면 503/429를 돌려줍니다(실제로 한 번 받았습니다). 잠깐 쉬면 됩니다.
  // 뒤에 이어지는 시험 수집이 10분짜리라, 첫 요청 한 번 실패로 접기엔 아깝습니다.
  const res = await retrying(() =>
    fetch(CDX_URL(domain), {
      headers: { 'user-agent': 'fishing-board discover (+https://github.com)' },
      signal: AbortSignal.timeout(120_000),
    }),
  );
  return hostsFromCdx(await res.json(), domain).map((h) => `https://${h}`);
}

const RETRY_STATUS = [429, 500, 502, 503, 504];
const WAITS_MS = [10_000, 30_000, 60_000];

async function retrying(request) {
  let last;
  for (const [i, wait] of [...WAITS_MS, null].entries()) {
    try {
      const res = await request();
      if (res.ok) return res;
      last = new Error(`web.archive.org ${res.status}`);
      if (!RETRY_STATUS.includes(res.status)) throw last;
    } catch (err) {
      last = err;
      if (err.name === 'AbortError') throw err;   // 시간이 다 된 건 기다려도 같습니다
    }
    if (wait === null) break;
    console.warn(`  ${last.message} — ${wait / 1000}초 쉬고 다시 (${i + 1}/${WAITS_MS.length})`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw last;
}

async function fromCrt(domain) {
  const res = await fetch(CRT_URL(domain), {
    headers: { 'user-agent': 'fishing-board discover (+https://github.com)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`crt.sh ${res.status}`);
  return subdomainsFromCrt(await res.json(), domain).map((h) => `https://${h}`);
}

// ── 후보 모으기: 페이지 링크 ────────────────────────────────────────────────
//
// 플랫폼 고객사 목록이나 지역 낚시 포털 한 장에 선사 홈페이지 수십 개가 걸려 있습니다.
// 링크를 전부 가져오되, 어디에나 붙어 있는 포털·SNS는 뺍니다.
const NOT_A_SHIP = /(naver|daum|kakao|google|facebook|instagram|youtube|twitter|tistory|blogspot|band\.us|t\.me|wikipedia|apple|microsoft|adobe|w3\.org|schema\.org|jquery|bootstrap|gstatic|cloudflare)/;

export function linksFrom(html, base) {
  const $ = cheerio.load(html);
  const baseHost = safeHost(base);
  const hosts = new Set();

  $('a[href]').each((_, el) => {
    let url;
    try {
      url = new URL($(el).attr('href'), base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) return;
    const host = url.hostname.toLowerCase();
    if (!host || host === baseHost || NOT_A_SHIP.test(host)) return;
    hosts.add(host);
  });

  return [...hosts].sort().map((h) => `https://${h}`);
}

async function fromLinks(url) {
  return linksFrom(await fetchHtml(url, { mode: 'auto' }), url);
}

// ── 시험 수집 ───────────────────────────────────────────────────────────────
//
// 주소만 있고 계열을 모르는 상태에서 시작합니다. 호스트로 알 수 있으면 그 어댑터
// 하나만, 모르면 흔한 순서(더피싱 예약모듈 → 자체 사이트)로 돌려봅니다. 요청이
// 아깝지만 후보 하나당 한 번뿐이고, 성공하면 거기서 멈춥니다.
export function adapterPlan(url) {
  const host = safeHost(url);
  const origin = originOf(url);

  if (host.endsWith('.sunsang24.com')) return [{ adapter: 'sunsang24', url: origin, mode: 'static' }];
  if (host.endsWith('.thefishing.kr')) return [{ adapter: 'thefishing', url: `${origin}/index.php?mid=bk` }];

  return [
    { adapter: 'thefishing', url: `${origin}/m/index.php?mid=bk` },
    { adapter: 'thefishing', url: `${origin}/index.php?mid=bk` },
    { adapter: 'generic', url, mode: 'auto' },
  ];
}

// 어댑터는 배 이름을 못 읽으면 site.name으로 대신합니다. 시험 수집에는 진짜 이름이
// 없으므로, 그 대체값이 배 이름으로 registry에 실리면 안 됩니다("probe호"가 아니라
// 아예 "probe"라는 배가 생겼습니다). 눈에 띄는 값을 넣고 나중에 걸러냅니다.
const PLACEHOLDER = '(이름미상)';

/**
 * days를 짧게 잡는 이유: 여기서 알고 싶은 건 "이 주소가 우리 어댑터로 읽히느냐"
 * 하나뿐입니다. 그런데 더피싱 상세 방식은 날짜마다 요청을 하나씩 보내고 호스트당
 * 3초를 쉬므로, 7일치면 사이트 하나에 20초가 넘습니다(242곳이면 한 시간이 넘습니다).
 * 이틀이면 읽히는지 아닌지는 똑같이 알 수 있습니다. 실제 수집은 registry에 올라간
 * 뒤 collect.js가 제 날짜 수(21일)로 합니다.
 */
export async function probe(url, { days = 2 } = {}) {
  const tried = [];

  for (const plan of adapterPlan(url)) {
    try {
      const trips = await collectSite({ id: 'probe', name: PLACEHOLDER, days, ...plan });
      if (trips.length) {
        return { source: url, ok: true, ...plan, count: trips.length, boats: boatsOf(trips), tried };
      }
      tried.push({ ...plan, error: '0건' });
    } catch (err) {
      tried.push({ ...plan, error: describeError(err).slice(0, 120) });
    }
  }

  return { source: url, ok: false, tried };
}

function boatsOf(trips) {
  const names = new Set();
  for (const t of trips) {
    // "(이름미상)", "(이름미상) 오전배"처럼 대체값이 섞여 나옵니다. 배 이름이 아닙니다.
    if (t.boat && !t.boat.startsWith(PLACEHOLDER)) names.add(t.boat);
  }
  return [...names].slice(0, 12);
}

// ── 신원(항구·전화) 추정 ────────────────────────────────────────────────────
//
// merge.js가 이름·출항지·전화번호 셋으로 같은 배를 알아보므로, 여기서 잘못 채우면
// 다른 배가 한 줄로 붙습니다. 그래서 "출항지 : ○○항"처럼 라벨이 붙어 있고 답이
// 하나일 때만 값으로 씁니다. 여러 개면 값을 비우고 후보만 돌려줘 사람이 고릅니다.
const PHONE = /\b(01[016-9]|0[2-6]\d?|070|080)[-.)\s]?\d{3,4}[-.\s]?\d{4}\b/g;

export function pickPhone(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(PHONE)) found.add(m[0].replace(/[.\s)]/g, '-').replace(/-+/g, '-'));
  const list = [...found];
  return { value: list.length === 1 ? list[0] : null, candidates: list.slice(0, 5) };
}

export function pickPort(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const labeled = new Set();
  for (const m of t.matchAll(/(?:출항지|출항항|승선장|출발지)\s*[:：]?\s*([가-힣A-Za-z0-9 ]{2,20}?항)/g)) {
    // 라벨이 붙었어도 잡힌 말이 "안전운항"이면 항구가 아닙니다. 라벨로 찾은 값은
    // registry에 그대로 실려 신원이 되므로(core/merge.js) 여기서 한 번 더 봅니다.
    const found = m[1].trim();
    if (looksLikePort(found)) labeled.add(found);
  }
  const list = [...labeled];
  if (list.length) return { value: list.length === 1 ? list[0] : null, candidates: list };

  // 라벨이 없으면 본문에 나온 "○○항"을 후보로만 모읍니다. 값으로는 쓰지 않습니다.
  //
  // 한글에는 \b 단어경계가 없고, 뒤에 한글이 오면 끊는 방식(?![가-힣])도 못 씁니다 —
  // "남당항에서"의 조사까지 걸러버립니다. 그래서 끊지 않고 뽑은 다음, 항구가 아닌
  // 낱말만 이름으로 버립니다(`core/ports.js`의 `looksLikePort`). 어차피 note에 적어
  // 사람이 고르는 후보입니다.
  const loose = new Set();
  for (const m of t.matchAll(/[가-힣]{2,6}항/g)) {
    if (looksLikePort(m[0])) loose.add(m[0]);
  }
  return { value: null, candidates: [...loose].slice(0, 5) };
}

/**
 * 못 받은 것과 받았는데 안 적혀 있는 것은 다릅니다. 앞은 다시 돌리면 되고 뒤는 사람이
 * 페이지를 봐야 합니다. 값이 없다는 것만 돌려주면 이 둘이 한 줄로 보여서, 상대가
 * 막고 있는 판에 "51곳 전부 페이지에 안 적혀 있음"이라고 읽게 됩니다.
 */
async function identity(url) {
  try {
    const html = await fetchHtml(originOf(url), { mode: 'static', retries: 0 });
    const text = cheerio.load(html)('body').text();
    return { phone: pickPhone(text), port: pickPort(text) };
  } catch (err) {
    return {
      phone: { value: null, candidates: [] },
      port: { value: null, candidates: [] },
      error: describeError(err),
    };
  }
}

// ── 등록된 선사의 항구 다시 읽기 ────────────────────────────────────────────
//
// 항구는 사람이 registry에 적는 값입니다(`core/merge.js`의 신원). 그래서 저절로 채워지지
// 않는데, 지금 배 473척 중 항구가 없는 것이 256척입니다. 손으로 채우려면 선사 페이지를
// 하나씩 열어야 하고, 개발 환경에서는 국내 도메인이 막혀 열 수조차 없습니다.
// 러너는 닿으므로 Actions에서 돌립니다 — peek·discover와 같은 이유입니다.
//
// **순서가 곧 이 기능입니다.** 항구가 빈 곳을 id 순으로 훑으면 지금 당장 손해를 보는 곳이
// 뒤에 묻힙니다. 지금 손해란 "같은 배가 현황판에 두 줄로 떠 있는 것"이고, 그건
// `core/quality.js`가 이미 세고 있습니다(`portHints` — 합치기가 막힌 곳만 추립니다).
// 그다음은 출조가 많은 곳입니다. 한 곳을 채워 여러 줄이 고쳐지는 순서입니다.
export function portTargets(registry, quality) {
  const blocked = new Map((quality?.portHints ?? []).map((row, rank) => [row.siteId, rank]));
  const trips = new Map((quality?.sites ?? []).map((row) => [row.key, row.trips]));

  return registry
    .filter((site) => site.enabled !== false && !site.port && site.url)
    // boats에 배별 항구를 적어둔 곳은 사이트에 port가 없어도 채워진 것입니다.
    .filter((site) => !Object.values(site.boats ?? {}).some((boat) => boat?.port))
    .map((site) => ({
      id: site.id, url: site.url, name: site.name ?? site.id,
      blocked: blocked.has(site.id), rank: blocked.get(site.id) ?? Infinity,
      trips: trips.get(site.id) ?? 0,
    }))
    .sort((a, b) => a.rank - b.rank || b.trips - a.trips || a.id.localeCompare(b.id));
}

/** 다시 읽은 결과를 registry에 반영합니다. 라벨이 붙어 답이 하나인 것만 값이 됩니다. */
export function applyPorts(parsed, found) {
  const sites = Array.isArray(parsed) ? parsed : (parsed.sites ?? []);
  const byId = new Map(sites.map((site) => [site.id, site]));
  const filled = [];

  for (const row of found) {
    const site = byId.get(row.id);
    // 이미 채워진 곳은 건드리지 않습니다 — 사람이 고쳐둔 값을 덮어쓰면 안 됩니다.
    if (!site || site.port || !row.port) continue;
    site.port = row.port;
    site.note = [site.note, `출항지 ${row.port} — 페이지의 라벨에서 읽었습니다(discover ports). 확인하세요.`]
      .filter(Boolean).join(' ');
    filled.push(row.id);
  }
  return filled;
}

// ── registry 조각 ───────────────────────────────────────────────────────────
export function idFor(url, taken = new Set()) {
  const host = safeHost(url);
  const base =
    (host.endsWith('.sunsang24.com') ? host.split('.')[0] : host.replace(/^www\./, '').split('.')[0])
      .replace(/[^a-z0-9]/g, '') || 'site';

  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}${i}`;
  return id;
}

export function entryFor(result, { id, phone, port } = {}) {
  const guesses = [
    port?.value ? null : port?.candidates?.length ? `출항지 후보: ${port.candidates.join(', ')}` : null,
    phone?.value ? null : phone?.candidates?.length ? `전화 후보: ${phone.candidates.join(', ')}` : null,
  ].filter(Boolean);

  return {
    id: id ?? idFor(result.url ?? result.source),
    name: result.boats?.[0] ?? id ?? safeHost(result.url ?? result.source),
    // boats가 비면 배 이름을 페이지에서 못 읽은 겁니다 — 사람이 채워야 합니다.
    adapter: result.adapter,
    url: result.url,
    ...(port?.value ? { port: port.value } : {}),
    ...(phone?.value ? { phone: phone.value } : {}),
    ...(result.mode ? { mode: result.mode } : {}),
    // 더피싱은 메인 요약표를 JS로 그려서 정적 요청으로는 안 보입니다(peek으로 확인).
    // 적어두지 않으면 수집할 때마다 헛된 요청을 한 번씩 더 보냅니다.
    ...(result.adapter === 'thefishing' ? { source: 'detail' } : {}),
    enabled: true,
    // 손으로 넣은 것과 구분합니다. 관리 화면이 이걸로 "수동/자동"을 나눠 보여줍니다.
    addedBy: 'discover',
    ...(result.boats?.length ? { boats: Object.fromEntries(result.boats.map((b) => [b, {}])) } : {}),
    note: [
      `자동 발견(${result.source}) — 시험 수집 ${result.count}건.`,
      result.boats?.length ? null : '배 이름을 페이지에서 못 읽었습니다 — boats를 채우세요.',
      '이름·출항지·전화번호는 확인하고 고치세요 — 셋이 다 맞아야 다른 사이트의 같은 배와 합쳐집니다.',
      ...guesses,
    ].filter(Boolean).join(' '),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const args = rest.filter((a) => !a.startsWith('--'));
const has = (f) => flags.includes(f);
const valueOf = (f) => {
  const i = rest.indexOf(f);
  return i >= 0 ? rest[i + 1] : null;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (err) {
    console.error(`실패: ${describeError(err)}`);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
}

async function main() {
  if (cmd === 'ct') return list(await fromCrt(need(args[0], '도메인을 적으세요 (예: sunsang24.com)')));
  if (cmd === 'wayback') return list(await fromWayback(need(args[0], '도메인을 적으세요 (예: sunsang24.com)')));
  if (cmd === 'links') return list(await fromLinks(need(args[0], '주소를 적으세요')));
  if (cmd === 'probe') return probeAll();
  if (cmd === 'ports') return portsAll();
  if (cmd === 'times') return timesAll();
  usage();
}

function usage() {
  console.log(`후보를 모으고 시험 수집합니다.

  node discover.js ct <도메인>        인증서 로그에서 서브도메인 후보
  node discover.js wayback <도메인>    웹 아카이브에 남은 서브도메인 후보
  node discover.js links <주소>        페이지 링크에서 후보 도메인
  node discover.js probe <주소...>     후보를 어댑터로 돌려보기
  node discover.js probe --from ${CANDIDATES_PATH}
  node discover.js probe ... --add     통과한 후보를 ${REGISTRY_PATH}에 붙이기
  node discover.js ports              항구가 빈 등록 선사를 다시 읽기 (급한 곳부터)
  node discover.js ports --add        라벨로 찾은 값만 ${REGISTRY_PATH}에 채우기
  node discover.js times              출항시각이 빈 선사의 공지에서 시각 후보 읽기 (많이 빈 곳부터)
`);
  process.exitCode = 1;
}

// 모은 후보는 파일로 남깁니다. 모으는 것과 시험하는 것을 다른 실행에서 해야
// (막힌 환경에서 모으고 러너에서 시험하는 식으로) 쓸 수 있습니다.
async function list(urls) {
  const known = new Set((await loadRegistry()).map((s) => safeHost(s.url)));
  const fresh = urls.filter((u) => !known.has(safeHost(u)));

  console.log(`후보 ${urls.length}곳 (이미 등록된 곳 ${urls.length - fresh.length}곳 제외 → ${fresh.length}곳)\n`);
  for (const u of fresh) console.log(`  ${u}`);

  await mkdir('tmp', { recursive: true });
  await writeFile(CANDIDATES_PATH, `${JSON.stringify(fresh, null, 2)}\n`);
  console.log(`\n${CANDIDATES_PATH} 에 적었습니다. 시험 수집: node discover.js probe --from ${CANDIDATES_PATH}`);
}

async function probeAll() {
  const from = valueOf('--from');
  const urls = from ? JSON.parse(await readFile(from, 'utf8')) : args;
  if (!urls.length) return usage();

  const limit = Number(valueOf('--limit') ?? urls.length);
  // 상대가 우리를 막으면 전부 같은 이유로 실패합니다. 더피싱 242곳이 첫 요청부터
  // 끝까지 시간초과로 떨어지는 걸 40분 동안 지켜본 적이 있습니다. 그럴 땐 멈춥니다.
  const GIVE_UP_AFTER = 15;
  let streak = 0;
  const registry = await loadRegistry();
  const known = new Set(registry.map((s) => safeHost(s.url)));
  const taken = new Set(registry.map((s) => s.id));
  const found = [];

  for (const url of urls.slice(0, limit)) {
    if (known.has(safeHost(url))) {
      console.log(`- ${url} — 이미 등록됨`);
      continue;
    }

    const result = await probe(url);
    if (!result.ok) {
      console.log(`✗ ${url} — ${result.tried.map((t) => `${t.adapter}:${t.error}`).join(' / ')}`);
      if (++streak >= GIVE_UP_AFTER) {
        console.log(
          `\n연속 ${streak}곳이 실패했습니다. 상대가 막고 있는 것으로 보고 멈춥니다 — ` +
            '시간을 두고 다시 돌리세요(간격은 core/fetcher.js의 MIN_GAP_MS).',
        );
        break;
      }
      continue;
    }
    streak = 0;

    const id = idFor(result.url, taken);
    taken.add(id);
    const entry = entryFor(result, { id, ...(await identity(result.url)) });
    found.push(entry);
    console.log(`✓ ${url} [${result.adapter}] ${result.count}건 — ${result.boats.join(', ') || '배 이름 미상'}`);
  }

  console.log(`\n읽히는 후보 ${found.length}곳`);
  if (!found.length) return;

  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/found.json', `${JSON.stringify(found, null, 2)}\n`);
  console.log('tmp/found.json 에 registry 조각을 적었습니다.');

  if (has('--add')) {
    await addToRegistry(found);
    console.log(`${REGISTRY_PATH} 에 ${found.length}곳을 붙였습니다. diff를 보고 이름·출항지·전화번호를 고치세요.`);
  }
}

// 통째로 다시 쓰지 않고 sites 배열에만 덧붙입니다. $comment 같은 다른 키를 잃지 않도록.
/**
 * 항구가 빈 선사를 급한 곳부터 다시 읽습니다. 값으로 쓰는 것은 **라벨이 붙어 답이 하나일
 * 때뿐**이고(`pickPort`), 나머지는 후보만 적어 사람이 고르게 둡니다 — 항구는 신원이라
 * 잘못 채우면 다른 배가 한 줄로 붙습니다(`core/merge.js`).
 */
async function portsAll() {
  const limit = Number(valueOf('--limit') ?? 30);
  const registry = await loadRegistry();
  // data.json이 있으면 "지금 두 줄로 뜨는 곳"을 앞에 둡니다. 없으면 출조 수를 모르므로
  // id 순이 되는데, 그래도 도는 데는 지장이 없습니다.
  const quality = await portQuality(registry);
  const targets = portTargets(registry, quality);

  console.log(`항구가 빈 선사 ${targets.length}곳`
    + ` (지금 두 줄로 뜨는 곳 ${targets.filter((t) => t.blocked).length}곳) — 앞에서 ${Math.min(limit, targets.length)}곳을 봅니다\n`);

  const found = [];
  for (const target of targets.slice(0, limit)) {
    const mark = target.blocked ? '!' : ' ';
    const { port, error } = await identity(target.url);
    found.push({ ...target, port: port.value, candidates: port.candidates, ...(error ? { error } : {}) });

    if (error) console.log(`${mark} ${target.id.padEnd(16)} 못 받았습니다: ${error.slice(0, 80)}`);
    else if (port.value) console.log(`${mark} ${target.id.padEnd(16)} ${port.value}  ← 라벨에서 읽음`);
    else if (port.candidates.length) console.log(`${mark} ${target.id.padEnd(16)} 후보: ${port.candidates.join(' · ')}`);
    else console.log(`${mark} ${target.id.padEnd(16)} 못 찾았습니다 — 페이지에 안 적혀 있거나 그림입니다`);
  }

  const values = found.filter((row) => row.port);
  const failed = found.filter((row) => row.error);
  console.log(`\n라벨로 값을 찾은 곳 ${values.length} / 후보만 있는 곳 ${found.filter((r) => !r.error && !r.port && r.candidates.length).length}`
    + ` / 페이지에 없는 곳 ${found.filter((r) => !r.error && !r.port && !r.candidates.length).length}`
    + ` / 못 받은 곳 ${failed.length}`);
  if (failed.length === found.length && found.length) {
    console.log('전부 못 받았습니다 — 여기서는 국내 도메인이 막혀 있습니다. Actions 탭 → ports 로 돌리세요.');
  }
  console.log('! 표시가 지금 현황판에 두 줄로 뜨고 있는 곳입니다.');

  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/ports.json', `${JSON.stringify(found, null, 2)}\n`);
  console.log('tmp/ports.json 에 후보까지 전부 적었습니다.');

  if (!has('--add')) return console.log(`\n${REGISTRY_PATH}에 채우려면 --add 를 붙이세요.`);
  if (!values.length) return console.log('\n채울 값이 없습니다.');

  const parsed = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
  const filled = applyPorts(parsed, values);
  await writeFile(REGISTRY_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`\n${REGISTRY_PATH} 에 ${filled.length}곳을 채웠습니다: ${filled.join(', ')}`);
  console.log('머지 전에 페이지와 맞춰보세요 — 항구는 다른 사이트의 같은 배와 합칠지를 정하는 값입니다.');
}

// ── 등록된 선사의 출항시각 후보 모으기 ──────────────────────────────────────
//
// 출항시각은 어댑터가 예약판에서 읽는 값인데, **예약판에 아예 안 적힌 사이트가 91곳**
// (2,827건)입니다(`core/quality.js`의 `timeGaps`). 거기는 파서를 고쳐도 안 채워집니다.
// 대신 선사 홈페이지 공지에는 "2026년 쭈/갑 출항시간 새벽 5:30"처럼 적혀 있는 곳이 있고,
// 지금 registry의 `timeGuide` 4곳이 그렇게 사람이 읽어 넣은 값입니다.
//
// 그 읽는 일을 여기서 돕습니다. **값으로 채우지는 않습니다** — timeGuide는 시각만이 아니라
// 어느 어종에 언제까지 유효한지까지 적어야 하는 값이라(`core/schema.js`의 makeTrip),
// 공지 한 줄에서 기계가 정할 수 없습니다. 후보 줄을 그대로 보여주고 사람이 고릅니다.
// 로그에 줄을 그대로 찍는 이유도 그것입니다 — 국내 도메인이 막힌 곳에서는 아티팩트를
// 내려받지 못하고 Actions 로그로만 봅니다(peek과 같은 사정).

/** 공지에서 출항시각처럼 보이는 줄만 추립니다. 값이 아니라 **후보**입니다. */
export function timeHints(html, limit = 5) {
  const bare = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const lines = bare.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ')
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const seen = new Map();
  for (const line of lines) {
    if (!/출항|출조\s*시간|운항\s*시간/.test(line)) continue;
    // 시각을 못 읽는 줄은 후보가 아닙니다("출항 문의는 전화로"). 버스·집결·입금 시각도
    // tripTimeRange가 이미 거릅니다 — 후보라도 그건 배가 뜨는 시각이 아닙니다.
    const { from, to } = tripTimeRange(line);
    if (!from) continue;
    const key = `${from}|${to}|${line.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      departAt: from,
      returnAt: to,
      // timeGuide는 어종을 적어야 걸립니다. 줄에 어종이 있으면 같이 보여줍니다.
      species: SPECIES.filter((name) => line.includes(name)).map(toSpecies).filter(Boolean),
      line: line.slice(0, 160),
    });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/**
 * 어디부터 볼까. **많이 빈 곳부터**입니다 — 한 곳에 timeGuide 한 줄을 적으면 그 선사의
 * 출조가 통째로 채워집니다(ssfish 161건 · yamujin 132건).
 *
 * 이미 timeGuide가 있는 곳은 뺍니다. 배별로 적어둔 곳(`boats`)도 마찬가지입니다.
 */
export function timeTargets(registry, quality) {
  const byId = new Map(registry.map((site) => [site.id, site]));
  const gaps = quality?.time;
  const rows = gaps
    ? [
      ...gaps.none.map((row) => ({ ...row, why: '예약판에 없음' })),
      ...gaps.byBoat.map((row) => ({ ...row, why: '배마다 갈림' })),
      ...gaps.byDate.map((row) => ({ ...row, why: '날짜마다 갈림' })),
    ]
    : registry.map((site) => ({ id: site.id, missing: 0, why: '수집 결과 없음' }));

  return rows
    .map((row) => ({ ...row, site: byId.get(row.id) }))
    .filter(({ site }) => site && site.enabled !== false && site.url)
    .filter(({ site }) => !site.timeGuide && !Object.values(site.boats ?? {}).some((boat) => boat?.timeGuide))
    .map(({ site, ...row }) => ({ ...row, url: site.url, name: site.name ?? site.id }))
    .sort((a, b) => b.missing - a.missing || a.id.localeCompare(b.id));
}

async function timesAll() {
  const limit = Number(valueOf('--limit') ?? 30);
  const registry = await loadRegistry();
  const quality = await portQuality(registry);
  const targets = timeTargets(registry, quality);

  console.log(`출항시각이 빈 선사 ${targets.length}곳 — 많이 빈 곳부터 ${Math.min(limit, targets.length)}곳을 봅니다`);
  console.log('공지에서 시각처럼 보이는 줄만 찍습니다. 값이 아니라 후보라, registry에는 사람이 적습니다.\n');

  const found = [];
  for (const target of targets.slice(0, limit)) {
    let hints = [], error = null;
    try {
      hints = timeHints(await fetchHtml(originOf(target.url), { mode: 'static', retries: 0 }));
    } catch (err) {
      error = describeError(err);
    }
    found.push({ ...target, hints, ...(error ? { error } : {}) });

    const head = `${target.id.padEnd(16)} ${String(target.missing).padStart(4)}건  ${target.why}`;
    if (error) console.log(`${head}  못 받았습니다: ${error.slice(0, 60)}`);
    else if (!hints.length) console.log(`${head}  공지에도 없습니다`);
    else {
      console.log(head);
      for (const hint of hints) {
        const span = hint.returnAt ? `${hint.departAt}~${hint.returnAt}` : hint.departAt;
        console.log(`    ${span}  ${hint.species.join('·') || '어종 없음'}  | ${hint.line}`);
      }
    }
  }

  const withHints = found.filter((row) => row.hints.length);
  const failed = found.filter((row) => row.error);
  console.log(`\n후보가 나온 곳 ${withHints.length} / 공지에도 없는 곳 ${found.length - withHints.length - failed.length}`
    + ` / 못 받은 곳 ${failed.length}`);
  if (failed.length === found.length && found.length) {
    console.log('전부 못 받았습니다 — 여기서는 국내 도메인이 막혀 있습니다. Actions 탭 → times 로 돌리세요.');
  }

  await mkdir('tmp', { recursive: true });
  await writeFile('tmp/times.json', `${JSON.stringify(found, null, 2)}\n`);
  console.log('tmp/times.json 에 후보까지 전부 적었습니다.');
  console.log('registry에 적을 때는 timeGuide에 departAt·species·validFrom·validThrough·source를 같이 적으세요');
  console.log('— 어느 어종에 언제까지 유효한지가 없으면 다음 시즌에 틀린 시각이 남습니다.');
}

/** 수집 결과가 있으면 "지금 두 줄로 뜨는 곳"을 알 수 있습니다. 없으면 순서만 거칠어집니다. */
async function portQuality(registry) {
  try {
    const { collectQuality } = await import('./core/quality.js');
    const { load } = await import('./core/store.js');
    return collectQuality(registry, await load());
  } catch {
    return null;
  }
}

async function addToRegistry(entries) {
  const parsed = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
  if (Array.isArray(parsed)) parsed.push(...entries);
  else parsed.sites = [...(parsed.sites ?? []), ...entries];
  await writeFile(REGISTRY_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
}

function need(value, message) {
  if (!value) {
    console.error(message);
    process.exit(1);
  }
  return value;
}

function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
