// docs/data.json 읽기·쓰기.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DATA_PATH = 'docs/data.json';

const EMPTY = { generatedAt: null, sites: {}, trips: [] };

export async function load(path = DATA_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return { ...EMPTY, ...parsed };
  } catch {
    // 첫 실행이거나 파일이 깨졌을 때. 수집은 계속 진행합니다.
    return { ...EMPTY };
  }
}

export async function save(data, path = DATA_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
