#!/usr/bin/env bash
# Ubuntu 22.04/24.04 기준. Oracle Cloud(ARM)와 카페24 VPS 둘 다 동작합니다.
#   bash deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "설치 경로: $APP_DIR"

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  echo "== Node 20 설치 =="
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "== 의존성 설치 =="
cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# registry에 mode:js 사이트가 있을 때만 크롬을 깐다 (ARM에서 몇 분 걸린다)
if grep -q '"mode": *"js"' sites/registry.json; then
  echo "== Playwright 크롬 설치 =="
  npm install playwright
  npx playwright install --with-deps chromium
else
  echo "== JS 렌더링 사이트 없음 — 크롬 설치 건너뜀 =="
fi

[ -f .env ] || { cp .env.example .env; echo "!! .env 를 만들었습니다. 알림 토큰을 채우세요."; }

echo "== systemd 등록 =="
sudo cp deploy/fishing-agg.service deploy/fishing-agg.timer deploy/fishing-agg-web.service /etc/systemd/system/
sudo sed -i "s#__APP_DIR__#$APP_DIR#g; s#__USER__#$USER#g" \
  /etc/systemd/system/fishing-agg.service \
  /etc/systemd/system/fishing-agg-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now fishing-agg.timer fishing-agg-web.service

echo
echo "완료. 확인 명령:"
echo "  systemctl list-timers fishing-agg.timer   # 다음 실행 시각"
echo "  journalctl -u fishing-agg -f              # 수집 로그"
echo "  sudo systemctl start fishing-agg          # 지금 바로 한 번 돌리기"
