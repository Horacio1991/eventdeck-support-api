import { AppError } from '../utils/errors.js';

export interface VisualPackStorage {
  readonly configured: boolean;
  /** Trusted exact HTTPS origins, configured server-side by a future adapter. */
  readonly allowedOrigins: readonly string[];
  /** Must sign a private object; no file bytes pass through this API. */
  createDownloadUrl(benefitId: string, expiresAt: number): Promise<{url: string; expiresAt: number}>;
}
export const storageUnavailable = () => new AppError(503, 'DOWNLOAD_UNAVAILABLE', 'La descarga todavía no está disponible.');
export class UnconfiguredVisualPackStorage implements VisualPackStorage {
  readonly configured = false;
  readonly allowedOrigins: readonly string[] = [];
  async createDownloadUrl(_benefitId: string, _expiresAt: number): Promise<{url: string; expiresAt: number}> {
    throw storageUnavailable();
  }
}
