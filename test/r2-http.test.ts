import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { MemoryStore } from '../src/services/store.js';
import { MemoryEntitlementRepository, MemoryDownloadTokenRepository, VISUAL_PACK } from '../src/benefits/repositories.js';
import { downloadTokenHash } from '../src/benefits/visual-pack.service.js';
import { CloudflareR2VisualPackStorage, type R2Presigner } from '../src/benefits/r2-storage.js';
import { r2Config, r2Env } from './helpers/r2-fixture.js';

async function fixture(t:TestContext,mode:'mock'|'real-offline'|'disabled'|'throw'='mock',approved=true) {
  const config=loadConfig({...r2Env,VISUAL_PACK_STORAGE_PROVIDER:mode==='disabled'?'disabled':'r2',
    MP_ACCESS_TOKEN:'TEST-fake-token',MP_WEBHOOK_SECRET:'fixture-test-secret',MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC:'fixture-prod-secret'});
  const store=new MemoryStore(),entitlements=new MemoryEntitlementRepository(),tokens=new MemoryDownloadTokenRepository();
  const {operation:op,publicToken}=store.create(100000,'ARS');const logs:unknown[]=[];
  if(approved) {
    op.payments.set('900',{id:'900',status:'approved',updatedAt:Date.now(),verifiedAt:new Date().toISOString()});
    store.grantOnce(op);
    entitlements.createOnce({operationId:op.id,paymentId:'900',benefitId:VISUAL_PACK,createdAt:Date.now(),expiresAt:op.expiresAt});
  }
  let calls=0,lookupCalls=0;const inputs:unknown[]=[];
  const sign:R2Presigner=async(_client,command,_options)=>{
    calls++;inputs.push(command.input);
    if(mode==='throw')throw new Error(`${r2Env.R2_SECRET_ACCESS_KEY} ${r2Env.R2_ACCESS_KEY_ID}`);
    return r2Env.R2_ENDPOINT+'/fixture?signature=synthetic';
  };
  const storage=mode==='mock'||mode==='throw'?new CloudflareR2VisualPackStorage(r2Config(),sign):undefined;
  const app=createApp(config,{store,entitlements,downloadTokens:tokens,storage,log:(event,fields)=>logs.push({event,fields}),
    gateway:{createPreference:async()=>{throw new Error('Not used');},getPayment:async()=>{lookupCalls++;throw new Error('Must not look up payment');}}});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request=(path:string,options?:RequestInit)=>fetch(base+path,{redirect:'manual',...options});
  const issue=(body:unknown={})=>request('/api/support/download-token/'+publicToken,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const token=async()=>{const r=await issue();assert.equal(r.status,201);const json=await r.json();return {path:json.downloadPath as string,hash:downloadTokenHash(json.downloadPath.split('/').at(-1))};};
  return {op,publicToken,entitlements,tokens,logs,inputs,request,issue,token,calls:()=>calls,lookupCalls:()=>lookupCalls};
}
test('R2 HTTP: disabled starts, health works, existing entitlement is not download-ready',async t=>{
  const f=await fixture(t,'disabled');assert.equal((await f.request('/health')).status,200);
  const status=await (await f.request('/api/support/status/'+f.publicToken+'?include=benefit')).json();
  assert.deepEqual(status.benefit,{id:VISUAL_PACK,available:true,downloadReady:false});
  const r=await f.issue();assert.equal(r.status,503);assert.equal((await r.json()).error,'DOWNLOAD_UNAVAILABLE');
  assert.equal(f.calls(),0);
});
test('R2 HTTP: automatic r2 factory yields real offline-signed redirect and no file bytes',async t=>{
  const f=await fixture(t,'real-offline');const {path}=await f.token();const r=await f.request(path);
  assert.equal(r.status,302);const location=r.headers.get('Location')!;const url=new URL(location);
  assert.equal(url.origin,r2Env.R2_ENDPOINT);assert.equal(url.pathname,`/${r2Env.R2_BUCKET}/${r2Env.R2_VISUAL_PACK_OBJECT_KEY}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'),'60');assert.equal(await r.text(),'');
  assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Referrer-Policy'),'no-referrer');
  assert(!location.includes(r2Env.R2_SECRET_ACCESS_KEY));
  // Public access-key identifier is intrinsic to SigV4, not a leaked secret key.
  assert(url.searchParams.get('X-Amz-Credential')?.startsWith(r2Env.R2_ACCESS_KEY_ID+'/'));
  assert(!JSON.stringify(f.logs).includes(location));
});
test('R2 HTTP: valid authorization signs configured object once and returns empty redirect',async t=>{
  const f=await fixture(t);const {path}=await f.token();const r=await f.request(path);
  assert.equal(r.status,302);assert.equal(await r.text(),'');assert.equal(f.calls(),1);
  assert.deepEqual(f.inputs,[{Bucket:r2Env.R2_BUCKET,Key:r2Env.R2_VISUAL_PACK_OBJECT_KEY,ResponseContentDisposition:'attachment; filename="EventDeck-Visual-Pack-v1.zip"'}]);
});
test('R2 HTTP: query parameters and extra path segments cannot choose object or bucket',async t=>{
  const f=await fixture(t);const {path}=await f.token();
  for(const query of ['key=other.zip','bucket=other','response-content-disposition=injected','assetId=other','key=a&key=b','%6bey=other'])assert.equal((await f.request(path+'?'+query)).status,400);
  assert.equal((await f.request(path+'/bucket/other')).status,404);assert.equal(f.calls(),0);
  assert.equal((await f.request(path)).status,302);assert.equal(f.calls(),1);
});
test('R2 HTTP: body cannot choose key, bucket, disposition or benefit',async t=>{
  const f=await fixture(t);for(const body of [{key:'other'},{bucket:'other'},{filename:'injected'},{benefitId:'other'}])assert.equal((await f.issue(body)).status,400);
  assert.equal(f.calls(),0);
});
test('R2 HTTP: invalid token never reaches presigner',async t=>{
  const f=await fixture(t);for(const token of ['bad','a'.repeat(64),f.publicToken])assert.equal((await f.request('/api/downloads/'+token)).status,404);
  assert.equal(f.calls(),0);
});
test('R2 HTTP: expired token never reaches presigner',async t=>{
  const f=await fixture(t);const {path,hash}=await f.token();f.tokens.replaceForEntitlement({...f.tokens.byHash(hash)!,expiresAt:Date.now()-1});
  assert.equal((await f.request(path)).status,404);assert.equal(f.calls(),0);
});
test('R2 HTTP: revoked token never reaches presigner',async t=>{
  const f=await fixture(t);const {path,hash}=await f.token();f.tokens.revoke(hash);
  assert.equal((await f.request(path)).status,404);assert.equal(f.calls(),0);
});
test('R2 HTTP: wrong benefit/entitlement never reaches presigner',async t=>{
  const f=await fixture(t);const {path,hash}=await f.token();const record=f.tokens.byHash(hash)!;
  f.tokens.replaceForEntitlement({...record,benefitId:'other'});assert.equal((await f.request(path)).status,404);
  f.tokens.replaceForEntitlement({...record,entitlementId:'missing'});assert.equal((await f.request(path)).status,404);assert.equal(f.calls(),0);
});
test('R2 HTTP: revoked entitlement never reaches presigner',async t=>{
  const f=await fixture(t);const {path}=await f.token();f.entitlements.revoke(f.entitlements.find(f.op.id,VISUAL_PACK)!.id);
  assert.equal((await f.request(path)).status,404);assert.equal(f.calls(),0);
});
test('R2 HTTP: SDK failure produces safe 503, no Location, no alternative access',async t=>{
  const f=await fixture(t,'throw');const {path}=await f.token();const r=await f.request(path);const text=await r.text();
  assert.equal(r.status,503);assert.equal(r.headers.get('Location'),null);assert.equal(f.calls(),1);
  for(const value of [r2Env.R2_ACCESS_KEY_ID,r2Env.R2_SECRET_ACCESS_KEY])assert(!(text+JSON.stringify(f.logs)).includes(value));
});
test('R2 HTTP: status, issuance and logs do not serialize storage config or credentials',async t=>{
  const f=await fixture(t);const status=await (await f.request('/api/support/status/'+f.publicToken+'?include=benefit')).text();
  const issued=await (await f.issue()).text();
  for(const value of [r2Env.R2_ACCESS_KEY_ID,r2Env.R2_SECRET_ACCESS_KEY,r2Env.R2_ENDPOINT,r2Env.R2_BUCKET,r2Env.R2_VISUAL_PACK_OBJECT_KEY])assert(!(status+issued+JSON.stringify(f.logs)).includes(value));
});
test('R2 HTTP: invalid TEST signature and PROD-only match remain 401 before lookup or grant',async t=>{
  const f=await fixture(t,'mock',false);
  for(const key of ['wrong','fixture-prod-secret']) {
    const ts='1792756800',requestId='r2-fixture';const mac=createHmac('sha256',key).update(`id:900;request-id:${requestId};ts:${ts};`).digest('hex');
    const r=await f.request('/api/webhooks/mercadopago?data.id=900&type=payment',{method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId,'x-signature':`ts=${ts},v1=${mac}`},body:'{"type":"payment","data":{"id":"900"}}'});
    assert.equal(r.status,401);
  }
  assert.equal(f.lookupCalls(),0);assert.equal(f.calls(),0);assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);
  assert.equal((await f.issue()).status,404);
});
