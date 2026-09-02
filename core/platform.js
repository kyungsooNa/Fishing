// 사이트가 어느 계열인지. 어댑터에서 자동으로 알아냅니다.
//
// 새 주소를 받았을 때 "이게 선상24냐 더피싱이냐 자체 사이트냐"를 매번 따져야 하는데,
// 한 번 정한 답이 registry에도 화면에도 남아있게 합니다. 수집이 실패했을 때
// 한 계열이 통째로 죽은 건지 그 사이트만 죽은 건지도 바로 보입니다.

const LABELS = {
  sunsang24: '선상24',
  thefishing: '더피싱',
  generic: '자체',
  _mock: '예시',
};

export function platformOf(site) {
  const id = site.adapter ?? 'unknown';
  if (site.platform) return { id, label: site.platform };

  let label = LABELS[id] ?? id;
  // 더피싱은 메인 요약(index)이냐 날짜별 상세(detail)냐에 따라 요청 수가 크게 다릅니다.
  if (id === 'thefishing' && site.source === 'detail') label += '(상세)';
  return { id, label };
}

// 어댑터마다 기본 수집 방식이 다릅니다. registry에 mode를 안 적었을 때 실제로 뭘 쓰는지.
const DEFAULT_MODE = {
  sunsang24: (site) => (site.path === 'schedule_fleet_simple_top' ? 'js' : 'static'),
  thefishing: () => 'static',
  generic: () => 'auto',
  _mock: () => 'none',
};

export function effectiveMode(site) {
  return site.mode ?? DEFAULT_MODE[site.adapter]?.(site) ?? 'auto';
}

/**
 * 워크플로가 playwright 브라우저를 받아야 하는지.
 *
 * "js" 사이트가 없으면 안 받아도 된다고 생각하기 쉬운데, "auto"도 본문이 비면
 * 브라우저로 넘어갑니다. 그때 브라우저가 없으면 그 사이트는 그냥 실패합니다.
 * 그래서 auto까지 세고, 전부 static이 되는 날 설치 단계가 저절로 건너뛰어집니다.
 */
export function needsBrowser(sites) {
  return sites
    .filter((s) => s.enabled !== false)
    .some((s) => ['js', 'auto'].includes(effectiveMode(s)));
}
