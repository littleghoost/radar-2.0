"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {sanitizeSnapshot}=require('../server/mobileRelay');
test('Sincronização de 444 anúncios preserva todos os registros e referências por radar',()=>{
 const listings=Array.from({length:444},(_,i)=>({
  id:i+1,radar_id:i<220?8:9,title:'Anúncio '+(i+1),
  status:i%5===0?'interessante':'novo',url:'https://example.com/'+(i+1),
  platform:'Radar',image_url:'https://example.com/'+i+'.jpg',
  current_price:100,updated_at:'2026-10-10 12:00:00'
 }));
 const snapshot=sanitizeSnapshot({radars:[{id:8,name:'Handycam',listing_count:220},{id:9,name:'Roupas',listing_count:224}],listings});
 assert.equal(snapshot.listings.length,444);
 assert.equal(new Set(snapshot.listings.map(x=>x.id)).size,444);
 assert.equal(snapshot.radars[0].listing_count,220);
 assert.equal(snapshot.radars[1].listing_count,224);
 assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<1024*1024);
});
test('Novo limite permite até mil anúncios sem cortes aos 250',()=>{
 const listings=Array.from({length:1000},(_,i)=>({id:i+1,title:'Item '+(i+1)}));
 const snapshot=sanitizeSnapshot({listings});
 assert.equal(snapshot.listings.length,1000);
});
