import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config/env.js';
import { loadStorageConfig, StorageConfigurationError } from '../src/config/storage-env.js';
import { createVisualPackStorage } from '../src/benefits/storage-factory.js';
import { CloudflareR2VisualPackStorage, VISUAL_PACK_DOWNLOAD_NAME, type R2Presigner } from '../src/benefits/r2-storage.js';
import { VISUAL_PACK } from '../src/benefits/repositories.js';
import { AppError } from '../src/utils/errors.js';
import { r2Config, r2Env } from './helpers/r2-fixture.js';

const unavailable = (e: unknown) => e instanceof AppError && e.status === 503;
test('R2 config: missing provider defaults disabled; unused R2 values are ignored',()=>{
  assert.deepEqual(loadConfig({}).storage,{provider:'disabled'});
  assert.deepEqual(loadStorageConfig({...r2Env,VISUAL_PACK_STORAGE_PROVIDER:'disabled',R2_ENDPOINT:'bad'}),{provider:'disabled'});
});
test('R2 config: unknown/empty provider fails rather than silently falling back',()=>{
  for(const value of ['','s3','R2',' r2 '])assert.throws(()=>loadStorageConfig({VISUAL_PACK_STORAGE_PROVIDER:value}),StorageConfigurationError);
});
test('R2 config: all required settings fail fast independently, without echoing values',()=>{
  for(const key of ['R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','R2_VISUAL_PACK_OBJECT_KEY']) {
    assert.throws(()=>loadConfig({...r2Env,[key]:''}),e=>e instanceof StorageConfigurationError && e.message.includes(key)
      && !e.message.includes(r2Env.R2_SECRET_ACCESS_KEY) && !e.message.includes(r2Env.R2_ACCESS_KEY_ID));
  }
});
test('R2 config: endpoint allows only exact HTTPS R2 API origins and jurisdictions',()=>{
  for(const jurisdiction of ['', '.eu','.us','.fedramp']) {
    const endpoint=`https://${'0'.repeat(32)}${jurisdiction}.r2.cloudflarestorage.com`;
    assert.equal((loadStorageConfig({...r2Env,R2_ENDPOINT:endpoint+'/'}) as any).endpoint,endpoint);
  }
  for(const endpoint of ['http://'+r2Env.R2_ENDPOINT.slice(8),r2Env.R2_ENDPOINT+':443',r2Env.R2_ENDPOINT+'/bucket',
    r2Env.R2_ENDPOINT+'?key=x',r2Env.R2_ENDPOINT+'#x',r2Env.R2_ENDPOINT+'.evil.invalid',
    'https://user:secret@'+r2Env.R2_ENDPOINT.slice(8),'https://public.r2.dev','https://localhost',' '+r2Env.R2_ENDPOINT]) {
    assert.throws(()=>loadStorageConfig({...r2Env,R2_ENDPOINT:endpoint}),StorageConfigurationError);
  }
});
test('R2 config: unsafe credentials, bucket and object key fail with safe messages',()=>{
  const invalids = {
    R2_ACCESS_KEY_ID:['short','bad\r\nsecret',r2Env.R2_ACCESS_KEY_ID+' '],
    R2_SECRET_ACCESS_KEY:['short','secret\nvalue',' secret-with-leading-space'],
    R2_BUCKET:['X','uppercase-Bucket','bucket.name','-bucket','bucket/other','a'.repeat(64)],
    R2_VISUAL_PACK_OBJECT_KEY:['/pack.zip','pack.zip/','../pack.zip','packs/../pack.zip','./pack.zip','packs//pack.zip','x\\pack.zip','x\r\nInjected:yes','x'.repeat(1025),'bad\ud800'],
  };
  for(const [key,values] of Object.entries(invalids))for(const value of values)assert.throws(()=>loadStorageConfig({...r2Env,[key]:value}),e=>
    e instanceof StorageConfigurationError && !e.message.includes(value));
});
test('R2 config: literal unicode and spaces in object key preserved, not URL-decoded',()=>{
  const key='packs/versión 1/pack%20literal.zip';
  assert.equal((loadStorageConfig({...r2Env,R2_VISUAL_PACK_OBJECT_KEY:key}) as any).objectKey,key);
});
test('R2 startup: incomplete explicit r2 exits with 1 before listen and masks secrets',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','src/server.ts'],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,...r2Env,R2_BUCKET:''},encoding:'utf8',timeout:10_000});
  assert.equal(result.status,1);assert.match(result.stderr,/R2_BUCKET/);assert(!result.stdout.includes('server_started'));
  for(const secret of [r2Env.R2_SECRET_ACCESS_KEY,r2Env.R2_ACCESS_KEY_ID])assert(!(result.stdout+result.stderr).includes(secret));
});
test('R2 factory: disabled never signs or provides an origin; r2 is selected explicitly',async()=>{
  const disabled=createVisualPackStorage({provider:'disabled'});
  assert.equal(disabled.configured,false);assert.deepEqual(disabled.allowedOrigins,[]);
  await assert.rejects(()=>disabled.createDownloadUrl(VISUAL_PACK,Date.now()+60_000),unavailable);
  assert(createVisualPackStorage(r2Config()) instanceof CloudflareR2VisualPackStorage);
});
test('R2 adapter: only configured bucket/key, GET, safe server filename, region auto, static credentials',async()=>{
  let calls=0;
  const sign:R2Presigner=async(client,command,options)=>{
    calls++;assert(command instanceof GetObjectCommand);
    assert.deepEqual(command.input,{Bucket:r2Env.R2_BUCKET,Key:r2Env.R2_VISUAL_PACK_OBJECT_KEY,
      ResponseContentDisposition:`attachment; filename="${VISUAL_PACK_DOWNLOAD_NAME}"`});
    assert.equal(await client.config.region(),'auto');assert.equal(client.config.forcePathStyle,true);
    assert.equal((await client.config.credentials()).accessKeyId,r2Env.R2_ACCESS_KEY_ID);
    assert.equal(options.expiresIn,60);
    // Even accidental SDK .send() cannot contact R2: the transport is disabled.
    await assert.rejects(()=>client.send(command),unavailable);
    return r2Env.R2_ENDPOINT+'/fixture';
  };
  const now=Date.UTC(2026,9,23,12);const storage=new CloudflareR2VisualPackStorage(r2Config(),sign,()=>now);
  assert.equal((await storage.createDownloadUrl(VISUAL_PACK,now+60_000)).expiresAt,now+60_000);assert.equal(calls,1);
});
test('R2 adapter: other benefit rejected before signing',async()=>{
  let calls=0;const storage=new CloudflareR2VisualPackStorage(r2Config(),async()=>{calls++;return '';});
  await assert.rejects(()=>storage.createDownloadUrl('other-pack',Date.now()+60_000),unavailable);assert.equal(calls,0);
});
test('R2 adapter: short deadlines round down and extended deadlines cap at sixty seconds',async()=>{
  const now=Date.UTC(2026,9,23,12)+789;const records:{ttl:number;start:number}[]=[];
  const storage=new CloudflareR2VisualPackStorage(r2Config(),async(_c,_cmd,o)=>{
    records.push({ttl:o.expiresIn,start:o.signingDate.getTime()});return r2Env.R2_ENDPOINT+'/fixture';
  },()=>now);
  for(const delta of [999,1500,15_234,60_000,120_000]) {
    const r=await storage.createDownloadUrl(VISUAL_PACK,now+delta);const last=records.at(-1)!;
    assert(last.ttl>=1&&last.ttl<=60);assert.equal(r.expiresAt,last.start+last.ttl*1000);
    assert(r.expiresAt<=now+Math.min(delta,60_000));assert(r.expiresAt>now);
  }
});
test('R2 adapter: expired, nonfinite or subsecond unrepresentable TTL never signed',async()=>{
  const now=Date.UTC(2026,9,23,12);let calls=0;
  const storage=new CloudflareR2VisualPackStorage(r2Config(),async()=>{calls++;return '';},()=>now);
  for(const deadline of [now-1,now,now+999,Infinity,NaN])await assert.rejects(()=>storage.createDownloadUrl(VISUAL_PACK,deadline),unavailable);
  assert.equal(calls,0);
});
test('R2 adapter: signer exceptions cannot expose credentials',async()=>{
  const storage=new CloudflareR2VisualPackStorage(r2Config(),async()=>{throw new Error(r2Env.R2_SECRET_ACCESS_KEY);});
  await assert.rejects(()=>storage.createDownloadUrl(VISUAL_PACK,Date.now()+60_000),e=>unavailable(e)&&!String(e).includes(r2Env.R2_SECRET_ACCESS_KEY));
});
test('R2 adapter: signing delay cannot return expired URL',async()=>{
  let now=Date.UTC(2026,9,23,12);const storage=new CloudflareR2VisualPackStorage(r2Config(),async()=>{now+=61_000;return r2Env.R2_ENDPOINT+'/fixture';},()=>now);
  await assert.rejects(()=>storage.createDownloadUrl(VISUAL_PACK,now+60_000),unavailable);
});
test('R2 SDK: real presigning is offline, scoped to exact object with TTL and disposition',async()=>{
  const now=Date.UTC(2026,9,23,12)+123;
  const storage=new CloudflareR2VisualPackStorage(r2Config(),undefined,()=>now);
  const result=await storage.createDownloadUrl(VISUAL_PACK,now+60_000);const url=new URL(result.url);
  assert.equal(url.origin,r2Env.R2_ENDPOINT);assert.deepEqual(storage.allowedOrigins,[url.origin]);
  assert.equal(url.pathname,`/${r2Env.R2_BUCKET}/${r2Env.R2_VISUAL_PACK_OBJECT_KEY}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'),'60');assert.equal(url.searchParams.get('X-Amz-Date'),'20261023T120000Z');
  assert.equal(result.expiresAt,Date.UTC(2026,9,23,12,1));
  assert.equal(url.searchParams.get('response-content-disposition'),`attachment; filename="${VISUAL_PACK_DOWNLOAD_NAME}"`);
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'host');assert.match(url.searchParams.get('X-Amz-Signature')!,/^[a-f0-9]{64}$/);
  // SigV4 necessarily carries the key IDENTIFIER; never the secret or a credential object.
  assert.equal(url.searchParams.get('X-Amz-Credential'),`${r2Env.R2_ACCESS_KEY_ID}/20261023/auto/s3/aws4_request`);
  assert(!result.url.includes(r2Env.R2_SECRET_ACCESS_KEY));assert.equal(url.searchParams.has('X-Amz-Security-Token'),false);
});
test('R2 SDK: literal object encoding preserved; changing object changes the signature',async()=>{
  const config={...r2Config(),objectKey:'packs/versión 1/pack%20literal.zip'};
  const now=Date.UTC(2026,9,23,12);const a=await new CloudflareR2VisualPackStorage(config,undefined,()=>now).createDownloadUrl(VISUAL_PACK,now+60_000);
  const b=await new CloudflareR2VisualPackStorage({...config,objectKey:'other.zip'},undefined,()=>now).createDownloadUrl(VISUAL_PACK,now+60_000);
  const url=new URL(a.url);assert.equal(decodeURIComponent(url.pathname),`/${config.bucket}/${config.objectKey}`);
  assert.notEqual(url.searchParams.get('X-Amz-Signature'),new URL(b.url).searchParams.get('X-Amz-Signature'));
});
