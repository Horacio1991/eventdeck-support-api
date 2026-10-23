import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import type { Operation, Store } from '../services/store.js';
import { VISUAL_PACK, type Entitlement, type EntitlementRepository, type DownloadTokenRepository } from './repositories.js';
import { storageUnavailable, type VisualPackStorage } from './storage.js';

export const DOWNLOAD_TOKEN_TTL_MS = 10 * 60_000;
export const DOWNLOAD_TOKEN_USES = 3;
export const STORAGE_URL_TTL_MS = 60_000;
export const downloadTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const missing = () => new AppError(404, 'DOWNLOAD_NOT_FOUND', 'Descarga inexistente o no disponible.');
const tokenPattern = /^[a-f0-9]{64}$/;

export class VisualPackService {
  constructor(private operations: Store, private entitlements: EntitlementRepository,
    private tokens: DownloadTokenRepository, private storage: VisualPackStorage, private now = Date.now) {}

  /** Internal only: invoked AFTER the existing server-side payment verification and grant. */
  syncVerifiedOperation(operationId: string, paymentId: string): void {
    const op = this.operations.byId(operationId);
    if (!op || op.expiresAt <= this.now()) return;
    const existing = this.entitlements.find(op.id, VISUAL_PACK);
    if (existing) {
      if (!this.eligible(existing)) this.entitlements.revoke(existing.id);
      return; // Revocation is terminal; duplicate notifications never restore access.
    }
    if (!op.grantedAt || op.payments.get(paymentId)?.status !== 'approved') return;
    this.entitlements.createOnce({operationId: op.id, paymentId, benefitId: VISUAL_PACK,
      createdAt: this.now(), expiresAt: op.expiresAt});
  }

  private eligible(entitlement: Entitlement): boolean {
    const op = this.operations.byId(entitlement.operationId);
    return entitlement.benefitId === VISUAL_PACK && entitlement.status === 'active'
      && entitlement.expiresAt > this.now() && !!op && op.expiresAt > this.now()
      && !!op.grantedAt && op.payments.get(entitlement.paymentId)?.status === 'approved';
  }
  private operation(publicToken: string): Operation {
    const op = tokenPattern.test(publicToken) ? this.operations.byToken(publicToken) : undefined;
    if (!op || op.expiresAt <= this.now()) throw missing();
    return op;
  }
  status(publicToken: string) {
    const op = this.operation(publicToken);
    const entitlement = this.entitlements.find(op.id, VISUAL_PACK);
    const available = !!entitlement && this.eligible(entitlement);
    return {id: VISUAL_PACK, available, downloadReady: available && this.storage.configured};
  }
  issue(publicToken: string) {
    const op = this.operation(publicToken);
    const entitlement = this.entitlements.find(op.id, VISUAL_PACK);
    if (!entitlement || !this.eligible(entitlement)) throw missing();
    if (!this.storage.configured) throw storageUnavailable();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Math.min(this.now() + DOWNLOAD_TOKEN_TTL_MS, op.expiresAt, entitlement.expiresAt);
    this.tokens.replaceForEntitlement({hash: downloadTokenHash(token), entitlementId: entitlement.id,
      entitlementRevision: entitlement.revision, benefitId: VISUAL_PACK, expiresAt,
      remainingUses: DOWNLOAD_TOKEN_USES, revoked: false});
    return {downloadPath: `/api/downloads/${token}`, expiresAt: new Date(expiresAt).toISOString()};
  }
  private authorized(hash: string, requireUse: boolean) {
    const token = this.tokens.byHash(hash);
    if (!token || token.revoked || token.expiresAt <= this.now() || token.benefitId !== VISUAL_PACK
      || (requireUse && token.remainingUses <= 0)) throw missing();
    const entitlement = this.entitlements.byId(token.entitlementId);
    if (!entitlement || entitlement.revision !== token.entitlementRevision || !this.eligible(entitlement)) throw missing();
    return token;
  }
  async resolve(token: string): Promise<string> {
    if (!tokenPattern.test(token)) throw missing();
    const hash = downloadTokenHash(token);
    const stored = this.authorized(hash, true);
    if (!this.storage.configured) throw storageUnavailable();
    // Reserve synchronously, including failed provider attempts; concurrent GETs cannot exceed the limit.
    if (!this.tokens.consume(hash)) throw missing();
    const expiresAt = Math.min(this.now() + STORAGE_URL_TTL_MS, stored.expiresAt);
    let result: {url: string; expiresAt: number};
    try { result = await this.storage.createDownloadUrl(VISUAL_PACK, expiresAt); }
    catch { throw storageUnavailable(); } // Do not expose provider errors/URLs/credentials.
    // A revocation/refund/rotation/expiry during async signing must also fail closed.
    this.authorized(hash, false);
    try {
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash
        || !this.storage.allowedOrigins.includes(url.origin)
        || !Number.isFinite(result.expiresAt) || result.expiresAt <= this.now() || result.expiresAt > expiresAt) throw new Error();
    } catch { throw storageUnavailable(); }
    return result.url;
  }
}
