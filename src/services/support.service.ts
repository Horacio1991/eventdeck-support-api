import { type Config, cents, ready } from '../config/env.js';
import { AppError, unavailable } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { PaymentLookupError, type Gateway, preferenceBody, sandboxUrl } from './mercadopago.service.js';
import { type Store, type PublicStatus, publicState } from './store.js';
import { grantVisualPackAccess } from './access.service.js';
const statuses: Record<string,PublicStatus> = {approved:'approved',pending:'pending',in_process:'pending',authorized:'pending',in_mediation:'not_approved',rejected:'rejected',cancelled:'cancelled',refunded:'refunded',charged_back:'charged_back'};
export class SupportService {
  private running = new Map<string,Promise<void>>();
  constructor(private config:Config, private store:Store, private gateway:Gateway, private log:Logger) {}
  async create() {
    if(!ready(this.config)) throw unavailable();
    const {operation:op,publicToken}=this.store.create(this.config.amountCents!,this.config.currency);
    this.log('checkout_creation_started',{operationId:op.id});
    try {
      const pref=await this.gateway.createPreference(preferenceBody(this.config,op,publicToken));
      const checkoutUrl=sandboxUrl(pref.sandbox_init_point);
      if(typeof pref.id!=='string'||!pref.id || !/^\d+$/.test(String(pref.collector_id))) throw new AppError(502,'MP_RESPONSE_INVALID','Respuesta de checkout inválida.');
      op.preferenceId=pref.id;op.collectorId=String(pref.collector_id);this.store.save(op);
      this.log('preference_created',{operationId:op.id,preferenceId:op.preferenceId});
      return {checkoutUrl,publicToken};
    } catch(error) {op.failed=true;this.store.save(op);throw error;}
  }
  status(token:string) {
    const op=this.store.byToken(token);
    if(!op) throw new AppError(404,'OPERATION_NOT_FOUND','Operación inexistente o vencida.');
    return publicState(op);
  }
  async verifyPayment(id:string, log:Logger=this.log) {
    // Coalesce concurrent duplicate notifications; subsequent notifications fetch MP again.
    const existing=this.running.get(id);if(existing) return existing;
    if(this.running.size>=100) throw new AppError(503,'BUSY','Reintentar notificación.');
    const task=this.refresh(id,log).finally(()=>this.running.delete(id));this.running.set(id,task);return task;
  }
  private async refresh(id:string, log:Logger) {
    log('webhook_payment_lookup_started',{paymentId:id});
    const p=await this.gateway.getPayment(id).catch(error=>{
      log('webhook_payment_lookup_failed',{paymentId:id,code:error instanceof AppError?error.code:'INTERNAL_ERROR',upstreamStatus:error instanceof PaymentLookupError?error.upstreamStatus:undefined});
      throw error;
    });
    if(String(p.id)!==id || typeof p.external_reference!=='string') throw new AppError(502,'MP_RESPONSE_INVALID','Respuesta de pago inválida.');
    const op=this.store.byId(p.external_reference);
    if(!op){log('payment_unrelated',{paymentId:id});return;}
    if(!op.preferenceId || !op.collectorId) throw new AppError(503,'PREFERENCE_NOT_READY','Reintentar notificación.');
    const timestamp=Date.parse(p.date_last_updated);
    const refund=cents(p.transaction_amount_refunded ?? 0);
    const valid=String(p.collector_id)===op.collectorId && p.live_mode===false && p.currency_id===op.currency && cents(p.transaction_amount)===op.amountCents && Number.isFinite(timestamp) && refund!==null;
    if(!valid){log('payment_mismatch',{operationId:op.id,paymentId:id});throw new AppError(422,'PAYMENT_MISMATCH','El pago no coincide con esta prueba.');}
    const status:PublicStatus=refund!>0?'refunded':statuses[p.status]||'not_approved';
    const previous=op.payments.get(id);
    if(previous && timestamp<previous.updatedAt) return;
    // Igual timestamp: nunca reactivar desde un snapshot terminal contradictorio.
    if(previous && timestamp===previous.updatedAt && previous.status!==status && ['refunded','charged_back','cancelled'].includes(previous.status)) return;
    if(!previous && op.payments.size>=50) throw new AppError(503,'PAYMENT_CAPACITY','Capacidad de prueba alcanzada.');
    op.payments.set(id,{id,status,updatedAt:timestamp,verifiedAt:new Date().toISOString()});this.store.save(op);
    log('webhook_payment_verified',{operationId:op.id,paymentId:id,status});
    if(status==='approved') grantVisualPackAccess(this.store,op,id,log);
    // Refunded/cancelled/charged_back => publicState no concede; futura entrega real requiere revocación.
  }
}
