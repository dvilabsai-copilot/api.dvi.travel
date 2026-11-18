import assert from 'node:assert/strict';
import test from 'node:test';
import { withVehicleRebuildLock } from '../src/modules/itineraries/utils/vehicle-rebuild-lock.util';

test('vehicle lock owns a dedicated session until work completes and releases on failures', async () => {
  const before = process.env.DATABASE_URL;
  process.env.DATABASE_URL='mysql://test:test@localhost/dvi_staging_test';
  try {
    for (const fail of [false,true]) {
      const events:string[]=[];let lockName='';
      const connect:any=async()=>({query:async(sql:string,args:any[])=>{
        events.push(sql.includes('GET_LOCK')?'acquire':'release');
        if(sql.includes('GET_LOCK')) {lockName=args[0];return [[{acquired:1}]];}
        assert.equal(args[0],lockName);return [[]];
      },end:async()=>{events.push('close');}});
      const work=async()=>{events.push('work');if(fail)throw Error('build failed');return 7;};
      if(fail) await assert.rejects(()=>withVehicleRebuildLock(12,work,connect),/build failed/);
      else assert.equal(await withVehicleRebuildLock(12,work,connect),7);
      assert.deepEqual(events,['acquire','work','release','close']);
      assert.ok(lockName.length<64);
    }
    const names:string[]=[];
    const connect:any=async()=>({query:async(sql:string,args:any[])=>{if(sql.includes('GET_LOCK'))names.push(args[0]);return [[{acquired:1}]];},end:async()=>{}});
    for(const [db,id] of [['dvi_staging_test',12],['dvi_staging_test',13],['dvi_production_test',12]] as const){process.env.DATABASE_URL='mysql://test:test@localhost/'+db;await withVehicleRebuildLock(id,async()=>{},connect);}
    assert.equal(new Set(names).size,3);
    let ran=false,closed=false,released=false;
    await assert.rejects(()=>withVehicleRebuildLock(12,async()=>{ran=true;},(async()=>({query:async(sql:string)=>{if(sql.includes('RELEASE'))released=true;return [[{acquired:0}]];},end:async()=>{closed=true;}})) as any),/Another vehicle rebuild/);
    assert.equal(ran,false);assert.equal(closed,true);assert.equal(released,false);
  } finally {if(before===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=before;}
});
