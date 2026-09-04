// 지도에 찍을 항구 좌표. 좌표가 없는 항구는 조용히 빠지면 안 됩니다 —
// 화면에서 배가 사라진 것처럼 보이기 때문입니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { usedPorts } from '../core/ports.js';

const ports = {
  '충남 보령 오천항': { lat: 36.4, lng: 126.5 },
  '경기 화성 전곡항': { lat: 37.19, lng: 126.68, approx: false },
  '안 쓰는 항': { lat: 1, lng: 1 },
};

const trips = [
  { port: '충남 보령 오천항', status: 'open', seatsLeft: 3 },
  { port: '충남 보령 오천항', status: 'closed', seatsLeft: 0 },
  { port: '경기 화성 전곡항', status: 'few', seatsLeft: 1 },
  { port: '좌표 없는 항', status: 'open', seatsLeft: 5 },
  { port: null, status: 'open', seatsLeft: 2 },
];

test('쓰이는 항구만, 출조 수와 함께 넘긴다', () => {
  const { places } = usedPorts(trips, ports);

  assert.deepEqual(Object.keys(places).sort(), ['경기 화성 전곡항', '충남 보령 오천항']);
  assert.equal(places['충남 보령 오천항'].trips, 2);
  assert.equal(places['충남 보령 오천항'].open, 1, '빈자리 있는 출조만 따로 센다');
  assert.equal(places['경기 화성 전곡항'].open, 1, '잔여 적음도 빈자리로 센다');
});

test('좌표가 없는 항구는 이름을 알려준다', () => {
  const { missing } = usedPorts(trips, ports);
  assert.deepEqual(missing, ['좌표 없는 항'], 'sites/ports.json에 추가하라고 말해줄 수 있어야 한다');
});

test('좌표가 하나도 없으면 지도를 비운다', () => {
  const { places, missing } = usedPorts(trips, {});
  assert.deepEqual(places, {});
  assert.equal(missing.length, 3);
});

// registry에 적은 항구가 ports.json에 없으면 지도에서만 조용히 사라집니다.
// 실제로 홍원항·내포항이 좌표 없이 머지된 적이 있어 테스트로 막습니다.
test('켜져 있는 사이트의 항구는 모두 좌표가 있다', async () => {
  const { loadRegistry } = await import('../core/runner.js');
  const { loadPorts } = await import('../core/ports.js');

  const ports = await loadPorts();
  const missing = (await loadRegistry())
    .filter((s) => s.enabled !== false && s.port)
    .map((s) => s.port)
    .filter((port) => !ports[port]);

  assert.deepEqual([...new Set(missing)], [], 'sites/ports.json에 좌표를 추가하세요');
});

test('배별로 다른 출항지도 좌표가 있어야 한다', async () => {
  const { loadRegistry } = await import('../core/runner.js');
  const { loadPorts } = await import('../core/ports.js');

  const ports = await loadPorts();
  const missing = [];
  for (const site of await loadRegistry()) {
    if (site.enabled === false) continue;
    for (const boat of Object.values(site.boats ?? {})) {
      if (boat.port && !ports[boat.port]) missing.push(boat.port);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
