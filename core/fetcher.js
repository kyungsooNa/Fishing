// HTTP / Playwright. 같은 서버에 연속으로 요청하지 않도록 간격을 지킵니다.

import http from 'node:http';
import https from 'node:https';


const MIN_GAP_MS = 3000;        // 같은 서버에 연속 요청할 때 최소 간격
// 러너는 해외에 있고 상대는 전부 국내 호스트입니다. Node fetch의 기본 연결 제한시간
// 10초로는 멀쩡한 사이트가 UND_ERR_CONNECT_TIMEOUT으로 무더기로 떨어집니다.
// undici Agent로 늘려보려다 내장 fetch와 버전이 안 맞아 모든 요청을 깨뜨린 적이 있어,
// 지금은 node:http/https로 직접 받아옵니다. 붙는 시간과 기다리는 시간을 다 덮습니다.
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const lastHit = new Map();      // 서버(=도메인) -> 마지막 요청 시각
let browser = null;             // playwright 브라우저는 한 번만 띄웁니다

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 간격을 지킬 단위. 호스트 이름이 아니라 도메인입니다.
 *
 * 선사 사이트는 대부분 플랫폼 서브도메인입니다(akbari.sunsang24.com,
 * ssfish.thefishing.kr...). 호스트별로 세면 200곳이 다 다른 상대로 보이지만
 * 실제로는 한 서버라, 3초 간격을 지킨다고 믿으면서 초당 몇 번씩 두드리게 됩니다.
 * 실제로 그러다 더피싱 계열 242곳이 통째로 시간초과로 막혔습니다.
 *
 * kr 2단계 도메인(co.kr, or.kr...)은 한 칸 더 봅니다 — thefishing.kr은 그대로 쓰되
 * xxx.co.kr에서 co.kr로 뭉뚱그리면 남남인 사이트끼리 서로 기다리게 됩니다.
 */
const SECOND_LEVEL = new Set(['co', 'or', 'ne', 'go', 're', 'pe', 'ac', 'com', 'net', 'org']);

const IS_IP = /^\d{1,3}(\.\d{1,3}){3}$/;

export function gapKey(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();

  // IP나 localhost는 도메인으로 자를 게 없습니다. 포트까지 넣어 따로 셉니다 —
  // 안 그러면 테스트용 로컬 서버들이 서로 3초씩 기다립니다.
  if (IS_IP.test(host) || host === 'localhost' || host.includes(':')) return u.host;

  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const take = SECOND_LEVEL.has(parts.at(-2)) ? 3 : 2;
  return parts.slice(-take).join('.');
}

async function pace(url) {
  const key = gapKey(url);
  const wait = (lastHit.get(key) ?? 0) + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(key, Date.now());
}

function getStatic(url, { referer, timeoutMs = TIMEOUT_MS, redirects = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(referer ? { Referer: referer } : {}),
        },
      },
      (res) => {
        const { statusCode, statusMessage, headers } = res;

        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('리다이렉트가 너무 많습니다'));

          // Location이 주소로 안 읽히는 경우가 실제로 있습니다. 한글 도메인으로 넘기면서
          // 헤더를 인코딩하지 않은 사이트를 만났습니다(ddoli.thefishing.kr → 깨진 바이트).
          // 여기서 new URL이 그냥 던지면 응답 콜백 안이라 아무도 못 받고 프로세스가
          // 통째로 죽습니다 — 사이트 하나 때문에 수집 전체가 날아갔습니다.
          let next;
          try {
            next = new URL(headers.location, url).toString();
          } catch {
            return reject(new Error(`리다이렉트 주소를 읽을 수 없습니다: ${String(headers.location).slice(0, 60)}`));
          }
          return resolve(getStatic(next, { referer, timeoutMs, redirects: redirects - 1 }));
        }

        if (statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} ${statusMessage ?? ''}`.trim()));
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(decode(Buffer.concat(chunks), headers['content-type'] ?? '')));
        res.on('error', reject);
      },
    );

    // 붙는 동안에도 도는 시계입니다. 국내 호스트에 해외에서 붙을 때 이게 관건입니다.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${timeoutMs}ms 안에 응답이 없습니다`)));
    req.on('error', reject);
  });
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


// 다시 걸어봐야 소용없는 실패들. 붙지도 않는 곳에 세 번 매달리면 수집이 몇 분씩
// 길어지고, 상대 서버 입장에서는 그저 두들기는 셈입니다.
const HOPELESS = /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|CERT_|ERR_TLS/;

function isHopeless(err) {
  if (/안에 응답이 없습니다/.test(String(err?.message ?? ''))) return true;
  for (let cur = err, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    if (HOPELESS.test(cur.code ?? '') || HOPELESS.test(String(cur.message ?? ''))) return true;
  }
  return false;
}

/**
 * 한 페이지를 받아옵니다.
 * mode: "static"(HTTP) | "js"(브라우저 렌더링) | "auto"(static 먼저, 본문이 비면 js)
 */
export async function fetchHtml(url, { mode = 'auto', waitFor, referer, retries = 2, timeoutMs } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    await pace(url);
    try {
      if (mode === 'js') return await getRendered(url, { waitFor, referer });
      const html = await getStatic(url, { referer, timeoutMs });
      if (mode === 'auto' && looksEmpty(html)) return await getRendered(url, { waitFor, referer });
      return html;
    } catch (err) {
      lastErr = err;
      if (isHopeless(err)) break;   // 연결 자체가 안 되면 재시도해도 같습니다
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
