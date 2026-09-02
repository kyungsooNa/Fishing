// 통합 스키마 + 표기 정규화.
// 어댑터는 사이트 원문 텍스트와 숫자만 넘기고, 정리는 여기서 합니다.

export const STATUS = {
  OPEN: 'open',       // 예약 가능
  FEW: 'few',         // 잔여석 적음 (1~2)
  CLOSED: 'closed',   // 만석/마감
  OFF: 'off',         // 휴항/결항
  UNKNOWN: 'unknown',
};

const OFF_WORDS = ['휴항', '결항', '출조취소', '취소됨', '기상악화', '운휴', '미출조'];
const CLOSED_WORDS = ['마감', '만석', '완료', '매진', '예약불가', '불가', '종료'];
const OPEN_WORDS = ['예약가능', '가능', '접수중', '모집', '여유', '○', 'ㅇ', 'O'];

/** "예약가능 / ○ / 잔여3 / 마감 / 휴항" 처럼 제각각인 표기를 하나로 정리합니다. */
export function toStatus(rawText, seatsLeft) {
  const t = String(rawText ?? '').replace(/\s+/g, '');

  // 휴항은 잔여석 숫자보다 우선합니다. 자리가 남아도 배가 안 뜹니다.
  if (OFF_WORDS.some((w) => t.includes(w))) return STATUS.OFF;

  if (Number.isFinite(seatsLeft)) {
    if (seatsLeft <= 0) return STATUS.CLOSED;
    if (seatsLeft <= 2) return STATUS.FEW;
    return STATUS.OPEN;
  }

  if (CLOSED_WORDS.some((w) => t.includes(w))) return STATUS.CLOSED;
  if (OPEN_WORDS.some((w) => t.includes(w))) return STATUS.OPEN;
  return STATUS.UNKNOWN;
}

/** "남은자리 3명", "잔여3", "3석" 등에서 숫자만 뽑습니다. 못 찾으면 null. */
export function parseSeats(rawText) {
  const t = String(rawText ?? '');
  if (/(마감|만석|매진)/.test(t)) return 0;
  const m = t.match(/(?:남은자리|잔여|여석|잔여석)\D{0,4}(\d{1,3})/) || t.match(/(\d{1,3})\s*(?:명|석|자리)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 여러 형식의 날짜를 YYYY-MM-DD로. 연도가 없으면 기준일로 보충합니다. */
export function toDate(raw, base = new Date()) {
  if (!raw) return null;
  const t = String(raw).replace(/\s+/g, '');

  let m = t.match(/(20\d{2})[-./년]?(\d{1,2})[-./월]?(\d{1,2})/);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));

  m = t.match(/(\d{1,2})[-./월](\d{1,2})/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = base.getFullYear();
    // 12월에 1월 일정을 보면 내년입니다.
    if (base.getMonth() + 1 >= 11 && month <= 2) year += 1;
    return ymd(year, month, day);
  }

  m = t.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));

  return null;
}

function ymd(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "06:00 출항", "오전 5시" → "05:00". 못 찾으면 null. */
export function toTime(raw) {
  if (!raw) return null;
  const t = String(raw);
  let m = t.match(/(\d{1,2})\s*[:시]\s*(\d{1,2})?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (/오후|PM/i.test(t) && h < 12) h += 12;
  if (/오전|AM/i.test(t) && h === 12) h = 0;
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 물때 표기(12물, 조금, 무시)를 그대로 살려 뽑습니다. */
export function toTide(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2}\s*물|조금|무시|사리)/);
  return m ? m[1].replace(/\s+/g, '') : null;
}

/**
 * registry에 적어둔 승선료에서 그 날 어종에 맞는 값을 고릅니다.
 * 배별 prices → 배별 price → 사이트 공통 prices → 사이트 공통 price 순.
 * 못 찾으면 null이고, 화면에서는 가격칸이 빈 채로 보입니다.
 */
export function pickPrice(site, boat, species) {
  const boatConf = site.boats?.[boat] ?? {};
  const key = species && String(species).trim();
  if (key && boatConf.prices?.[key] != null) return boatConf.prices[key];
  if (boatConf.price != null) return boatConf.price;
  if (key && site.prices?.[key] != null) return site.prices[key];
  if (site.price != null) return site.price;
  return null;
}

/** 배별 출항지가 따로 적혀 있으면 그걸, 없으면 사이트 기본값을 씁니다. */
export function pickPort(site, boat) {
  return site.boats?.[boat]?.port ?? site.port ?? null;
}

/** 같은 출조를 두 번 수집해도 같은 키가 나오도록. 알림 비교의 기준입니다. */
export function tripKey(t) {
  return [t.siteId, t.boat ?? '', t.date ?? '', t.departAt ?? ''].join('|');
}

/** 어댑터가 넘긴 원문을 통합 스키마로 만듭니다. */
export function makeTrip(site, fields) {
  const {
    boat = null,
    date,
    rawDate = null,
    departAt = null,
    rawTime = null,
    species = null,
    tide = null,
    rawTide = null,
    status: rawStatus = null,
    seatsLeft = null,
    seatsTotal = null,
    price = null,
    url = null,
  } = fields;

  const resolvedDate = date ?? toDate(rawDate);
  const seats = Number.isFinite(seatsLeft) ? seatsLeft : parseSeats(rawStatus);
  const boatName = boat ? String(boat).trim() : null;

  return {
    siteId: site.id,
    siteName: site.name ?? site.id,
    boat: boatName,
    port: pickPort(site, boatName),
    date: resolvedDate,
    departAt: departAt ?? toTime(rawTime),
    species: species ? String(species).trim() : null,
    tide: tide ?? toTide(rawTide),
    status: toStatus(rawStatus, seats),
    statusText: rawStatus ? String(rawStatus).replace(/\s+/g, ' ').trim() : null,
    seatsLeft: seats,
    seatsTotal: seatsTotal ?? site.seatsTotal ?? null,
    price: price ?? pickPrice(site, boatName, species),
    url: url ?? site.url ?? null,
  };
}
