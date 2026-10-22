# FIX4.1 — URL original para WCS-55735

Build: webhook-raw-url-diagnostic. Base: FIX4 webhook-raw-header-diagnostic (70 tests). Diagnóstico exclusivamente; no corrige ni flexibiliza firmas.

## Propiedades elegidas

Se revisó la captura existente y el código del router Express instalado. El router conserva req.originalUrl desde req.url al ingresar y recorta req.url al ejecutar middleware montado. Como FIX4 se monta con app.use('/api/webhooks', ...), en su primera instrucción:

- req.originalUrl conserva /api/webhooks/mercadopago y la query completa. Se copia directamente a rawRequestUrl.
- req.url contiene /mercadopago y la misma query. Se copia directamente a mountedRequestUrl para comparar.

La captura se realiza dentro de la misma llamada captureWebhookHeaders, antes de traceId, loggers, Helmet, rate limiter y parser JSON. Son copias de strings disponibles en el runtime. No se usa req.query, URLSearchParams, decodeURIComponent ni reconstrucción de protocolo/host/query. No se cambia el montaje de middleware.

rawUrlEqualsMounted=false es esperable por el prefijo recortado. No implica que Mercado Pago ni Render hayan alterado el request. Las longitudes se registran como rawRequestUrlLength y mountedRequestUrlLength.

Código instalado inspeccionado en la base: node_modules/router/index.js, asignación req.originalUrl = req.originalUrl || req.url y recorte de req.url por removed. No hay un middleware propio anterior que reescriba esa URL.

## Qué garantiza la captura

Conserva la representación que Express guardó al recibir la solicitud desde Node: path y query, nombres, encoding, orden y duplicados tal como están disponibles. Las pruebas HTTP locales usan orden no canónico, data%2eid, %2f/%2F, +, %20, %252F y parámetros duplicados.

No constituye una captura de red anterior a Render/proxies, ni prueba que coincida byte por byte con la URL usada por Mercado Pago antes de enviarla. Si el proxy normaliza/reconstruye el request antes de Node, no puede recuperarse aquí. No se inventan protocolo/host desde Host o X-Forwarded-*.

## Activación y evidencia para soporte

Por defecto MP_WEBHOOK_RAW_DIAGNOSTIC=false (o ausente). Solo el valor literal true activa el diagnóstico exacto, como en FIX4. No se agregan variables.

Procedimiento manual cuando se decida probar:
1. Instalar este build por el procedimiento habitual y confirmar server_started con code webhook-raw-url-diagnostic. Esta entrega NO hizo el despliegue.
2. Activar temporalmente MP_WEBHOOK_RAW_DIAGNOSTIC=true y aplicar el reinicio requerido por la plataforma. Conservar todas las claves/configuraciones existentes; FIX4.1 no requiere regenerarlas.
3. Recibir una entrega controlada. No se realizó ningún pago en esta tarea.
4. Buscar webhook_raw_header_diagnostic y copiar, del MISMO traceId, rawRequestUrl y manifestExact para WCS-55735. Si soporte necesita correlación, adjuntar time, traceId y los headers RAW ya autorizados de esa misma línea. No mezclar reintentos.
5. Volver inmediatamente MP_WEBHOOK_RAW_DIAGNOSTIC a false y aplicar el reinicio correspondiente. Comprobar que las siguientes líneas no contienen rawRequestUrl ni mountedRequestUrl ni los valores RAW de FIX4.

Con OFF solo se añaden longitudes y el booleano de comparación, sin query exacta. La whitelist del logger vuelve a aplicar el control por evento y rawDiagnosticEnabled. No se registran secretos, variables de credenciales ni HMAC calculados. ON conserva la firma recibida autorizada en FIX4.

Al copiar JSON, usar sus strings interpretados: no convertir escapes JSON en caracteres literales ni recortar espacios. La URL exacta podría contener datos introducidos por el remitente en la query; conservar el diagnóstico para una prueba privada y compartir solo con soporte. No se leen secretos para construirla. Desactivar el flag no elimina logs históricos retenidos.

## Ejemplo ilustrativo parcial, no evidencia real nueva

```json
{
  "event": "webhook_raw_header_diagnostic",
  "rawDiagnosticEnabled": true,
  "rawRequestUrl": "/api/webhooks/mercadopago?data.id=185573790598&type=payment",
  "mountedRequestUrl": "/mercadopago?data.id=185573790598&type=payment",
  "rawUrlEqualsMounted": false,
  "manifestExact": "id:185573790598;request-id:<header de esa entrega>;ts:<ts de esa entrega>;"
}
```

manifestExact sigue siendo el string del validador existente. Si no se construyó por un rechazo previo, permanece null; no se fabrica uno para soporte.

## Archivos

Modificados:
- src/services/webhook-raw-diagnostic.ts: captura directa de originalUrl/url, métricas y whitelist condicionada.
- src/services/webhook-signature.ts: SOLO identificador de build; algoritmo idéntico a FIX4.
- test/support.test.ts: SOLO dos expectativas del nuevo build identifier. No se eliminan tests ni se debilitan aserciones.

Nuevos:
- test/raw-url.test.ts: 11 tests HTTP para los escenarios pedidos.
- DIAGNOSTICO-RAW-URL.md: este documento.

No cambiaron server.ts (ya lee identificador compartido), app.ts, checkout, Preferences, notification_url, secretos, consultas payment, reglas de acceso, frontend, dependencias ni configuración externa. Los tests anteriores RAW siguen comprobando sus tres valores originales en fixtures sin URL; los nuevos tests verifican la extensión de URL con solicitudes HTTP reales locales.

## Validación y seguridad

El resultado normal depende exclusivamente de MP_WEBHOOK_SECRET. TEST mismatch sigue401, PROD-only match sigue401, cero lookup payment y cero acceso. URL no participa en manifest ni HMAC. No hay nuevos fallbacks/manifests ni aceptación de IPN.

Las pruebas usan servidor local y gateway simulado; ninguna llamada de pago. Resultados: build OK; typecheck OK; 81/81 tests PASS (70 existentes + 11 nuevos), 0 fallos. Warning ambiental npm: Unknown env config http-proxy. Documentos anteriores se conservan como historial de sus respectivos builds.

No desplegado. Ningún pago realizado. Sin regeneración de claves ni cambios en Render/Mercado Pago. Sin Hito10.
