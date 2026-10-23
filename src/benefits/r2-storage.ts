import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { R2StorageConfig } from '../config/storage-env.js';
import { VISUAL_PACK } from './repositories.js';
import { STORAGE_URL_TTL_MS } from './visual-pack.service.js';
import { storageUnavailable, type VisualPackStorage } from './storage.js';

export const VISUAL_PACK_DOWNLOAD_NAME = 'EventDeck-Visual-Pack-v1.zip';
export type R2Presigner = (client: S3Client, command: GetObjectCommand,
  options: {expiresIn: number; signingDate: Date}) => Promise<string>;

export class CloudflareR2VisualPackStorage implements VisualPackStorage {
  readonly configured = true;
  readonly allowedOrigins: readonly string[];
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly objectKey: string;

  constructor(config: R2StorageConfig, private readonly sign: R2Presigner = getSignedUrl,
    private readonly now = Date.now) {
    this.allowedOrigins = Object.freeze([config.endpoint]);
    this.bucket = config.bucket;this.objectKey = config.objectKey;
    this.client = new S3Client({
      region: 'auto', endpoint: config.endpoint, forcePathStyle: true,
      credentials: {accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey},
      // Signing is entirely local. No SDK credential discovery, HeadObject, GetObject send, or network fallback.
      requestHandler: {handle: async () => { throw storageUnavailable(); }},
    });
  }

  async createDownloadUrl(benefitId: string, requestedExpiresAt: number) {
    if (benefitId !== VISUAL_PACK || !Number.isFinite(requestedExpiresAt)) throw storageUnavailable();
    const now = this.now();
    const signingTime = Math.floor(now / 1000) * 1000;
    const deadline = Math.min(requestedExpiresAt, now + STORAGE_URL_TTL_MS);
    // SigV4 timestamps and TTL have second precision. Round DOWN, never extend token lifetime.
    const expiresIn = Math.min(60, Math.floor((deadline - signingTime) / 1000));
    const expiresAt = signingTime + expiresIn * 1000;
    if (expiresIn < 1 || expiresAt <= now) throw storageUnavailable();
    try {
      const url = await this.sign(this.client, new GetObjectCommand({
        Bucket: this.bucket, Key: this.objectKey,
        ResponseContentDisposition: `attachment; filename="${VISUAL_PACK_DOWNLOAD_NAME}"`,
      }), {expiresIn, signingDate: new Date(signingTime)});
      if (expiresAt <= this.now()) throw storageUnavailable();
      return {url, expiresAt};
    } catch { throw storageUnavailable(); } // Never expose SDK errors, credentials or signed URL.
  }
}
