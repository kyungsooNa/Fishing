import { makeTrip, toStatus, toPrice } from '../core/schema.js';
import { upcomingDates } from '../core/runner.js';
export async function collect(site){
  return upcomingDates(4).map((date, i) => makeTrip(site, {
    boatName: ['악바리호','레드맨호','맥가이버호','악바리호'][i], port:'구매항', date, departTime:'05:30',
    status: toStatus(i===2?'마감':'예약가능', i===2?0:i+1),
    seatsLeft: i===2?0:i+1, seatsTotal:12, price: toPrice('12만원'), species:['주꾸미','갑오징어'], tide:'12물',
  }));
}
