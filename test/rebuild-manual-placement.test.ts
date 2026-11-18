import assert from 'node:assert/strict';
import test from 'node:test';
import { HotspotEngineService } from '../src/modules/itineraries/engines/hotspot-engine.service';
import { TimelineBuilder } from '../src/modules/itineraries/engines/helpers/timeline.builder';
import { TimelineManualPlacementOrderingService } from '../src/modules/itineraries/engines/helpers/timeline-manual-placement-ordering.service';

test('engine retains individual manual positions unless an explicit route anchor was supplied', async () => {
  const manual = [743,671,90,675].map((id,i)=>({itinerary_route_ID:23112,hotspot_ID:id,hotspot_order:i+2,item_type:4,deleted:0,hotspot_plan_own_way:1}));
  const model = {count:async()=>0,findMany:async()=>[],deleteMany:async()=>{throw Error('empty range must not be deleted');}};
  const tx = {$queryRaw:async()=>[],dvi_itinerary_route_hotspot_details:model,dvi_itinerary_route_hotspot_parking_charge:model} as any;
  const original = TimelineBuilder.prototype.buildTimelineForPlan;
  const stop = new Error('inspected builder boundary');
  try {
    for (const options of [undefined,{anchorOrderByRoute:{23112:6}},{preferredManualPlacementByRoute:{23112:{hotspotOrder:7}}}]) {
      let captured: any;
      TimelineBuilder.prototype.buildTimelineForPlan = async (_tx,_id,_rows,opts) => {captured=opts;throw stop;};
      await assert.rejects(()=>new HotspotEngineService(null as any).rebuildRouteHotspots(tx,11713,manual,options),e=>e===stop);
      if (!options) {
        assert.deepEqual(captured.manualPlacementByRoute,{});
        const result = new TimelineManualPlacementOrderingService(()=>{}).apply({options:captured,route:{itinerary_route_ID:23112},plan:{},planId:11713,selectedHotspots:[],existingHotspots:manual});
        assert.deepEqual(result.selectedHotspots.map(x=>[x.hotspot_ID,x.display_order]),manual.map(x=>[x.hotspot_ID,x.hotspot_order]));
      } else assert.equal(captured.manualPlacementByRoute[23112].hotspotOrder,options.anchorOrderByRoute?6:7);
    }
  } finally {TimelineBuilder.prototype.buildTimelineForPlan=original;}
});
