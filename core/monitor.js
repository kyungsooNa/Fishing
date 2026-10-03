// 로컬 서버의 전체 수집과 관심 출조를 한 스케줄러에서 돌립니다.
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectSite, loadRegistry, nextMonthWindow, pruneOld, sortTrips } from './runner.js';
import { load } from './store.js';
import { gapKey } from './fetcher.js';
import { mergeDuplicates } from './merge.js';
import { findOpenings } from './diff.js';
import { tripKey } from './schema.js';
import { platformOf } from './platform.js';
import { notify } from './notify.js';
import { alertRecords, appendAlerts, dropRepeats, rememberSent } from './alerts.js';
import { loadWatchers, listOf, allWatches, setList, MAX_WATCHES } from './watchers.js';
import { loadPorts, usedPorts } from './ports.js';
import { kstDate } from './when.js';

export const FULL_MS = 60 * 60 * 1000;
export const WATCH_MS = 3 * 60 * 1000;

/**
 * 서버가 "이 IP는 그만"이라고 답한 상태코드. 선상24는 2026-09-17부터 한 IP가 27~31요청을
 * 넘기면 `HTTP 405`를 주고, 그 뒤로는 10초 간격으로 천천히 물어도 22분 동안 성공이 0곳이었습니다
 * (`core/runner.js`의 `ROTATE_PER_RUN` 설명). 로컬 모니터는 그 상한 없이 한 시간에 선상24
 * 153곳 × 최대 3요청을 보내서, 이 PC도 같은 식으로 막히면 매시간 다시 두드려 **풀릴 틈이
 * 없습니다** — 화면에는 Actions가 순서상 미뤄둔 며칠 전 값이 "수집 보류"로 계속 남습니다.
 * 404처럼 그 선사 하나만의 문제인 것은 넣지 않습니다.
 *
 * **503도 넣습니다.** 2026-10-03에 이 PC에서 선상24가 **모든 선사에** `HTTP 503`을 줬는데,
 * 같은 시각 Actions 수집 80번치에는 503이 한 번도 없었습니다 — 서버가 죽은 게 아니라 이 IP를
 * 503으로 거절한 것입니다. 여기 없어서 매시간 153곳을 계속 두드렸고, "선사 최신화"도 계속
 * 실패했습니다. 진짜 일시 장애여도 그 서버를 잠시 쉬는 것이 맞는 답이라 잃을 것이 없습니다.
 */
const BLOCK_STATUSES = new Set([403, 405, 429, 503]);
export const BLOCK_MS = 60 * 60 * 1000;
const BLOCK_MAX_MS = 6 * 60 * 60 * 1000;
const blockStatusOf = (err) => {
  for (let cur = err, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    if (BLOCK_STATUSES.has(cur.status)) return cur.status;
  }
  return null;
};

