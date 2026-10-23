import type { VisualPackStorage } from '../../src/benefits/storage.js';
export class FakeStorage implements VisualPackStorage {
  readonly configured = true;
  readonly allowedOrigins = ['https://storage.example.invalid'];
  calls: {benefitId: string; expiresAt: number}[] = [];
  async createDownloadUrl(benefitId: string, expiresAt: number) {
    this.calls.push({benefitId, expiresAt});
    return {url: 'https://storage.example.invalid/private/pack?test-signature=fake', expiresAt};
  }
}
