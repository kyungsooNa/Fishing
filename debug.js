// 사이트 하나만 골라서 돌려보고, 실패하면 원인을 볼 수 있게 원본을 떨궈준다.
//
//   node debug.js akbari            # 파싱 결과만
//   node debug.js akbari --dump     # 받아온 HTML을 tmp/akbari.html 로 저장
//   node debug.js akbari --days 3
//
// 어댑터를 고칠 때는 --dump 로 실제 HTML을 받아두고, 그걸 tmp/ 에서 열어
// 셀렉터나 텍스트 패턴을 확인하는 흐름이 가장 빠르다.

import { mkdir, writeFile } from 'node:fs/promises';
import { loadSites } from './core/runner.js';
import { closeBrowser } from './core/fetcher.js';

const [id, ...rest] = process.argv.slice(2);
const dump = rest.includes('--dump');
const days = Number(rest[rest.indexOf('--days') + 1]) || 7;

if (!id) {
  const sites = await loadSites();
  console.log('사용법: node debug.js <사이트id> [--dump] [--days N]\n');
  console.log('등록된 id:', sites.map((s) => s.id).join(', '));
  process.exit(1);
}

const sites = await loadSites();
const site = sites.find((s) => s.id === id);
if (!site) {
  console.error(`'${id}' 를 registry.json 에서 못 찾았습니다.`);
  process.exit(1);
}

// --dump: 어댑터가 부르는 fetch를 가로채서 원본을 저장한다
if (dump) {
  await mkdir('tmp', { recursive: true });
  const fetcher = await import('./core/fetcher.js');
  const orig = fetcher.loadHtml;
  let n = 0;
  Object.defineProperty(fetcher, 'loadHtml', {
    value: async (url, opts) => {
      const result = await orig(url, opts);
      const file = `tmp/${id}${n++ ? `-${n}` : ''}.html`;
      await writeFile(file, result.$.html(), 'utf8');
      console.log(`  [dump] ${url}\n         → ${file} (${result.mode})`);
      return result;
    },
    configurable: true,
  });
}

console.log(`\n${site.name} (${site.id})`);
console.log(`  어댑터: ${site.adapter} · mode: ${site.mode ?? 'auto'}${site.source ? ` · source: ${site.source}` : ''}`);
console.log(`  ${site.url}\n`);

const started = Date.now();
try {
  const trips = await site.collect(site, { days });
  console.log(`${trips.length}건 · ${Date.now() - started}ms\n`);

  for (const t of trips.slice(0, 30)) {
    const seats = t.seatsLeft != null ? `${t.seatsLeft}/${t.seatsTotal ?? '?'}` : '-';
    console.log(
      [
        t.date,
        (t.tide ?? '-').padEnd(4),
        t.boatName.padEnd(14),
        (t.departTime ?? '-').padEnd(5),
        t.status.padEnd(9),
        seats.padEnd(7),
        t.species.join(',') || '-',
      ].join(' '),
    );
  }
  if (trips.length > 30) console.log(`... 외 ${trips.length - 30}건`);

  // 자주 나오는 문제들을 미리 짚어준다
  const warn = [];
  if (trips.some((t) => t.status === 'unknown')) warn.push('status가 unknown인 행이 있습니다 — 잔여석 표기를 못 읽었습니다');
  if (trips.every((t) => t.seatsLeft == null)) warn.push('잔여석이 전부 비어있습니다');
  if (new Set(trips.map((t) => t.date)).size === 1 && days > 1)
    warn.push('날짜가 하루뿐입니다 — 날짜별 주소(dayPath)가 안 먹는지 확인하세요');
  if (trips.some((t) => t.boatName.length > 12)) warn.push('배 이름이 비정상적으로 깁니다 — 파싱 범위가 틀렸을 수 있습니다');
  if (warn.length) console.log('\n확인 필요:\n  - ' + warn.join('\n  - '));
} catch (err) {
  console.error(`실패: ${err.message}\n`);
  if (!dump) console.error('--dump 를 붙여 다시 돌리면 받아온 HTML이 tmp/ 에 저장됩니다.');
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
