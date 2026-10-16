"use strict";
const {trainingCategoryMismatch}=require("./trainingEligibility");
const {inspectListing}=require("./listingPreflight");
function normalizedTitle(text) {
  return String(text||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
// All findings are advisory. URLs are never visited and records never deleted here.
function catalogReviewFlags(listing,category,titleCounts=new Map()) {
  const result=[];
  const title=normalizedTitle(listing.title);
  const key=(listing.platform||"").toLowerCase()+"|"+title;
  if (trainingCategoryMismatch(listing,category))
    result.push({code:"category",reason:"Parece pertencer a outro tipo de radar"});
  else if (category==="roupas" &&
      inspectListing(listing,{radar_category:"roupas"}).verdict==="rejected")
    result.push({code:"category",reason:"Título ou categoria incompatível com roupas"});
  if (title.length>=16 && (titleCounts.get(key)||0)>1)
    result.push({code:"duplicate_title",reason:"Título igual a outro anúncio da mesma plataforma; conferir fotos"});
  let valid=false;
  try {const u=new URL(listing.url);valid=["http:","https:"].includes(u.protocol)&&Boolean(u.hostname);}catch {}
  if (!valid) result.push({code:"invalid_link",reason:"Link inválido; não abre como anúncio HTTP(S)"});
  if (!listing.image_url) result.push({code:"no_image",reason:"Anúncio sem imagem para avaliar"});
  if (["sold","unavailable","removed"].includes(String(listing.availability_status||"").toLowerCase()) &&
    !["vendido","descartado"].includes(listing.status))
    result.push({code:"unavailable",reason:"Fonte sinalizou indisponibilidade; conferir antes de comprar"});
  return result;
}
function catalogReviewReport(rows=[],radars=new Map(),dismissed=new Set()) {
  const titleCounts=new Map();
  for(const row of rows) {
    const t=normalizedTitle(row.title);
    if (t.length<16)continue;
    const key=(row.platform||"").toLowerCase()+"|"+t;
    titleCounts.set(key,(titleCounts.get(key)||0)+1);
  }
  const flagged=[];
  for(const row of rows) {
    const category=radars.get(row.radar_id)?.category || "geral";
    for(const flag of catalogReviewFlags(row,category,titleCounts)) {
      if(dismissed.has(String(row.id)+":"+flag.code))continue;
      flagged.push({id:row.id,title:row.title,url:row.url,platform:row.platform,
        radar_id:row.radar_id,status:row.status,image_url:row.image_url,
        code:flag.code,reason:flag.reason});
    }
  }
  const order={category:0,invalid_link:1,unavailable:2,duplicate_title:3,no_image:4};
  flagged.sort((a,b)=>(order[a.code]??9)-(order[b.code]??9)||b.id-a.id);
  const counts={};
  for(const row of flagged)counts[row.code]=(counts[row.code]||0)+1;
  return {total:flagged.length,counts,items:flagged};
}
module.exports={catalogReviewFlags,catalogReviewReport,normalizedTitle};
