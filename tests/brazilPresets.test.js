"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const presets=require('../extension/brazilPresets.js');
test('Pesquisas nacionais têm termos úteis aos dois radares',()=>{
  assert.ok(presets.terms.roupas.includes('JNCO'));
  assert.ok(presets.terms.cameras.some(x=>x.includes('NightShot')));
});
test('Links de buscas nacionais são HTTPS, apontam à busca, não a um anúncio inventado',()=>{
  for(const source of presets.sources) {
    const url=presets.buildUrl(source,'Sony Handycam DCR-SR');
    const parsed=new URL(url);
    assert.equal(parsed.protocol,'https:');
    assert.match(decodeURIComponent(url), /Sony[- ]Handycam[- ]DCR-SR/);
  }
  assert.equal(presets.buildUrl('olx',''),null);
  assert.equal(presets.buildUrl('site-desconhecido','JNCO'),null);
});

test('Popup inclui atalhos BR e o script que os gera',()=>{
  const fs=require('node:fs');
  const path=require('node:path');
  const html=fs.readFileSync(path.join(__dirname,'../extension/popup.html'),'utf8');
  const js=fs.readFileSync(path.join(__dirname,'../extension/popup-browser.js'),'utf8');
  for(const id of ['brazilCategory','brazilSource','brazilTerm','openBrazilSearch']) {
    assert.ok(html.includes('id="'+id+'"'),id);
    assert.ok(js.includes("'#"+id+"'"),id);
  }
  assert.ok(html.includes('src="brazilPresets.js"'));
});
