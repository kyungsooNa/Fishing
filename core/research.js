// 공식 사이트 조사: 확정값이 아니라 적용 범위를 검토할 근거와 후속 작업을 모읍니다.
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { kstDate } from './when.js';
import { toTime, toTimeRange } from './schema.js';
import { priceHints } from '../discover.js';

export const FIELDS = ['departAt', 'returnAt', 'port', 'phone', 'species', 'price', 'seatsLeft', 'seatsTotal'];
const UNKNOWN = /선사\s*확인|전화\s*(?:문의|확인)|별도\s*(?:문의|안내)|추후\s*(?:공지|안내)|미정|미확인|미제공|정보\s*없음|확인\s*중|준비\s*중|문의\s*바랍니다|확인\s*필요|^(?:문의|상담|unknown)$/i;
const empty = (v) => v == null || /^(?:\s*|[-—?]+|null|N\/A)$/i.test(String(v).trim());

/** 데이터 누락과 화면 대체 문구, 원문 안내, 낡은 근거를 같이 조사합니다. */
export function researchTargets(registry, data, today = kstDate()) {
  const sites = new Map(registry.filter(s => s.enabled !== false && s.url).map(s => [s.id, s]));
  const rows = new Map();
  for (const t of data.trips ?? []) {
    if (t.date && t.date < today) continue;
    const site = sites.get(t.siteId);
    if (!site) continue;
    const row = rows.get(site.id) ?? { id: site.id, name: site.name, url: site.url, trips: 0, issues: new Map(), samples: [], boats: new Set() };
    rows.set(site.id, row);
    row.trips++;
    // 공지가 어느 배 이야기인지 맞춰보려면 배 이름을 알아야 합니다. registry에 적힌 것만
    // 보면 안 적어둔 선사(2026-09-16 기준 25곳·46척)에서는 아무 배도 못 알아봅니다.
    if (t.boat) row.boats.add(t.boat);
    const issues = [];
    for (const field of FIELDS) {
      // 마감/휴항의 잔여 숫자 빈칸은 미확인 좌석이 아닙니다. 0원·0석도 유효한 값입니다.
      if (field === 'seatsLeft' && ['off', 'closed'].includes(t.status)) continue;
      const value = t[field];
      if (empty(value) || UNKNOWN.test(String(value))) {
        const reason = empty(value) ? (['departAt', 'seatsLeft'].includes(field) ? '선사 확인(값 누락)' : '값 누락') : String(value);
        issues.push({ field, reason });
      }
    }
    if (UNKNOWN.test(t.statusText ?? '')) issues.push({ field: 'notice', reason: '원문에 확인·추후 안내 문구' });
    if (!t.status || t.status === 'unknown') issues.push({ field: 'status', reason: '예약 상태 미확인' });
    if (!t.departAt && /오전|오후|종일|야간/.test(t.session ?? '')) issues.push({ field: 'departAt', reason: '항차만 있고 시각 없음' });
    const boat = site.boats?.[t.boat] ?? {};
    const guides = [boat.timeGuide ?? site.timeGuide, ...(boat.priceGuides ?? site.priceGuides ?? [])].filter(Boolean);
    for (const guide of guides) {
      if (!guide.source || !guide.validFrom || !guide.validThrough || guide.validThrough < t.date) {
        issues.push({ field: 'guide', reason: !guide.source ? '근거 URL 없음' : !guide.validFrom || !guide.validThrough ? '적용 기간 없음' : '적용 기간 지남' });
      }
    }
    for (const issue of new Map(issues.map(i => [i.field + '|' + i.reason, i])).values()) {
      const key = issue.field + '|' + issue.reason;
      const item = row.issues.get(key) ?? { ...issue, count: 0 };
      item.count++;
      row.issues.set(key, item);
    }
    if (issues.length && row.samples.length < 12) row.samples.push({ boat: t.boat, date: t.date, species: t.species, url: t.url });
  }
  return [...rows.values()].filter(r => r.issues.size).map(r => {
    const issues = [...r.issues.values()];
    r.boats = [...r.boats].sort((a, b) => a.localeCompare(b, 'ko'));
    // 매일 달라지는 날짜·건수 대신 미확인 항목과 등록 근거가 바뀔 때 재조사합니다.
    const fingerprint = createHash('sha256').update(JSON.stringify([issues.map(i => [i.field, i.reason]).sort(), sites.get(r.id)])).digest('hex');
    return { ...r, issues, fingerprint, priority: issues.reduce((n, i) => n + i.count, 0) };
  }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function dueForResearch(target, previous, now = Date.now(), cooldownHours = 168) {
  if (!previous || previous.fingerprint !== target.fingerprint) return true;
  const hours = previous.status === 'failed' ? 6 : cooldownHours;
  return now - Date.parse(previous.checkedAt) >= hours * 3600000 || !Number.isFinite(Date.parse(previous.checkedAt));
}

const relevant = /공지|안내|출항|출조|운항|승선|선비|요금|집결|오시는|선박|배\s*소개|notice|guide/i;
const attachment = /\.(?:png|jpe?g|webp|gif|heic|pdf)(?:$|[?#])|(?:procFileDownload|fileDownload|action\.download)/i;
const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const clock = /(?:오전\s*|오후\s*|새벽\s*)?\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분)?)/g;

function pageKey(raw) {
  const u = new URL(raw);
  // 같은 게시물의 목록 페이지 번호만 다른 링크를 다시 받지 않습니다.
  if (u.searchParams.get('mode') === 'view' && u.searchParams.has('wr_uid')) u.searchParams.delete('page');
  u.searchParams.sort();
  u.hash = '';
  return u.href;
}

/** 출항 범위를 returnAt으로 오인하지 않고, 집결·출항·입항 원문을 각각 보존합니다. */
export function inspectPage(html, source) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer').remove();
  const lines = new Set();
  $('p, li, td, div').each((_, el) => {
    const text = clean($(el).text());
    if (text && text.length <= 300) lines.add(text);
  });
  // br로 나눈 공지와 inline 태그로 분리한 시각 모두 읽습니다.
  const copy = cheerio.load($.html().replace(/<br\s*\/?\s*>/gi, '\n'));
  for (const line of copy.text().split(/[\n\r]+/).map(clean)) if (line && line.length <= 300) lines.add(line);
  const evidence = [];
  for (const quote of lines) {
    // 예약자 행은 수집·로그·보고서에 남기지 않습니다.
    if (/예약확정|입금대기|예약자|취소자|예약완료|\([^)]*\d+[^)]*\)/.test(quote)) continue;
    const times = quote.match(clock) ?? [];
    let kind;
    if (times.length && /집결|도착|명부|대기|모이/.test(quote)) kind = 'meeting';
    else if (times.length && /출항|출조\s*시간|운항\s*시간/.test(quote)) kind = times.length > 1 && /사이|부터|에서|~|∼/.test(quote) ? 'departure-window-or-operation' : 'departure';
    else if (times.length && /입항|귀항|철수/.test(quote)) kind = 'return';
    else if (UNKNOWN.test(quote) && relevant.test(quote)) kind = 'needs-confirmation';
    else if (/출항지|승선지|집결지|주소\s*[:：]|오시는\s*길\s*[가-힣]{2,}|예약\s*문의.*\d{2,3}[-.]/.test(quote)) kind = 'location-or-contact';
    if (kind) evidence.push({ kind, quote, times, source, review: '배·어종·적용 기간 확인 필요' });
  }
  for (const hint of priceHints(html)) {
    if (/예약확정|입금대기|예약자|취소자|예약완료|\([^)]*\d+[^)]*\)/.test(hint.line)) continue;
    evidence.push({ kind: 'price', quote: hint.line, amounts: hint.amounts, source, review: '배·어종·항차·적용 기간 확인 필요' });
  }
  const links = [], media = [];
  $('a[href], img[src]').each((_, el) => {
    const raw = $(el).attr('href') ?? $(el).attr('src');
    let url;
    try { url = new URL(raw, source); } catch { return; }
    if (!['https:', 'http:'].includes(url.protocol)) return;
    url.hash = '';
    const title = clean($(el).text() || $(el).attr('alt') || $(el).attr('title'));
    if (attachment.test(url.href)) {
      if (!/logo|icon|button|btn|emoji|emoticon|loading|\/footer\/|\/module\/.*\/image\/|\/img\/(?:on|naver|ttl_)|\/images\/(?:ship_|bnr|left_|2017ssfish)/i.test(url.href)) media.push({ url: url.href, title, source, status: 'visual-review-required' });
    } else if (url.origin === new URL(source).origin && relevant.test(title) && !/로그인|예약하기|글쓰기|삭제|수정/.test(title) && !(url.searchParams.get('mid') === 'bk')) {
      links.push({ url: url.href, title, score: /출항|시간|집결|승선|요금|선비/.test(title) ? 2 : 1 });
    }
  });
  const pageTitle = clean($('title').text());
  const unique = [...new Map(evidence.map(e => [e.kind + e.quote, e])).values()];
  return { title: pageTitle, evidence: unique.filter(e => !unique.some(other => other !== e && other.kind === e.kind && other.quote.includes(e.quote)))
    .map(e => ({ ...e, pageTitle })),
    links: [...new Map(links.map(l => [l.url, l])).values()].sort((a, b) => b.score - a.score),
    media: [...new Map(media.map(m => [m.url, m])).values()] };
}

