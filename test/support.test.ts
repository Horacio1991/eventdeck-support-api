import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig, cents } from '../src/config/env.js';
import { MemoryStore } from '../src/services/store.js';
import { MercadoPagoGateway, PaymentLookupError, type Gateway, type Payment } from '../src/services/mercadopago.service.js';
import { validSignature } from '../src/services/webhook-signature.js';
const secret=randomBytes(32).toString('hex');
const env={MP_ACCESS_TOKEN:`TEST-${randomBytes(32).toString('hex')}`,MP_WEBHOOK_SECRET:secret,BASE_URL:'https://api.example.test',FRONTEND_URL:'https://api.example.test',CORS_ORIGIN:'https://api.example.test',SUPPORT_AMOUNT:'1000.50'};
const config=loadConfig(env);
class FakeGateway implements Gateway {
 bodies:Record<string,unknown>[]=[];payment!:Payment;calls=0;fail=false;
 async createPreference(body:Record<string,unknown>){this.bodies.push(body);return {id:'pref-test',collector_id:123,sandbox_init_point:'https://sandbox.mercadopago.com/mla/checkout/pay?pref_id=pref-test'};}
 async getPayment(id:string){this.calls++;if(this.fail)throw new Error('private upstream error must not leak');await new Promise(r=>setTimeout(r,10));return structuredClone(this.payment);}
}
async function fixture(t:any,c=config){
 const gateway=new FakeGateway();const logs:{event:string;fields?:unknown}[]=[];const store=new MemoryStore();
 const app=createApp(c,{gateway,store,log:(event,fields)=>logs.push({event,fields})});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
 const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}`;
 const request=(path:string,init?:RequestInit)=>fetch(base+path,init);
 const checkout=async()=>{const r=await request('/api/support/create-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,201);return r.json() as Promise<{publicToken:string;checkoutUrl:string}>;};
 const payment=(status='pending',extra:Partial<Payment>={})=>{gateway.payment={id:900,external_reference:String(gateway.bodies.at(-1)!.external_reference),collector_id:123,transaction_amount:1000.5,currency_id:'ARS',live_mode:false,status,date_last_updated:'2026-10-22T12:00:00Z',...extra};};
 const webhook=(signature?:string,body:unknown={type:'payment',data:{id:'900'}},query='data.id=900&type=payment')=>{
  const ts='1792670400000',requestId='test-request';const mac=createHmac('sha256',secret).update(`id:900;request-id:${requestId};ts:${ts};`).digest('hex');
  return request('/api/webhooks/mercadopago?'+query,{method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId,'x-signature':signature??`ts=${ts},v1=${mac}`},body:JSON.stringify(body)});
 };
 return {gateway,logs,store,request,checkout,payment,webhook};
}
test('health starts with no secrets; checkout fails closed',async t=>{const f=await fixture(t,loadConfig({}));assert.deepEqual(await (await f.request('/health')).json(),{status:'ok',service:'eventdeck-support-api'});const r=await f.request('/api/support/create-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,503);});
test('amount validated exactly, opaque test credential prefixes and restrictive CORS',()=>{
 assert.equal(cents('1000.50'),100050);for(const n of ['-1','1e3','NaN','1.234','0x20','Infinity'])assert.equal(cents(n),null);
 for(const v of ['0','-2','1.234'])assert.throws(()=>loadConfig({...env,SUPPORT_AMOUNT:v}));
 const alternate=`APP_USR-${randomBytes(32).toString('hex')}`;
 assert.equal(loadConfig({...env,MP_ACCESS_TOKEN:alternate}).accessToken,alternate);
 assert.throws(()=>loadConfig({...env,MP_ACCESS_TOKEN:'invalid token'}));assert.throws(()=>loadConfig({...env,CORS_ORIGIN:'*'}));
});
test('create ignores no browser fields: it rejects amount/currency/urls/cards',async t=>{const f=await fixture(t);for(const body of [{amount:1},{currency:'USD'},{back_urls:{}},{notification_url:'https://evil.test'},{card_number:'not-a-card'},[],null]){const r=await f.request('/api/support/create-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,400);}assert.equal(f.gateway.bodies.length,0);});
test('preference has server amount, UUID, unique public tokens, HTTPS returns',async t=>{const f=await fixture(t);const a=await f.checkout(),b=await f.checkout();assert.match(a.publicToken,/^[a-f0-9]{64}$/);assert.notEqual(a.publicToken,b.publicToken);const p=f.gateway.bodies[0]!;assert.match(String(p.external_reference),/^[a-f0-9-]{36}$/);assert.notEqual(p.external_reference,a.publicToken);assert.equal((p.items as any)[0].unit_price,1000.5);assert.equal(p.auto_return,'approved');assert.equal(p.notification_url,'https://api.example.test/api/webhooks/mercadopago');assert.equal((p.back_urls as any).success,`https://api.example.test/support/success/${a.publicToken}`);assert.equal(JSON.stringify(f.logs).includes(a.publicToken),false);});
test('status is minimal, nonenumerable; success/query cannot grant',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();assert.equal((await f.request('/api/support/status/1')).status,404);assert.equal((await f.request('/api/support/status/'+'a'.repeat(64))).status,404);assert.equal((await f.request(`/support/success/${publicToken}?status=approved&payment_id=900`)).status,200);assert.deepEqual(await (await f.request('/api/support/status/'+publicToken)).json(),{status:'processing',accessGranted:false});});
test('pending verified via API, forged approved payload ignored',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();f.payment();assert.equal((await f.webhook(undefined,{type:'payment',data:{id:'900'},status:'approved',live_mode:false})).status,200);assert.deepEqual(await (await f.request('/api/support/status/'+publicToken)).json(),{status:'pending',accessGranted:false});});
test('invalid/absent signature and ID mismatch cannot call MP',async t=>{const f=await fixture(t);await f.checkout();f.payment('approved');assert.equal((await f.webhook('ts=1,v1=bad')).status,401);assert.equal((await f.webhook(undefined,{type:'payment',data:{id:'901'}})).status,400);assert.equal((await f.webhook(undefined,{},'data.id=900&data.id=901&type=payment')).status,401);assert.equal(f.gateway.calls,0);});
test('approved grants once, including concurrent duplicate webhooks',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();f.payment('approved');const results=await Promise.all(Array.from({length:5},()=>f.webhook()));assert(results.every(r=>r.status===200));await f.webhook();assert.equal(f.logs.filter(l=>l.event==='VISUAL PACK ACCESS GRANTED').length,1);assert.deepEqual(await (await f.request('/api/support/status/'+publicToken)).json(),{status:'approved',accessGranted:true});});
test('rejected/cancelled/refunded/charged_back/unknown never grant',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();let i=0;for(const status of ['rejected','cancelled','refunded','charged_back','something_new']){f.payment(status,{date_last_updated:`2026-10-22T12:0${i++}:00Z`});assert.equal((await f.webhook()).status,200);assert.equal((await (await f.request('/api/support/status/'+publicToken)).json()).accessGranted,false);}assert.equal(f.logs.filter(l=>l.event==='VISUAL PACK ACCESS GRANTED').length,0);});
test('mismatched amount/currency/collector/live mode cannot grant',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();for(const extra of [{transaction_amount:1},{currency_id:'USD'},{collector_id:777},{live_mode:true},{date_last_updated:'invalid'}]){f.payment('approved',extra);assert.equal((await f.webhook()).status,422);}assert.equal((await (await f.request('/api/support/status/'+publicToken)).json()).accessGranted,false);});
test('unrelated external reference ignored',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();f.payment('approved',{external_reference:'someone-else'});assert.equal((await f.webhook()).status,200);assert.equal((await (await f.request('/api/support/status/'+publicToken)).json()).accessGranted,false);});
test('refund removes current access; older approval cannot restore; no duplicate grants',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();f.payment('approved');await f.webhook();f.payment('refunded',{date_last_updated:'2026-10-22T13:00:00Z'});await f.webhook();f.payment('approved');await f.webhook();assert.deepEqual(await (await f.request('/api/support/status/'+publicToken)).json(),{status:'refunded',accessGranted:false});assert.equal(f.logs.filter(l=>l.event==='VISUAL PACK ACCESS GRANTED').length,1);});
test('partial refund does not leave access granted',async t=>{const f=await fixture(t);const {publicToken}=await f.checkout();f.payment('approved',{transaction_amount_refunded:1});await f.webhook();assert.equal((await (await f.request('/api/support/status/'+publicToken)).json()).accessGranted,false);});
test('MP failure does not ACK success; retry succeeds; safe error',async t=>{const f=await fixture(t);await f.checkout();f.payment('approved');f.gateway.fail=true;const r=await f.webhook();assert.equal(r.status,500);assert(!JSON.stringify(await r.json()).includes('private'));f.gateway.fail=false;assert.equal((await f.webhook()).status,200);});
test('restrictive CORS, CSP and no-store',async t=>{const f=await fixture(t);const denied=await f.request('/api/support/config',{headers:{Origin:'https://evil.test'}});assert.equal(denied.status,403);assert.equal(denied.headers.get('access-control-allow-origin'),null);const r=await f.request('/api/support/config',{headers:{Origin:config.corsOrigin}});assert.equal(r.headers.get('access-control-allow-origin'),config.corsOrigin);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert(r.headers.get('content-security-policy')?.includes("script-src 'self'"));});
test('create-checkout rate limit',async t=>{const f=await fixture(t);for(let i=0;i<10;i++)await f.checkout();assert.equal((await f.request('/api/support/create-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,429);});
test('signature known manifest, ts seconds and ms, missing/tampered fields',()=>{for(const ts of ['1792670400','1792670400000']){const h=createHmac('sha256',secret).update(`id:123;request-id:req;ts:${ts};`).digest('hex');assert(validSignature(`ts=${ts},v1=${h}`,'req','123',secret));assert(!validSignature(`ts=${ts},v1=${h}`,'req','124',secret));assert(!validSignature(`ts=${ts},v1=${h}`,'other','123',secret));assert(!validSignature(`ts=${ts},v1=${h},ts=${ts}`,'req','123',secret));}assert(!validSignature(undefined,'req','123',secret));});
test('memory capacity and token hashing',()=>{const store=new MemoryStore(1000,1);const {operation,publicToken}=store.create(100,'ARS');assert.notEqual(operation.tokenHash,publicToken);assert.equal(store.byToken(publicToken)?.id,operation.id);assert.throws(()=>store.create(100,'ARS'));const expired=new MemoryStore(-1);const created=expired.create(100,'ARS');assert.equal(expired.byToken(created.publicToken),undefined);});
test('REST adapter uses correct endpoint/auth and masks upstream secrets',async()=>{let seen='';const gateway=new MercadoPagoGateway('unit-secret',async(url,init)=>{seen=String(url);assert.equal((init?.headers as any).Authorization,'Bearer unit-secret');return new Response(JSON.stringify({id:900}),{status:200});});await gateway.getPayment('900');assert.equal(seen,'https://api.mercadopago.com/v1/payments/900');const failing=new MercadoPagoGateway('unit-secret',async()=>new Response('unit-secret',{status:401}));await assert.rejects(()=>failing.getPayment('900'),error=>error instanceof Error&&!error.message.includes('unit-secret'));});

test('FIX: first observable webhook log precedes JSON parser failure',async t=>{
 const f=await fixture(t);
 const r=await f.request('/api/webhooks/mercadopago?data.id=900&type=payment&secret=do-not-log',{method:'POST',headers:{'Content-Type':'application/json','x-signature':'do-not-log'},body:'{broken'});
 assert.equal(r.status,400);
 assert.equal(f.logs[0]?.event,'webhook_request_received');
 assert.equal(f.logs[0]?.fields?.code,'webhook-raw-url-diagnostic');
 assert(f.logs.some(l=>l.event==='webhook_response_sent'));
 assert(!f.logs.some(l=>l.event==='webhook_handler_entered'));
 assert.equal(f.gateway.calls,0);
 assert(!JSON.stringify(f.logs).includes('do-not-log'));
 assert.equal(r.headers.get('x-eventdeck-webhook-fix'),'webhook-raw-url-diagnostic');
 assert.match(r.headers.get('x-eventdeck-trace-id')!,/^[a-f0-9-]{36}$/);
});
test('FIX: signed JSON without Origin reaches exact POST route and logs ACK',async t=>{
 const f=await fixture(t);await f.checkout();f.payment('approved');f.logs.length=0;
 assert.equal((await f.webhook()).status,200);
 const names=f.logs.map(l=>l.event);
 for(const name of ['webhook_request_received','webhook_handler_entered','webhook_signature_valid','webhook_payment_lookup_started','webhook_payment_verified','VISUAL PACK ACCESS GRANTED','webhook_acknowledged'])assert(names.includes(name),name);
 assert.equal(names[0],'webhook_request_received');
 const traces=f.logs.map(l=>(l.fields as any)?.traceId).filter(Boolean);assert.equal(new Set(traces).size,1);
});
test('FIX: invalid signature is observable, 401 and never acknowledged',async t=>{
 const f=await fixture(t);
 const r=await f.webhook('ts=1792670400,v1='+'0'.repeat(64));assert.equal(r.status,401);
 assert(f.logs.some(l=>l.event==='webhook_request_received'));
 assert(f.logs.some(l=>l.event==='webhook_signature_invalid'));
 assert(!f.logs.some(l=>l.event==='webhook_acknowledged'));assert.equal(f.gateway.calls,0);
});
test('FIX: authenticated missing payment is acknowledged, no access or grant',async t=>{
 const f=await fixture(t);const {publicToken}=await f.checkout();
 f.gateway.getPayment=async(id:string)=>{assert.equal(id,'123456');throw new PaymentLookupError(404);};
 const ts='1792670400000';
 const signature=createHmac('sha256',secret).update(`id:123456;request-id:test-request;ts:${ts};`).digest('hex');
 assert.equal((await f.webhook(`ts=${ts},v1=${signature}`,{type:'payment',data:{id:'123456'}},'data.id=123456&type=payment')).status,200);
 assert.deepEqual(await (await f.request('/api/support/status/'+publicToken)).json(),{status:'processing',accessGranted:false});
 assert(f.logs.some(l=>l.event==='webhook_payment_lookup_failed'&&(l.fields as any).upstreamStatus===404));
 assert(f.logs.some(l=>l.event==='webhook_acknowledged'));
 assert(!f.logs.some(l=>l.event==='VISUAL PACK ACCESS GRANTED'));
});
test('FIX: auth/rate/provider/transport lookup failures remain retryable, not false ACKs',async t=>{
 const f=await fixture(t);const {publicToken}=await f.checkout();
 for(const status of [401,403,429,500,503,undefined]){
  f.gateway.getPayment=async()=>{throw new PaymentLookupError(status);};
  assert.equal((await f.webhook()).status,502);
 }
 assert(!f.logs.some(l=>l.event==='webhook_acknowledged'));
 assert.equal((await (await f.request('/api/support/status/'+publicToken)).json()).accessGranted,false);
});
test('FIX: adapter distinguishes authenticated payment 404 from other errors, no raw body',async()=>{
 for(const status of [404,401,403,429,500]){
  const gateway=new MercadoPagoGateway('fixture',async()=>new Response('sensitive upstream body',{status}));
  await assert.rejects(()=>gateway.getPayment('123456'),e=>e instanceof PaymentLookupError&&e.upstreamStatus===status&&!e.message.includes('sensitive'));
 }
 const broken=new MercadoPagoGateway('fixture',async()=>{throw new Error('sensitive transport');});
 await assert.rejects(()=>broken.getPayment('123456'),e=>e instanceof PaymentLookupError&&e.upstreamStatus===undefined);
});
test('FIX: webhook ignores foreign Origin; CORS on frontend remains restrictive',async t=>{
 const f=await fixture(t);
 const r=await f.request('/api/webhooks/mercadopago?data.id=900&type=payment',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'});
 assert.equal(r.status,401);assert.equal((await r.json() as any).error,'INVALID_SIGNATURE');
 assert(f.logs.some(l=>l.event==='webhook_handler_entered'));
 assert.equal((await f.request('/api/support/config',{headers:{Origin:'https://foreign.example'}})).status,403);
});
test('FIX: wrong method or suffix is observed but cannot process payment',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/webhooks/mercadopago')).status,404);
 assert.equal((await f.request('/api/webhooks/mercadopago-typo',{method:'POST'})).status,404);
 assert.equal(f.logs.filter(l=>l.event==='webhook_request_received').length,2);
 assert(!f.logs.some(l=>l.event==='webhook_handler_entered'));assert.equal(f.gateway.calls,0);
});
test('FIX: oversized payload and rate limiter still emit ingress and response logs',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/webhooks/mercadopago',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:'a'.repeat(17000)})})).status,413);
 for(let i=0;i<179;i++)await f.webhook('invalid');
 f.logs.length=0;
 assert.equal((await f.webhook('invalid')).status,429);
 assert.equal(f.logs[0]?.event,'webhook_request_received');
 assert(f.logs.some(l=>l.event==='webhook_response_sent'&&(l.fields as any).httpStatus===429));
 assert(!f.logs.some(l=>l.event==='webhook_handler_entered'));
});
