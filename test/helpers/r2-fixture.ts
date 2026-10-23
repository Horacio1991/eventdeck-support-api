import { loadStorageConfig, type R2StorageConfig } from '../../src/config/storage-env.js';
// Synthetic identifiers only. No real account, credentials, object or remote requests.
export const r2Env = {
  VISUAL_PACK_STORAGE_PROVIDER: 'r2',
  R2_ENDPOINT: `https://${'0'.repeat(32)}.r2.cloudflarestorage.com`,
  R2_ACCESS_KEY_ID: 'SYNTHETICACCESSKEY0000000000000000',
  R2_SECRET_ACCESS_KEY: 'SYNTHETIC_SECRET_NOT_A_REAL_CLOUDFLARE_CREDENTIAL_0123456789',
  R2_BUCKET: 'fixture-private-pack',
  R2_VISUAL_PACK_OBJECT_KEY: 'packs/v1/EventDeck-Visual-Pack-v1.zip',
};
export const r2Config = () => loadStorageConfig(r2Env) as R2StorageConfig;