/** 요청 수를 제한한 공식 도메인 조사. 실패·미발견·미방문 링크를 분리합니다. */
export async function researchSite(target, { readPage, maxPages = 6, now = Date.now() }) {
  const queue = [{ url: new URL(target.url).origin + '/', title: '홈페이지' }, { url: target.samples[0]?.url || target.url, title: '예약판' }];
  const seen = new Set(), pages = [], evidence = [], media = [];
  while (queue.length && pages.length < maxPages) {
    const page = queue.shift();
    if (seen.has(pageKey(page.url))) continue;
    seen.add(pageKey(page.url));
    try {
      const inspected = inspectPage(await readPage(page.url), page.url);
      pages.push({ url: page.url, title: inspected.title || page.title, status: 'read' });
      evidence.push(...inspected.evidence);
      media.push(...inspected.media);
      queue.push(...inspected.links.filter(l => !seen.has(pageKey(l.url))));
    } catch (error) {
      pages.push({ ...page, status: 'failed', error: error.message });
    }
  }
  const remaining = [...new Map(queue.filter(p => !seen.has(pageKey(p.url))).map(p => [pageKey(p.url), p])).values()];
  const result = { ...target, checkedAt: new Date(now).toISOString(), pages,
    evidence: [...new Map(evidence.map(e => [e.source + e.kind + e.quote, e])).values()],
    media: [...new Map(media.map(m => [m.url, m])).values()], remaining };
  result.status = pages.every(p => p.status === 'failed') ? 'failed' : evidence.length ? 'review-required' : 'not-found-in-checked-pages';
  return result;
}

