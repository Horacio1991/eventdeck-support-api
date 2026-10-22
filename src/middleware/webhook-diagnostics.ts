import { SIGNATURE_FIX } from '../services/webhook-signature.js';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../utils/logger.js';
export const WEBHOOK_FIX = SIGNATURE_FIX;
// Montar antes de Helmet, parser, rate limit y CORS. Nunca registrar URL/query completos.
export function webhookDiagnostics(log:Logger):RequestHandler {
  return (req,res,next)=>{
    const traceId=randomUUID();
    const requestLog:Logger=(event,fields)=>log(event,{...fields,traceId});
    res.locals.webhookLog=requestLog;
    res.setHeader('X-EventDeck-Webhook-Fix',WEBHOOK_FIX);
    res.setHeader('X-EventDeck-Signature-Fix',SIGNATURE_FIX);
    res.setHeader('X-EventDeck-Trace-Id',traceId);
    const started=Date.now();
    requestLog('webhook_request_received',{
      method:req.method,path:'/api/webhooks',
      signaturePresent:Boolean(req.get('x-signature')),requestIdPresent:Boolean(req.get('x-request-id')),
      code:SIGNATURE_FIX
    });
    // La primera línea ya se emitió incluso si falla la lectura posterior del query.
    const id=req.query['data.id'];
    requestLog('webhook_request_metadata',{
      paymentId:typeof id==='string' && /^\d{1,20}$/.test(id)?id:undefined,
      routeMatched:/^\/mercadopago\/?$/i.test(req.path),
      queryIdValid:typeof id==='string' && /^\d{1,20}$/.test(id),
      eventType:req.query.type==='payment'?'payment':req.query.type===undefined?'absent':'other',
      contentType:req.is('application/json')?'application/json':'other'
    });
    res.once('finish',()=>requestLog(res.statusCode>=200 && res.statusCode<300?'webhook_acknowledged':'webhook_response_sent',{
      httpStatus:res.statusCode,durationMs:Date.now()-started
    }));
    res.once('close',()=>{if(!res.writableFinished) requestLog('webhook_connection_closed',{durationMs:Date.now()-started});});
    next();
  };
}
