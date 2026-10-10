"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseStableVersion, compareStableVersions, parseOfficialRelease,
} = require("../server/services/desktopUpdates");

test("Versões estáveis são comparadas numericamente", () => {
  assert.deepEqual(parseStableVersion("v0.2.0"), [0,2,0]);
  assert.equal(compareStableVersions("0.2.0","0.1.9"),1);
  assert.equal(compareStableVersions("v1.0.0","0.9.99"),1);
  assert.equal(compareStableVersions("0.2.0","0.2.0"),0);
  assert.equal(compareStableVersions("0.2.0","1.0.0"),-1);
  assert.equal(compareStableVersions("0.2.0-beta","0.2.0"),null);
});

function release(overrides={}) {
  const tag="v0.2.0",name="Radar_2.0_0.2.0_x64-setup.exe";
  return {
    tag_name:tag, draft:false, prerelease:false, body:"Atualização de segurança e layout",
    html_url:"https://github.com/littleghoost/radar-2.0/releases/tag/"+tag,
    assets:[{
      name, size:124000000,
      browser_download_url:"https://github.com/littleghoost/radar-2.0/releases/download/"+tag+"/"+name,
    }],
    ...overrides,
  };
}

test("Aceita apenas releases e instaladores oficiais do GitHub",()=>{
  const result=parseOfficialRelease(release());
  assert.equal(result.version,"0.2.0");
  assert.match(result.download_url,/Radar_2.0_0.2.0_x64-setup\.exe/);
  assert.equal(parseOfficialRelease(release({draft:true})),null);
  assert.equal(parseOfficialRelease(release({prerelease:true})),null);
  assert.equal(parseOfficialRelease(release({tag_name:"v0.2.0-rc1"})),null);
  assert.equal(parseOfficialRelease(release({html_url:"https://other.com/release"})),null);
  const malicious=release();
  malicious.assets[0].browser_download_url="https://attacker.example/evil.exe";
  assert.equal(parseOfficialRelease(malicious),null);
  const noWindows=release();
  noWindows.assets[0].name="radar.zip";
  assert.equal(parseOfficialRelease(noWindows),null);
});
