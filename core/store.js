import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tripKey } from './schema.js';

/**
 * GitHub Actions에는 살아있는 DB가 없다. 대신 결과를 JSON 한 덩어리로 만들어
 * 레포에 커밋하고, GitHub Pages가 그걸 그대로 서빙한다.
 *
 * 이전 실행 결과를 먼저 읽어두는 이유:
 * 특정 사이트 수집이 실패해도 그 사이트의 지난 데이터를 지우지 않기 위해서다.
 * (대신 stale: true 로 표시해서 화면에서 "n분 전 기준"으로 보여준다)
 */
export async function openStore(path = './docs/data.json') {
  let prev = { trips: [], sites: {} };
  try {
    prev = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // 첫 실행
  }

  const before = prev.trips ?? []; // 알림용: 이번 실행 전 상태를 그대로 보관
  const trips = new Map();
  for (const t of before) trips.set(tripKey(t), t);

  const sites = { ...(prev.sites ?? {}) };
  const touched = new Set(); // 이번에 성공한 사이트

  return {
    /** 이번 실행 전의 스냅샷 (변화 감지에 쓴다) */
    before,

    /** 사이트별 마지막 수집 시각 (사이트마다 주기를 다르게 줄 때 쓴다) */
    lastRun: (siteId) => sites[siteId]?.ranAt ?? null,

    save(siteId, list) {
      // 성공한 사이트는 기존 데이터를 통째로 교체한다.
      // 그래야 원본에서 사라진 출조(취소된 배)가 화면에 남지 않는다.
      for (const [key, t] of trips) if (t.siteId === siteId) trips.delete(key);
      for (const t of list) trips.set(tripKey(t), t);
      touched.add(siteId);
      sites[siteId] = { ok: true, count: list.length, ranAt: new Date().toISOString(), error: null };
    },

    fail(siteId, err) {
      sites[siteId] = {
        ...(sites[siteId] ?? {}),
        ok: false,
        error: String(err?.message ?? err),
        ranAt: new Date().toISOString(),
      };
    },

    async flush() {
      const today = new Date().toISOString().slice(0, 10);
      const rows = [...trips.values()]
        .filter((t) => t.date >= today) // 지난 날짜 정리
        .map((t) => ({ ...t, stale: !touched.has(t.siteId) }))
        .sort((a, b) =>
          a.date.localeCompare(b.date) ||
          String(a.departTime).localeCompare(String(b.departTime)) ||
          a.boatName.localeCompare(b.boatName, 'ko'),
        );

      const out = { updatedAt: new Date().toISOString(), sites, trips: rows };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(out, null, 1) + '\n', 'utf8');
      this.rows = rows;
      return rows.length;
    },
  };
}
