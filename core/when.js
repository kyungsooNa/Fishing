// 날짜는 전부 한국시간 기준입니다.
//
// GitHub Actions 러너는 해외(UTC)에서 돕니다. 러너 기준으로 날짜를 세면
// 한국시간과 최대 9시간 어긋나서, 워크플로의 06:10 수집(= UTC 전날 21:10) 때
// "오늘"이 어제가 됩니다. 지난 출조가 화면에 남고, 날짜별로 받는 사이트는
// 어제 페이지부터 긁습니다. 대상이 전부 국내 사이트라 기준을 KST로 고정합니다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 한국시간 달력값을 UTC 게터로 읽을 수 있게 밀어둔 Date. 계산 전용입니다. */
function shifted(offsetDays, now) {
  return new Date(now.getTime() + KST_OFFSET_MS + offsetDays * 86400e3);
}

/** 오늘로부터 offsetDays 뒤의 한국 날짜. "2026-09-04" */
export function kstDate(offsetDays = 0, now = new Date()) {
  return shifted(offsetDays, now).toISOString().slice(0, 10);
}

/** 한국시간의 현재 시각을 분 단위로 반환합니다. 출항 시각 비교에 씁니다. */
export function kstMinutes(now = new Date()) {
  const d = shifted(0, now);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 한국 기준 연월. "202609" */
export function kstYm(offsetMonths = 0, now = new Date()) {
  const d = shifted(0, now);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 한국 기준 "지금". 연도 추론처럼 달력값이 필요할 때 씁니다. */
export function kstNow(now = new Date()) {
  const d = shifted(0, now);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
