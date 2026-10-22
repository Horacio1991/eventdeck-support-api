import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { captureWebhookHeaders,rawHeaderDiagnostic,type SignatureObservation } from '../src/services/webhook-raw-diagnostic.js';
import { inspectSignature,buildManifest } from '../src/services/webhook-signature.js';
import { logger } from '../src/utils/logger.js';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import type { Gateway } from '../src/services/mercadopago.service.js';
const secret=randomBytes(32).toString('hex'),prod=randomBytes(32).toString('hex');
const id='185567845436',rid='12345678-1234-1234-1234-123456789abc',ts='1792684550';
const sign=(key=secret)=>`ts=${ts},v1=${createHmac('sha256',key).update(buildManifest(id,rid,ts)).digest('hex')}`;
function snapshot(ids:string[]=[rid],sigs:string[]=[sign()],expressId=ids.join(', ')){
 const rawHeaders=['Authorization','DO_NOT_COPY_AUTH','Cookie','DO_NOT_COPY_COOKIE',...ids.flatMap(v=>['X-Request-ID',v]),...sigs.flatMap(v=>['X-Signature',v])];
 const headers={'x-request-id':expressId,'x-signature':sigs.join(', ')};
 return captureWebhookHeaders({rawHeaders,headers,get:(name:string)=>headers[name as keyof typeof headers]} as any);
}
function analyze(ids=[rid],sigs=[sign()],expressId=ids.join(', '),on=false){
 const s=snapshot(ids,sigs,expressId);let used:SignatureObservation={};
 const result=inspectSignature(s.expressSignature,s.expressRequestId,id,secret,prod,v=>{used=v;});
 return {s,result,d:rawHeaderDiagnostic(s,used,on)};
}
test('RAW 1 single request-id matches actual manifest input',()=>{
 const {d}=analyze();assert.equal(d.rawRequestIdCount,1);assert.deepEqual(d.rawRequestIdLengths,[36]);
 assert.equal(d.rawEqualsExpress,true);assert.equal(d.rawEqualsManifest,true);assert.equal(d.manifestRequestIdLength,36);
});
test('RAW 2 duplicate request-id preserved, combined value rejected',()=>{
 const {d,result}=analyze([rid,rid]);assert.equal(d.rawRequestIdCount,2);assert.equal(d.requestIdCombined,true);
 assert.equal(d.rawEqualsExpress,null);assert.equal(d.manifestBuilt,false);assert.equal(result.valid,false);
});
test('RAW 3 request-id leading and trailing whitespace detected without trimming',()=>{
 const {d,result}=analyze([' '+rid+'\t']);assert(d.requestIdHasLeadingWhitespace);assert(d.requestIdHasTrailingWhitespace);
 assert.equal(result.valid,false);assert.equal(d.rawEqualsManifest,null);
});
test('RAW 4 comma concatenation distinguished from duplicates',()=>{
 const {d,result}=analyze([rid+', other']);assert.equal(d.rawRequestIdCount,1);assert(d.requestIdContainsComma);
 assert.equal(d.requestIdCombined,false);assert.equal(result.valid,false);
});
test('RAW 5 one signature preserves exact ts/v1 comparison',()=>{
 const {d}=analyze();assert.equal(d.rawSignatureCount,1);assert.equal(d.tsComponentCount,1);assert.equal(d.v1ComponentCount,1);
 assert.equal(d.rawTsEqualsManifestTs,true);assert.equal(d.rawV1EqualsComparedV1,true);
 assert.equal(d.rawTsLength,10);assert.equal(d.rawV1Length,64);
});
test('RAW 6 duplicate signature counted and rejected',()=>{
 const {d,result}=analyze([rid],[sign(),sign()]);assert.equal(d.rawSignatureCount,2);assert(d.signatureCombined);
 assert.equal(d.tsComponentCount,2);assert.equal(d.v1ComponentCount,2);assert.equal(result.valid,false);
});
test('RAW 7 multiple ts counted without altering normal rejection',()=>{
 const {d,result}=analyze([rid],[sign()+',ts='+ts]);assert.equal(d.tsComponentCount,2);
 assert.equal(d.rawTsLength,null);assert.equal(result.diagnostics.signatureCheck,'DUPLICATE_SIGNATURE_COMPONENT');
});
test('RAW 8 multiple v1 counted without altering normal rejection',()=>{
 const {d,result}=analyze([rid],[sign()+',v1='+sign().split('v1=')[1]]);assert.equal(d.v1ComponentCount,2);
 assert.equal(d.rawV1EqualsComparedV1,null);assert.equal(result.valid,false);
});
test('RAW 9 delimiter whitespace exposes actual regex extraction',()=>{
 const header=` ts = ${ts} , v1 = ${sign().split('v1=')[1]} `;
 const {d,result}=analyze([rid],[header]);assert.equal(result.valid,true);assert(d.signatureContainsWhitespace);
 assert.equal(d.rawTsLength,12);assert.equal(d.parsedTsLength,10);assert.equal(d.rawTsEqualsManifestTs,false);
 assert.equal(d.rawV1Length,66);assert.equal(d.parsedV1Length,64);assert.equal(d.rawV1EqualsComparedV1,false);
});
test('RAW 10 changed Express input does not overwrite captured raw value',()=>{
 const {d}=analyze(['original-id'],[sign()],rid);assert.equal(d.rawEqualsExpress,false);assert.equal(d.rawEqualsManifest,false);
 const s=snapshot();const modified=rawHeaderDiagnostic(s,{requestId:'changed',manifest:buildManifest(id,'changed',ts),ts});
 assert.equal(modified.expressRequestIdEqualsValidator,false);assert.equal(modified.rawEqualsManifest,false);
});
test('RAW 11 OFF excludes all original values, config opt-in exact true only',()=>{
 const {d}=analyze();for(const key of ['rawRequestIdValues','rawSignatureValues','manifestExact'])assert(!(key in d));
 const raw=JSON.stringify(d);for(const v of [rid,ts,sign(),secret,prod])assert(!raw.includes(v));
 for(const value of [undefined,'false','TRUE','1',' true '])assert.equal(loadConfig({MP_WEBHOOK_RAW_DIAGNOSTIC:value}).webhookRawDiagnostic,false);
 assert.equal(loadConfig({MP_WEBHOOK_RAW_DIAGNOSTIC:'true'}).webhookRawDiagnostic,true);
});
test('RAW 12 ON exposes only authorized three value fields',()=>{
 const off=analyze().d,on=analyze([rid],[sign()],rid,true).d;
 assert.deepEqual(Object.keys(on).filter(k=>!(k in off)).sort(),['manifestExact','rawRequestIdValues','rawSignatureValues']);
 assert.deepEqual(on.rawRequestIdValues,[rid]);assert.deepEqual(on.rawSignatureValues,[sign()]);
 assert.equal(on.manifestExact,buildManifest(id,rid,ts));
});
test('RAW 13 real logger excludes secrets/tokens/auth/cookies and guards raw fields',t=>{
 const lines:string[]=[];t.mock.method(console,'log',(v:string)=>lines.push(v));
 const payload={...analyze([rid],[sign()],rid,true).d,secret,prod,Authorization:'DO_NOT_COPY_AUTH',Cookie:'DO_NOT_COPY_COOKIE',accessToken:'DO_NOT_COPY_TOKEN'};
 logger('webhook_raw_header_diagnostic',payload);
 const enabled=JSON.parse(lines[0]!);assert.deepEqual(enabled.rawRequestIdValues,[rid]);
 for(const v of [secret,prod,'DO_NOT_COPY_AUTH','DO_NOT_COPY_COOKIE','DO_NOT_COPY_TOKEN'])assert(!lines[0]!.includes(v));
 logger('webhook_raw_header_diagnostic',{...payload,rawDiagnosticEnabled:false});assert(!lines[1]!.includes(rid));
 logger('other-event',payload);assert(!lines[2]!.includes(rid));
});
async function fixture(t:any,on:boolean){
 const logs:{event:string;fields:any}[]=[];let reference='',calls=0;
 const gateway:Gateway={async createPreference(body){reference=String(body.external_reference);return {id:'fixture',collector_id:123,sandbox_init_point:'https://sandbox.mercadopago.com/mla/checkout/pay?pref_id=fixture'};},
 async getPayment(pid){calls++;return {id:pid,external_reference:reference,collector_id:123,transaction_amount:1000,currency_id:'ARS',live_mode:false,status:'approved',date_last_updated:'2026-10-22T16:55:00Z'};}};
 const config=loadConfig({MP_ACCESS_TOKEN:'synthetic-token',MP_WEBHOOK_SECRET:secret,MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC:prod,MP_WEBHOOK_RAW_DIAGNOSTIC:String(on),BASE_URL:'https://example.test',SUPPORT_AMOUNT:'1000'});
 const app=createApp(config,{gateway,log:(event,fields)=>logs.push({event,fields})});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const res=await fetch(base+'/api/support/create-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const {publicToken}=await res.json() as any;
 const send=(headers:string[],body=JSON.stringify({type:'payment',data:{id}}))=>new Promise<number>((resolve,reject)=>{
  const req=request(base+'/api/webhooks/mercadopago?data.id='+id+'&type=payment',{method:'POST',headers:['Host',new URL(base).host,'Content-Type','application/json','Authorization','DO_NOT_COPY_AUTH','Cookie','DO_NOT_COPY_COOKIE',...headers]},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(body);
 });
 const status=async()=>await (await fetch(base+'/api/support/status/'+publicToken)).json() as any;
 return {send,logs,status,calls:()=>calls};
}
test('RAW 14 real HTTP authorization identical ON/OFF',async t=>{
 for(const on of [false,true]){
  const f=await fixture(t,on);assert.equal(await f.send(['X-Request-Id',rid,'X-Signature',sign()]),200);
  assert.equal((await f.status()).accessGranted,true);assert.equal(f.calls(),1);
  const d=f.logs.find(l=>l.event==='webhook_raw_header_diagnostic')!.fields;
  assert.equal(d.rawEqualsManifest,true);assert.equal(d.rawTsEqualsManifestTs,true);
  assert.equal('manifestExact' in d,on);
 }
});
test('RAW 15 PROD-only signature cannot authorize ON or OFF',async t=>{
 for(const on of [false,true]){
  const f=await fixture(t,on);assert.equal(await f.send(['X-Request-Id',rid,'X-Signature',sign(prod)]),401);
  assert.equal(f.calls(),0);assert.equal((await f.status()).accessGranted,false);
  const dual=f.logs.find(l=>l.event==='webhook_dual_secret_diagnostic')!.fields;
  assert.equal(dual.testSecretMatch,false);assert.equal(dual.productionSecretMatch,true);
 }
});
test('RAW 16 real Node HTTP duplicate headers are counted and joined',async t=>{
 const f=await fixture(t,true);
 assert.equal(await f.send(['X-Request-Id',rid,'x-request-id','second','X-Signature',sign(),'x-signature',sign()]),401);
 const d=f.logs.find(l=>l.event==='webhook_raw_header_diagnostic')!.fields;
 assert.equal(d.rawRequestIdCount,2);assert.equal(d.rawSignatureCount,2);
 assert(d.requestIdCombined);assert(d.signatureCombined);assert.deepEqual(d.rawRequestIdValues,[rid,'second']);assert.equal(f.calls(),0);
});
test('RAW 17 Node parser boundary: wire surrounding OWS may already be stripped',async t=>{
 const f=await fixture(t,true);
 assert.equal(await f.send(['X-Request-Id',' '+rid+'\t','X-Signature',' '+sign()+' ']),200);
 const d=f.logs.find(l=>l.event==='webhook_raw_header_diagnostic')!.fields;
 assert.deepEqual(d.rawRequestIdValues,[rid]);assert.equal(d.requestIdHasLeadingWhitespace,false);
 assert.deepEqual(d.rawSignatureValues,[sign()]);
});
test('RAW 18 parser failure still emits captured headers without fabricated manifest',async t=>{
 const f=await fixture(t,true);assert.equal(await f.send(['X-Request-Id',rid,'X-Signature',sign()],'{bad'),400);
 const d=f.logs.find(l=>l.event==='webhook_raw_header_diagnostic')!.fields;
 assert.equal(d.rawRequestIdCount,1);assert.equal(d.manifestExact,null);assert.equal(d.manifestBuilt,false);assert.equal(f.calls(),0);
});
