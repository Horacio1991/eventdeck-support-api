export type StorageConfig = {provider: 'disabled'} | R2StorageConfig;
export interface R2StorageConfig {
  provider: 'r2'; endpoint: string; accessKeyId: string; secretAccessKey: string;
  bucket: string; objectKey: string;
}
type StorageVariable = 'VISUAL_PACK_STORAGE_PROVIDER' | 'R2_ENDPOINT' | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY' | 'R2_BUCKET' | 'R2_VISUAL_PACK_OBJECT_KEY';

/** Message contains only an allowlisted variable name, never its value. */
export class StorageConfigurationError extends Error {
  constructor(variable: StorageVariable) { super(`Configuración de storage inválida: revisar ${variable}. Consultá HITO-11-R2-STORAGE.md.`); }
}
export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const provider = env.VISUAL_PACK_STORAGE_PROVIDER ?? 'disabled';
  if (provider === 'disabled') return {provider}; // Ignore unused R2 variables deliberately.
  if (provider !== 'r2') throw new StorageConfigurationError('VISUAL_PACK_STORAGE_PROVIDER');
  const required = (name: StorageVariable) => {
    const value = env[name];
    if (!value || value !== value.trim()) throw new StorageConfigurationError(name);
    return value;
  };
  const endpoint = required('R2_ENDPOINT');
  // Only R2 S3 API origins: no custom/public domain, port, userinfo, path or query.
  if (!/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com\/?$/.test(endpoint)) throw new StorageConfigurationError('R2_ENDPOINT');
  const accessKeyId = required('R2_ACCESS_KEY_ID');
  if (!/^[A-Za-z0-9]{16,128}$/.test(accessKeyId)) throw new StorageConfigurationError('R2_ACCESS_KEY_ID');
  const secretAccessKey = required('R2_SECRET_ACCESS_KEY');
  if (!/^[\x21-\x7e]{16,256}$/.test(secretAccessKey)) throw new StorageConfigurationError('R2_SECRET_ACCESS_KEY');
  const bucket = required('R2_BUCKET');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new StorageConfigurationError('R2_BUCKET');
  const objectKey = required('R2_VISUAL_PACK_OBJECT_KEY');
  if (Buffer.byteLength(objectKey, 'utf8') > 1024 || /[\x00-\x1f\x7f\\]/.test(objectKey)
    || objectKey.split('/').some(part => !part || part === '.' || part === '..')
    || Buffer.from(objectKey, 'utf8').toString('utf8') !== objectKey) throw new StorageConfigurationError('R2_VISUAL_PACK_OBJECT_KEY');
  return {provider, endpoint: new URL(endpoint).origin, accessKeyId, secretAccessKey, bucket, objectKey};
}
