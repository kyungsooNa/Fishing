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
