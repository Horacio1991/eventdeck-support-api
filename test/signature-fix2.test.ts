import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { buildManifest, inspectSignature, validSignature } from '../src/services/webhook-signature.js';
import { webhookInput } from '../src/services/webhook-input.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { PaymentLookupError, type Gateway } from '../src/services/mercadopago.service.js';
const secret=randomBytes(32).toString('hex');
const ts='1792684550804',requestId='test-request-123';
// Fixtures sintéticos con estructura oficial. NO son las firmas reales del log recibido.
const signed=(id:string,key=secret)=>`ts=${ts},v1=${createHmac('sha256',key).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex')}`;
test('FIX2: documented manifest ordering, separators and trailing semicolon',()=>{
 assert.equal(buildManifest('123456',requestId,ts),`id:123456;request-id:${requestId};ts:${ts};`);
 assert.equal(buildManifest(undefined,requestId,ts),`request-id:${requestId};ts:${ts};`);
 assert.equal(buildManifest('123456',undefined,ts),`id:123456;ts:${ts};`);
 assert.equal(buildManifest(undefined,undefined,undefined),'');
});
test('FIX2: simulator-shaped signature validates',()=>{
 assert(validSignature(signed('123456'),requestId,'123456',secret));
});
test('FIX2: real Payments-shaped numeric ID validates unchanged',()=>{
 assert(validSignature(signed('185544391474'),requestId,'185544391474',secret));
 assert.equal(inspectSignature(signed('185544391474'),requestId,'185544391474',secret).diagnostics.signatureCheck,'MATCH');
});
test('FIX2: current official SDK case preservation; no lowercase fallback',()=>{
 assert.equal(buildManifest('AbC123',requestId,ts),`id:AbC123;request-id:${requestId};ts:${ts};`);
 assert(validSignature(signed('AbC123'),requestId,'AbC123',secret));
 assert(!validSignature(signed('AbC123'),requestId,'abc123',secret));
 assert.equal(buildManifest('00123',requestId,ts),`id:00123;request-id:${requestId};ts:${ts};`);
 assert(!validSignature(signed('123'),requestId,' 123 ',secret));
});
test('FIX2: header order and delimiter whitespace allowed',()=>{
 const v1=signed('123456').split('v1=')[1];
 assert(validSignature(` v1 = ${v1} , ts = ${ts} `,requestId,'123456',secret));
});
test('FIX2: missing, malformed and duplicate signature fields diagnosed',()=>{
 const check=(s:string|undefined,r=requestId)=>inspectSignature(s,r,'123456',secret).diagnostics.signatureCheck;
 assert.equal(check(undefined),'MISSING_SIGNATURE');
 assert.equal(check(signed('123456')+',ts='+ts),'DUPLICATE_SIGNATURE_COMPONENT');
 assert.equal(check(signed('123456')+',v1='+'a'.repeat(64)),'DUPLICATE_SIGNATURE_COMPONENT');
 assert.equal(check('ts=1,v1='+'a'.repeat(64)),'TIMESTAMP_FORMAT');
 assert.equal(check('ts='+ts+',v1=bad'),'DIGEST_FORMAT');
 assert.equal(check(signed('123456'),'has spaces'),'REQUEST_ID_FORMAT');
 assert.equal(check(signed('123456')+',extra=unknown'),'SIGNATURE_HEADER_FORMAT');
});
test('FIX2: missing components cannot authenticate even if generic manifest omits pairs',()=>{
 const v1=createHmac('sha256',secret).update(buildManifest(undefined,requestId,ts)).digest('hex');
 assert.equal(inspectSignature(`ts=${ts},v1=${v1}`,requestId,undefined,secret).valid,false);
 assert.equal(inspectSignature(signed('123456'),undefined,'123456',secret).valid,false);
});
test('FIX2: wrong secret is HMAC_MISMATCH, not parser failure',()=>{
 assert.equal(inspectSignature(signed('123456'),requestId,'123456',randomBytes(32).toString('hex')).diagnostics.signatureCheck,'HMAC_MISMATCH');
});
test('FIX2: data.id only from query; duplicate query cannot be coerced',()=>{
 assert.equal(webhookInput({}, {data:{id:'123456'}}).dataId,undefined);
 assert.equal(webhookInput({'data.id':['123456','123456']},{}).dataId,undefined);
 assert.equal(webhookInput({'data.id':'123456'},{data:{id:'999'}}).dataId,'123456');
 assert.equal(webhookInput({'data.id':'123456'},{data:{id:'999'}}).diagnostics.bodyIdMatchesQuery,false);
});
test('FIX2: legacy notification and body-only are candidates, never authenticated by shape',()=>{
 assert.equal(webhookInput({id:'123',topic:'payment'},{}).diagnostics.notificationShape,'legacy_ipn_candidate');
 assert.equal(webhookInput({},{resource:'https://example.invalid',topic:'merchant_order'}).diagnostics.notificationShape,'legacy_ipn_candidate');
 assert.equal(webhookInput({},{type:'payment',data:{id:123}}).diagnostics.notificationShape,'body_only_candidate');
 assert.equal(webhookInput({'data.id':'123',type:'payment'},{}).diagnostics.notificationShape,'payments_webhook');
});
async function fixture(t:any){
 let reference='';let calls=0;let missing=false;
 const logs:{event:string;fields:any}[]=[];
 const gateway:Gateway={
  async createPreference(body){reference=String(body.external_reference);return {id:'pref',collector_id:123,sandbox_init_point:'https://sandbox.mercadopago.com/mla/checkout/pay?pref_id=fixture'};},
  async getPayment(id){calls++;if(missing)throw new PaymentLookupError(404);return {id,external_reference:reference,collector_id:123,transaction_amount:1000,currency_id:'ARS',live_mode:false,status:'approved',date_last_updated:'2026-10-22T15:55:50Z'};}
 };
 const config=loadConfig({MP_ACCESS_TOKEN:'TEST-'+randomBytes(32).toString('hex'),MP_WEBHOOK_SECRET:secret,BASE_URL:'https://example.test',SUPPORT_AMOUNT:'1000'});
 const server=createApp(config,{gateway,log:(event,fields)=>logs.push({event,fields})}).listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const created=await fetch(base+'/api/support/create-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 const {publicToken}=await created.json() as any;
 const id='185544391474';
 const webhook=(query=`data.id=${id}&type=payment`,body:unknown={action:'payment.updated',type:'payment',data:{id},live_mode:false},signature=signed(id))=>fetch(base+'/api/webhooks/mercadopago?'+query,{method:'POST',headers:{'Content-Type':'application/json','x-signature':signature,'x-request-id':requestId},body:JSON.stringify(body)});
 const status=async()=>await (await fetch(base+'/api/support/status/'+publicToken)).json() as any;
 return {webhook,status,logs,calls:()=>calls,setMissing:()=>{missing=true;}};
}
test('FIX2: approved signed Payments, duplicates, status and safe diagnostics',async t=>{
 const f=await fixture(t);
 assert.equal((await f.webhook()).status,200);assert.equal((await f.webhook()).status,200);
 assert.deepEqual(await f.status(),{status:'approved',accessGranted:true});
 assert.equal(f.logs.filter(l=>l.event==='VISUAL PACK ACCESS GRANTED').length,1);
 const d=f.logs.find(l=>l.event==='webhook_signature_components')!.fields;
 assert.equal(d.paymentIdSource,'query');assert.equal(d.signatureCheck,'MATCH');assert.equal(d.timestampPresent,true);
 const raw=JSON.stringify(f.logs);assert(!raw.includes(secret));assert(!raw.includes(signed('185544391474').split('v1=')[1]!));assert(!raw.includes(requestId));
});
test('FIX2: real-shaped wrong HMAC gets401, no lookup, no access',async t=>{
 const f=await fixture(t);assert.equal((await f.webhook(undefined,undefined,signed('185544391474','wrong-fixture-secret'))).status,401);
 assert.equal(f.calls(),0);assert.equal((await f.status()).accessGranted,false);
 assert(f.logs.some(l=>l.event==='webhook_signature_invalid'&&l.fields.code==='HMAC_MISMATCH'));
});
test('FIX2: authenticated nonexistent payment acknowledged with no grant',async t=>{
 const f=await fixture(t);f.setMissing();assert.equal((await f.webhook()).status,200);
 assert.deepEqual(await f.status(),{status:'processing',accessGranted:false});
});
test('FIX2: absent query ID, legacy ID and duplicate query cannot use body as fallback',async t=>{
 const f=await fixture(t);
 for(const query of ['type=payment','id=185544391474&topic=payment','data.id=185544391474&data.id=185544391474&type=payment'])assert.equal((await f.webhook(query)).status,401);
 assert.equal(f.calls(),0);assert.equal((await f.status()).accessGranted,false);
});
test('FIX2: HMAC authenticates query ID; contradictory body is rejected',async t=>{
 const f=await fixture(t);assert.equal((await f.webhook(undefined,{type:'payment',data:{id:'999'}})).status,400);
 assert.equal(f.calls(),0);assert.equal((await f.status()).accessGranted,false);
});
test('FIX2: authenticated non-payment ignored; shape alone never bypasses HMAC',async t=>{
 const f=await fixture(t);
 assert.equal((await f.webhook('data.id=185544391474&type=merchant_order',{type:'merchant_order'})).status,200);
 assert(f.logs.some(l=>l.event==='webhook_event_ignored'));assert.equal(f.calls(),0);
 assert.equal((await f.webhook('data.id=185544391474&type=merchant_order',{type:'merchant_order'},'invalid')).status,401);
});
