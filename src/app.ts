import express from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { type Config, ready } from './config/env.js';
import { AppError, unavailable } from './utils/errors.js';
import { logger, type Logger } from './utils/logger.js';
import { cors, errors, limiter } from './middleware/security.js';
import { MemoryStore, type Store } from './services/store.js';
import { MercadoPagoGateway, PaymentLookupError, type Gateway } from './services/mercadopago.service.js';
import { SupportService } from './services/support.service.js';
import { webhookDiagnostics } from './middleware/webhook-diagnostics.js';
import { validSignature } from './services/webhook-signature.js';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const tokenPattern=/^[a-f0-9]{64}$/;
export function createApp(config:Config, deps:{store?:Store;gateway?:Gateway;log?:Logger}={}) {
  const app=express();const log=deps.log||logger;
  const service=new SupportService(config,deps.store||new MemoryStore(),deps.gateway||new MercadoPagoGateway(config.accessToken),log);
  app.disable('x-powered-by');app.set('trust proxy',config.trustProxyHops);app.set('query parser','simple');
  app.use('/api/webhooks',webhookDiagnostics(log));
  app.use(helmet({referrerPolicy:{policy:'no-referrer'},contentSecurityPolicy:{directives:{'default-src':["'self'"],'script-src':["'self'"],'style-src':["'self'"],'img-src':["'self'"],'connect-src':["'self'"],'object-src':["'none'"],'frame-ancestors':["'none'"],'form-action':["'self'"],'upgrade-insecure-requests':config.production?[]:null}}}));
  app.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  app.get('/health',(_req,res)=>{res.json({status:'ok',service:'eventdeck-support-api'});});
  // Webhooks no usan CORS: autenticación por firma, nunca por Origin.
  app.post('/api/webhooks/mercadopago',limiter(180,60_000),express.json({limit:'16kb'}),async(req,res)=>{
    const requestLog=res.locals.webhookLog as Logger;
    requestLog('webhook_handler_entered');
    if(!config.webhookSecret || !config.accessToken) throw unavailable();
    const id=req.query['data.id'];
    if(typeof id!=='string'|| !/^\d{1,20}$/.test(id) || !validSignature(req.get('x-signature'),req.get('x-request-id'),id,config.webhookSecret)) {
      requestLog('webhook_signature_invalid');throw new AppError(401,'INVALID_SIGNATURE','Notificación no autenticada.');
    }
    requestLog('webhook_signature_valid',{paymentId:id});
    const type=req.query.type ?? req.body?.type;
    if(type!=='payment'){res.status(200).json({received:true});return;}
    if(req.body?.type && req.body.type!=='payment') throw new AppError(400,'INVALID_EVENT','Evento inconsistente.');
    if(req.body?.data?.id!==undefined && String(req.body.data.id)!==id) throw new AppError(400,'INVALID_EVENT','Evento inconsistente.');
    // ACK de recepción no equivale a aprobación. Solo 404 del GET auténtico se reconoce sin acceso.
    // No adivinar si un ID pertenece al simulador; 401/403/429/5xx/timeouts conservan reintentos.
    try { await service.verifyPayment(id,requestLog); }
    catch(error) {
      if(!(error instanceof PaymentLookupError) || error.upstreamStatus!==404) throw error;
      requestLog('webhook_payment_not_found_no_access',{paymentId:id,code:'MP_PAYMENT_NOT_FOUND'});
    }
    res.status(200).json({received:true});
  });
  app.use('/api/support',cors(config.corsOrigin));
  app.get('/api/support/config',(_req,res)=>res.json({testMode:true,amount:config.amountCents===null?null:config.amountCents/100,currency:config.currency,ready:ready(config)}));
  app.post('/api/support/create-checkout',limiter(10,15*60_000),express.json({limit:'1kb'}),async(req,res)=>{
    if(!req.is('application/json')) throw new AppError(415,'JSON_REQUIRED','Enviá un objeto JSON vacío.');
    if(!req.body || Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).length) throw new AppError(400,'INVALID_INPUT','Solo se admite un objeto JSON vacío. El monto se configura en el servidor.');
    res.status(201).json(await service.create());
  });
  app.get('/api/support/status/:publicToken',limiter(90,60_000),(req,res)=>{
    const token=req.params.publicToken;
    if(typeof token!=='string'||!tokenPattern.test(token)) throw new AppError(404,'OPERATION_NOT_FOUND','Operación inexistente o vencida.');
    res.json(service.status(token));
  });
  app.get('/support/:outcome/:publicToken',(req,res,next)=>{
    if(!['success','pending','failure'].includes(String(req.params.outcome)) || !tokenPattern.test(String(req.params.publicToken))) return next(new AppError(404,'NOT_FOUND','Página no encontrada.'));
    // El path y cualquier query de MP no modifican ningún estado.
    res.sendFile('result.html',{root:publicDir});
  });
  app.use(express.static(publicDir,{index:'index.html',dotfiles:'deny',maxAge:0}));
  app.use((_req,_res,next)=>next(new AppError(404,'NOT_FOUND','Recurso no encontrado.')));
  app.use(errors(log));
  return app;
}