export function researchMarkdown(results, proposals = []) {
  const out = ['# 선사 정보 조사 결과', '', '후보는 아직 확정값이 아닙니다. 이미지·첨부파일과 적용 범위를 확인한 뒤 반영하세요.', ''];
  if (proposals.length) {
    const ready = proposals.filter((p) => !p.missing.length);
    out.push('## registry 반영 후보', '',
      `${proposals.length}건 · 그대로 붙일 수 있는 것 ${ready.length}건. **값을 정해주지 않습니다** —`,
      '막는 것이 없는 줄만 초안 그대로 쓰고, 나머지는 막힌 이유를 먼저 해결하세요.', '');
    for (const p of proposals) {
      const value = p.draft.timeGuide.departThrough
        ? `${p.draft.timeGuide[p.field]}~${p.draft.timeGuide.departThrough}`
        : p.draft.timeGuide[p.field];
      out.push(`- ${p.site} · ${p.path}.${p.field} ${value} — ${p.missing.length ? '막힘: ' + p.missing.join(' · ') : '**막는 것 없음**'}`);
      if (p.candidates.length > 1) out.push(`  - 다른 후보: ${p.candidates.join(', ')}`);
      out.push(`  - 근거: ${p.draft.timeGuide.note} — ${p.draft.timeGuide.source}`);
      out.push('  - 초안: ' + JSON.stringify(p.draft));
    }
    out.push('');
  }
  for (const r of results) {
    out.push(`## ${r.name} (${r.id}) — ${r.status}`, '', `확인: ${r.checkedAt}`, '', ...r.issues.map(i => `- ${i.field}: ${i.reason} (${i.count}건)`), '');
    for (const e of r.evidence) out.push(`- ${e.kind}: ${e.quote.replace(/[\r\n]/g, ' ')} — ${e.source} (${e.pageTitle || '제목 없음'})`);
    out.push('', '확인한 페이지:', ...r.pages.map(p => `- ${p.status}: ${p.url}${p.error ? ' — ' + p.error : ''}`), '', '이미지·첨부파일 확인 대기:', ...r.media.map(m => `- ${m.title || '첨부자료'}: ${m.url} (게시물: ${m.source})`), '', '요청 상한으로 미방문:', ...r.remaining.map(p => `- ${p.title}: ${p.url}`), '');
  }
  return out.join('\n');
}

// 조사한 근거를 registry에 붙일 **초안**으로 정리합니다. 값을 정해주지는 않습니다 —
// 무엇이 후보이고 **무엇 때문에 아직 못 붙이는지**를 같이 적는 것이 이 함수의 일입니다.
// 막는 것을 안 적으면 사람이 초안을 그대로 붙여 넣고, 작년 공지의 시각이 올해 값으로 남습니다
// (홍원 2024·2025년도 공지가 실제로 그럴 뻔했습니다 — RESEARCH.md).
const GUIDE_FIELD = { meeting: 'meetingAt', departure: 'departAt', 'departure-window-or-operation': 'departAt', return: 'returnAt' };
// "2026년 9월 1일 ~ 10월 31일"처럼 **원문이 적어둔** 기간만 인정합니다. 연도만 있는 공지는
// 그 연도를 알려주기만 하고 기간으로 치지 않습니다.
const PERIOD = /(\d{4})[.\-년]\s*(\d{1,2})[.\-월]\s*(\d{1,2})\s*일?\s*(?:부터|~|-|–|—)\s*(?:(\d{4})[.\-년]\s*)?(\d{1,2})[.\-월]\s*(\d{1,2})\s*일?\s*(?:까지)?/;
const pad = (n) => String(n).padStart(2, '0');

