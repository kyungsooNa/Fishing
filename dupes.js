#!/usr/bin/env node
// 같은 일정표를 두 번 긁고 있는 사이트를 찾습니다.
//
//   node dupes.js              진단만 — 무엇을 끌 수 있는지 보여줍니다
//   node dupes.js --disable    판정이 끝난 곳을 registry에서 끕니다
//   node dupes.js --from tmp/monitor.json   다른 수집 결과로 보기
//
// 선상24는 배마다 서브도메인을 주는데 어느 주소로 들어가든 함대 전체가 나옵니다.
// 그래서 한 선사의 주소를 두 개 등록하면 같은 출조가 현황판에 두 줄로 뜹니다.
// registry만 봐서는 알 수 없고(주소도 이름도 다릅니다) 수집 결과를 봐야 압니다.

import { readFile, writeFile } from 'node:fs/promises';
import { load, DATA_PATH } from './core/store.js';
import { findDuplicates, disableInRegistry } from './core/dupes.js';
import { REGISTRY_PATH } from './core/runner.js';

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const valueOf = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : null;
};

const dataPath = valueOf('--from') ?? DATA_PATH;
const data = await load(dataPath);

if (!data.trips?.length) {
  console.error(`${dataPath} 에 출조가 없습니다. 먼저 수집하세요 — npm run collect`);
  process.exit(1);
}

const { groups, reviews } = findDuplicates(data.trips);
console.log(`${dataPath} — 출조 ${data.trips.length}건 / 사이트 ${Object.keys(data.sites ?? {}).length}곳\n`);

if (groups.length) {
  console.log('■ 같은 일정표 — 한 곳만 남기면 됩니다');
  for (const g of groups) {
    console.log(`\n  남김: ${g.keep} (${g.keepBoats.join(', ')})`);
    for (const d of g.drop) console.log(`  끔  : ${d.id} — ${d.count}건, ${d.boats.join(', ')}`);
  }
  const saved = groups.reduce((sum, g) => sum + g.saved, 0);
  const count = groups.reduce((sum, g) => sum + g.drop.length, 0);
  console.log(`\n  → ${count}곳을 끄면 중복 ${saved}건이 없어집니다.`);
} else {
  console.log('■ 자동으로 정리할 중복은 없습니다.');
}

if (reviews.length) {
  // 많이 겹치는 쌍만 보여줍니다. 하루 이틀 겹치는 건 대개 다른 지역의 동명이배라
  // 전부 늘어놓으면 볼 것과 안 볼 것이 섞입니다. 다 보려면 --all.
  const shown = flags.includes('--all') ? reviews : reviews.filter((r) => r.overlap >= 5).slice(0, 10);

  console.log('\n■ 사람이 봐야 하는 것 — 값이 갈려 자동으로 못 정합니다');
  for (const r of shown) {
    console.log(`\n  ${r.sites.join(' / ')} — 같은 자리 ${r.overlap}건 겹침`);
    console.log(`    겹치는 배: ${r.shared.join(', ')}`);
    console.log(`    ${r.reason}`);
  }
  if (shown.length < reviews.length) {
    console.log(`\n  … 외 ${reviews.length - shown.length}쌍 (겹침이 적어 동명이배로 보입니다. --all 로 전부)`);
  }
  console.log('\n  peek으로 양쪽 페이지를 대조해서 같은 배인지 보세요 — Actions 탭 → peek → Run workflow.');
}

if (flags.includes('--disable')) {
  if (!groups.length) {
    console.log('\n끌 것이 없습니다.');
  } else {
    let text = await readFile(REGISTRY_PATH, 'utf8');
    // 원래 메모는 남깁니다 — discover가 적어둔 출항지·전화번호 후보가 거기 있고,
    // 그건 이 사이트를 껐다고 없어지는 정보가 아닙니다.
    const wasNoted = new Map(JSON.parse(text).sites.map((s) => [s.id, s.note]));
    let n = 0;
    for (const g of groups) {
      for (const d of g.drop) {
        text = disableInRegistry(text, d.id, noteFor(g.keep, d, wasNoted.get(d.id)));
        n += 1;
      }
    }
    await writeFile(REGISTRY_PATH, text, 'utf8');
    console.log(`\n${REGISTRY_PATH} 에서 ${n}곳을 껐습니다. diff를 보고 남길 쪽이 맞는지 확인하세요.`);
  }
}

function noteFor(keep, dropped, before) {
  return `[dupes] ${keep}와 같은 일정표라 껐습니다 — 겹치는 배(${dropped.boats.join(', ')})의 출조가 `
    + '날짜·출항시각·잔여석까지 같습니다. 둘 다 켜면 같은 출조가 두 줄로 뜹니다'
    + '(전화번호가 없어 core/merge.js가 못 합칩니다). 배를 더 많이 주는 쪽을 남겼습니다.'
    + (before ? ` — 원래 메모: ${before}` : '');
}
