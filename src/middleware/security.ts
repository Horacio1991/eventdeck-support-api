import type { RequestHandler, ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
export function cors(origin:string): RequestHandler {
  return (req,res,next)=>{
    res.vary('Origin');
    const received=req.get('origin');
    if(received && received!==origin) return next(new AppError(403,'ORIGIN_DENIED','Origen no autorizado.'));
    if(received && received===origin) {
      res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type');
    }
    if(req.method==='OPTIONS'){res.sendStatus(204);return;}
    next();
  };
}
export const limiter = (limit:number,windowMs:number) => rateLimit({windowMs,limit,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'RATE_LIMITED',message:'Demasiadas solicitudes. Intentá más tarde.'}});
export function errors(log:Logger):ErrorRequestHandler {
  return (error,_req,res,_next)=>{
    let status=500,code='INTERNAL_ERROR',message='No se pudo completar la solicitud.';
    if(error instanceof AppError){status=error.status;code=error.code;message=error.safeMessage;}
    else if(error?.type==='entity.parse.failed'){status=400;code='INVALID_JSON';message='JSON inválido.';}
    else if(error?.type==='entity.too.large'){status=413;code='BODY_TOO_LARGE';message='Solicitud demasiado grande.';}
    const requestLog:Logger=res.locals.webhookLog || log;
    requestLog('request_failed',{code,httpStatus:status});
    res.status(status).json({error:code,message});
  };
}