export function proposeGuides(result, site = {}) {
  // registry에 적힌 이름과 수집이 읽어온 이름을 같이 봅니다. 공지가 어느 배인지 알아보는
  // 일이라 출처를 가릴 이유가 없고, registry에 배를 안 적어둔 선사가 25곳이라 registry만
  // 보면 그 곳들은 "배가 하나뿐"인 것처럼 보여 경고조차 안 붙었습니다.
  const boats = [...new Set([...Object.keys(site.boats ?? {}), ...(result.boats ?? [])])];
  const wanted = new Set((result.issues ?? []).map((i) => i.field));
  const byField = new Map();

  for (const e of result.evidence ?? []) {
    const field = GUIDE_FIELD[e.kind];
    if (!field) continue;
    // 그 선사가 아쉬운 값만 제안합니다. 집결시각은 출항시각이 빈 곳에서만 쓸모가 있습니다.
    if (!wanted.has(field === 'meetingAt' ? 'departAt' : field)) continue;
    const { from, to } = toTimeRange(e.quote);
    if (!from) continue;
    // "05시 에서 05시 30분 사이"처럼 ~ 없이 적은 범위는 toTimeRange가 못 읽습니다.
    // inspectPage가 이미 뽑아둔 시각 목록에서 둘째 값을 씁니다.
    const second = to ?? (e.times?.length > 1 ? toTime(e.times[1]) : null);
    const named = boats.filter((boat) => e.quote.includes(boat));
    const period = `${e.quote} ${e.pageTitle ?? ''}`.match(PERIOD);
    const rawYear = `${e.quote} ${e.pageTitle ?? ''}`.match(/(?:20)?(\d{2})\s*년도?|(?:20)?(\d{2})\s*시즌/);
    const year = rawYear ? `20${rawYear[1] ?? rawYear[2]}` : null;
    const item = byField.get(field) ?? { field, values: new Map() };
    const key = [from, to ?? '', named[0] ?? ''].join('|');
    item.values.set(key, item.values.get(key) ?? {
      value: from,
      through: e.kind === 'departure-window-or-operation' ? second : null,
      boat: named.length === 1 ? named[0] : null,
      source: e.source,
      note: e.quote,
      year,
      period: period && {
        validFrom: `${period[1]}-${pad(period[2])}-${pad(period[3])}`,
        validThrough: `${period[4] ?? period[1]}-${pad(period[5])}-${pad(period[6])}`,
      },
    });
    byField.set(field, item);
  }

  return [...byField.values()].map(({ field, values }) => {
    const candidates = [...values.values()];
    const first = candidates[0];
    const missing = [];
    // 값이 갈리면 어느 쪽이 맞는지 우리가 고를 수 없습니다. 고르면 절반은 틀립니다.
    if (new Set(candidates.map((c) => c.value + (c.through ?? ''))).size > 1) missing.push('값이 여러 개');
    if (!first.period) missing.push(first.year ? `적용 기간(근거는 ${first.year}년 공지)` : '적용 기간');
    // 배가 여럿인 선사에서 공지가 어느 배인지 모르면 멀쩡한 배까지 그 시각이 됩니다.
    if (boats.length > 1 && !first.boat) missing.push(`배 확인(${boats.length}척)`);
    const guide = {
      [field]: first.value,
      ...(first.through ? { departThrough: first.through } : {}),
      validFrom: first.period?.validFrom ?? null,
      validThrough: first.period?.validThrough ?? null,
      source: first.source,
      note: first.note,
    };
    return {
      site: result.id, boat: first.boat, field, candidates: candidates.map((c) => c.value),
      missing, checkedAt: result.checkedAt,
      // 붙일 곳까지 적습니다 — boats[배].timeGuide인지 사이트 공통 timeGuide인지.
      path: first.boat ? `boats.${first.boat}.timeGuide` : 'timeGuide',
      draft: { timeGuide: guide },
    };
  });
}

/** 선사별 제안. registry에서 그 선사를 찾아 배 목록·붙일 곳을 같이 봅니다. */
export function researchProposals(results, registry) {
  const sites = new Map(registry.map((s) => [s.id, s]));
  return results.flatMap((r) => proposeGuides(r, sites.get(r.id) ?? {}));
}
