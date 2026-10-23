import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/services/store.js';
import { grantVisualPackAccess } from '../src/services/access.service.js';
import { MemoryEntitlementRepository, MemoryDownloadTokenRepository, VISUAL_PACK } from '../src/benefits/repositories.js';
import { VisualPackService, downloadTokenHash, DOWNLOAD_TOKEN_TTL_MS, STORAGE_URL_TTL_MS } from '../src/benefits/visual-pack.service.js';
import { UnconfiguredVisualPackStorage } from '../src/benefits/storage.js';
import { AppError } from '../src/utils/errors.js';
import { FakeStorage } from './helpers/fake-storage.js';

const is404 = (e: unknown) => e instanceof AppError && e.status === 404;
const is503 = (e: unknown) => e instanceof AppError && e.status === 503;
function fixture() {
  let now = Date.now();const clock = () => now;
  const operations = new MemoryStore();const {operation: op, publicToken} = operations.create(100000,'ARS');
  const entitlements = new MemoryEntitlementRepository(clock);const tokens = new MemoryDownloadTokenRepository(clock);
  const storage = new FakeStorage();const service = new VisualPackService(operations,entitlements,tokens,storage,clock);
  const approve = () => {
    op.payments.set('900',{id:'900',status:'approved',updatedAt:now,verifiedAt:new Date(now).toISOString()});
    grantVisualPackAccess(operations,op,'900',()=>{});service.syncVerifiedOperation(op.id,'900');
    return entitlements.find(op.id,VISUAL_PACK)!;
  };
  const issue = () => service.issue(publicToken).downloadPath.split('/').at(-1)!;
  return {operations,op,publicToken,entitlements,tokens,storage,service,approve,issue,clock,advance:(ms:number)=>{now+=ms;}};
}
test('entitlement: unique operation/benefit with verified source and stable timestamp',()=>{
  const f=fixture();const first=f.approve();f.advance(1000);f.approve();
  assert.deepEqual(f.entitlements.find(f.op.id,VISUAL_PACK),first);
  assert.equal(first.paymentId,'900');assert.equal(first.status,'active');assert.equal(first.operationId,f.op.id);
});
test('entitlement: missing verified snapshot or missing existing grant cannot create access',()=>{
  const f=fixture();f.service.syncVerifiedOperation(f.op.id,'900');assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);
  f.op.payments.set('900',{id:'900',status:'approved',updatedAt:f.clock(),verifiedAt:'test'});
  f.service.syncVerifiedOperation(f.op.id,'900');assert.equal(f.entitlements.find(f.op.id,VISUAL_PACK),undefined);
  assert.throws(()=>f.issue(),is404);assert.equal(f.storage.calls.length,0);
});
test('entitlement: distinct approved payment cannot duplicate existing right',()=>{
  const f=fixture();const e=f.approve();f.op.payments.set('901',{...f.op.payments.get('900')!,id:'901'});
  f.service.syncVerifiedOperation(f.op.id,'901');assert.deepEqual(f.entitlements.find(f.op.id,VISUAL_PACK),e);
});
test('token: random 256-bit values, SHA256 only, rotation invalidates previous',async()=>{
  const f=fixture();f.approve();const a=f.issue(),b=f.issue();
  assert.match(a,/^[a-f0-9]{64}$/);assert.notEqual(a,b);assert.notEqual(a,f.publicToken);assert.notEqual(a,f.op.id);
  const record=f.tokens.byHash(downloadTokenHash(b))!;
  assert.equal(record.hash,downloadTokenHash(b));assert(!JSON.stringify(record).includes(b));
  await assert.rejects(()=>f.service.resolve(a),is404);await f.service.resolve(b);assert.equal(f.storage.calls.length,1);
});
test('token: resolves correct benefit with URL limited to sixty seconds',async()=>{
  const f=fixture();const e=f.approve();const token=f.issue();
  assert.equal(f.tokens.byHash(downloadTokenHash(token))?.entitlementId,e.id);
  assert.equal(await f.service.resolve(token),'https://storage.example.invalid/private/pack?test-signature=fake');
  assert.deepEqual(f.storage.calls,[{benefitId:VISUAL_PACK,expiresAt:f.clock()+STORAGE_URL_TTL_MS}]);
});
test('token: invalid token/status token/operation ID never reach storage',async()=>{
  const f=fixture();f.approve();for(const token of ['invalid','a'.repeat(64),f.publicToken,f.op.id]) await assert.rejects(()=>f.service.resolve(token),is404);
  assert.equal(f.storage.calls.length,0);
});
test('token: expiry boundary rejects without storage access',async()=>{
  const f=fixture();f.approve();const token=f.issue();f.advance(DOWNLOAD_TOKEN_TTL_MS);
  await assert.rejects(()=>f.service.resolve(token),is404);assert.equal(f.storage.calls.length,0);
});
test('token: revocation rejects without storage access',async()=>{
  const f=fixture();f.approve();const token=f.issue();f.tokens.revoke(downloadTokenHash(token));
  await assert.rejects(()=>f.service.resolve(token),is404);assert.equal(f.storage.calls.length,0);
});
test('token: wrong benefit cannot authorize visual-pack-v1',async()=>{
  const f=fixture();f.approve();const token=f.issue();const record=f.tokens.byHash(downloadTokenHash(token))!;
  f.tokens.replaceForEntitlement({...record,benefitId:'other-pack'});
  await assert.rejects(()=>f.service.resolve(token),is404);assert.equal(f.storage.calls.length,0);
});
test('token: wrong entitlement benefit and missing entitlement both reject',async()=>{
  const f=fixture();f.approve();const token=f.issue();const record=f.tokens.byHash(downloadTokenHash(token))!;
  const other=f.entitlements.createOnce({operationId:f.op.id,paymentId:'900',benefitId:'other',createdAt:f.clock(),expiresAt:f.op.expiresAt});
  for(const entitlementId of [other.id,'missing']) {
    f.tokens.replaceForEntitlement({...record,entitlementId});await assert.rejects(()=>f.service.resolve(token),is404);
  }
  assert.equal(f.storage.calls.length,0);
});
test('token: three concurrent reservations maximum',async()=>{
  const f=fixture();f.approve();const token=f.issue();
  const results=await Promise.allSettled(Array.from({length:12},()=>f.service.resolve(token)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal(f.storage.calls.length,3);
});
test('entitlement: explicit revocation is terminal on duplicate approval',async()=>{
  const f=fixture();const e=f.approve();const token=f.issue();f.entitlements.revoke(e.id);f.approve();
  assert.equal(f.entitlements.byId(e.id)?.status,'revoked');assert.throws(()=>f.issue(),is404);
  await assert.rejects(()=>f.service.resolve(token),is404);assert.equal(f.storage.calls.length,0);
});
test('entitlement: refund prevents old tokens even before synchronization',async()=>{
  const f=fixture();const e=f.approve();const token=f.issue();f.op.payments.get('900')!.status='refunded';
  await assert.rejects(()=>f.service.resolve(token),is404);f.service.syncVerifiedOperation(f.op.id,'900');
  assert.equal(f.entitlements.byId(e.id)?.status,'revoked');f.approve();assert.throws(()=>f.issue(),is404);
});
test('entitlement: another approved payment does not restore a revoked source',()=>{
  const f=fixture();const e=f.approve();f.op.payments.set('901',{...f.op.payments.get('900')!,id:'901'});
  f.op.payments.get('900')!.status='charged_back';f.service.syncVerifiedOperation(f.op.id,'900');
  assert.equal(f.entitlements.byId(e.id)?.status,'revoked');assert.equal(f.service.status(f.publicToken).available,false);
});
test('token: operation expiry caps token and signed URL',async()=>{
  const f=fixture();f.op.expiresAt=f.clock()+20_000;f.approve();const token=f.issue();
  assert.equal(f.tokens.byHash(downloadTokenHash(token))?.expiresAt,f.op.expiresAt);
  await f.service.resolve(token);assert.equal(f.storage.calls[0]?.expiresAt,f.op.expiresAt);
  f.advance(20_000);await assert.rejects(()=>f.service.resolve(token),is404);
});
test('storage: default unavailable, no token issued',()=>{
  const f=fixture();f.approve();const service=new VisualPackService(f.operations,f.entitlements,f.tokens,new UnconfiguredVisualPackStorage(),f.clock);
  assert.deepEqual(service.status(f.publicToken),{id:VISUAL_PACK,available:true,downloadReady:false});
  assert.throws(()=>service.issue(f.publicToken),is503);
});
test('storage: provider exceptions are masked and consume reserved attempt',async()=>{
  const f=fixture();f.approve();const token=f.issue();f.storage.createDownloadUrl=async()=>{throw new Error('private-secret-url');};
  await assert.rejects(()=>f.service.resolve(token),e=>is503(e)&&!String(e).includes('private-secret-url'));
  assert.equal(f.tokens.byHash(downloadTokenHash(token))?.remainingUses,2);
});
test('storage: disallowed origin, protocol, userinfo, fragment or invalid expiry rejected',async()=>{
  for(const change of [{url:'https://evil.invalid/pack'},{url:'http://storage.example.invalid/pack'},
    {url:'https://user:pass@storage.example.invalid/pack'},{url:'https://storage.example.invalid/pack#fragment'},
    {expiresAt:0},{expiresAt:Infinity},{expiresAt:Date.now()+999999}]) {
    const f=fixture();f.approve();const token=f.issue();f.storage.createDownloadUrl=async(_id,expiresAt)=>({url:'https://storage.example.invalid/pack',expiresAt,...change});
    await assert.rejects(()=>f.service.resolve(token),is503);
  }
});
test('storage: revocation while signing prevents redirect',async()=>{
  const f=fixture();const e=f.approve();const token=f.issue();
  f.storage.createDownloadUrl=async(_id,expiresAt)=>{f.entitlements.revoke(e.id);return {url:'https://storage.example.invalid/pack',expiresAt};};
  await assert.rejects(()=>f.service.resolve(token),is404);
});
test('storage: token rotation while signing prevents redirect',async()=>{
  const f=fixture();f.approve();const token=f.issue();
  f.storage.createDownloadUrl=async(_id,expiresAt)=>{f.issue();return {url:'https://storage.example.invalid/pack',expiresAt};};
  await assert.rejects(()=>f.service.resolve(token),is404);
});
test('storage: expiry while signing prevents redirect',async()=>{
  const f=fixture();f.approve();const token=f.issue();
  f.storage.createDownloadUrl=async(_id,expiresAt)=>{f.advance(DOWNLOAD_TOKEN_TTL_MS);return {url:'https://storage.example.invalid/pack',expiresAt};};
  await assert.rejects(()=>f.service.resolve(token),is404);
});
test('status: exposes only benefit identity and availability, no token per poll',()=>{
  const f=fixture();f.approve();const token=f.issue();const hash=downloadTokenHash(token);const before=f.tokens.byHash(hash);
  assert.deepEqual(f.service.status(f.publicToken),{id:VISUAL_PACK,available:true,downloadReady:true});
  f.service.status(f.publicToken);assert.deepEqual(f.tokens.byHash(hash),before);
});
test('memory: restart loses operations, entitlements and tokens',async()=>{
  const f=fixture();const e=f.approve();const token=f.issue();
  const operations=new MemoryStore(),entitlements=new MemoryEntitlementRepository(),tokens=new MemoryDownloadTokenRepository();
  assert.equal(operations.byToken(f.publicToken),undefined);assert.equal(entitlements.byId(e.id),undefined);assert.equal(tokens.byHash(downloadTokenHash(token)),undefined);
  await assert.rejects(()=>new VisualPackService(operations,entitlements,tokens,f.storage).resolve(token),is404);
});
test('memory: returned records cannot mutate persisted authorization',()=>{
  const f=fixture();const e=f.approve();e.status='revoked';assert.equal(f.entitlements.byId(e.id)?.status,'active');
  const token=f.issue(),hash=downloadTokenHash(token);f.tokens.byHash(hash)!.remainingUses=100;
  assert.equal(f.tokens.byHash(hash)?.remainingUses,3);
});
test('memory: bounded repositories prune expired entries and preserve idempotency',()=>{
  let now=1;const e=new MemoryEntitlementRepository(()=>now,1),t=new MemoryDownloadTokenRepository(()=>now,1);
  const input={operationId:'op',paymentId:'p',benefitId:VISUAL_PACK,createdAt:1,expiresAt:10};
  const first=e.createOnce(input);assert.equal(e.createOnce(input).id,first.id);
  assert.throws(()=>e.createOnce({...input,operationId:'other'}),is503);
  const token={hash:'hash',entitlementId:first.id,entitlementRevision:1,benefitId:VISUAL_PACK,expiresAt:10,remainingUses:3,revoked:false};
  t.replaceForEntitlement(token);t.replaceForEntitlement({...token,hash:'rotated'});assert.equal(t.byHash('hash'),undefined);
  assert.throws(()=>t.replaceForEntitlement({...token,entitlementId:'other'}),is503);
  now=10;assert.equal(e.byId(first.id),undefined);assert.equal(t.byHash('rotated'),undefined);
  e.createOnce({...input,expiresAt:20});t.replaceForEntitlement({...token,expiresAt:20});
});
