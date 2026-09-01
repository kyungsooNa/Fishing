// 모든 어댑터가 이 형태로 반환한다. 필드가 없으면 null.
// 새 사이트를 붙일 때 고민할 것은 "원본 표기 -> 이 스키마" 매핑뿐이다.

export const STATUS = {
  AVAILABLE: 'available', // 예약 가능
  FEW: 'few',             // 잔여 소수 / 마감임박
  FULL: 'full',           // 마감
  CLOSED: 'closed',       // 휴항, 기상 결항
  UNKNOWN: 'unknown',     // 파싱 실패했지만 행 자체는 존재
};

/** @typedef {Object} Trip
 * @property {string} siteId      registry.json 의 id
 * @property {string} siteName    표시용 사이트/플랫폼 이름
 * @property {string} boatName    선사(배) 이름
 * @property {string} port        출항지 (없으면 null)
 * @property {string} date        'YYYY-MM-DD'
 * @property {string|null} departTime  '05:30' 형태
 * @property {string|null} tide       물때
 * @property {string} status      STATUS 중 하나
 * @property {number|null} seatsLeft
 * @property {number|null} seatsTotal
 * @property {number|null} price  1인 기준 원
 * @property {string[]} species   ['갈치','참돔']
 * @property {string} url         예약 원본 링크
 * @property {string} fetchedAt   ISO8601
 */

const FULL_WORDS = ['마감', '매진', '완료', '불가', '×', 'x', 'X'];
const CLOSED_WORDS = ['휴항', '결항', '취소', '미출조', '출조없음'];
const FEW_WORDS = ['임박', '소수', '얼마', '잔여'];
const OK_WORDS = ['가능', '예약', '여유', '○', 'O', '모집'];

/**
 * 사이트마다 "예약가능 / ○ / 잔여3 / 마감" 등 표기가 제각각이다.
 * 원문 텍스트 + 숫자를 같이 넣으면 하나의 status로 정리해준다.
 */
export function toStatus(rawText, seatsLeft = null) {
  const t = String(rawText ?? '').trim();

  if (CLOSED_WORDS.some((w) => t.includes(w))) return STATUS.CLOSED;
  if (FULL_WORDS.some((w) => t.includes(w))) return STATUS.FULL;

  if (typeof seatsLeft === 'number') {
    if (seatsLeft <= 0) return STATUS.FULL;
    if (seatsLeft <= 3) return STATUS.FEW;
    return STATUS.AVAILABLE;
  }

  if (FEW_WORDS.some((w) => t.includes(w))) return STATUS.FEW;
  if (OK_WORDS.some((w) => t.includes(w))) return STATUS.AVAILABLE;
  return STATUS.UNKNOWN;
}

/** '15,000원', '15만원', '1인 150000' -> 150000 */
export function toPrice(raw) {
  const t = String(raw ?? '');
  const man = t.match(/(\d+(?:\.\d+)?)\s*만/);
  if (man) return Math.round(parseFloat(man[1]) * 10000);
  const digits = t.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

/** '2026.09.05', '9/5', '9월 5일' -> '2026-09-05' */
export function toDate(raw, baseYear = new Date().getFullYear()) {
  const t = String(raw ?? '').trim();
  let m = t.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/(\d{1,2})\D+(\d{1,2})/);
  if (m) return `${baseYear}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

/** 어댑터 결과에 공통 필드를 채우고 최소 검증한다. */
export function makeTrip(site, partial) {
  const trip = {
    siteId: site.id,
    siteName: site.name,
    boatName: partial.boatName ?? site.name,
    port: partial.port ?? null,
    date: partial.date ?? null,
    departTime: partial.departTime ?? null,
    tide: partial.tide ?? null,          // 물때 (12물, 조금, 무시 …)
    status: partial.status ?? STATUS.UNKNOWN,
    seatsLeft: partial.seatsLeft ?? null,
    seatsTotal: partial.seatsTotal ?? null,
    price: partial.price ?? null,
    species: partial.species ?? [],
    url: partial.url ?? site.url,
    fetchedAt: new Date().toISOString(),
  };
  if (!trip.date) throw new Error(`[${site.id}] date 파싱 실패: ${JSON.stringify(partial)}`);
  return trip;
}

/** 같은 배 + 같은 날짜 + 같은 출항시간이면 동일 건으로 본다. */
export function tripKey(t) {
  return [t.siteId, t.boatName, t.date, t.departTime ?? '-'].join('|');
}
