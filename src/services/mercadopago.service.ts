import type { Config } from '../config/env.js';
import type { Operation } from './store.js';
import { AppError } from '../utils/errors.js';
export interface Preference { id: string; collector_id: number | string; sandbox_init_point: string }
export interface Payment {
  id: number | string; external_reference: string; collector_id: number | string;
  transaction_amount: number; currency_id: string; live_mode: boolean; status: string;
  date_last_updated: string; transaction_amount_refunded?: number;
}
export interface Gateway {
  createPreference(body: Record<string,unknown>): Promise<Preference>;
  getPayment(id: string): Promise<Payment>;
}
export class MercadoPagoGateway implements Gateway {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, body?: Record<string,unknown>): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.mercadopago.com${path}`, {
        method:body?'POST':'GET', headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},
        ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10_000),redirect:'error'
      });
      if (!response.ok) throw new AppError(502,'MP_API_ERROR','Mercado Pago no pudo completar la consulta. Intentá nuevamente.');
      return await response.json();
    } catch { throw new AppError(502,'MP_API_ERROR','Mercado Pago no pudo completar la consulta. Intentá nuevamente.'); }
  }
  async createPreference(body: Record<string,unknown>) { return await this.request('/checkout/preferences',body) as Preference; }
  async getPayment(id: string) { return await this.request(`/v1/payments/${encodeURIComponent(id)}`) as Payment; }
}
export function preferenceBody(c: Config, op: Operation, publicToken: string): Record<string,unknown> {
  const back = (state:string) => `${c.frontendUrl}/support/${state}/${publicToken}`;
  return {
    items:[{id:'eventdeck-support-test',title:'Apoyo a EventDeck',description:'Apoyo al desarrollo de EventDeck',quantity:1,currency_id:op.currency,unit_price:op.amountCents/100}],
    external_reference:op.id,
    back_urls:{success:back('success'),pending:back('pending'),failure:back('failure')},
    auto_return:'approved',
    notification_url:`${c.baseUrl}/api/webhooks/mercadopago`,
    expires:true,expiration_date_from:new Date(op.createdAt).toISOString(),expiration_date_to:new Date(op.expiresAt).toISOString()
  };
}
export function sandboxUrl(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(502,'MP_RESPONSE_INVALID','Respuesta de checkout inválida.');
  let url:URL;try{url=new URL(value)}catch{throw new AppError(502,'MP_RESPONSE_INVALID','Respuesta de checkout inválida.')}
  if(url.protocol!=='https:' || !['sandbox.mercadopago.com','sandbox.mercadopago.com.ar'].includes(url.hostname) || url.username || url.password || url.port) throw new AppError(502,'MP_RESPONSE_INVALID','El checkout recibido no es de prueba.');
  return url.href;
}
