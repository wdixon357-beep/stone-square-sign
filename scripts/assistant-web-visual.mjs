// Generates an isolated headless review script; never a production test.
import fs from 'node:fs/promises';
import path from 'node:path';
import { assistantFixture } from '../test/fixtures/assistant-workspace.mjs';
import { ASSISTANT_CAPABILITIES } from '../assistant-actions.js';
const destination=path.resolve('output/muse-assistant-build/web');
await fs.mkdir(destination,{recursive:true});
const fixture={...assistantFixture,capabilities:ASSISTANT_CAPABILITIES};
const source=`async page => {
 const fixture=${JSON.stringify(fixture)};
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/auth/me',async route=>{
   const response=await route.fetch();const data=await response.json();
   if(data.user)data.user.hasSignature=true;
   await route.fulfill({response,json:data});
 });
 await page.route('**/api/assistant/workspace',route=>route.fulfill({json:fixture}));
 await page.route('**/api/assistant/attestations',route=>route.fulfill({json:{attestations:fixture.attestations}}));
 // The isolated owner session has already completed its normal initial load.
 const results=[];
 for (const [name,width,height] of [['desktop',1440,1000],['ipad',834,1112],['phone',390,844]]) {
  await page.setViewportSize({width,height});
  await page.locator('#assistantNav').evaluate(element=>element.click());
  await page.locator('#assistantSection h1').waitFor();
  await page.screenshot({path:${JSON.stringify(destination)}+'/'+name+'-access.png',fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  results.push({name,width,view:'access',overflow,heading:await page.locator('#assistantSection h1').textContent()});
  await page.locator('#attestationsNav').evaluate(element=>element.click());
  await page.locator('#attestationsSection h1').waitFor();
  await page.screenshot({path:${JSON.stringify(destination)}+'/'+name+'-queue.png',fullPage:true});
  results.push({name,width,view:'queue',overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),personalButtons:await page.locator('#attestationsSection button').allTextContents()});
 }
 return {results,errors};
}`;
await fs.writeFile(path.join(destination,'run.cjs'),source);
