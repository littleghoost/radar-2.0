"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { searchMercadoLivre } = require("../server/services/sources/mercadolivre");
const { searchEbay } = require("../server/services/sources/ebay");

test("Mercado Livre respeita HTTP 429 sem disparar consultas extras no catálogo", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/api\.mercadolibre\.com\//);
    calls += 1;
    return new Response(JSON.stringify({error:"too_many_requests"}), {
      status:429,
      headers:{"content-type":"application/json","retry-after":"90"},
    });
  };
  try {
    const response = await searchMercadoLivre({
      query:"sony hdd|sony sr",
      accessToken:"fake-test-token",
      limit:20,
    });
    assert.equal(response.ok,false);
    assert.equal(response.status,429);
    assert.equal(response.items.length,0);
    assert.deepEqual(response.catalog_items,[]);
    assert.equal(calls,1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("eBay respeita HTTP 429 após autenticação e reporta o limite da fonte", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes("/identity/v1/oauth2/token")) {
      return new Response(JSON.stringify({access_token:"test-token",expires_in:3600}),{
        status:200, headers:{"content-type":"application/json"},
      });
    }
    return new Response(JSON.stringify({errors:[{message:"rate limit reached"}]}),{
      status:429,headers:{"content-type":"application/json","retry-after":"120"},
    });
  };
  try {
    const response = await searchEbay({
      query:"Sony SR|Sony HDR",
      credentials:{clientId:"test-client",clientSecret:"test-secret",marketplaceId:"EBAY_US"},
      limit:15,
    });
    assert.equal(response.ok,false);
    assert.equal(response.status,429);
    assert.equal(response.items.length,0);
    assert.equal(urls.length,2);
    assert.match(urls[0],/identity.*token/);
    assert.match(urls[1],/browse.*search/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
