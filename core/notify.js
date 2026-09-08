// 텔레그램 / 디스코드 알림. 토큰이 없으면 조용히 건너뜁니다.

const MAX_LINES = 20;

function line(o) {
  const bits = [
    o.date,
    o.departAt,
    o.siteName,
    o.boat,
    o.species,
    o.reason === 'reopened' ? '취소석' : `자리 늘어남 ${o.before}→${o.seatsLeft}`,
    Number.isFinite(o.seatsLeft) ? `잔여 ${o.seatsLeft}` : null,
  ].filter(Boolean);
  return '• ' + bits.join(' | ');
}

function format(openings) {
  const head = `🎣 자리 났습니다 (${openings.length}건)`;
  const body = openings.slice(0, MAX_LINES).map(line);
  if (openings.length > MAX_LINES) body.push(`… 외 ${openings.length - MAX_LINES}건`);
  return [head, ...body].join('\n');
}

/**
 * 알림 발송이 실패해도 수집 결과는 그대로 저장되도록, 여기서 던지지 않습니다.
 *
 * 결과는 **채널별로** 돌려줍니다. 성공 개수만 세면 "둘 중 하나가 갔다"까지는 알아도
 * 어느 쪽이 왜 막혔는지는 모릅니다. 그 이유를 그대로 이력에 남깁니다(core/alerts.js).
 */
export async function notify(openings, env = process.env) {
  if (!openings.length) return { attempted: [], sent: [], failed: [], skipped: 'no-openings' };

  const text = format(openings);
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
