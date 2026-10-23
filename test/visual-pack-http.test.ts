import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { MemoryStore } from '../src/services/store.js';
import { MemoryEntitlementRepository, MemoryDownloadTokenRepository, VISUAL_PACK } from '../src/benefits/repositories.js';
import { downloadTokenHash } from '../src/benefits/visual-pack.service.js';
import type { Gateway, Payment } from '../src/services/mercadopago.service.js';
import { FakeStorage } from './helpers/fake-storage.js';

const secret='test-webhook-secret-for-local-fixture';
const prod='diagnostic-production-secret-for-local-fixture';
const config=loadConfig({MP_ACCESS_TOKEN:'TEST-local-fixture-token',MP_WEBHOOK_SECRET:secret,
  MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC:prod,BASE_URL:'https://api.example.test',FRONTEND_URL:'https://api.example.test',
  CORS_ORIGIN:'https://api.example.test',SUPPORT_AMOUNT:'1000'});
async function fixture(t:TestContext,configured=true) {
  const store=new MemoryStore(),entitlements=new MemoryEntitlementRepository(),downloadTokens=new MemoryDownloadTokenRepository();
  const storage=new FakeStorage();const logs:unknown[]=[];let calls=0;
  const {operation:op,publicToken}=store.create(100000,'ARS');op.preferenceId='pref';op.collectorId='123';
  let payment:Payment={id:900,external_reference:op.id,collector_id:123,transaction_amount:1000,currency_id:'ARS',live_mode:false,status:'approved',date_last_updated:'2026-10-23T00:00:00Z'};
  const gateway:Gateway={createPreference:async()=>{throw new Error('Checkout must not be called');},getPayment:async()=>{calls++;return {...payment};}};
  const app=createApp(config,{store,entitlements,downloadTokens,gateway,storage:configured?storage:undefined,log:(event,fields)=>logs.push({event,fields})});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request=(path:string,options?:RequestInit)=>fetch(base+path,{redirect:'manual',...options});
  const webhook=(signingSecret=secret,query='data.id=900&type=payment')=>{
    const ts='1792713600000',requestId='fixture-request';
    const mac=createHmac('sha256',signingSecret).update(`id:900;request-id:${requestId};ts:${ts};`).digest('hex');
    return request('/api/webhooks/mercadopago?'+query,{method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId,'x-signature':`ts=${ts},v1=${mac}`},body:JSON.stringify({type:'payment',data:{id:'900'}})});
  };
  const issue=(body:unknown={},token=publicToken,origin?:string)=>request('/api/support/download-token/'+token,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  return {op,publicToken,store,entitlements,downloadTokens,storage,logs,request,webhook,issue,calls:()=>calls,
    setPayment:(extra:Partial<Payment>)=>{payment={...payment,...extra};}};
}
test('HTTP: verified approval creates exactly one entitlement across duplicate webhooks',async t=>{
  const f=await fixture(t);assert.equal((await f.webhook()).status,200);const e=f.entitlements.find(f.op.id,VISUAL_PACK)!;
  assert(e);await Promise.all([f.webhook(),f.webhook(),f.webhook()]);assert.deepEqual(f.entitlements.find(f.op.id,VISUAL_PACK),e);
  assert.equal(f.logs.filter((l:any)=>l.event==='VISUAL PACK ACCESS GRANTED').length,1);
});
test('HTTP: invalid TEST HMAC never looks up payment, creates entitlement or token',async t=>{
  const f=await fixture(t);assert.equal((await f.webhook('wrong')).status,401);assert.equal(f.calls(),0);
  assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);assert.equal((await f.issue()).status,404);assert.equal(f.storage.calls.length,0);
});
test('HTTP: PROD-only match remains 401 with no entitlement',async t=>{
  const f=await fixture(t);assert.equal((await f.webhook(prod)).status,401);assert.equal(f.calls(),0);
  assert(f.logs.some((l:any)=>l.event==='webhook_dual_secret_diagnostic'&&l.fields.productionSecretMatch===true&&l.fields.testSecretMatch===false));
  assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);assert.equal((await f.issue()).status,404);
});
test('HTTP: unverified/mismatched payment, legacy query and redirect cannot grant',async t=>{
  const f=await fixture(t);f.setPayment({transaction_amount:1});assert.equal((await f.webhook()).status,422);
  assert.equal((await f.webhook(secret,'id=900&topic=payment')).status,401);
  assert.equal((await f.request(`/support/success/${f.publicToken}?status=approved&payment_id=900`)).status,200);
  assert.equal((await f.issue()).status,404);assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);
});
test('HTTP: pending verified payment does not create entitlement',async t=>{
  const f=await fixture(t);f.setPayment({status:'pending'});assert.equal((await f.webhook()).status,200);
  assert.equal((await f.issue()).status,404);assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);
});
test('HTTP: status compatibility plus opt-in safe benefit metadata; no tokens per poll',async t=>{
  const f=await fixture(t);await f.webhook();
  assert.deepEqual(await (await f.request('/api/support/status/'+f.publicToken)).json(),{status:'approved',accessGranted:true});
  const enhanced=await (await f.request('/api/support/status/'+f.publicToken+'?include=benefit')).json();
  assert.deepEqual(enhanced,{status:'approved',accessGranted:true,benefit:{id:VISUAL_PACK,available:true,downloadReady:true}});
  assert.equal(f.storage.calls.length,0);assert(!JSON.stringify(enhanced).includes(f.publicToken));
});
test('HTTP: default storage disabled even for approved entitlement',async t=>{
  const f=await fixture(t,false);await f.webhook();assert.equal((await f.issue()).status,503);
  const status=await (await f.request('/api/support/status/'+f.publicToken+'?include=benefit')).json();
  assert.deepEqual(status.benefit,{id:VISUAL_PACK,available:true,downloadReady:false});assert.equal(f.storage.calls.length,0);
});
test('HTTP: authorized GET returns empty 302 to storage, never file bytes',async t=>{
  const f=await fixture(t);await f.webhook();const r=await f.issue();assert.equal(r.status,201);
  const result=await r.json();const download=await f.request(result.downloadPath);
  assert.equal(download.status,302);assert.equal(download.headers.get('location'),'https://storage.example.invalid/private/pack?test-signature=fake');
  assert.equal(await download.text(),'');assert.equal(download.headers.get('cache-control'),'no-store');assert.equal(download.headers.get('referrer-policy'),'no-referrer');
  assert.deepEqual(f.storage.calls.map(x=>x.benefitId),[VISUAL_PACK]);
  const text=JSON.stringify(f.logs);for(const sensitive of [secret,prod,config.accessToken,f.publicToken,result.downloadPath,'test-signature=fake'])assert(!text.includes(sensitive));
});
test('HTTP: HEAD does not resolve storage or consume a use',async t=>{
  const f=await fixture(t);await f.webhook();const {downloadPath}=await (await f.issue()).json();
  assert.equal((await f.request(downloadPath,{method:'HEAD'})).status,405);assert.equal(f.storage.calls.length,0);
  const hash=downloadTokenHash(downloadPath.split('/').at(-1));assert.equal(f.downloadTokens.byHash(hash)?.remainingUses,3);
});
test('HTTP: browser cannot choose entitlement, payment, approved status or asset',async t=>{
  const f=await fixture(t);await f.webhook();
  for(const body of [{status:'approved'},{paymentId:'900'},{benefitId:VISUAL_PACK},{assetId:'other'},{operationId:f.op.id}])assert.equal((await f.issue(body)).status,400);
  assert.equal((await f.issue({},f.op.id)).status,404);assert.equal((await f.issue({},'a'.repeat(64))).status,404);
  assert.equal(f.storage.calls.length,0);
});
test('HTTP: token issuance retains restrictive frontend CORS and rate limiting',async t=>{
  const f=await fixture(t);await f.webhook();assert.equal((await f.issue({},f.publicToken,'https://evil.invalid')).status,403);
  for(let i=0;i<10;i++)assert.equal((await f.issue()).status,201);
  assert.equal((await f.issue()).status,429);
});
test('HTTP: invalid token rejection is generic and storage remains untouched',async t=>{
  const f=await fixture(t);for(const token of ['bad','b'.repeat(64),f.publicToken])assert.equal((await f.request('/api/downloads/'+token)).status,404);
  assert.equal(f.storage.calls.length,0);
});
test('HTTP: verified refund revokes entitlement and previously issued token',async t=>{
  const f=await fixture(t);await f.webhook();const {downloadPath}=await (await f.issue()).json();
  f.setPayment({status:'approved',transaction_amount_refunded:1,date_last_updated:'2026-10-23T01:00:00Z'});await f.webhook();
  assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK)?.status,'revoked');assert.equal((await f.request(downloadPath)).status,404);assert.equal((await f.issue()).status,404);
  assert.equal(f.storage.calls.length,0);
});
test('HTTP: no public grant/approve endpoints exist',async t=>{
  const f=await fixture(t);for(const path of ['/dev/grant','/test/approve','/api/support/grant'])assert.equal((await f.request(path,{method:'POST'})).status,404);
  assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);
});
