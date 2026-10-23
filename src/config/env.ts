import { loadStorageConfig, type StorageConfig } from './storage-env.js';
export interface Config {
  storage: StorageConfig;
  port: number; production: boolean; accessToken: string; webhookSecret: string;
  webhookProductionDiagnosticSecret?: string; webhookRawDiagnostic?: boolean;
  baseUrl: string; frontendUrl: string; corsOrigin: string; amountCents: number | null;
  currency: 'ARS'; trustProxyHops: number;
}
export function cents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}
function origin(value: string, name: string, production: boolean): string {
  if (!value) return '';
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name}: URL inválida`); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`${name}: usar solamente un origen sin ruta ni credenciales`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production)) throw new Error(`${name}: requiere HTTPS (HTTP solo localhost en desarrollo)`);
  return url.origin;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido');
  if (![0, 1].includes(trustProxyHops)) throw new Error('TRUST_PROXY_HOPS debe ser 0 o 1');
  if (env.SUPPORT_CURRENCY && env.SUPPORT_CURRENCY !== 'ARS') throw new Error('Solo se admite ARS');
  const amountCents = env.SUPPORT_AMOUNT ? cents(env.SUPPORT_AMOUNT) : null;
  if (env.SUPPORT_AMOUNT && (amountCents === null || amountCents <= 0)) throw new Error('SUPPORT_AMOUNT debe ser positivo con hasta 2 decimales');
  const accessToken = (env.MP_ACCESS_TOKEN || '').trim();
  // El prefijo de prueba varía por solución; no permite inferir el ambiente.
  // Usar credenciales de Pruebas. Además se exige sandbox_init_point y live_mode=false.
  if (accessToken && /\s/.test(accessToken)) throw new Error('MP_ACCESS_TOKEN: formato inválido');
  const baseUrl = origin(env.BASE_URL || '', 'BASE_URL', production);
  const frontendUrl = origin(env.FRONTEND_URL || baseUrl, 'FRONTEND_URL', production);
  const corsOrigin = origin(env.CORS_ORIGIN || frontendUrl, 'CORS_ORIGIN', production);
  if (frontendUrl && corsOrigin && frontendUrl !== corsOrigin) throw new Error('CORS_ORIGIN debe coincidir con FRONTEND_URL en esta prueba');
  return {storage:loadStorageConfig(env), webhookRawDiagnostic:env.MP_WEBHOOK_RAW_DIAGNOSTIC==='true', webhookProductionDiagnosticSecret: (env.MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC || '').trim(), port, production, accessToken, webhookSecret: (env.MP_WEBHOOK_SECRET || '').trim(), baseUrl, frontendUrl, corsOrigin, amountCents, currency:'ARS', trustProxyHops};
}
export function ready(c: Config): boolean {
  return Boolean(c.accessToken && c.webhookSecret && c.amountCents && c.baseUrl.startsWith('https://') && c.frontendUrl.startsWith('https://') && c.corsOrigin);
}
