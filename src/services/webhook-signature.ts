import type { SignatureObservation } from './webhook-raw-diagnostic.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
export const SIGNATURE_FIX = 'webhook-raw-header-diagnostic';
export type SignatureDiagnostics = {
  timestampPresent:boolean; signatureVersionPresent:boolean; timestampLength:number;
  signatureLength:number; requestIdPresent:boolean; requestIdLength:number;
  manifestLength:number; manifestVariant:string; signatureCheck:string;
};
// Política existente: preservar valores aceptados, sin lowercase, trim ni Number().
// Los pares ausentes se omiten en el constructor general; el endpoint Payments los exige.
export function buildManifest(dataId:string|undefined,requestId:string|undefined,ts:string|undefined):string {
  return (dataId ? `id:${dataId};` : '') + (requestId ? `request-id:${requestId};` : '') + (ts ? `ts:${ts};` : '');
}
export function inspectSignature(signature:string|undefined,requestId:string|undefined,dataId:string|undefined,secret:string,productionDiagnosticSecret?:string,observe?:(value:SignatureObservation)=>void):{valid:boolean;diagnostics:SignatureDiagnostics;dualDiagnostic?:{testSecretConfigured:boolean;productionSecretConfigured:boolean;testSecretMatch:boolean;productionSecretMatch:boolean|null;sameManifestUsed:boolean}} {
  const observed:SignatureObservation={requestId,signature};
  const d:SignatureDiagnostics={timestampPresent:false,signatureVersionPresent:false,timestampLength:0,
    signatureLength:signature?.length||0,requestIdPresent:Boolean(requestId),requestIdLength:requestId?.length||0,
    manifestLength:0,manifestVariant:'not-built',signatureCheck:'UNTESTED'};
  const fail=(code:string)=>{observe?.({...observed});d.signatureCheck=code;return {valid:false,diagnostics:d};};
  if(!signature)return fail('MISSING_SIGNATURE');
  if(signature.length>1024)return fail('SIGNATURE_TOO_LONG');
  const values=new Map<string,string>();
  let parseError:string|undefined;
  for(const part of signature.split(',')) {
    // Solo whitespace delimitador del header; no modificar valores firmados.
    const match=/^\s*(ts|v1)\s*=\s*([^\s,]+)\s*$/.exec(part);
    if(!match){parseError ||= 'SIGNATURE_HEADER_FORMAT';continue;}
    if(values.has(match[1]!)){parseError='DUPLICATE_SIGNATURE_COMPONENT';continue;}
    values.set(match[1]!,match[2]!);
  }
  const ts=values.get('ts'),v1=values.get('v1');
  observed.ts=ts;observed.v1=v1;
  d.timestampPresent=Boolean(ts);d.signatureVersionPresent=Boolean(v1);d.timestampLength=ts?.length||0;
  if(parseError)return fail(parseError);
  if(!secret)return fail('MISSING_SECRET');
  if(!dataId)return fail('MISSING_QUERY_DATA_ID');
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(dataId))return fail('DATA_ID_FORMAT');
  if(!requestId)return fail('MISSING_REQUEST_ID');
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(requestId))return fail('REQUEST_ID_FORMAT');
  if(!ts || !/^\d{10,16}$/.test(ts))return fail('TIMESTAMP_FORMAT');
  if(!v1 || !/^[a-fA-F0-9]{64}$/.test(v1))return fail('DIGEST_FORMAT');
  const manifest=buildManifest(dataId,requestId,ts);
  d.manifestVariant='query-id_request-id_ts_exact-v2';d.manifestLength=Buffer.byteLength(manifest,'utf8');
  const received=Buffer.from(v1,'hex');
  const matches=(key:string)=>timingSafeEqual(createHmac('sha256',key).update(manifest,'utf8').digest(),received);
  const valid=matches(secret);
  // Telemetría únicamente. NUNCA participa en valid ni en la autorización.
  const productionSecretMatch=productionDiagnosticSecret ? matches(productionDiagnosticSecret) : null;
  d.signatureCheck=valid?'MATCH':'HMAC_MISMATCH';
  observe?.({...observed,manifest,compared:true});
  return {valid,diagnostics:d,dualDiagnostic:{testSecretConfigured:Boolean(secret),productionSecretConfigured:Boolean(productionDiagnosticSecret),testSecretMatch:valid,productionSecretMatch,sameManifestUsed:true}};
}
// Interfaz conservada para los tests anteriores. Sin fallback a body ni variantes de manifest.
export function validSignature(signature:string|undefined,requestId:string|undefined,dataId:string,secret:string):boolean {
  return inspectSignature(signature,requestId,dataId,secret).valid;
}
