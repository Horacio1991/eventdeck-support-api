// Clasificación diagnóstica: ningún campo del body es fuente del ID firmado.
// No registrar el body, el query completo ni valores desconocidos.
export function webhookInput(query:Record<string,unknown>,body:unknown) {
  const id=query['data.id'];
  const dataId=typeof id==='string'?id:undefined;
  const queryIdValid=Boolean(dataId && /^\d{1,20}$/.test(dataId));
  const b=body && typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:{};
  const data=b.data && typeof b.data==='object'&&!Array.isArray(b.data)?b.data as Record<string,unknown>:{};
  const safeId=(v:unknown)=>typeof v==='string'&&/^\d{1,20}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?String(v):undefined;
  const bodyId=safeId(data.id);
  const category=(v:unknown)=>v===undefined?'absent':v==='payment'?'payment':v==='merchant_order'?'merchant_order':v==='topic_merchant_order_wh'?'topic_merchant_order_wh':'other';
  const legacyQueryPresent=query.id!==undefined || query.topic!==undefined;
  const bodyLegacyPresent=b.resource!==undefined || b.topic!==undefined;
  const shape=id!==undefined && legacyQueryPresent?'mixed_query':id!==undefined?(query.type==='payment'?'payments_webhook':'other_webhook'):legacyQueryPresent||bodyLegacyPresent?'legacy_ipn_candidate':data.id!==undefined?'body_only_candidate':'unknown';
  return {dataId,queryIdValid,diagnostics:{
    paymentId:queryIdValid?dataId:undefined,paymentIdSource:id===undefined?'absent':typeof id==='string'?'query':'ambiguous_query',
    paymentIdLength:dataId?.length||0,queryIdValid,bodyIdPresent:data.id!==undefined,
    bodyIdMatchesQuery:bodyId!==undefined&&dataId!==undefined?bodyId===dataId:undefined,
    eventType:category(query.type),bodyEventType:category(b.type),notificationShape:shape,
    legacyQueryPresent,bodyLegacyPresent,
    claimedApplicationId:safeId(b.application_id),claimedUserId:safeId(b.user_id),claimedLiveMode:typeof b.live_mode==='boolean'?b.live_mode:undefined
  }};
}
