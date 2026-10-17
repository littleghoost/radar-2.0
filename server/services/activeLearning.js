"use strict";
// Active learning is a scheduling heuristic, NOT a rarity/authenticity classifier.
// Never writes labels: only the user can answer Rare / Common / Unsure.
function normalizedTokens(value) {
  const stop=new Set(["calca","jeans","vintage","usado","usada","y2k","rare","raro","new","novo","nova","size","mens","feminino","original","de","do","da","for","with","the"]);
  return [...new Set(String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
    .match(/[a-z0-9]+/g)||[])].filter(word=>word.length>2&&!stop.has(word));
}
function candidateReviewPriority(row, {rare=0,common=0}={}) {
  const numeric=Number(row.preference_score);
  const known=row.preference_score!==null && row.preference_score!==undefined && Number.isFinite(numeric);
  // Images with comparable known ratings help calibrate visual similarity.
  const uncertainty=known ? 62-Math.min(50,Math.abs(numeric-50))*0.75 : 45;
  const visual=Boolean(row.image_embedding_json)?18:0;
  const imbalance=rare>common*1.4 && known && numeric<=65 ? 9:0;
  const brazil=/(?:olx|enjoei|mercado livre|facebook marketplace)/i.test(row.platform||"")?9:0;
  return Math.round(uncertainty+visual+imbalance+brazil);
}
function reviewReason(row) {
  const v=row.preference_score;
  if (v!==null && v!==undefined && Number.isFinite(Number(v)) &&
      Math.abs(Number(v)-50)<=14)
    return "Pontuação intermediária: sua resposta ajuda a diferenciar raras e comuns.";
  if (row.image_embedding_json)
    return "Imagem já analisada: confirme se a semelhança visual faz sentido.";
  return "Sem análise visual: sua avaliação ajuda a calibrar o filtro.";
}
function learnedTasteExplanation(row,profile={}) {
  const words=normalizedTokens(row.title);
  const favorable=words.map(word=>({word,count:(profile.positive_terms?.[word]||0)-(profile.negative_terms?.[word]||0)}))
    .filter(x=>x.count>0).sort((a,b)=>b.count-a.count).slice(0,2).map(x=>x.word);
  const unfavorable=words.map(word=>({word,count:(profile.negative_terms?.[word]||0)-(profile.positive_terms?.[word]||0)}))
    .filter(x=>x.count>0).sort((a,b)=>b.count-a.count).slice(0,2).map(x=>x.word);
  const texts=[];
  if (favorable.length)texts.push("Você costuma aprovar títulos com: "+favorable.join(", ")+".");
  if (unfavorable.length)texts.push("Você já rejeitou características com: "+unfavorable.join(", ")+".");
  if (row.image_embedding_json) texts.push("Comparação visual CLIP disponível.");
  else texts.push("Ainda não há comparação visual CLIP desta foto.");
  return texts.join(" ");
}
function rankTrainingCandidates(rows=[],profile={},limit=5) {
  const sorted=rows.map(row=>({...row,
    review_priority:candidateReviewPriority(row,{
      rare:profile.labeled_positive||0,common:profile.labeled_negative||0,
    }),
    review_reason:reviewReason(row),
    taste_explanation:learnedTasteExplanation(row,profile),
  })).sort((a,b)=>b.review_priority-a.review_priority ||
    Number(b.id||0)-Number(a.id||0));
  const result=[],remaining=[...sorted],seenTokens=[];
  // Diversity prevents a batch of near-identical brand/garment titles.
  while(result.length<limit && remaining.length) {
    const idx=remaining.findIndex(row=>{
      const tokens=normalizedTokens(row.title);
      return !seenTokens.some(previous=>{
        const overlap=tokens.filter(word=>previous.includes(word)).length;
        return overlap>=3 && overlap>=Math.ceil(Math.min(tokens.length,previous.length)*0.65);
      });
    });
    const [row]=remaining.splice(idx>=0?idx:0,1);
    result.push(row);
    seenTokens.push(normalizedTokens(row.title));
  }
  return result;
}
module.exports={rankTrainingCandidates,candidateReviewPriority,reviewReason,learnedTasteExplanation};
