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
 const send=(headers:string[],target='/api/webhooks/mercadopago?data.id='+id+'&type=payment',body=JSON.stringify({type:'payment',data:{id}}))=>new Promise<number>((resolve,reject)=>{
  const req=request(base+target,{method:'POST',headers:['Host',new URL(base).host,'Content-Type','application/json','Authorization','DO_NOT_COPY_AUTH','Cookie','DO_NOT_COPY_COOKIE',...headers]},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(body);
 });
 const status=async()=>await (await fetch(base+'/api/support/status/'+publicToken)).json() as any;
 return {send,logs,status,calls:()=>calls};
}

const headers=(key=secret)=>['X-Request-Id',rid,'X-Signature',sign(key)];
const diagnostic=(f:any)=>f.logs.find((l:any)=>l.event==='webhook_raw_header_diagnostic').fields;
const target='/api/webhooks/mercadopago?data.id='+id+'&type=payment';
test('URL 1 original path and query captured before mounted path rewrite is lost',async t=>{
 const f=await fixture(t,true);assert.equal(await f.send(headers()),200);const d=diagnostic(f);
 assert.equal(d.rawRequestUrl,target);assert.equal(d.mountedRequestUrl,'/mercadopago?data.id='+id+'&type=payment');
 assert.equal(d.rawUrlEqualsMounted,false);assert.equal(d.rawRequestUrlLength,target.length);
});
test('URL 2 data.id remains literal in captured query',async t=>{
 const f=await fixture(t,true);await f.send(headers());assert(diagnostic(f).rawRequestUrl.includes('data.id='+id));
});
test('URL 3 query order preserved',async t=>{
 const f=await fixture(t,true);const url='/api/webhooks/mercadopago?z=last&type=payment&data.id='+id+'&a=first';
 assert.equal(await f.send(headers(),url),200);assert.equal(diagnostic(f).rawRequestUrl,url);
});
test('URL 4 original encoding preserved rather than decode/reencode',async t=>{
 const f=await fixture(t,true);const url='/api/webhooks/mercadopago?data%2eid='+id+'&type=payment&note=%2f%2F+%20%252F';
 assert.equal(await f.send(headers(),url),200);assert.equal(diagnostic(f).rawRequestUrl,url);
});
test('URL 5 duplicate parameters preserved while normal validation rejects ambiguous ID',async t=>{
 const f=await fixture(t,true);const url=target+'&data.id='+id+'&x=1&x=2';
 assert.equal(await f.send(headers(),url),401);assert.equal(diagnostic(f).rawRequestUrl,url);assert.equal(f.calls(),0);
});
test('URL 6 ON real logger retains exact URLs and manifest',async t=>{
 const f=await fixture(t,true);await f.send(headers());const lines:string[]=[];
 t.mock.method(console,'log',(v:string)=>lines.push(v));logger('webhook_raw_header_diagnostic',diagnostic(f));
 const d=JSON.parse(lines[0]!);assert.equal(d.rawRequestUrl,target);assert.equal(d.manifestExact,buildManifest(id,rid,ts));
});
test('URL 7 OFF omits exact query both at event creation and final logger',async t=>{
 const f=await fixture(t,false);const url=target+'&note=PRIVATE_QUERY_SENTINEL';await f.send(headers(),url);
 const d=diagnostic(f);assert(!('rawRequestUrl' in d));assert(!('mountedRequestUrl' in d));
 assert(!JSON.stringify(f.logs).includes('PRIVATE_QUERY_SENTINEL'));
 const lines:string[]=[];t.mock.method(console,'log',(v:string)=>lines.push(v));
 logger('webhook_raw_header_diagnostic',{...d,rawRequestUrl:url,mountedRequestUrl:url});
 assert(!lines[0]!.includes('PRIVATE_QUERY_SENTINEL'));
});
test('URL 8 URL changes never enter HMAC manifest',async t=>{
 const f=await fixture(t,true);await f.send(headers(),target+'&extra=%41');
 assert.equal(diagnostic(f).manifestExact,buildManifest(id,rid,ts));
});
test('URL 9 ON/OFF preserve same normal and diagnostic HMAC results',async t=>{
 for(const on of [false,true]){const f=await fixture(t,on);assert.equal(await f.send(headers()),200);
 const d=f.logs.find(l=>l.event==='webhook_dual_secret_diagnostic')!.fields;
 assert.equal(d.testSecretMatch,true);assert.equal(d.productionSecretMatch,false);}
});
test('URL 10 invalid TEST remains401 without lookup or access',async t=>{
 const f=await fixture(t,true);assert.equal(await f.send(headers('invalid-fixture')),401);
 assert.equal(f.calls(),0);assert.equal((await f.status()).accessGranted,false);assert.equal(diagnostic(f).rawRequestUrl,target);
});
test('URL 11 PROD-only match remains401 without lookup or access',async t=>{
 const f=await fixture(t,true);assert.equal(await f.send(headers(prod)),401);
 assert.equal(f.calls(),0);assert.equal((await f.status()).accessGranted,false);
 const d=f.logs.find(l=>l.event==='webhook_dual_secret_diagnostic')!.fields;
 assert.equal(d.testSecretMatch,false);assert.equal(d.productionSecretMatch,true);
});
