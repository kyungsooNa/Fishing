#!/usr/bin/env node
// 어댑터 고칠 때 쓰는 도구. 파싱 결과를 표로 보여주고 흔한 증상을 짚어줍니다.
//
//   node debug.js                 등록된 사이트 id 목록
//   node debug.js akbari          한 곳만 돌려보기
//   node debug.js akbari --dump   실패 시 원본 HTML을 tmp/ 에 저장

import { mkdir, writeFile } from 'node:fs/promises';
import { loadRegistry, collectSite } from './core/runner.js';
import { platformOf } from './core/platform.js';
import { fetchHtml, closeBrowser } from './core/fetcher.js';

const [id, ...flags] = process.argv.slice(2);
const dump = flags.includes('--dump');
const days = Number(process.env.DAYS ?? 7);
const registry = await loadRegistry();

if (!id) {
  console.log('등록된 사이트:\n');
  for (const s of registry) {
    const mark = s.enabled === false ? '  ' : '✓ ';
    console.log(`${mark}${s.id.padEnd(14)} ${(s.name ?? '').padEnd(18)} [${platformOf(s).label}]`);
  }
  console.log('\n사용법: node debug.js <id> [--dump]');
  process.exit(0);
}

const site = registry.find((s) => s.id === id);
if (!site) {
  console.error(`'${id}' 가 registry에 없습니다. 등록된 id: ${registry.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

console.log(`${site.name ?? site.id} [${platformOf(site).label}] ${site.adapter} — ${site.url}\n`);

try {
  const trips = await collectSite({ ...site, days });
  report(trips);
} catch (err) {
  console.error(`실패: ${err.message}\n`);
  if (dump) await dumpHtml(site);
  else console.error('원본 HTML을 보려면 --dump 를 붙이세요.');
  process.exitCode = 1;
} finally {
  await closeBrowser();
}

function report(trips) {
  if (!trips.length) {
    console.log('0건. 셀렉터나 주소가 안 맞는 것 같습니다. --dump 로 원본을 보세요.');
    return;
  }

  const rows = trips.slice(0, 40).map((t) => ({
    날짜: t.date ?? '-',
    출항: t.departAt ?? '-',
    배: t.boat ?? '-',
    어종: t.species ?? '-',
    물때: t.tide ?? '-',
    상태: t.status,
    잔여: t.seatsLeft ?? '-',
    가격: t.price ?? '-',
  }));
  console.table(rows);
  if (trips.length > rows.length) console.log(`… 외 ${trips.length - rows.length}건`);

  // 흔한 증상 짚기
  const dates = new Set(trips.map((t) => t.date));
  const warn = [];
  if (trips.every((t) => t.seatsLeft === null)) warn.push('잔여석이 전부 비었습니다 — 좌석 표기를 못 읽고 있습니다.');
  if (dates.size === 1) warn.push(`날짜가 ${[...dates][0]} 하루뿐입니다 — dayPath/월 주소가 안 먹는지 보세요.`);
  if (trips.every((t) => t.boat === (site.name ?? site.id))) warn.push('배 이름을 못 찾아 사이트 이름으로 대체했습니다.');
  if (trips.every((t) => t.species === null)) warn.push('어종이 전부 비었습니다 (index 방식이면 정상입니다).');
  if (trips.every((t) => t.price === null)) warn.push('가격이 전부 비었습니다 — registry의 prices를 채우세요.');

  console.log(`\n총 ${trips.length}건 / 날짜 ${dates.size}일 / 배 ${new Set(trips.map((t) => t.boat)).size}척`);
  for (const w of warn) console.log(`  ⚠ ${w}`);
}

async function dumpHtml(site) {
  try {
    const html = await fetchHtml(site.url, { mode: site.mode ?? 'auto', waitFor: site.waitFor });
    await mkdir('tmp', { recursive: true });
    const path = `tmp/${site.id}.html`;
    await writeFile(path, html, 'utf8');
    console.error(`원본을 ${path} 에 저장했습니다 (${html.length.toLocaleString()}자).`);
  } catch (err) {
    console.error(`원본도 못 받았습니다: ${err.message}`);
  }
}
