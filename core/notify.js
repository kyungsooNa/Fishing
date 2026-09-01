import { tripKey } from './schema.js';

/**
 * 이전 수집 결과와 비교해서 "새로 열린 자리"만 골라낸다.
 *
 * 낚시 예약에서 값어치 있는 신호는 두 가지뿐이다.
 *   - 마감이던 배에 자리가 났다 (취소석)
 *   - 이미 열려있던 배의 잔여석이 늘었다 (부분 취소)
 * 새로 올라온 일정은 아직 아무도 예약 안 한 게 당연하므로 알림 대상이 아니다.
 */
export function findOpenings(prevTrips, curTrips, { minSeats = 1 } = {}) {
  const prev = new Map((prevTrips ?? []).map((t) => [tripKey(t), t]));
  const open = (s) => s === 'available' || s === 'few';
  const out = [];

  for (const t of curTrips) {
    if (!open(t.status)) continue;

    const was = prev.get(tripKey(t));
    if (!was) continue; // 처음 보는 일정은 취소석이 아니다

    if (!open(was.status)) {
      out.push({ ...t, reason: 'reopened', before: was.seatsLeft ?? 0 });
      continue;
    }
    if (t.seatsLeft != null && was.seatsLeft != null && t.seatsLeft - was.seatsLeft >= minSeats) {
      out.push({ ...t, reason: 'more', before: was.seatsLeft });
    }
  }

  // 가까운 날짜부터
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 사람이 읽을 한 줄 */
export function formatOpening(t) {
  const [, m, d] = t.date.split('-');
  const when = `${Number(m)}/${Number(d)}`;
  const seats = t.seatsLeft != null ? `${t.seatsLeft}자리` : '자리 있음';
  const delta = t.reason === 'reopened' ? '마감 해제' : `${t.before}→${t.seatsLeft}`;
  const extra = [t.tide, t.departTime, t.port].filter(Boolean).join(' · ');
  return `${when} ${t.boatName} — ${seats} (${delta})${extra ? `\n   ${extra}` : ''}`;
}

/**
 * 텔레그램으로 보낸다. 환경변수가 없으면 조용히 건너뛴다.
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * 디스코드를 쓰면 DISCORD_WEBHOOK 하나만 넣으면 된다.
 */
export async function notify(openings, { limit = 15 } = {}) {
  if (openings.length === 0) return { sent: false, reason: 'none' };

  const shown = openings.slice(0, limit);
  const more = openings.length - shown.length;
  const body =
    `자리 났습니다 (${openings.length}건)\n\n` +
    shown.map(formatOpening).join('\n') +
    (more > 0 ? `\n\n외 ${more}건` : '');

  const tg = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  const discord = process.env.DISCORD_WEBHOOK;

  try {
    if (tg && chat) {
      const res = await fetch(`https://api.telegram.org/bot${tg}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: body, disable_web_page_preview: true }),
      });
      if (!res.ok) throw new Error(`텔레그램 ${res.status}`);
      return { sent: true, via: 'telegram', count: openings.length };
    }
    if (discord) {
      const res = await fetch(discord, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: body.slice(0, 1900) }),
      });
      if (!res.ok) throw new Error(`디스코드 ${res.status}`);
      return { sent: true, via: 'discord', count: openings.length };
    }
  } catch (err) {
    // 알림 실패가 수집 자체를 망치면 안 된다
    return { sent: false, reason: String(err.message ?? err) };
  }

  return { sent: false, reason: 'no-config' };
}
