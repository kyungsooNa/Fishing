import * as cheerio from 'cheerio';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 호스트별 마지막 요청 시각. 같은 서버를 연달아 때리지 않게 한다.
const lastHit = new Map();
const MIN_GAP_MS = 3000;

let browserPromise = null;

async function gate(url) {
  const host = new URL(url).host;
  const prev = lastHit.get(host) ?? 0;
  const wait = prev + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * mode 'static': 순수 HTML. 빠르고 가볍다. 대부분의 플랫폼 목록 페이지가 여기 해당.
 * mode 'js'    : Playwright로 렌더링. 개별 선사 홈페이지, 달력 위젯 등에 필요.
 * 어느 쪽인지 모르면 registry에 'auto'로 두면 static 먼저 시도한다.
 */
export async function loadHtml(url, { mode = 'auto', waitFor = null, timeout = 20000 } = {}) {
  if (mode === 'js') return { $: cheerio.load(await renderJs(url, waitFor, timeout)), mode: 'js' };

  const html = await fetchStatic(url, timeout);
  const $ = cheerio.load(html);

  if (mode === 'auto' && looksEmpty($)) {
    // 본문이 거의 없으면 JS 렌더링 페이지로 보고 한 번 더 시도
    return { $: cheerio.load(await renderJs(url, waitFor, timeout)), mode: 'js' };
  }
  return { $, mode: 'static' };
}

async function fetchStatic(url, timeout, attempt = 0) {
  await gate(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      signal: ac.signal,
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < 2) {
      await sleep(2000 * 2 ** attempt); // 지수 백오프
      return fetchStatic(url, timeout, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function renderJs(url, waitFor, timeout) {
  const { chromium } = await import('playwright'); // 필요할 때만 로드
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  const browser = await browserPromise;

  await gate(url);
  const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (waitFor) await page.waitForSelector(waitFor, { timeout });
    else await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    return await page.content();
  } finally {
    await ctx.close();
  }
}

function looksEmpty($) {
  return $('body').text().replace(/\s/g, '').length < 200;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

/** JSON API를 직접 때리는 사이트용 (플랫폼 쪽에 종종 있다) */
export async function loadJson(url, init = {}) {
  await gate(url);
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
