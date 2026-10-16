"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {rankTrainingCandidates}=require("../server/services/activeLearning");
const {catalogReviewReport}=require("../server/services/catalogReview");
test("Treinamento prioriza dúvidas e diversifica fotos sem rotular automaticamente",()=>{
 const items=[
  {id:1,title:"JNCO dragon blue baggy jeans",preference_score:91,image_embedding_json:null,platform:"eBay"},
  {id:2,title:"Calça Ecko tribal embroidered black",preference_score:52,image_embedding_json:"[1,2,3]",platform:"OLX"},
  {id:3,title:"Calça Ecko tribal embroidered preta",preference_score:54,image_embedding_json:"[1,2,3]",platform:"OLX"},
  {id:4,title:"Tapout graphic jersey",preference_score:50,image_embedding_json:"[1,2,3]",platform:"Enjoei"},
  {id:5,title:"Southpole vintage cargo",preference_score:49,image_embedding_json:"[1,2,3]",platform:"Mercado Livre"},
  {id:6,title:"Jeans sem detalhes",preference_score:47,image_embedding_json:null,platform:"eBay"},
 ];
 const result=rankTrainingCandidates(items,{labeled_positive:86,labeled_negative:27},3);
 assert.equal(result.length,3);
 assert.ok(result.every(x=>Number.isFinite(x.review_priority)&&x.review_reason));
 assert.ok(result.every(x=>x.id!==1),"Não deve privilegiar raridade com score extremo");
 assert.ok(result.filter(x=>[2,3].includes(x.id)).length<=1,"Evita exemplos muito parecidos");
 assert.equal(items[0].review_priority,undefined);
});
test("Revisão identifica categoria errada, duplicatas e link inválido; não deleta",()=>{
 const list=[
  {id:1,radar_id:9,title:"Handycam Sony DCR-SR47",platform:"OLX",url:"https://olx.com.br/item/1",image_url:"https://img.example.com/1.jpg"},
  {id:2,radar_id:9,title:"JNCO vintage dragon embroidered jeans",platform:"OLX",url:"https://olx.com.br/item/2",image_url:"https://img.example.com/2.jpg"},
  {id:3,radar_id:9,title:"JNCO vintage dragon embroidered jeans",platform:"OLX",url:"https://olx.com.br/item/3",image_url:"https://img.example.com/3.jpg"},
  {id:4,radar_id:9,title:"MCD vintage jeans",platform:"Enjoei",url:"javascript:alert(1)",image_url:null},
 ];
 const radars=new Map([[9,{category:"roupas"}]]);
 const result=catalogReviewReport(list,radars);
 assert.equal(list.length,4);
 assert.ok(result.items.some(x=>x.id===1&&x.code==="category"));
 assert.ok(result.items.some(x=>x.id===2&&x.code==="duplicate_title"));
 assert.ok(result.items.some(x=>x.id===4&&x.code==="invalid_link"));
 assert.ok(result.items.some(x=>x.id===4&&x.code==="no_image"));
 const dismissed=catalogReviewReport(list,radars,new Set(["1:category"]));
 assert.ok(!dismissed.items.some(x=>x.id===1&&x.code==="category"));
 assert.equal(list[0].radar_id,9);
});
