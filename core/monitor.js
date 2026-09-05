// 로컬 서버의 전체 수집과 관심 출조를 한 스케줄러에서 돌립니다.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectSite, loadRegistry, pruneOld, sortTrips } from './runner.js';
import { load } from './store.js';
import { gapKey } from './fetcher.js';
import { mergeDuplicates } from './merge.js';
import { findOpenings } from './diff.js';
import { tripKey } from './schema.js';
import { platformOf } from './platform.js';
import { notify } from './notify.js';
import { loadPorts, usedPorts } from './ports.js';

export const FULL_MS = 60 * 60 * 1000;
export const WATCH_MS = 3 * 60 * 1000;

export function createMonitor({
  registryPath = 'sites/registry.json', dataPath = 'docs/data.json',
  statePath = 'tmp/monitor.json', collect = collectSite, send = notify,
  clock = Date.now, readRegistry = () => loadRegistry(registryPath),
} = {}) {
  let base, ports = {}, sites = [], watches = [], records = {}, timer, stopped = false;
  let saving = Promise.resolve(), ticking = false;
  const busy = new Set(), pending = new Set();
  const log = [];
  const addLog = (s) => { log.push(s); if (log.length > 100) log.shift(); };
  const activeWatches = () => pruneOld(watches, 21, new Date(clock()));
  const interested = (id) => activeWatches().some((w) => w.siteId === id);
  const interval = (id) => interested(id) ? WATCH_MS : FULL_MS;
  const nextAt = (s) => {
    const r = records[s.id];
    if (!r) return 0;
    const delay = r.failures ? Math.min(FULL_MS, interval(s.id) * 2 ** Math.min(r.failures, 5)) : interval(s.id);
    return r.attempted + delay;
  };
  const persist = () => {
    const text = JSON.stringify({ watches, records });
    const operation = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath + '.next', text);
      await rename(statePath + '.next', statePath);
    });
    saving = operation;
    return operation;
  };

  async function init() {
    base = await load(dataPath);
    ports = await loadPorts();
    sites = await readRegistry();
    try {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      watches = Array.isArray(saved.watches) ? saved.watches : [];
      records = saved.records ?? {};
    } catch { /* 첫 실행 */ }
  }

  function data() {
    const enabled = new Set(sites.filter((s) => s.enabled !== false).map((s) => s.id));
    const fresh = new Set(Object.keys(records).filter((id) => enabled.has(id) && records[id].trips));
    // 옛 통합 결과를 다시 다른 출처의 원문으로 취급하면 잔여석을 부풀릴 수 있습니다.
    const untouched = base.trips.filter((t) => enabled.has(t.siteId) &&
      !(t.sources ?? [t]).some((s) => fresh.has(s.siteId)));
    const trips = sortTrips(mergeDuplicates(pruneOld([
      ...untouched,
      ...Object.entries(records).filter(([id]) => enabled.has(id)).flatMap(([, r]) => r.trips ?? []),
    ], 21, new Date(clock()))));
    const status = Object.fromEntries(sites.filter((s) => enabled.has(s.id)).map((s) => [s.id, {
      ...base.sites[s.id], name: s.name ?? s.id, url: s.url,
      port: s.port, phone: s.phone, addedBy: s.addedBy, platform: platformOf(s).label,
      ...(records[s.id]?.status ?? {}),
    }]));
    const times = Object.values(records).map((r) => r.status?.at).filter(Boolean).sort();
    return { ...base, trips, sites: status, ports: usedPorts(trips, ports).places,
      generatedAt: times.at(-1) ?? base.generatedAt };
  }

  function status() {
    const enabled = sites.filter((s) => s.enabled !== false);
    const running = busy.size > 0 || enabled.some((s) => nextAt(s) <= clock());
    return {
      watches: activeWatches(), fullMinutes: 60, watchMinutes: 3,
      running, log: [...log], code: running ? null : 0,
      overdue: enabled.filter((s) => interested(s.id) && clock() > nextAt(s) + WATCH_MS).length,
      notificationConfigured: Boolean((process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) || process.env.DISCORD_WEBHOOK),
    };
  }

  async function setWatch(key, enabled) {
    const existing = watches.find((w) => tripKey(w) === key);
    const trip = data().trips.find((t) => tripKey(t) === key);
    if (!existing && !trip) throw new Error('목록에 없는 출조입니다');
    const source = existing ?? trip;
    const ids = (trip?.sources ?? [source]).map((s) => s.siteId);
    const next = activeWatches().filter((w) => !(ids.includes(w.siteId) && w.boat === source.boat &&
      w.date === source.date && w.departAt === source.departAt));
    if (enabled) {
      if (next.length + ids.length > 50) throw new Error('관심 출조는 최대 50개입니다');
      for (const siteId of ids) next.push({ siteId, boat: source.boat, date: source.date, departAt: source.departAt });
    }
    watches = next;
    await persist();
    return status();
  }

  async function collectOne(site) {
    const old = records[site.id];
    const attempted = clock();
    try {
      const trips = mergeDuplicates(pruneOld(await collect({ ...site, days: 21 }), 21, new Date(clock())));
      const at = new Date(clock()).toISOString();
      records[site.id] = { attempted, failures: 0, trips,
        status: { ok: true, at, count: trips.length } };
      // 이전에 직접 확인한 원문끼리만 비교합니다. 초기 통합값은 출처별 기준이 아닙니다.
      const keys = new Set(activeWatches().map(tripKey));
      const openings = findOpenings(old?.trips ?? [], trips).filter((t) => keys.has(tripKey(t)));
      addLog(`${site.name ?? site.id}: ${trips.length}건 확인${openings.length ? ` · 취소석/자리 증가 ${openings.length}건` : ''}`);
      await persist();
      if (openings.length) {
        try { await send(openings); }
        catch (err) { addLog(`알림 실패: ${err.message}`); }
      }
    } catch (err) {
      const previous = old?.status ?? base.sites[site.id];
      records[site.id] = { ...old, attempted, failures: (old?.failures ?? 0) + 1,
        status: { ok: false, at: new Date(clock()).toISOString(), error: err.message,
          keptFrom: previous?.ok ? previous.at : previous?.keptFrom,
          count: old?.trips?.length ?? previous?.count ?? 0 } };
      addLog(`${site.id}: 실패 — ${err.message}`);
      await persist();
    }
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      sites = await readRegistry();
      if (stopped) return;
      const due = sites.filter((s) => s.enabled !== false && nextAt(s) <= clock());
      // 같은 플랫폼은 한 번에 하나, 전체 동시 실행은 여섯 개까지입니다.
      due.sort((a, b) => Number(interested(b.id)) - Number(interested(a.id)) || nextAt(a) - nextAt(b));
      for (const site of due) {
        const group = site.url ? gapKey(site.url) : site.id;
        if (busy.has(group) || busy.size >= 6) continue;
        busy.add(group);
        const task = collectOne(site).catch((e) => addLog(`저장 실패: ${e.message}`)).finally(() => {
          busy.delete(group); pending.delete(task);
        });
        pending.add(task);
      }
    } finally { ticking = false; }
  }
  function start() {
    stopped = false;
    timer = setInterval(() => tick().catch((e) => addLog(e.message)), 1000);
    timer.unref();
    void tick().catch((e) => addLog(e.message));
  }
  async function stop() { stopped = true; clearInterval(timer); await Promise.allSettled([...pending]); await saving.catch(() => {}); }
  function requestFull() { for (const r of Object.values(records)) r.attempted = 0; }
  return { init, data, status, setWatch, tick, start, stop, requestFull,
    idle: () => Promise.allSettled([...pending]) };
}
