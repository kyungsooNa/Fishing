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

/** 알림 발송이 실패해도 수집 결과는 그대로 저장되도록, 여기서 던지지 않습니다. */
export async function notify(openings, env = process.env) {
  if (!openings.length) return { sent: 0, skipped: 'no-openings' };

  const text = format(openings);
  const jobs = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }).then(() => 'telegram'),
    );
  }
  if (env.DISCORD_WEBHOOK) {
    jobs.push(post(env.DISCORD_WEBHOOK, { content: text }).then(() => 'discord'));
  }
  if (!jobs.length) return { sent: 0, skipped: 'no-credentials' };

  const results = await Promise.allSettled(jobs);
  const sent = results.filter((r) => r.status === 'fulfilled').length;
  for (const r of results) {
    if (r.status === 'rejected') console.warn('알림 발송 실패:', r.reason?.message ?? r.reason);
  }
  return { sent };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
}
