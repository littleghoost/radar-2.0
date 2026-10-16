"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {inspectListing,inspectBatch}=require('../server/services/listingPreflight');
const origin={source_url:'https://www.olx.com.br/brasil?q=JNCO'};
test('JNCO não confunde com JNC de rodas de carro e surdina',()=>{
  for(const [title,url] of [
    ['Rodas aro 15 JNC Furação 4x100','https://pr.olx.com.br/autos-e-pecas/rodas-jnc-1480299257'],
    ['Surdina JNC Mutes and Accessories','https://df.olx.com.br/instrumentos-musicais/surdina-jnc-1479893581'],
  ]) assert.equal(inspectListing({title,url},origin).verdict,'rejected');
  assert.equal(inspectListing({title:'JNCO Big Crown',url:'https://pr.olx.com.br/roupas/jnco-big-crown-1543363631'},origin).verdict,'candidate');
  assert.equal(inspectListing({title:'Calça baggy bordado raro',url:'https://pr.olx.com.br/roupas/calca-baggy-1543363631'},origin).verdict,'candidate');
});
test('Mini system não entra no radar Handycam, câmera duvidosa pede avaliação',()=>{
  const ctx={source_url:'https://www.facebook.com/marketplace/manaus/search/?query=Sony%20Handycam%20DCR-SR'};
  assert.equal(inspectListing({title:'Mini system sony no grupo Manaus, AM',url:'https://www.facebook.com/marketplace/item/456123/'},ctx).verdict,'rejected');
  assert.equal(inspectListing({title:'Sony Handycam DCR-SR47',url:'https://www.facebook.com/marketplace/item/456123/'},ctx).verdict,'candidate');
});
test('Pré-triagem nunca descarta peça sem certeza e não altera lote original',()=>{
  const items=[
    {title:'JNCO Crown pants',url:'https://www.olx.com.br/roupas/jnco-1543363631'},
    {title:'Rodas JNC aro 15',url:'https://www.olx.com.br/autos-e-pecas/rodas-1543363632'},
  ];
  const screening=inspectBatch(items,origin);
  assert.equal(screening.accepted.length,1);
  assert.equal(screening.rejected.length,1);
  assert.equal(items.length,2);
  const unknown=inspectListing(items[0],{source_url:'https://www.ebay.com'});
  assert.equal(unknown.verdict,'review');
});
test('Servidor e Bridge usam exatamente as mesmas regras de pré-inspeção',()=>{
  assert.equal(
    fs.readFileSync(path.join(__dirname,'../server/services/listingPreflight.js'),'utf8'),
    fs.readFileSync(path.join(__dirname,'../extension/listingPreflight.js'),'utf8'),
  );
});
test('Interface apresenta filtros e treino opcional sem interromper navegação',()=>{
  const popup=fs.readFileSync(path.join(__dirname,'../extension/popup.html'),'utf8');
  const feed=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  for(const snippet of ['listingPreflight.js','includeRejectedRow'])assert.ok(popup.includes(snippet));
  for(const snippet of ['trainerPanel','trainerRadar','Treinar IA'])assert.ok(feed.includes(snippet));
});
