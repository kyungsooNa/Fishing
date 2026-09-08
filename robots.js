#!/usr/bin/env node
// 이 사이트가 "받아가도 된다"고 했는지 봅니다.
//
//   node robots.js sunsang24.com thefishing.kr
//   node robots.js --path /ship/schedule_fleet sunsang24.com
//   node robots.js --sites            registry에 켜져 있는 사이트의 도메인 전부
//
// 새 플랫폼을 붙이기 전에 이걸 먼저 돌립니다(PLATFORMS.md). 막아둔 곳은 구현하지 않고
// 공식 연동 대상으로 돌립니다 — 우회하지 않습니다.
//
// 개발 환경에서는 국내 도메인이 막혀 있어 여기서는 못 돌립니다.
// Actions 탭 → robots → Run workflow 로 러너에서 돌리세요(peek·discover와 같은 이유).

import { fetchHtml, describeError } from './core/fetcher.js';
import { parseRobots, isAllowed, groupFor } from './core/robots.js';
import { loadRegistry } from './core/runner.js';

// 우리가 실제로 보내는 User-Agent와 같아야 합니다(core/fetcher.js).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const path = valueOf('--path') ?? '/';
let hosts = argv.filter((a) => !a.startsWith('--') && a !== path);

if (argv.includes('--sites')) {
  const registry = await loadRegistry();
  hosts = [...new Set(registry.filter((s) => s.enabled !== false)
    .map((s) => { try { return new URL(s.url).hostname; } catch { return null; } })
    .filter(Boolean))];
}

if (!hosts.length) {
  console.error('도메인을 적으세요 — node robots.js sunsang24.com (또는 --sites)');
  process.exit(1);
}

console.log(`확인할 경로: ${path}\nUser-Agent: ${UA.slice(0, 40)}…\n`);

for (const host of hosts) {
  const url = host.startsWith('http') ? host : `https://${host}/robots.txt`;
  try {
    const text = await fetchHtml(url, { mode: 'static' });
    // robots.txt 자리에 HTML이 오면 그 사이트는 robots.txt가 없는 것입니다(404 페이지).
    if (/<html/i.test(text)) {
      console.log(`${host.padEnd(28)} robots.txt 없음(HTML이 돌아옴) — 제한 없음으로 봅니다`);
      continue;
    }
    const robots = parseRobots(text);
    const group = groupFor(robots, UA);
    const got = isAllowed(robots, UA, path);

    console.log(`${host.padEnd(28)} ${got.allowed ? '허용' : '금지'}`
      + (got.rule ? ` (${got.rule.allow ? 'Allow' : 'Disallow'}: ${got.rule.path})` : ' (맞는 규칙 없음)')
      + (group ? ` · 그룹 [${group.agents.join(', ')}]` : '')
      + (got.crawlDelay != null ? ` · Crawl-delay ${got.crawlDelay}초` : ''));
    if (robots.sitemaps.length) console.log(`${' '.repeat(29)}Sitemap: ${robots.sitemaps.join(', ')}`);
  } catch (err) {
    // 못 받은 것을 허용으로 치지 않습니다. 모르는 건 모르는 겁니다.
    console.log(`${host.padEnd(28)} 모름 — ${describeError(err)}`);
  }
}

console.log('\n우리 User-Agent는 브라우저를 흉내 냅니다. robots는 이름으로 대상을 가르므로,');
console.log('지금 적용되는 것은 사실상 * 그룹입니다. 봇 이름을 밝히는 편이 정직하지만');
console.log('그 순간 이름으로 막는 사이트가 생깁니다 — 바꾸려면 이 값을 재고 정하세요.');
