#!/usr/bin/env node
// 어댑터 고칠 때 쓰는 도구. 파싱 결과를 표로 보여주고 흔한 증상을 짚어줍니다.
//
//   node debug.js                 등록된 사이트 id 목록
//   node debug.js akbari          한 곳만 돌려보기
//   node debug.js akbari --dump   원본 HTML을 tmp/ 에 저장
//   node debug.js akbari --peek   페이지가 어떻게 생겼는지 로그로 요약 (원격에서 볼 때)

import { mkdir, writeFile } from 'node:fs/promises';
import { loadRegistry, collectSite } from './core/runner.js';
import { platformOf } from './core/platform.js';
import * as cheerio from 'cheerio';

// 최상위에서 바로 쓰이므로 함수보다 위에 있어야 합니다(const는 호이스팅돼도 초기화 전엔 못 씁니다).
const MARKERS = ['운항시간', '남은자리', '예약마감', '잔여', '출조', '물때', '예약', '출항', '마감'];
import { fetchHtml, closeBrowser, describeError } from './core/fetcher.js';

const [id, ...flags] = process.argv.slice(2);
const dump = flags.includes('--dump');
const peek = flags.includes('--peek');
const days = Number(process.env.DAYS ?? 7);
const registry = await loadRegistry();

if (!id) {
  console.log('등록된 사이트:\n');
  for (const s of registry) {
    const mark = s.enabled === false ? '  ' : '✓ ';
    console.log(`${mark}${s.id.padEnd(14)} ${(s.name ?? '').padEnd(18)} [${platformOf(s).label}]`);
  }
  console.log('\n사용법: node debug.js <id> [--dump] [--peek]');
  process.exit(0);
}

const site = registry.find((s) => s.id === id);
if (!site) {
  console.error(`'${id}' 가 registry에 없습니다. 등록된 id: ${registry.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

console.log(`${site.name ?? site.id} [${platformOf(site).label}] ${site.adapter} — ${site.url}\n`);

try {
  if (peek) await peekPages(site);
  const trips = await collectSite({ ...site, days });
  report(trips);
} catch (err) {
  console.error(`실패: ${describeError(err)}\n`);
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

// site.url이 아니라 어댑터가 실제로 긁는 주소를 봅니다.
// sunsang24는 메인이 아니라 /ship/schedule_fleet 에 일정이 있습니다.
async function targetUrls(site) {
  try {
    const { targets } = await import(`./adapters/${site.adapter}.js`);
    return targets?.(site) ?? [site.url];
  } catch {
    return [site.url];
  }
}

async function dumpHtml(site) {
  const urls = await targetUrls(site);
  await mkdir('tmp', { recursive: true });
  for (const [i, url] of urls.entries()) {
    try {
      const html = await fetchHtml(url, { mode: site.mode ?? 'auto', waitFor: site.waitFor });
      const path = `tmp/${site.id}${i ? `-${i}` : ''}.html`;
      await writeFile(path, html, 'utf8');
      console.error(`${url}\n  → ${path} (${html.length.toLocaleString()}자)`);
    } catch (err) {
      console.error(`${url}\n  → 못 받았습니다: ${describeError(err)}`);
    }
  }
}

/**
 * 페이지가 어떻게 생겼는지 로그로 요약합니다.
 * 도메인이 막힌 곳에서는 HTML을 직접 볼 수 없어서, Actions 로그로 대신 봅니다.
 */
async function peekPages(site) {
  for (const url of await targetUrls(site)) {
    console.log(`\n─── ${url}`);
    let html;
    try {
      html = await fetchHtml(url, { mode: site.mode ?? 'auto', waitFor: site.waitFor });
    } catch (err) {
      console.log(`  못 받았습니다: ${describeError(err)}`);
      continue;
    }

    const scripts = (html.match(/<script/gi) ?? []).length;
    const bare = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const text = bare.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');
    const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

    console.log(`  ${html.length.toLocaleString()}자 · <table> ${(html.match(/<table/gi) ?? []).length}` +
      ` · <tr> ${(html.match(/<tr/gi) ?? []).length} · <li> ${(html.match(/<li[ >]/gi) ?? []).length}` +
      ` · <script> ${scripts}`);
    console.log(`  제목: ${html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() ?? '(없음)'}`);

    const found = MARKERS.filter((m) => html.includes(m));
    console.log(`  표기: ${found.length ? found.join(', ') : '하나도 없음 — 표기가 다르거나 JS로 그립니다'}`);

    const hits = lines.filter((l) => MARKERS.some((m) => l.includes(m))).slice(0, 20);
    if (hits.length) {
      console.log('  표기가 있는 줄:');
      for (const l of hits) console.log(`    | ${l.slice(0, 160)}`);
    }

    // 파서가 보는 것과 같은 후보 행을 직접 찍습니다. 왜 0건인지는 여기서 갈립니다.
    const $ = cheerio.load(html);
    const rows = $('tr, li, .row, .list_item').toArray()
      .filter((el) => !$(el).find('tr, li').length)
      .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const withMarker = rows.filter((t) => MARKERS.some((m) => t.includes(m)));
    console.log(`  후보 행 ${rows.length}개 중 표기 있는 행 ${withMarker.length}개`);
    for (const t of withMarker.slice(0, 12)) console.log(`    > ${t.slice(0, 200)}`);
    if (!withMarker.length) {
      console.log('  (표기 있는 행이 없어 아무 행이나 보여줍니다)');
      for (const t of rows.slice(0, 12)) console.log(`    > ${t.slice(0, 200)}`);
    }
  }
  console.log('');
}
