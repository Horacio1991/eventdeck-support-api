import { StorageConfigurationError, type StorageConfig } from '../config/storage-env.js';
import { CloudflareR2VisualPackStorage } from './r2-storage.js';
import { UnconfiguredVisualPackStorage, type VisualPackStorage } from './storage.js';

export function createVisualPackStorage(config: StorageConfig): VisualPackStorage {
  switch (config.provider) {
    case 'disabled': return new UnconfiguredVisualPackStorage();
    case 'r2': return new CloudflareR2VisualPackStorage(config);
    default: throw new StorageConfigurationError('VISUAL_PACK_STORAGE_PROVIDER');
  }
}
