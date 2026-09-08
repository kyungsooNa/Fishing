// 텔레그램 / 디스코드 알림. 토큰이 없으면 조용히 건너뜁니다.

const MAX_LINES = 20;

/**
 * 한 건이 두 줄입니다. 알림을 받고 **바로 예약하러 갈 수 있어야** 하는데, 첫 줄에 다 넣으면
 * 주소가 잘리거나 줄이 접혀서 정작 링크가 안 보였습니다. 배·시각은 첫 줄, 주소는 그 아래.
 *
 * 주소는 그 출조의 예약 화면입니다. 사이트가 주소로 날짜를 못 받으면(`urlDated`가 없으면)
 * 일정표로 가므로 그렇다고 적어줍니다 — 열고 나서 날짜를 직접 찾아야 합니다.
 */
export function line(opening) {
  const bits = [
    opening.date,
    opening.departAt,
    opening.siteName,
    opening.boat,
    opening.species,
    opening.reason === 'reopened' ? '취소석' : `자리 늘어남 ${opening.before}→${opening.seatsLeft}`,
    Number.isFinite(opening.seatsLeft) ? `잔여 ${opening.seatsLeft}` : null,
  ].filter(Boolean);

  const rows = ['• ' + bits.join(' | ')];
  if (opening.url) rows.push(`  ${opening.url}${opening.urlDated ? '' : ' (일정표 — 날짜는 직접 고르세요)'}`);
  return rows.join('\n');
}

/**
 * 언제 확인한 값인지도 같이 보냅니다. 알림이 늦게 도착하는 일이 있어서(전송 실패 후 재시도,
 * 서버가 잠깐 죽었다 살아난 경우) "지금 자리가 있다"가 아니라 "몇 시 몇 분에 봤을 때
 * 있었다"로 읽혀야 합니다.
 */
export function format(openings, at = new Date()) {
  const head = `🎣 자리 났습니다 (${openings.length}건) · ${kstTime(at)} 확인`;
  const body = openings.slice(0, MAX_LINES).map(line);
  if (openings.length > MAX_LINES) body.push(`… 외 ${openings.length - MAX_LINES}건`);
  // 감시는 화면에서 끕니다. 알림에 그 말이 없으면 "그만 받으려면 어떡하지"가 됩니다.
  body.push('감시 해제는 현황판의 [감시 중인 출조 관리]에서.');
  return [head, ...body].join('\n');
}

/** 러너가 UTC라 그냥 찍으면 9시간 전으로 보입니다(core/when.js와 같은 이유). */
function kstTime(at) {
  const d = new Date(at);
  if (!Number.isFinite(Number(d))) return '시각 미상';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

/**
 * 알림 발송이 실패해도 수집 결과는 그대로 저장되도록, 여기서 던지지 않습니다.
 *
 * 결과는 **채널별로** 돌려줍니다. 성공 개수만 세면 "둘 중 하나가 갔다"까지는 알아도
 * 어느 쪽이 왜 막혔는지는 모릅니다. 그 이유를 그대로 이력에 남깁니다(core/alerts.js).
 */
export async function notify(openings, env = process.env, at = new Date()) {
  if (!openings.length) return { attempted: [], sent: [], failed: [], skipped: 'no-openings' };

  const text = format(openings, at);
  const jobs = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(['telegram', () => post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    })]);
  }
  if (env.DISCORD_WEBHOOK) {
    jobs.push(['discord', () => post(env.DISCORD_WEBHOOK, { content: text })]);
  }
  if (!jobs.length) return { attempted: [], sent: [], failed: [], skipped: 'no-credentials' };

  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  const sent = [];
  const failed = [];

  results.forEach((result, i) => {
    const channel = jobs[i][0];
    if (result.status === 'fulfilled') {
      sent.push(channel);
      return;
    }
    const error = String(result.reason?.message ?? result.reason).slice(0, 200);
    failed.push({ channel, error });
    console.warn(`알림 발송 실패(${channel}):`, error);
  });

  return { attempted: jobs.map(([channel]) => channel), sent, failed };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
}
