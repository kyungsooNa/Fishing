// 가장 짧은 어댑터 예시. 네트워크 없이 파이프라인을 확인할 때 씁니다.

import { makeTrip } from '../core/schema.js';
import { kstDate } from '../core/when.js';

export async function collect(site) {
  const rows = [
    { d: 0, boat: '모형호', time: '05:30', species: '우럭', seats: 6, raw: '남은자리 6명' },
    { d: 1, boat: '모형호', time: '05:30', species: '광어', seats: 0, raw: '예약마감' },
    { d: 2, boat: '모형2호', time: '13:00', species: '주꾸미', seats: 2, raw: '남은자리 2명' },
    { d: 3, boat: '모형2호', time: '13:00', species: '갑오징어', seats: null, raw: '휴항' },
  ];

  return rows.map((r) =>
    makeTrip(site, {
      boat: r.boat,
      date: kstDate(r.d),
      departAt: r.time,
      species: r.species,
      tide: '7물',
      status: r.raw,
      seatsLeft: r.seats,
    }),
  );
}
