import assert from 'node:assert/strict';
import test from 'node:test';
import { repairStaleManualTerminalTravel } from '../src/modules/itineraries/engines/helpers/manual-terminal-travel-repair.helper';
import { findTerminalTravelAndOvernightRows } from '../src/modules/itineraries/engines/helpers/terminal-route-pair.helper';
const at = (s:string) => new Date('1970-01-01T'+s+':00Z');
const fixture = () => [
  {item_type:4,hotspot_ID:267,hotspot_start_time:at('10:00'),hotspot_end_time:at('12:00')},
  {item_type:4,hotspot_ID:89,hotspot_start_time:at('14:47'),hotspot_end_time:at('15:47')},
  {item_type:5,hotspot_start_time:at('11:00'),hotspot_end_time:at('18:21'),hotspot_travelling_distance:'329.78'},
  {item_type:6,hotspot_start_time:at('18:21'),hotspot_end_time:at('18:21')},
];
test('manual chain movement rebuilds the final journey from the new last attraction', async () => {
  const rows = fixture();
  assert.equal(findTerminalTravelAndOvernightRows(rows, at('15:47').getTime()), null);
  assert.equal(await repairStaleManualTerminalTravel(rows, async (last, previous) => {
    assert.equal(last.hotspot_ID, 89); assert.equal(previous.hotspot_travelling_distance, '329.78');
    return {item_type:5,hotspot_start_time:at('15:47'),hotspot_end_time:at('16:07'),hotspot_travelling_distance:'8.10'};
  }), true);
  assert.ok(findTerminalTravelAndOvernightRows(rows, at('15:47').getTime()));
  assert.equal(rows[2].hotspot_travelling_distance, '8.10');
});
test('hotel-first, valid final travel, no visits and ambiguous terminal legs remain untouched', async () => {
  for (const rows of [[], fixture().filter(x=>x.item_type!==4), [...fixture(),fixture()[2]],
    fixture().map(x=>x.item_type===6?{...x,hotspot_start_time:at('09:00'),hotspot_end_time:at('09:00')}:x),
    fixture().map(x=>x.item_type===5?{...x,hotspot_start_time:at('15:47')}:x)]) {
    const before=JSON.stringify(rows);
    assert.equal(await repairStaleManualTerminalTravel(rows, async()=>{throw Error('unexpected rebuild');}),false);
    assert.equal(JSON.stringify(rows),before);
  }
});
