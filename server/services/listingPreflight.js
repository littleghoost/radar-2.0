"use strict";
// Rules deliberately conservative: "rejected" means clearly wrong category,
// while ambiguous vintage pieces must remain available for human review.
function normalizePreflight(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function preflightKind({source_url="", radar_category=""}={}) {
  const category = normalizePreflight(radar_category);
  if (category.includes("roupa") || category.includes("fashion")) return "clothes";
  if (category.includes("camera") || category.includes("filmadora")) return "cameras";
  let query="";
  try {
    const parsed=new URL(source_url);
    query=decodeURIComponent(parsed.searchParams.get("q") ||
      parsed.searchParams.get("query") || parsed.searchParams.get("keyword") || "");
  } catch {}
  const text=normalizePreflight(query);
  if (/\b(jnco|tapout|mcd|baggy|jeans|jorts|tribal|bermuda|calca|camisa|hoodie)\b/.test(text)) return "clothes";
  if (/\b(handycam|filmadora|nightshot|camcorder|dcr sr|hdr xr)\b/.test(text)) return "cameras";
  return "unknown";
}
// Signals are derived from product descriptions, NOT the actual image. A
// borderline title stays available for the person's visual judgement.
function rarityTitleEvidence(value) {
  const text=normalizePreflight(value);
  const matches=[
    ["Modelagem larga",/\b(baggy|wide leg|wideleg|ultra wide|oversized|pantalona|flare|boca de sino|super wide)\b/],
    ["Bordado",/\b(bordad[oa]|embroider(?:ed|y)|bordados)\b/],
    ["Grafismo marcante",/\b(tribal|dragon|dragao|caveira|skull|all over|allover|giant print|grafico grande|big graphic|rhinestones?|strass)\b/],
    ["Construção diferenciada",/\b(patchwork|patches|bolso gigante|giant pocket|kanga(?:roo)?|applique|aplicac[ao]|remendos)\b/],
    ["Marca procurada",/\b(jnco|tapout|mcd|tripside|kikwear|southpole|ecko|diablo)\b/],
  ].filter(([,regex])=>regex.test(text)).map(([label])=>label);
  return matches;
}
function inspectListing(item={},context={}) {
  const text=normalizePreflight(item.title);
  const path=normalizePreflight((()=>{try {return new URL(item.url).pathname}catch{return ""}})());
  const kind=preflightKind(context);
  const source=normalizePreflight(context.source_url);
  const fail=reason=>({verdict:"rejected",reason});
  const review=reason=>({verdict:"review",reason});
  if (!text || !item.url) return fail("Anúncio sem título ou link");
  if (kind==="clothes") {
    if (/\b(autos e pecas|pecas e acessorios|instrumentos musicais|carros vans e utilitarios)\b/.test(path) ||
        /\b(rodas aro|furacao 4x|pneu|sur(dina|dinas)|silenciador|instrumento musical|volante automotivo)\b/.test(text)) {
      return fail("Não é roupa: categoria automotiva ou musical");
    }
    const garment=/\b(calca|jeans|jnco|jorts|bermuda|shorts|camisa|camiseta|moletom|hoodie|jaqueta|jacket|pants|denim|cargo|baggy|vestido|blusa|skirt|coat)\b/.test(text+" "+path);
    if (/\bjnco\b/.test(source) && !/\bjnco\b/.test(text) && !garment) {
      return fail("Pesquisa JNCO: anúncio sem marca e sem sinal de roupa");
    }
    const evidence=rarityTitleEvidence(item.title);
    if (garment && evidence.length) return {verdict:"candidate",
      reason:"Sinais no título: "+evidence.join(", "),evidence};
    if (garment) return {verdict:"review",
      reason:"Parece roupa, mas sem detalhes raros no título: avaliar a foto",evidence};
    return review("Não foi possível confirmar pelo título");
  }
  if (kind==="cameras") {
    if (/\b(mini system|micro system|home theater|caixa de som|televisao|controle remoto|bateria avulsa|carregador avulso|cabo usb|fone de ouvido)\b/.test(text) ||
        /\b(instrumentos musicais|som e audio|automotivo)\b/.test(path)) {
      return fail("Não é uma filmadora");
    }
    const camera=/\b(handycam|filmadora|camcorder|videocamera|video camera|dcr sr\d+|dcr trv\d+|hdr xr\d+|nightshot)\b/.test(text);
    return camera ? {verdict:"candidate",reason:"Possível filmadora; confirme NightShot e HDD"} :
      review("Precisa confirmar se é filmadora");
  }
  return review("Sem categoria definida: revisão recomendada");
}
function inspectBatch(items=[],context={}) {
  const entries=items.map(item=>({...inspectListing(item,context),item}));
  return {
    accepted:entries.filter(x=>x.verdict!=="rejected").map(x=>x.item),
    rejected:entries.filter(x=>x.verdict==="rejected"),
    review:entries.filter(x=>x.verdict==="review"),
    candidates:entries.filter(x=>x.verdict==="candidate"),
  };
}
const ListingPreflight={inspectListing,inspectBatch,preflightKind,rarityTitleEvidence};
if(typeof globalThis!=="undefined")globalThis.ListingPreflight=ListingPreflight;
if(typeof module!=="undefined")module.exports=ListingPreflight;
