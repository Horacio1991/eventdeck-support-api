import type { Request } from 'express';
export type SignatureObservation = {requestId?:string;signature?:string;ts?:string;v1?:string;manifest?:string;compared?:boolean};
type HeaderValue = string|string[]|undefined;
export type HeaderSnapshot = {
  rawRequestUrl?:string; mountedRequestUrl?:string;
  requestIds:readonly string[]; signatures:readonly string[];
  nodeRequestId:HeaderValue;nodeSignature:HeaderValue;
  expressRequestId:string|undefined;expressSignature:string|undefined;
};
// Se copian SOLO los dos headers autorizados antes de traceId/otros middleware.
export function captureWebhookHeaders(req:Pick<Request,'rawHeaders'|'headers'|'get'> & Partial<Pick<Request,'originalUrl'|'url'>>):HeaderSnapshot {
  const ids:string[]=[],signatures:string[]=[];
  for(let i=0;i<req.rawHeaders.length;i+=2){
    const name=req.rawHeaders[i]!.toLowerCase(),value=req.rawHeaders[i+1];
    if(value===undefined)continue;
    if(name==='x-request-id')ids.push(value);
    if(name==='x-signature')signatures.push(value);
  }
  const copy=(v:HeaderValue)=>Array.isArray(v)?[...v]:v;
  // Express conserva originalUrl antes de recortar el prefijo del middleware montado.
  return Object.freeze({rawRequestUrl:req.originalUrl,mountedRequestUrl:req.url,requestIds:Object.freeze(ids),signatures:Object.freeze(signatures),
    nodeRequestId:copy(req.headers['x-request-id']),nodeSignature:copy(req.headers['x-signature']),
    expressRequestId:req.get('x-request-id'),expressSignature:req.get('x-signature')});
}
const oneEquals=(raw:readonly string[],used:string|undefined)=>raw.length===1 && used!==undefined ? raw[0]===used : null;
const len=(value:string|undefined)=>value===undefined?null:value.length;
const components=(raw:readonly string[],key:string)=>raw.flatMap(value=>value.split(',').flatMap(part=>{
  const at=part.indexOf('=');
  // Reconocimiento diagnóstico: no interviene en el parser de autorización.
  return at>=0 && part.slice(0,at).trim()===key ? [part.slice(at+1)] : [];
}));
export function rawHeaderDiagnostic(snapshot:HeaderSnapshot,used:SignatureObservation={},enabled=false){
  const ids=snapshot.requestIds,sigs=snapshot.signatures;
  const ts=components(sigs,'ts'),v1=components(sigs,'v1');
  const manifestId=used.manifest===undefined?undefined:used.requestId;
  const manifestTs=used.manifest===undefined?undefined:used.ts;
  const comparedV1=used.compared?used.v1:undefined;
  return {
    rawDiagnosticEnabled:enabled,
    rawRequestUrlLength:len(snapshot.rawRequestUrl),mountedRequestUrlLength:len(snapshot.mountedRequestUrl),
    rawUrlEqualsMounted:snapshot.rawRequestUrl!==undefined && snapshot.mountedRequestUrl!==undefined?snapshot.rawRequestUrl===snapshot.mountedRequestUrl:null,
    rawRequestIdCount:ids.length,rawRequestIdLengths:ids.map(v=>v.length),
    expressRequestIdLength:len(snapshot.expressRequestId),manifestRequestIdLength:len(manifestId),
    rawEqualsExpress:oneEquals(ids,snapshot.expressRequestId),rawEqualsManifest:oneEquals(ids,manifestId),
    nodeRequestIdEqualsExpress:typeof snapshot.nodeRequestId==='string'?snapshot.nodeRequestId===snapshot.expressRequestId:null,
    nodeRequestIdIsArray:Array.isArray(snapshot.nodeRequestId),
    requestIdCombined:ids.length>1 && snapshot.expressRequestId===ids.join(', '),
    requestIdHasLeadingWhitespace:ids.some(v=>/^\s/.test(v)),
    requestIdHasTrailingWhitespace:ids.some(v=>/\s$/.test(v)),
    requestIdContainsComma:ids.some(v=>v.includes(',')),
    expressRequestIdContainsComma:snapshot.expressRequestId?.includes(',')??false,
    expressRequestIdEqualsValidator:snapshot.expressRequestId!==undefined && used.requestId!==undefined?snapshot.expressRequestId===used.requestId:null,
    rawSignatureCount:sigs.length,rawSignatureLengths:sigs.map(v=>v.length),
    expressSignatureLength:len(snapshot.expressSignature),
    validatorSignatureLength:len(used.signature),
    expressSignatureEqualsValidator:snapshot.expressSignature!==undefined && used.signature!==undefined?snapshot.expressSignature===used.signature:null,
    rawSignatureEqualsExpress:oneEquals(sigs,snapshot.expressSignature),
    nodeSignatureEqualsExpress:typeof snapshot.nodeSignature==='string'?snapshot.nodeSignature===snapshot.expressSignature:null,
    nodeSignatureIsArray:Array.isArray(snapshot.nodeSignature),
    signatureCombined:sigs.length>1 && snapshot.expressSignature===sigs.join(', '),
    signatureContainsComma:sigs.some(v=>v.includes(',')),signatureContainsWhitespace:sigs.some(v=>/\s/.test(v)),
    tsComponentCount:ts.length,v1ComponentCount:v1.length,
    rawTsLength:ts.length===1?ts[0]!.length:null,rawTsLengths:ts.map(v=>v.length),parsedTsLength:len(used.ts),
    rawTsEqualsManifestTs:oneEquals(ts,manifestTs),
    rawV1Length:v1.length===1?v1[0]!.length:null,rawV1Lengths:v1.map(v=>v.length),parsedV1Length:len(used.v1),
    rawV1EqualsComparedV1:oneEquals(v1,comparedV1),
    rawV1HasUnexpectedCharacters:v1.some(v=>!/^[a-fA-F0-9]{64}$/.test(v)),
    manifestBuilt:used.manifest!==undefined,signatureCompared:used.compared===true,
    // Valores exactos autorizados solo con opt-in; no reconstruir ni parsear la URL.
    ...(enabled?{rawRequestIdValues:[...ids],rawSignatureValues:[...sigs],manifestExact:used.manifest??null,
      ...(snapshot.rawRequestUrl!==undefined?{rawRequestUrl:snapshot.rawRequestUrl}:{}),
      ...(snapshot.mountedRequestUrl!==undefined?{mountedRequestUrl:snapshot.mountedRequestUrl}:{})}:{})
  };
}
export type RawHeaderLogFields = Partial<ReturnType<typeof rawHeaderDiagnostic>>;
// Whitelist explícita. No aceptar objetos request/snapshots/secret en el logger.
export const RAW_SAFE_KEYS = [
 'rawRequestUrlLength','mountedRequestUrlLength','rawUrlEqualsMounted','rawDiagnosticEnabled','rawRequestIdCount','rawRequestIdLengths','expressRequestIdLength','manifestRequestIdLength',
 'rawEqualsExpress','rawEqualsManifest','nodeRequestIdEqualsExpress','nodeRequestIdIsArray','requestIdCombined',
 'requestIdHasLeadingWhitespace','requestIdHasTrailingWhitespace','requestIdContainsComma','expressRequestIdContainsComma',
 'validatorSignatureLength','expressSignatureEqualsValidator','expressRequestIdEqualsValidator','rawSignatureCount','rawSignatureLengths','expressSignatureLength','rawSignatureEqualsExpress',
 'nodeSignatureEqualsExpress','nodeSignatureIsArray','signatureCombined','signatureContainsComma','signatureContainsWhitespace',
 'tsComponentCount','v1ComponentCount','rawTsLength','rawTsLengths','parsedTsLength','rawTsEqualsManifestTs',
 'rawV1Length','rawV1Lengths','parsedV1Length','rawV1EqualsComparedV1','rawV1HasUnexpectedCharacters','manifestBuilt','signatureCompared'
] as const;
export function selectRawLogFields(event:string,fields:RawHeaderLogFields):RawHeaderLogFields {
  if(event!=='webhook_raw_header_diagnostic')return {};
  const safe=Object.fromEntries(RAW_SAFE_KEYS.map(k=>[k,fields[k]]));
  return {...safe,...(fields.rawDiagnosticEnabled===true?{
    rawRequestIdValues:fields.rawRequestIdValues,rawSignatureValues:fields.rawSignatureValues,manifestExact:fields.manifestExact,rawRequestUrl:fields.rawRequestUrl,mountedRequestUrl:fields.mountedRequestUrl
  }:{})};
}
