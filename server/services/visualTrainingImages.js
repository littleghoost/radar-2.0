"use strict";
const http=require("node:http");
const https=require("node:https");
const dns=require("node:dns");
const net=require("node:net");

function isPublicAddress(address) {
  const value=String(address||"").toLowerCase();
  if (!net.isIP(value)) return false;
  if (net.isIP(value)===4) {
    const [a,b,c]=value.split(".").map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||
      a===172&&b>=16&&b<=31||a===192&&b===168||
      a===100&&b>=64&&b<=127||a===192&&b===0||
      a===198&&(b===18||b===19)||a===198&&b===51&&c===100||
      a===203&&b===0&&c===113);
  }
  if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
  return !(value==="::"||value==="::1"||
    value.startsWith("fc")||value.startsWith("fd")||
    /^fe[89ab]/.test(value)||value.startsWith("ff")||
    value.startsWith("2001:db8:"));
}
function trainingImageUrl(value) {
  const u=new URL(String(value||""));
  if (!["https:","http:"].includes(u.protocol) || u.username || u.password) throw new Error("Endereço de imagem inválido");
  if ((u.port && !["80","443"].includes(u.port)) ||
      /(?:^|\.)(?:localhost|local|internal|test)$/.test(u.hostname) ||
      !u.hostname.includes(".") || net.isIP(u.hostname) && !isPublicAddress(u.hostname)) {
    throw new Error("Origem de imagem não permitida");
  }
  return u;
}
async function downloadTrainingImage(value) {
  const u=trainingImageUrl(value);
  return new Promise((resolve,reject)=>{
    let resolved=false;
    const done=(error,body)=>{if(resolved)return;resolved=true;error?reject(error):resolve(body);};
    const transport=u.protocol==="https:"?https:http;
    const request=transport.get(u,{
      timeout:12000,
      headers:{"user-agent":"Radar2/0.2.13 image-trainer","accept":"image/*"},
      lookup(host,opts,cb) {
        dns.lookup(host,opts,(err,address,family)=>{
          if(err)return cb(err);
          const values=Array.isArray(address)?address.map(row=>row.address):[address];
          if (!values.every(isPublicAddress)) return cb(new Error("Imagem aponta para rede interna"));
          cb(null,address,family);
        });
      },
    },res=>{
      if(res.statusCode!==200){res.resume();return done(new Error("HTTP "+res.statusCode));}
      if(!/^(?:image\/(?:jpeg|png|webp|gif|bmp)|application\/octet-stream)(?:;|$)/i.test(String(res.headers["content-type"]||""))) {
        res.resume();return done(new Error("Resposta não é uma imagem"));
      }
      const parts=[];let size=0;const max=8*1024*1024;
      res.on("data",part=>{size+=part.length;if(size>max){request.destroy(new Error("Imagem maior que 8 MB"));return;}parts.push(part);});
      res.on("end",()=>done(null,Buffer.concat(parts)));
      res.on("error",done);
    });
    request.on("timeout",()=>request.destroy(new Error("Tempo limite de imagem")));
    request.on("error",done);
  });
}
module.exports={trainingImageUrl,isPublicAddress,downloadTrainingImage};
