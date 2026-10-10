"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {rescheduleAfterFailure}=require('../server/services/radarRunner');

test('Falha de radar ativo respeita o intervalo de uma hora',async()=>{
  const queries=[];
  const adjusted=await rescheduleAfterFailure({
    get:async()=>({schedule_enabled:1,schedule_interval_minutes:60}),
    run:async(sql,args)=>queries.push({sql,args}),
  },9);
  assert.equal(adjusted,true);
  assert.equal(queries.length,1);
  assert.deepEqual(queries[0].args,[60,9]);
  assert.ok(queries[0].sql.includes('next_run_at'));
});
test('Radar desativado não é reagendado',async()=>{
  let calls=0;
  const adjusted=await rescheduleAfterFailure({
    get:async()=>({schedule_enabled:0,schedule_interval_minutes:60}),
    run:async()=>{calls++;},
  },8);
  assert.equal(adjusted,false);
  assert.equal(calls,0);
});
