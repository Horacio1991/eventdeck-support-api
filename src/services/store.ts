import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
export type PublicStatus = 'processing' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back' | 'not_approved';
export interface PaymentSnapshot { id: string; status: PublicStatus; updatedAt: number; verifiedAt: string }
export interface Operation {
  id: string; tokenHash: string; createdAt: number; expiresAt: number; amountCents: number; currency: 'ARS';
  preferenceId?: string; collectorId?: string; failed?: boolean;
  payments: Map<string, PaymentSnapshot>; grantedAt?: string;
}
export interface Store {
  create(amountCents: number, currency: 'ARS'): {operation: Operation; publicToken: string};
  byId(id: string): Operation | undefined;
  byToken(token: string): Operation | undefined;
  save(operation: Operation): void;
  grantOnce(operation: Operation): boolean;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export class MemoryStore implements Store {
  private operations = new Map<string, Operation>();
  private tokens = new Map<string, string>();
  constructor(private ttlMs = 24 * 60 * 60_000, private max = 5000) {}
  private prune() {
    for (const [id, op] of this.operations) if (op.expiresAt <= Date.now()) {this.operations.delete(id);this.tokens.delete(op.tokenHash);}
  }
  create(amountCents: number, currency: 'ARS') {
    this.prune();
    if (this.operations.size >= this.max) throw new AppError(503, 'CAPACITY', 'Capacidad de prueba alcanzada. Intentá más tarde.');
    const publicToken = randomBytes(32).toString('hex');
    const operation: Operation = {id:randomUUID(), tokenHash:hash(publicToken), createdAt:Date.now(), expiresAt:Date.now()+this.ttlMs, amountCents,currency,payments:new Map()};
    this.operations.set(operation.id,operation);this.tokens.set(operation.tokenHash,operation.id);
    return {operation,publicToken};
  }
  byId(id: string) { this.prune();return this.operations.get(id); }
  byToken(token: string) { this.prune();const id=this.tokens.get(hash(token));return id ? this.operations.get(id) : undefined; }
  save(op: Operation) { if (this.byId(op.id)) this.operations.set(op.id,op); }
  // Atómico dentro de UN proceso: no hay await entre chequeo y escritura.
  grantOnce(op: Operation) { if(op.grantedAt) return false;op.grantedAt=new Date().toISOString();this.save(op);return true; }
}
export function publicState(op: Operation): {status: PublicStatus; accessGranted: boolean} {
  const payments = [...op.payments.values()];
  if (payments.some(p=>p.status==='approved')) return {status:'approved',accessGranted:Boolean(op.grantedAt)};
  if (payments.some(p=>p.status==='pending')) return {status:'pending',accessGranted:false};
  const last = payments.sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  return {status:last?.status || (op.failed?'not_approved':'processing'),accessGranted:false};
}
