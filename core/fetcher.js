// HTTP / Playwright. 호스트별 요청 간격을 지킵니다.

import { Agent } from 'undici';

const MIN_GAP_MS = 3000;        // 같은 호스트에 연속 요청할 때 최소 간격
const TIMEOUT_MS = 25000;
// 러너는 해외에 있고 상대는 전부 국내 호스트입니다. Node 기본 연결 제한시간(10초)이
// 빠듯해서 멀쩡한 사이트가 UND_ERR_CONNECT_TIMEOUT으로 무더기로 떨어졌습니다.
const CONNECT_TIMEOUT_MS = 30000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const lastHit = new Map();      // host -> timestamp
const dispatcher = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
let browser = null;             // playwright 브라우저는 한 번만 띄웁니다

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pace(url) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

async function getStatic(url, { referer } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      dispatcher,
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return decode(buf, res.headers.get('content-type') ?? '');
  } finally {
    clearTimeout(timer);
  }
}

// 국내 예약 사이트는 아직 EUC-KR이 흔합니다. 잘못 읽으면 파싱이 통째로 깨집니다.
function decode(buf, contentType) {
  const head = buf.subarray(0, 2048).toString('latin1');
  const declared =
    contentType.match(/charset=([\w-]+)/i)?.[1] ??
    head.match(/charset=["']?([\w-]+)/i)?.[1] ??
    'utf-8';
  const cs = declared.toLowerCase();
  if (cs === 'euc-kr' || cs === 'ks_c_5601-1987' || cs === 'cp949' || cs === 'windows-949') {
    return new TextDecoder('euc-kr').decode(buf);
  }
  return buf.toString('utf8');
}

async function getRendered(url, { waitFor, referer } = {}) {
  if (!browser) {
    let chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new Error('mode:"js" 사이트를 쓰려면 playwright가 필요합니다 — npx playwright install chromium');
    }
    browser = await chromium.launch({ args: ['--no-sandbox'] });
  }
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'ko-KR',
    ...(referer ? { extraHTTPHeaders: { Referer: referer } } : {}),
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    if (waitFor) {
      // "text=운항시간" 같은 셀렉터가 나타날 때까지. 안 나오면 그대로 진행하고
      // 파싱 단계에서 0건으로 잡히게 둡니다 — 여기서 던지면 원인이 흐려집니다.
      await page.waitForSelector(waitFor, { timeout: TIMEOUT_MS }).catch(() => {});
    }
    return await page.content();
  } finally {
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }
}

/**
 * 한 페이지를 받아옵니다.
 * mode: "static"(HTTP) | "js"(브라우저 렌더링) | "auto"(static 먼저, 본문이 비면 js)
 */
export async function fetchHtml(url, { mode = 'auto', waitFor, referer, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    await pace(url);
    try {
      if (mode === 'js') return await getRendered(url, { waitFor, referer });
      const html = await getStatic(url, { referer });
      if (mode === 'auto' && looksEmpty(html)) return await getRendered(url, { waitFor, referer });
      return html;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// 껍데기만 오고 내용은 JS로 그리는 페이지를 대충 걸러냅니다.
function looksEmpty(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
  return body.replace(/\s+/g, '').length < 400;
}


/**
 * Node의 fetch는 DNS·TLS·연결 거부를 전부 "fetch failed" 한 줄로 감쌉니다.
 * 그대로 두면 화면의 "수집 상태"에 원인이 안 남아 손쓸 수가 없습니다.
 * cause를 따라가며 코드와 메시지를 붙여 돌려줍니다.
 */
export function describeError(err) {
  const head = String(err?.message ?? err);
  const parts = [];
  for (let cur = err?.cause, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    const code = cur.code ? `${cur.code}: ` : '';
    const msg = String(cur.message ?? cur);
    if (msg && msg !== head) parts.push(`${code}${msg}`);
  }
  return parts.length ? `${head} (${parts.join(' ← ')})` : head;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
