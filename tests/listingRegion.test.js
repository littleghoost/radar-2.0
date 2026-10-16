"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {listingRegion}=require('../server/services/listingRegion');
const check=(row,expected,basis)=>assert.deepEqual(listingRegion(row),{region:expected,region_basis:basis});

test('País informado tem precedência sobre plataforma e moeda',()=>{
  check({platform:'eBay',currency:'USD',item_country:'BR',url:'https://www.ebay.com/itm/12345678'},'br','item_country');
  check({platform:'Mercado Livre',currency:'BRL',item_country:'CN',url:'https://produto.mercadolivre.com.br/MLB-123456789-_JM'},'international','item_country');
  check({platform:'eBay',currency:'BRL',item_country:'JP'},'international','item_country');
});

test('Origem brasileira pela plataforma exige domínio reconhecido',()=>{
  for(const url of [
    'https://www.olx.com.br/d/roupa-12345678',
    'https://www.enjoei.com.br/p/calca-1234567',
    'https://produto.mercadolivre.com.br/MLB-12345678-_JM',
    'https://www.repassa.com.br/produtos/calca-vintage',
    'https://www.ebrecho.com.br/produto/calca-123',
  ]) check({url,currency:'BRL'},'br','marketplace');
});

test('Marketplace gringo não vira brasileiro por exibir reais',()=>{
  for(const url of [
    'https://www.ebay.com/itm/12345678',
    'https://jp.mercari.com/item/m123456',
    'https://www.vinted.fr/items/123',
    'https://www.grailed.com/listings/123',
  ]) check({url,currency:'BRL'},'international','marketplace');
});

test('Shopee e Marketplace sem país informado ficam a confirmar',()=>{
  for(const url of [
    'https://shopee.com.br/product/123/456',
    'https://www.facebook.com/marketplace/item/123',
    'https://unknown.com.br/produto/calca',
  ]) check({url,currency:'BRL'},'unknown','unknown');
});

test('Classificação de plataforma conhecida e URLs parecidas suspeitas',()=>{
  check({platform:'Enjoei'},'br','marketplace');
  check({platform:'Poshmark'},'international','marketplace');
  check({platform:'Outro',url:'https://fake-vinted.fr/items/100'},'unknown','unknown');
});