export function createMonitor({
  registryPath = 'sites/registry.json', dataPath = 'docs/data.json',
  statePath = 'tmp/monitor.json', collect = collectSite, send = notify, writeAlerts = appendAlerts,
  clock = Date.now, readRegistry = () => loadRegistry(registryPath),
} = {}) {
  // 감시 목록은 사람(브라우저 토큰의 해시)마다 따로 둡니다(core/watchers.js).
  // legacy는 사용자 구분이 없던 시절의 목록입니다 — 주인을 모르니 아무에게나 주지 않고,
  // 로컬 화면이 처음 붙을 때 그 사람에게 넘깁니다(adopt).
  let base, baseMark = null, ports = {}, sites = [], watchers = {}, legacy = [], records = {}, timer, stopped = false;
  // GitHub 러너에서 더피싱이 막혀도 국내 PC의 로컬 수집이 3개월 일정을 채울 수 있습니다.
  // 가까운 출조와 섞으면 3분 감시 대상까지 불어나므로 상태 파일 안에서 따로 보관합니다.
  let futureTrips = [], futureCursors = {};
  // 이미 보낸 소식. 3분마다 보니 같은 자리가 붙었다 떨어졌다 하면 계속 울립니다(core/alerts.js).
  let sentAlerts = {};
  // 막힌 서버(gapKey 단위)와 언제까지 쉬는지. 한 선사가 막히면 같은 서버의 나머지도 같은
  // 답을 받으니 서버째 쉽니다. 연달아 막히면 1·2·4시간으로 늘려 6시간에서 멈춥니다.
  // 쉬는 동안 안 본 선사는 `attempted`가 그대로라 풀리면 그쪽부터 봅니다 — 앞쪽만 갱신되지 않습니다.
  let blocked = {};
  // 사람이 누른 "선사 최신화". 서버가 쉬는 중이어도 그 한 곳은 시도합니다.
  const forced = new Set();
  let saving = Promise.resolve(), ticking = false, fullRun = null;
  const busy = new Set(), pending = new Set();
  const log = [];
  const addLog = (s) => { log.push(s); if (log.length > 100) log.shift(); };
  // 수집 스케줄은 모두의 목록을 합쳐 정합니다. 한 번 받아 다 같이 나눠 씁니다.
  const activeWatches = () => pruneOld(allWatches(watchers, legacy), 21, new Date(clock()));
  const watchesOf = (id) => pruneOld(listOf(watchers, id), 21, new Date(clock()));
  const interested = (id) => activeWatches().some((w) => w.siteId === id);
  const interval = (id) => interested(id) ? WATCH_MS : FULL_MS;
  const groupOf = (site) => site.url ? gapKey(site.url) : site.id;
  const blockOf = (site) => {
    const b = blocked[groupOf(site)];
    return b && clock() < Date.parse(b.until) ? b : null;
  };
  const nextAt = (s) => {
    const r = records[s.id];
    if (!r) return 0;
    const delay = r.failures ? Math.min(FULL_MS, interval(s.id) * 2 ** Math.min(r.failures, 5)) : interval(s.id);
    return r.attempted + delay;
  };
  const persist = () => {
    const text = JSON.stringify({
      watchers, ...(legacy.length ? { watches: legacy } : {}), records, sentAlerts,
      ...(Object.keys(blocked).length ? { blocked } : {}),
      ...(futureTrips.length ? { futureTrips } : {}),
      ...(Object.keys(futureCursors).length ? { futureCursors } : {}),
    });
    const operation = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath + '.next', text);
      await rename(statePath + '.next', statePath);
    });
    saving = operation;
    return operation;
  };

  /**
   * 받아온 수집 결과를 다시 읽습니다.
   *
   * `docs/data.json`은 Actions가 매시간 수집해 커밋하고 run.bat이 켤 때 받아옵니다.
   * 켤 때 한 번만 읽으면, 그 뒤에 받은 값은 서버를 껐다 켜기 전까지 화면에 못 올라옵니다 —
   * 로컬 수집이 실패하는 선사는 그동안 통째로 시간이 멈춥니다. 그렇다고 6.7MB짜리를
   * tick마다 다시 파싱할 수는 없으니, 파일이 바뀐 것이 보일 때만 읽습니다.
   * 못 읽을 때(파일이 없거나 받는 중)는 들고 있던 것을 그대로 씁니다.
   */
  async function refreshBase() {
    const mark = await stat(dataPath).then(({ mtimeMs, size }) => `${mtimeMs}:${size}`, () => null);
    if (base && (mark === null || mark === baseMark)) return false;
    base = await load(dataPath);
    baseMark = mark;
    return true;
  }

  async function init() {
    await refreshBase();
    ports = await loadPorts();
    sites = await readRegistry();
    try {
      const saved = JSON.parse(await readFile(statePath, 'utf8'));
      ({ watchers, legacy } = loadWatchers(saved));
      records = saved.records ?? {};
      sentAlerts = rememberSent(saved.sentAlerts, [], { now: clock() });
      blocked = saved.blocked && typeof saved.blocked === 'object' ? saved.blocked : {};
      futureTrips = Array.isArray(saved.futureTrips) ? saved.futureTrips : [];
      futureCursors = saved.futureCursors && typeof saved.futureCursors === 'object' ? saved.futureCursors : {};
    } catch { /* 첫 실행 */ }
  }

  /**
   * 그 결과가 언제 본 값인가. 실패한 수집의 시각(`at`)은 "언제 시도했나"라서 화면에
   * 실린 값의 나이가 아닙니다 — 직전에 성공한 시각(`keptFrom`)으로 셉니다.
   */
  const snapAt = (s) => Date.parse(s?.ok ? s.at : s?.keptFrom) || 0;

  /**
   * 로컬 수집이 실패한 선사를 받아온 결과보다 더 낡은 채로 붙들고 있나.
   *
   * 실패한 선사는 직전 결과를 그대로 남깁니다. 그런데 그 사이에도 Actions는 매시간
   * 수집해 커밋하고 run.bat이 그걸 받아옵니다. 받아온 값이 더 새것인데 며칠 묵은 로컬
   * 결과로 덮으면 그 배만 현황판에서 시간이 멈춥니다 — 헌터호가 실제로 그랬습니다.
   * 사이트도 멀쩡했고 Actions 수집도 계속 성공하고 있었는데, 로컬에서만 실패해서
   * 나흘 전 잔여석이 "수집 실패 · 직전 4일 전 확인"으로 계속 떠 있었습니다.
   *
   * 그래서 실패한 선사는 둘 중 새 쪽을 씁니다. 성공한 수집은 따지지 않습니다 —
   * 방금 직접 확인한 값이고, 알림도 그 값으로 갑니다.
   */
  const stalled = (id) => {
    const local = records[id]?.status;
    return Boolean(local) && !local.ok && snapAt(base.sites[id]) > snapAt(local);
  };

  function data() {
    const enabled = new Set(sites.filter((s) => s.enabled !== false).map((s) => s.id));
    const fresh = new Set(Object.keys(records)
      .filter((id) => enabled.has(id) && records[id].trips && !stalled(id)));
    // 옛 통합 결과를 다시 다른 출처의 원문으로 취급하면 잔여석을 부풀릴 수 있습니다.
    const untouched = base.trips.filter((t) => enabled.has(t.siteId) &&
      !(t.sources ?? [t]).some((s) => fresh.has(s.siteId)));
    const trips = sortTrips(mergeDuplicates(pruneOld([
      ...untouched,
      ...[...fresh].flatMap((id) => records[id].trips),
    ], 21, new Date(clock()))));
    const status = Object.fromEntries(sites.filter((s) => enabled.has(s.id)).map((s) => [s.id, {
      ...base.sites[s.id], name: s.name ?? s.id, url: s.url,
      port: s.port, phone: s.phone, addedBy: s.addedBy, platform: platformOf(s).label,
      // 받아온 값을 쓰기로 한 선사는 그 값의 시각·건수를 그대로 답니다. 다만 이 PC의
      // 수집이 깨진 것은 남겨야 합니다 — 그래야 3분 감시가 왜 안 도는지 알 수 있습니다.
      ...(stalled(s.id) ? { localError: records[s.id].status.error } : records[s.id]?.status ?? {}),
      // 서버가 이 PC를 막아 쉬는 중인데 직접 확인한 값이 없는 선사. 받아온 값을 싣고 있어도
      // 그게 왜 안 갱신되는지 화면에 남겨야 "수집 보류"가 며칠씩 가는 이유를 압니다.
      ...(!records[s.id] && blockOf(s) ? { localError: blockNote(blockOf(s)) } : {}),
    }]));
    const times = Object.values(records).map((r) => r.status?.at).filter(Boolean).sort();
    return { ...base, trips, sites: status, ports: usedPorts(trips, ports).places,
      generatedAt: times.at(-1) ?? base.generatedAt };
  }

  function blockNote(b) {
    const until = new Date(b.until).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
    return `${b.error} — 서버가 이 PC를 막아 ${until}까지 쉽니다`;
  }

  function futureData() {
    const now = new Date(clock());
    const nearTo = kstDate(21, now);
    const trips = sortTrips(mergeDuplicates(
      pruneOld(futureTrips, 90, now).filter((t) => t.date > nearTo),
    ));
    return { generatedAt: new Date(clock()).toISOString(), horizonDays: 90, cursors: futureCursors, trips };
  }

  /**
   * `watcherId`가 있으면 **그 사람의 목록만** 돌려줍니다. 남의 감시는 응답에 싣지 않습니다 —
   * 목록만 봐도 누가 어느 배를 노리는지 드러납니다.
   */
  function status(watcherId = null) {
    const enabled = sites.filter((s) => s.enabled !== false);
    const running = busy.size > 0 || enabled.some((s) => nextAt(s) <= clock() && !blockOf(s));
    const done = fullRun ? fullRun.total - fullRun.pending.size : 0;
    return {
      watches: watchesOf(watcherId), fullMinutes: 60, watchMinutes: 3,
      running, log: [...log], code: running ? null : 0,
      progress: fullRun ? {
        done, total: fullRun.total,
        percent: fullRun.total ? Math.round(done / fullRun.total * 100) : 100,
      } : null,
      overdue: enabled.filter((s) => interested(s.id) && clock() > nextAt(s) + WATCH_MS).length,
      notificationConfigured: Boolean((process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) || process.env.DISCORD_WEBHOOK),
    };
  }

  async function setWatch(key, enabled, watcherId = null, { local = true } = {}) {
    if (!watcherId) throw new Error('감시를 걸려면 브라우저 식별자가 필요합니다');
    await adopt(watcherId, { local });
    const mine = watchesOf(watcherId);
    const existing = mine.find((w) => tripKey(w) === key);
    const trip = data().trips.find((t) => tripKey(t) === key);
    if (!existing && !trip) throw new Error('목록에 없는 출조입니다');
    const source = existing ?? trip;
    const ids = (trip?.sources ?? [source]).map((s) => s.siteId);
    const next = mine.filter((w) => !(ids.includes(w.siteId) && w.boat === source.boat &&
      w.date === source.date && w.departAt === source.departAt));
    if (enabled) {
      // 상한은 사람마다 셉니다. 한 벌로 세면 남이 채워서 내가 못 겁니다.
      if (next.length + ids.length > MAX_WATCHES) throw new Error(`관심 출조는 최대 ${MAX_WATCHES}개입니다`);
      for (const siteId of ids) next.push({ siteId, boat: source.boat, date: source.date, departAt: source.departAt });
    }
    watchers = setList(watchers, watcherId, next);
    await persist();
    return status(watcherId);
  }

  /**
   * 사용자 구분이 없던 시절의 목록을 처음 붙은 사람에게 넘깁니다.
   *
   * 그때는 서버가 루프백 전용이라 그 목록의 주인은 이 PC를 쓰던 사람 하나뿐입니다.
   * 그래서 **한 번만, 아직 아무 목록도 없는 사람에게만** 넘깁니다. 넘기고 나면 legacy는
   * 비워져서 다음 사람은 못 가져갑니다. 서버를 바깥에 열기 전에 끝나는 일입니다.
   */
  async function adopt(watcherId, { local = true } = {}) {
    // 바깥에서 온 요청에는 절대 넘기지 않습니다 — 남의 감시 목록을 통째로 가져가게 됩니다.
    if (!local || !legacy.length || !watcherId || listOf(watchers, watcherId).length) return false;
    watchers = setList(watchers, watcherId, legacy);
    legacy = [];
    addLog('사용자 구분이 없던 감시 목록을 이 브라우저로 옮겼습니다');
    await persist();
    return true;
  }

  /** 이 소식을 누구의 감시가 잡았나. 주인 없는 옛 목록(legacy)이 잡은 것은 주인이 없습니다. */
  const ownersOf = (opening) => Object.entries(watchers)
    .filter(([, list]) => list.some((w) => tripKey(w) === tripKey(opening)))
    .map(([id]) => id);

  async function record(openings, before, at, result, siteId) {
    try {
      await writeAlerts(alertRecords({ openings, at, since: { [siteId]: before }, result, ownersOf }));
    } catch (err) {
      addLog(`알림 이력 기록 실패: ${err.message}`);
    }
  }

  async function collectOne(site) {
    const old = records[site.id];
    const attempted = clock();
    try {
      const now = new Date(clock());
      const raw = await collect({ ...site, days: 21 });
      const trips = mergeDuplicates(pruneOld(raw, 21, now));
      const at = new Date(clock()).toISOString();
      records[site.id] = { attempted, failures: 0, trips,
        status: { ok: true, at, count: trips.length } };
      if (blocked[groupOf(site)]) {
        delete blocked[groupOf(site)];
        addLog(`${groupOf(site)}: 다시 열렸습니다`);
      }
      // 이전에 직접 확인한 원문끼리만 비교합니다. 초기 통합값은 출처별 기준이 아닙니다.
      const keys = new Set(activeWatches().map(tripKey));
      const openings = findOpenings(old?.trips ?? [], trips).filter((t) => keys.has(tripKey(t)));
      addLog(`${site.name ?? site.id}: ${trips.length}건 확인${openings.length ? ` · 취소석/자리 증가 ${openings.length}건` : ''}`);

      // 먼 일정은 한 시간 수집 차례마다 7일 창 하나만 더 봅니다. 이 PC에서 더피싱이
      // 열리는 경우 Actions의 해외 IP 차단과 무관하게 약 열 차례에 90일 범위를 채웁니다.
      const nearTo = kstDate(21, now);
      const horizonTo = kstDate(90, now);
      let mine = futureTrips.filter((t) => t.siteId === site.id && t.date > nearTo && t.date <= horizonTo);
      const replace = (rows, fresh, from, to) => [
        ...rows.filter((t) => t.date < from || t.date > to),
        ...fresh.filter((t) => t.date >= from && t.date <= to),
      ];
      const inherent = raw.filter((t) => t.date > nearTo && t.date <= horizonTo);
      if (inherent.length) {
        const dates = inherent.map((t) => t.date).sort();
        mine = replace(mine, inherent, dates[0], dates.at(-1));
      }
      if (site.adapter === 'thefishing' && site.source === 'detail') {
        const saved = Number(futureCursors[site.id]);
        const offset = Number.isInteger(saved) && saved >= 22 && saved <= 90 ? saved : 22;
        const window = Math.min(7, 91 - offset);
        const from = kstDate(offset, now), to = kstDate(offset + window - 1, now);
        try {
          const fresh = await collect({ ...site, days: window, startDay: offset });
          mine = replace(mine, fresh, from, to);
          futureCursors[site.id] = offset + window > 90 ? 22 : offset + window;
        } catch (err) {
          addLog(`${site.name ?? site.id}: 장기 일정 ${from}~${to} 실패 — ${err.message}`);
        }
      }
      if (site.adapter === 'sunsang24' && (site.monthPath || (site.path ?? 'schedule_fleet') === 'schedule_fleet')) {
        const window = nextMonthWindow(futureCursors[site.id], {
          minOffset: 22, maxOffset: 90, after: nearTo, now,
        });
        if (window) {
          try {
            const fresh = await collect({ ...site, days: 0, startDay: window.offset, allowEmpty: true });
            mine = replace(mine, fresh, window.from, window.to);
            futureCursors[site.id] = window.next > 90 ? 22 : window.next;
          } catch (err) {
            addLog(`${site.name ?? site.id}: 장기 일정 ${window.from}~${window.to} 실패 — ${err.message}`);
          }
        }
      }
      futureTrips = [
        ...futureTrips.filter((t) => t.siteId !== site.id && t.date > nearTo && t.date <= horizonTo),
        ...mine,
      ];
      await persist();
      if (openings.length) {
        // 같은 소식을 다시 울리지 않습니다. 몇 번 헛울리면 사람이 알림을 꺼버리고,
        // 그러면 정작 필요한 알림도 같이 잃습니다.
        const { fresh, repeats } = dropRepeats(openings, sentAlerts, { now: clock() });
        if (repeats.length) addLog(`이미 알린 소식 ${repeats.length}건은 건너뜁니다`);

        if (fresh.length) {
          // 관심 출조는 3분마다 봅니다. 그 주기가 실제로 값어치가 있는지는 여기 남는
          // 기록으로만 확인할 수 있습니다(node alerts.js) — 보냈든 못 보냈든 남깁니다.
          let result = null;
          try { result = await send(fresh, undefined, new Date(clock())); }
          catch (err) { addLog(`알림 실패: ${err.message}`); result = { attempted: [], sent: [], failed: [{ channel: '전체', error: err.message }] }; }
          // 보낸 것으로 치는 기준은 "보냈다"가 아니라 "보내려 했다"입니다. 채널이 죽어
          // 실패한 것을 3분 뒤에 또 시도하면 살아나는 순간 밀린 알림이 한꺼번에 옵니다.
          sentAlerts = rememberSent(sentAlerts, fresh, { now: clock() });
          // 여기서 한 번 더 저장합니다. 위(수집 직후)의 persist는 이 기록이 생기기 전이라,
          // 알린 직후에 서버가 죽으면 다시 떴을 때 같은 소식을 또 보냅니다.
          await persist();
          await record(fresh, old?.status?.at ?? null, at, result, site.id);
        }
      }
    } catch (err) {
      const previous = old?.status ?? base.sites[site.id];
      records[site.id] = { ...old, attempted, failures: (old?.failures ?? 0) + 1,
        status: { ok: false, at: new Date(clock()).toISOString(), error: err.message,
          keptFrom: previous?.ok ? previous.at : previous?.keptFrom,
          count: old?.trips?.length ?? previous?.count ?? 0 } };
      addLog(`${site.id}: 실패 — ${err.message}`);
      const code = blockStatusOf(err);
      if (code) {
        const group = groupOf(site);
        const streak = (blocked[group]?.streak ?? 0) + 1;
        const ms = Math.min(BLOCK_MS * 2 ** Math.min(streak - 1, 20), BLOCK_MAX_MS);
        blocked[group] = { until: new Date(clock() + ms).toISOString(), streak, error: `HTTP ${code}` };
        addLog(`${group}: HTTP ${code}로 막혔습니다 — ${Math.round(ms / 60000)}분 동안 이 서버는 쉽니다`);
      }
      await persist();
    } finally {
      fullRun?.pending.delete(site.id);
    }
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      sites = await readRegistry();
      // run.bat이 받아온(또는 collect.js가 새로 쓴) 결과가 있으면 그때 집어 올립니다.
      if (await refreshBase().catch((err) => { addLog(`받아온 결과 읽기 실패: ${err.message}`); return false; })) {
        addLog('받아온 수집 결과(docs/data.json)를 다시 읽었습니다');
      }
      if (stopped) return;
      const due = sites.filter((s) => s.enabled !== false && nextAt(s) <= clock());
      // 쉬는 서버의 선사는 이번 전체 수집에서 못 봅니다. 진행률이 거기서 멈추지 않게 뺍니다.
      for (const s of due) if (blockOf(s) && !forced.has(s.id)) fullRun?.pending.delete(s.id);
      // 같은 플랫폼은 한 번에 하나, 전체 동시 실행은 여섯 개까지입니다.
      due.sort((a, b) => Number(interested(b.id)) - Number(interested(a.id)) || nextAt(a) - nextAt(b));
      for (const site of due) {
        const group = groupOf(site);
        if (busy.has(group) || busy.size >= 6) continue;
        // 서버가 쉬는 중이면 건너뜁니다. 사람이 누른 "선사 최신화"만 시도합니다.
        if (blockOf(site) && !forced.has(site.id)) continue;
        forced.delete(site.id);
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
  function requestFull() {
    const ids = sites.filter((s) => s.enabled !== false).map((s) => s.id);
    fullRun = { total: ids.length, pending: new Set(ids) };
    for (const r of Object.values(records)) r.attempted = 0;
  }
  function requestSite(id) {
    const site = sites.find((candidate) => candidate.id === id);
    if (!site) throw new Error('등록되지 않은 선사입니다');
    if (site.enabled === false) throw new Error('꺼진 선사는 최신화할 수 없습니다');
    // 다음 tick에서 이 선사만 즉시 대상이 됩니다. 다른 선사의 주기는 건드리지 않습니다.
    if (records[id]) records[id].attempted = 0;
    forced.add(id);
    addLog(`${site.name ?? id}: 수동 최신화 요청`);
    return { siteId: id, requested: true };
  }
  return { init, data, futureData, status, setWatch, adopt, tick, start, stop, requestFull, requestSite,
    idle: () => Promise.allSettled([...pending]) };
}
