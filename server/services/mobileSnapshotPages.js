"use strict";

// Mantém compatibilidade com os snapshots 0.2.7 e pagina catálogos maiores.
const SINGLE_PAGE_LIMIT = 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

function paginateMobileListings(listings) {
  if (!Array.isArray(listings)) throw new TypeError("listings precisa ser array");
  if (listings.length <= SINGLE_PAGE_LIMIT) {
    return {paged:false,pages:[listings],truncated:false};
  }
  const pages = [];
  for (let offset=0;offset<listings.length && pages.length<MAX_PAGES;offset+=PAGE_SIZE) {
    pages.push(listings.slice(offset,offset+PAGE_SIZE));
  }
  return {paged:true,pages,truncated:listings.length>PAGE_SIZE*MAX_PAGES};
}

function isSnapshotId(value) {
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

module.exports = {paginateMobileListings,isSnapshotId,SINGLE_PAGE_LIMIT,PAGE_SIZE,MAX_PAGES};
