"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {trainingImageUrl,isPublicAddress}=require("../server/services/visualTrainingImages");
test("Downloader visual evita localhost, IPs privados e endereços internos",()=>{
  for(const url of [
    "http://127.0.0.1/image.png",
    "http://10.1.2.3/image.png",
    "http://192.168.0.1/image.png",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost/image.png",
    "http://server.local/image.png",
    "file:///home/little/.ssh/id_rsa",
    "https://cdn.example.com:8080/image.png",
  ]) assert.throws(()=>trainingImageUrl(url),url);
  for(const address of ["127.0.0.1","10.2.3.4","192.168.1.2","172.16.1.1","::1","fe80::1","::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(address),false,address);
  }
  for(const address of ["8.8.8.8","1.1.1.1","2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address),true,address);
});
test("Aceita imagem de host público HTTPS",()=>{
  assert.equal(trainingImageUrl("https://image-cdn.example.com/photos/item.jpg").protocol,"https:");
});
