import assert from 'node:assert/strict';
import test from 'node:test';
import { HotspotSegmentBuilder } from '../src/modules/itineraries/engines/helpers/hotspot-segment.builder';
import { buildSameCityRoutePolicyContexts, findSameCityPolicyViolations } from '../src/modules/itineraries/engines/helpers/same-city-hotspot-priority-policy';

test('materialized saved manual Ooty selection retains identity through final policy validation', async () => {
  const master = {hotspot_ID:335,hotspot_location:'Ooty',hotspot_to_location:'Ooty',hotspot_priority:26,status:1,deleted:0};
  const allHotspots = Array.from({length:28}, (_, i) => ({...master,hotspot_ID:1000+i,hotspot_priority:i+1}));
  allHotspots[25] = master;
  const contexts = buildSameCityRoutePolicyContexts([
    {itinerary_route_ID:1,itinerary_route_date:'2026-12-01',location_name:'Bangalore International Airport',next_visiting_location:'Ooty'},
    {itinerary_route_ID:2,itinerary_route_date:'2026-12-02',location_name:'Ooty',next_visiting_location:'Ooty'},
  ], x => x.toLowerCase());
  const tx = {dvi_hotspot_place:{findFirst:async () => master}} as any;
  const builder = new HotspotSegmentBuilder();
  const options = {planId:11713,routeId:2,order:2,hotspotId:335,startTime:'11:00:00',userId:1,totalAdult:2,totalChildren:0,totalInfants:0,nationality:1,itineraryPreference:2};
  const validate = (row: any) => findSameCityPolicyViolations({rows:[row],allHotspots,contexts,config:{enabled:true,maxPriority:30,baseIncrement:10,distributionMode:'BALANCED'},hotspotLocationMatchesCity:(a,b)=>a.toLowerCase()===b});
  const auto = (await builder.build(tx, options)).row;
  assert.equal(auto.hotspot_plan_own_way, 0);
  assert.equal(validate(auto)[0].limit, 18);
  for (const selection of [{isManualSelection:true},{isManual:true},{hotspot_plan_own_way:1}]) {
    const manual = (await builder.build(tx, {...options,selection})).row;
    assert.equal(manual.hotspot_plan_own_way, 1);
    assert.equal(manual.isManual, true);
    assert.deepEqual(validate(manual), []);
  }
  assert.equal((await builder.build(tx, {...options,selection:{isManualSelection:false}})).row.hotspot_plan_own_way, 0);
});
