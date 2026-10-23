import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export const VISUAL_PACK = 'visual-pack-v1';
export interface Entitlement {
  id: string; operationId: string; paymentId: string; benefitId: string;
  createdAt: number; expiresAt: number; status: 'active' | 'revoked'; revision: number;
}
export interface EntitlementRepository {
  find(operationId: string, benefitId: string): Entitlement | undefined;
  byId(id: string): Entitlement | undefined;
  createOnce(input: Omit<Entitlement, 'id' | 'status' | 'revision'>): Entitlement;
  revoke(id: string): void;
}
export interface DownloadToken {
  hash: string; entitlementId: string; entitlementRevision: number; benefitId: string;
  expiresAt: number; remainingUses: number; revoked: boolean;
}
export interface DownloadTokenRepository {
  byHash(hash: string): DownloadToken | undefined;
  replaceForEntitlement(token: DownloadToken): void;
  /** Atomic reservation before any async storage work. */
  consume(hash: string): boolean;
  revoke(hash: string): void;
}
const capacity = () => new AppError(503, 'BENEFIT_CAPACITY', 'Capacidad temporal alcanzada.');

export class MemoryEntitlementRepository implements EntitlementRepository {
  private records = new Map<string, Entitlement>();
  constructor(private now = Date.now, private max = 5000) {}
  private prune() { for (const [id, item] of this.records) if (item.expiresAt <= this.now()) this.records.delete(id); }
  find(operationId: string, benefitId: string) {
    this.prune();const item = [...this.records.values()].find(e => e.operationId === operationId && e.benefitId === benefitId);
    return item && {...item};
  }
  byId(id: string) { this.prune();const item = this.records.get(id);return item && {...item}; }
  createOnce(input: Omit<Entitlement, 'id' | 'status' | 'revision'>) {
    const existing = this.find(input.operationId, input.benefitId);if (existing) return existing;
    if (this.records.size >= this.max) throw capacity();
    const item: Entitlement = {...input, id: randomUUID(), status: 'active', revision: 1};
    this.records.set(item.id, item);return {...item};
  }
  revoke(id: string) {
    const item = this.records.get(id);
    if (item && item.status !== 'revoked') { item.status = 'revoked';item.revision++; }
  }
}

export class MemoryDownloadTokenRepository implements DownloadTokenRepository {
  private records = new Map<string, DownloadToken>();
  constructor(private now = Date.now, private max = 5000) {}
  private prune() { for (const [hash, token] of this.records) if (token.expiresAt <= this.now()) this.records.delete(hash); }
  byHash(hash: string) { this.prune();const item = this.records.get(hash);return item && {...item}; }
  replaceForEntitlement(token: DownloadToken) {
    this.prune();
    const previous = [...this.records.values()].find(t => t.entitlementId === token.entitlementId);
    if (!previous && this.records.size >= this.max) throw capacity();
    if (previous) this.records.delete(previous.hash);
    this.records.set(token.hash, {...token});
  }
  consume(hash: string) {
    this.prune();const item = this.records.get(hash);
    if (!item || item.revoked || item.remainingUses <= 0) return false;
    item.remainingUses--;return true;
  }
  revoke(hash: string) { const item = this.records.get(hash);if (item) item.revoked = true; }
}
