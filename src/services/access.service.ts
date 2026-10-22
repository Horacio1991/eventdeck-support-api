import { type Operation, type Store } from './store.js';
import type { Logger } from '../utils/logger.js';
export function grantVisualPackAccess(store: Store, op: Operation, paymentId: string, log: Logger): void {
  if (op.payments.get(paymentId)?.status !== 'approved') return;
  if (store.grantOnce(op)) log('VISUAL PACK ACCESS GRANTED',{operationId:op.id,paymentId,status:'approved'});
  // Solo prueba: sin URL, email, archivo ni entrega. Una DB futura necesita transacción/outbox.
}
