'use strict';
// Restrict feedback across distinct product families. This never deletes labels.
function normalizedProductText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function trainingCategoryMismatch(item,category) {
  const kind=normalizedProductText(category);
  const title=normalizedProductText(item?.title);
  const path=normalizedProductText((()=>{try{return new URL(item?.url).pathname;}catch{return '';}})());
  const text=title+' '+path;
  const camera=/\b(handycam|camcorder|camescope|filmadora|videocamera|video camera|camara sony|camera sony|dcr (sr|sx|dvd|hc|trv) ?[0-9]+|hdr (sr|xr) ?[0-9]+)\b/.test(text);
  const garment=/\b(calca|jeans|jorts|camisa|camiseta|shirt|jersey|hoodie|jaqueta|bermuda|shorts|pants|trousers|jacket|moletom)\b/.test(text);
  if ((kind.includes('roupa')||kind.includes('fashion')) && camera && !garment) {
    return 'camera_in_clothes';
  }
  if ((kind.includes('camera')||kind.includes('filmadora')) && garment && !camera) {
    return 'clothes_in_cameras';
  }
  return null;
}
module.exports={trainingCategoryMismatch,normalizedProductText};
