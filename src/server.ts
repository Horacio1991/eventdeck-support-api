import { SIGNATURE_FIX } from './services/webhook-signature.js';
import { createApp } from './app.js';
import { loadConfig, ready } from './config/env.js';
import { logger } from './utils/logger.js';
try {
  const config=loadConfig();
  const server=createApp(config).listen(config.port,'0.0.0.0',()=>{
    logger('server_started',{code:'hito10-visual-pack-entitlement'});
    logger('webhook_diagnostics_version',{code:SIGNATURE_FIX});
    if(!ready(config)) logger('checkout_disabled',{code:'MISSING_TEST_CONFIGURATION'});
  });
  server.requestTimeout=15_000;server.headersTimeout=12_000;
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
    server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10_000).unref();
  });
} catch {
  // No imprimir excepciones/configuración: podrían incluir secretos de dependencias.
  console.error('Configuración inválida. Revisá .env.example y README (sin compartir credenciales).');
  process.exitCode=1;
}
