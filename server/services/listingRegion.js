"use strict";

// Regiao de origem = localizacao informada quando disponivel; caso contrario,
// inferencia limitada da plataforma, nunca da moeda exibida.
const BRAZILIAN_HOSTS = new Set([
  "olx.com.br", "enjoei.com.br", "mercadolivre.com.br",
  "repassa.com.br", "ebrecho.com.br",
  "desapegodaka.com.br",
]);
const FOREIGN_HOSTS = new Set([
  "depop.com", "mercari.com", "mercari.jp", "grailed.com",
]);
const FOREIGN_DOMAIN_PATTERN = /^(?:[a-z0-9-]+\.)*(?:ebay|vinted|poshmark)\.[a-z]{2,}(?:\.[a-z]{2,})?$/;
const BRAZILIAN_PLATFORMS = new Set([
  "olx", "enjoei", "mercado livre", "repassa", "ebrecho", "ebrechó",
]);
const FOREIGN_PLATFORMS = new Set([
  "ebay", "depop", "mercari", "vinted", "grailed", "poshmark",
]);

function listingRegion(listing = {}) {
  const country = String(listing.item_country || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) {
    return {region: country === "BR" ? "br" : "international", region_basis: "item_country"};
  }
  let host = "";
  try { host = new URL(String(listing.url || "")).hostname.toLowerCase(); }
  catch { /* URLs legadas podem não existir. */ }
  const hostMatches = value => host === value || host.endsWith("." + value);
  if ([...BRAZILIAN_HOSTS].some(hostMatches)) {
    return {region:"br",region_basis:"marketplace"};
  }
  if ([...FOREIGN_HOSTS].some(hostMatches) || FOREIGN_DOMAIN_PATTERN.test(host)) {
    return {region:"international",region_basis:"marketplace"};
  }
  // Uma plataforma brasileira pode ser conhecida mesmo para dados sem URL.
  const platform = String(listing.platform || "").trim().toLowerCase();
  if (BRAZILIAN_PLATFORMS.has(platform)) {
    return {region:"br",region_basis:"marketplace"};
  }
  if (FOREIGN_PLATFORMS.has(platform)) {
    return {region:"international",region_basis:"marketplace"};
  }
  // Facebook Marketplace e Shopee podem ter vendedores de varios paises.
  // BRL, idioma PT-BR e dominio .com.br nao provam a origem do vendedor.
  return {region:"unknown",region_basis:"unknown"};
}
module.exports = {listingRegion};
