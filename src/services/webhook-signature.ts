import { createHmac, timingSafeEqual } from 'node:crypto';
// Manifest oficial. Este endpoint de pagos exige las tres partes (no acepta un ID ausente).
export function validSignature(signature: string | undefined, requestId: string | undefined, dataId: string, secret: string): boolean {
  if (!secret || !signature || signature.length>1024 || !requestId || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return false;
  const values = new Map<string,string>();
  for (const part of signature.split(',')) {
    const match = /^\s*(ts|v1)\s*=\s*([^\s,]+)\s*$/.exec(part);
    if(!match || values.has(match[1]!)) return false;
    values.set(match[1]!,match[2]!);
  }
  const ts=values.get('ts'),v1=values.get('v1');
  if(!ts || !/^\d{10,16}$/.test(ts) || !v1 || !/^[a-fA-F0-9]{64}$/.test(v1)) return false;
  const manifest=`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected=createHmac('sha256',secret).update(manifest).digest();
  // No expirar por reloj local: reenvíos legítimos pueden ser tardíos. Replay => consulta actual + idempotencia.
  return timingSafeEqual(expected,Buffer.from(v1,'hex'));
}
