// 공식 사이트 조사: 확정값이 아니라 적용 범위를 검토할 근거와 후속 작업을 모읍니다.
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { kstDate } from './when.js';
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
    const row = rows.get(site.id) ?? { id: site.id, name: site.name, url: site.url, trips: 0, issues: new Map(), samples: [] };
    rows.set(site.id, row);
    row.trips++;
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

export function researchMarkdown(results) {
  const out = ['# 선사 정보 조사 결과', '', '후보는 아직 확정값이 아닙니다. 이미지·첨부파일과 적용 범위를 확인한 뒤 반영하세요.', ''];
  for (const r of results) {
    out.push(`## ${r.name} (${r.id}) — ${r.status}`, '', `확인: ${r.checkedAt}`, '', ...r.issues.map(i => `- ${i.field}: ${i.reason} (${i.count}건)`), '');
    for (const e of r.evidence) out.push(`- ${e.kind}: ${e.quote.replace(/[\r\n]/g, ' ')} — ${e.source} (${e.pageTitle || '제목 없음'})`);
    out.push('', '확인한 페이지:', ...r.pages.map(p => `- ${p.status}: ${p.url}${p.error ? ' — ' + p.error : ''}`), '', '이미지·첨부파일 확인 대기:', ...r.media.map(m => `- ${m.title || '첨부자료'}: ${m.url} (게시물: ${m.source})`), '', '요청 상한으로 미방문:', ...r.remaining.map(p => `- ${p.title}: ${p.url}`), '');
  }
  return out.join('\n');
}
