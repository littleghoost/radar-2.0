"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {trainingCategoryMismatch}=require("../server/services/trainingEligibility");
test("Filmadoras não ensinam o radar de roupas, incluindo os casos reais encontrados",()=>{
  const examples=[
    "Handycam y2k vintage caméscope Samsung noir/ gris carte sd",
    "Camara Sony Handycam DCR SX 30 Blue Vlogs Camcorder 2000",
    "Caméscope Vintage Sony Handycam DCR-DVD310 + Chargeur",
  ];
  for(const title of examples) {
    assert.equal(trainingCategoryMismatch({title,url:"https://www.vinted.pt/items/123"}, "roupas"),"camera_in_clothes",title);
    assert.equal(trainingCategoryMismatch({title}, "cameras"),null,title);
  }
});
test("Roupas baggy, bordados e camiseta estampada com câmera não são descartados",()=>{
  for(const title of [
    "JNCO dragon embroidered baggy jeans",
    "Calça Southpole vintage",
    "Vintage Handycam graphic shirt 2000s",
  ]) assert.equal(trainingCategoryMismatch({title},"roupas"),null,title);
  assert.equal(trainingCategoryMismatch({title:"JNCO baggy jeans"},"cameras"),"clothes_in_cameras");
});
