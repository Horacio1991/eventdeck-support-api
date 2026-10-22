import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { buildManifest, inspectSignature, validSignature } from '../src/services/webhook-signature.js';
import { webhookInput } from '../src/services/webhook-input.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { PaymentLookupError, type Gateway } from '../src/services/mercadopago.service.js';
import { logger } from '../src/utils/logger.js';
const secret=randomBytes(32).toString('hex');
const other=randomBytes(32).toString('hex');
const third=randomBytes(32).toString('hex');
const ts='1792684550',requestId='dual-request-fixture';
const signed=(id:string,key=secret)=>`ts=${ts},v1=${createHmac('sha256',key).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex')}`;
async function fixture(t:any,productionSecret:string|undefined){
 let reference='';let calls=0;let missing=false;
 const logs:{event:string;fields:any}[]=[];
 const gateway:Gateway={
  async createPreference(body){reference=String(body.external_reference);return {id:'pref',collector_id:123,sandbox_init_point:'https://sandbox.mercadopago.com/mla/checkout/pay?pref_id=fixture'};},
  async getPayment(id){calls++;if(missing)throw new PaymentLookupError(404);return {id,external_reference:reference,collector_id:123,transaction_amount:1000,currency_id:'ARS',live_mode:false,status:'approved',date_last_updated:'2026-10-22T15:55:50Z'};}
 };
 const config=loadConfig({MP_ACCESS_TOKEN:'TEST-'+randomBytes(32).toString('hex'),MP_WEBHOOK_SECRET:secret,MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC:productionSecret,BASE_URL:'https://example.test',SUPPORT_AMOUNT:'1000'});
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

const cases=[
 {name:'A TEST only',prod:other,key:secret,normal:true,production:false},
 {name:'B PROD only must reject without lookup or grant',prod:other,key:other,normal:false,production:true},
 {name:'C neither matches',prod:other,key:third,normal:false,production:false},
 {name:'D both match identical keys',prod:secret,key:secret,normal:true,production:true},
 {name:'E missing PROD normal valid',prod:undefined,key:secret,normal:true,production:null},
 {name:'F missing PROD normal invalid',prod:undefined,key:other,normal:false,production:null}
];
for(const c of cases)test('DUAL '+c.name,async t=>{
 const f=await fixture(t,c.prod);
 const header=signed('185544391474',c.key);
 assert.equal((await f.webhook(undefined,undefined,header)).status,c.normal?200:401);
 const d=f.logs.find(l=>l.event==='webhook_dual_secret_diagnostic')!.fields;
 assert.equal(d.testSecretConfigured,true);
 assert.equal(d.productionSecretConfigured,Boolean(c.prod));
 assert.equal(d.testSecretMatch,c.normal);
 assert.equal(d.productionSecretMatch,c.production);
 assert.equal(d.sameManifestUsed,true);
 assert.equal(d.manifestLength,Buffer.byteLength(buildManifest('185544391474',requestId,ts)));
 assert.equal((await f.status()).accessGranted,c.normal);
 assert.equal(f.calls(),c.normal?1:0);
 assert.equal(f.logs.filter(l=>l.event==='VISUAL PACK ACCESS GRANTED').length,c.normal?1:0);
 if(c.normal){
  assert.equal((await f.webhook(undefined,undefined,header)).status,200);
  assert.equal(f.logs.filter(l=>l.event==='VISUAL PACK ACCESS GRANTED').length,1);
 }
 const raw=JSON.stringify(f.logs);
 for(const value of [secret,other,third,requestId,header,header.split('v1=')[1]!])assert(!raw.includes(value));
});
test('DUAL malformed input cannot become a false/false cryptographic conclusion',()=>{
 for(const header of [undefined,'bad','ts='+ts+',v1=bad',signed('123')+',ts='+ts]){
  const r=inspectSignature(header,requestId,'123',secret,other);
  assert.equal(r.valid,false);assert.equal(r.dualDiagnostic,undefined);
 }
});
test('DUAL production logger emits safe fields and excludes secrets/digests',t=>{
 const lines:string[]=[];
 t.mock.method(console,'log',(line:string)=>lines.push(line));
 logger('webhook_dual_secret_diagnostic',{
  testSecretConfigured:true,productionSecretConfigured:false,testSecretMatch:false,
  productionSecretMatch:null,sameManifestUsed:true,
  secret,productionSecret:other,v1:third,accessToken:secret
 } as any);
 const value=JSON.parse(lines[0]!);
 assert.equal(value.productionSecretMatch,null);assert.equal(value.testSecretMatch,false);
 assert.equal(value.sameManifestUsed,true);
 for(const v of [secret,other,third])assert(!lines[0]!.includes(v));
});
