import express from 'express';
import { rawHeaderDiagnostic, type SignatureObservation, type HeaderSnapshot } from './services/webhook-raw-diagnostic.js';
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
import { inspectSignature } from './services/webhook-signature.js';
import { webhookInput } from './services/webhook-input.js';
import { MemoryEntitlementRepository, MemoryDownloadTokenRepository, type EntitlementRepository, type DownloadTokenRepository } from './benefits/repositories.js';
import { UnconfiguredVisualPackStorage, type VisualPackStorage } from './benefits/storage.js';
import { VisualPackService } from './benefits/visual-pack.service.js';
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const tokenPattern=/^[a-f0-9]{64}$/;
export function createApp(config:Config, deps:{store?:Store;gateway?:Gateway;log?:Logger;entitlements?:EntitlementRepository;downloadTokens?:DownloadTokenRepository;storage?:VisualPackStorage}={}) {
  const app=express();const log=deps.log||logger;
  const store=deps.store||new MemoryStore();
  const benefits=new VisualPackService(store,deps.entitlements||new MemoryEntitlementRepository(),deps.downloadTokens||new MemoryDownloadTokenRepository(),deps.storage||new UnconfiguredVisualPackStorage());
  const service=new SupportService(config,store,deps.gateway||new MercadoPagoGateway(config.accessToken),log,benefits);
  app.disable('x-powered-by');app.set('trust proxy',config.trustProxyHops);app.set('query parser','simple');
  app.use('/api/webhooks',webhookDiagnostics(log,config.webhookRawDiagnostic));
  app.use(helmet({referrerPolicy:{policy:'no-referrer'},contentSecurityPolicy:{directives:{'default-src':["'self'"],'script-src':["'self'"],'style-src':["'self'"],'img-src':["'self'"],'connect-src':["'self'"],'object-src':["'none'"],'frame-ancestors':["'none'"],'form-action':["'self'"],'upgrade-insecure-requests':config.production?[]:null}}}));
  app.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  app.get('/health',(_req,res)=>{res.json({status:'ok',service:'eventdeck-support-api'});});
  // Webhooks no usan CORS: autenticación por firma, nunca por Origin.
  app.post('/api/webhooks/mercadopago',limiter(180,60_000),express.json({limit:'16kb'}),async(req,res)=>{
    const requestLog=res.locals.webhookLog as Logger;
    requestLog('webhook_handler_entered');
    if(!config.webhookSecret || !config.accessToken) throw unavailable();
    const input=webhookInput(req.query,req.body);
    let observed:SignatureObservation={};
    const signature=inspectSignature(req.get('x-signature'),req.get('x-request-id'),input.dataId,config.webhookSecret,config.webhookProductionDiagnosticSecret,value=>{observed=value;});
    requestLog('webhook_raw_header_diagnostic',rawHeaderDiagnostic(res.locals.webhookHeaderSnapshot as HeaderSnapshot,observed,config.webhookRawDiagnostic));
    res.locals.webhookRawLogged=true;
    requestLog('webhook_signature_components',{...input.diagnostics,...signature.diagnostics});
    if(signature.dualDiagnostic) requestLog('webhook_dual_secret_diagnostic',{
      ...signature.dualDiagnostic,paymentId:input.queryIdValid?input.dataId:undefined,
      notificationShape:input.diagnostics.notificationShape,
      manifestVariant:signature.diagnostics.manifestVariant,manifestLength:signature.diagnostics.manifestLength
    });
    if(!input.queryIdValid || !signature.valid) {
      const code=!input.queryIdValid?(input.dataId===undefined?'MISSING_OR_AMBIGUOUS_QUERY_ID':'INVALID_PAYMENT_ID'):signature.diagnostics.signatureCheck;
      requestLog('webhook_signature_invalid',{code});throw new AppError(401,'INVALID_SIGNATURE','Notificación no autenticada.');
    }
    const id=input.dataId!;
    requestLog('webhook_signature_valid',{paymentId:id});
    const type=req.query.type ?? req.body?.type;
    if(type!=='payment'){requestLog('webhook_event_ignored',{code:'NOT_PAYMENT'});res.status(200).json({received:true});return;}
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
    const status=service.status(token);
    res.json(req.query.include==='benefit'?{...status,benefit:benefits.status(token)}:status);
  });
  app.post('/api/support/download-token/:publicToken',limiter(10,15*60_000),express.json({limit:'1kb'}),(req,res)=>{
    if(!req.is('application/json')) throw new AppError(415,'JSON_REQUIRED','Enviá un objeto JSON vacío.');
    if(!req.body||Array.isArray(req.body)||typeof req.body!=='object'||Object.keys(req.body).length) throw new AppError(400,'INVALID_INPUT','Solo se admite un objeto JSON vacío.');
    res.status(201).json(benefits.issue(String(req.params.publicToken)));
  });
  // HEAD must not implicitly run GET and consume a bearer token.
  app.head('/api/downloads/:token',(_req,res)=>{res.setHeader('Allow','GET');res.status(405).end();});
  app.get('/api/downloads/:token',limiter(60,60_000),async(req,res)=>{
    const url=await benefits.resolve(String(req.params.token));
    res.status(302).setHeader('Location',url).end(); // No fetch, proxy or file stream.
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
