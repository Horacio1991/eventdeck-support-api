# FIX acotado — webhook-fix-1

Base exacta: eventdeck-support-api(3).zip. Fecha: 22/10/2026. Sin cambios a la web, WPF, Preferences, monto, UUID, acceso al Visual Pack ni dependencias. No se desplegó esta corrección.

## 1. Causa encontrada y qué sigue sin confirmar

La ruta Express es exactamente **POST /api/webhooks/mercadopago**. No hay router o prefijo adicional. El CORS existente se monta exclusivamente en /api/support; no exige Origin para el webhook. Helmet agrega headers, no autentica el webhook. No existe filtro de host. trust proxy modifica la IP que usa rate limiting; no valida la firma.

Se comprobaron dos problemas de implementación:

1. El log webhook_received estaba dentro del handler, **después** del limitador y express.json. Un rechazo 429, JSON inválido o demasiado grande podía impedir ese log. El middleware de errores solo registraba un código genérico sin correlación con el webhook; rate limiting respondía directamente.
2. El adapter convertía cualquier respuesta no exitosa del GET payment en un mismo MP_API_ERROR / HTTP 502, perdiendo la distinción entre recurso inexistente, autorización, rate limit y fallo del proveedor. Un 404 del ID ficticio del simulador terminaba innecesariamente en 502.

**Esto no prueba que alguno sea la causa de todos los envíos faltantes en Render.** Sin logs del intento específico no se puede atribuir el 502 a Express, gateway, cold start, configuración o filtros del visor.

Comprobación pública realizada sobre el despliegue anterior al FIX, el 22/10/2026 alrededor de las 12:31 de Argentina:

- GET /health: 200 con JSON esperado.
- POST al webhook exacto, JSON de payment 123456 **sin firma**: 401 INVALID_SIGNATURE, con headers de Express/Render y rate limiting. No se creó Preference ni se ejecutó pago.

Esto demuestra conectividad desde el entorno de comprobación y que el endpoint desplegado ejecutaba el rechazo de firma. No prueba conectividad desde Mercado Pago ni permite consultar tus logs privados. Ese POST anterior debería haber producido webhook_received y webhook_signature_invalid en el servicio que respondió.

## 2. Archivos modificados

- `src/app.ts`: instrumentación temprana y ACK acotado del error 404 autenticado; firma y validaciones de pago conservadas.
- `src/middleware/webhook-diagnostics.ts`: nuevo middleware solo en /api/webhooks, antes de Helmet, parser y limitador; correlación y estado final.
- `src/utils/logger.ts`: campos seguros explícitos de diagnóstico; no serializa request, headers completos o errores crudos.
- `src/services/mercadopago.service.ts`: PaymentLookupError con HTTP upstream para GET payment; POST Preference mantiene comportamiento y contenido.
- `src/services/support.service.ts`: logs de consulta/fallo/verificación con correlación. Sin cambios en reglas de aprobación/idempotencia.
- `src/middleware/security.ts`: correlaciona el error con el webhook y registra código HTTP.
- `src/server.ts`: agrega code=webhook-fix-1 al log de arranque.
- `test/support.test.ts`: conserva los 19 tests y agrega 9 pruebas del FIX.
- `README.md`, `VERIFICACION.md`, `FIX-WEBHOOK.md`: documentación y resultados.

El archivo HMAC `webhook-signature.ts`, configuración/env, store, grantVisualPackAccess, public/, package.json y lockfile permanecen idénticos al ZIP recibido.

## 3. Antes y después

| Caso | Antes | Ahora |
| --- | --- | --- |
| Entrada HTTP webhook | Primer log después de parser/limiter | Primer log antes de ambos y de Helmet; headers de identificación |
| Firma inválida/ausente | 401 | 401, entrada/fallo/respuesta correlacionados |
| Firma válida, GET payment devuelve 404 | 502 genérico | 200 recibido, sin acceso ni alteración del estado |
| GET payment devuelve 401/403/429/5xx o falla transporte | 502 genérico | 502 con diagnóstico seguro de upstream, sin ACK exitoso |
| Pago aprobado y correlacionado | Acceso TEST una vez | Igual; logs detallados |
| Reintento duplicado | Sin doble concesión | Igual |
| JSON inválido/grande, límite excedido | Log de entrada ausente | Entrada visible y respuesta 400/413/429 identificable |
| Ruta incorrecta dentro de /api/webhooks o método incorrecto | 404 | 404 observable, sin procesamiento |

No existe excepción especial para 123456 ni una bandera del body que active modo simulador. La firma se verifica antes de cualquier consulta/ACK del handler. Un 404 del GET después de autenticación demuestra recurso no encontrado para esa credencial, **no demuestra que sea un simulador**. Esta política se aplica a cualquier payment inexistente. No otorga acceso ni convierte una operación en approved/rejected.

El ACK 200 de un 404 evita reintentos automáticos de ese evento. Si excepcionalmente un pago auténtico todavía no era visible para la API, habrá que reenviar su notificación cuando esté disponible. No se agregó una cola ni reconciliación persistente. Por eso **no** se reconocen indiscriminadamente timeouts/5xx/errores de credenciales: perderíamos reintentos de pagos reales.

## 4. Firma y formato conservados

La documentación oficial actual de Payments utiliza JSON application/json, query data.id/type y headers x-signature/x-request-id. express.json con límite 16 KB es compatible. La firma no depende de los bytes originales del body: no se necesita raw-body ni quitar el parser.

Se mantiene la extracción de ts y v1, manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, ID normalizado a minúsculas, timestamp literal, HMAC-SHA256 con MP_WEBHOOK_SECRET y comparación timingSafeEqual. No se imprime la firma, el secret ni el token. El endpoint de payments exige los tres campos y rechaza duplicados; no se relajó esa política. La firma no acredita un status que venga en el JSON.

Mercado Pago documenta ACK 200/201 y espera hasta 22 segundos. En este prototipo sin cola durable se mantiene la consulta síncrona (timeout 10 s) para conservar reintentos cuando falla; solo se reconoce específicamente el 404. ACK significa recepción, no pago aprobado.

Fuentes oficiales verificadas el 22/10/2026:

- https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/payment-notifications
- https://www.mercadopago.com.uy/developers/en/docs/checkout-pro-preferences/additional-settings/optional-notifications (algoritmo de firma; el tópico utilizado sigue siendo payment de Preferences).

## 5. Logs y cómo ubicar la falla

Cada request recibe traceId generado por el servidor. Headers de respuesta:

- `X-EventDeck-Webhook-Fix: webhook-fix-1`
- `X-EventDeck-Trace-Id: <UUID del request>`

Al iniciar: `server_started` con code=webhook-fix-1. Los logs registran fecha UTC; ajustar el rango horario del visor (Argentina UTC−3).

Secuencia normal:

1. webhook_request_received: timestamp, método, namespace fijo, presencia de los dos headers y traceId. Es el primer middleware del webhook.
2. webhook_request_metadata: ID solo si es numérico y acotado, booleanos de ruta/query, categorías de type/Content-Type. Nunca query completo ni campos desconocidos.
3. webhook_handler_entered: confirma que pasó parser y rate limit.
4. webhook_signature_valid **o** webhook_signature_invalid.
5. webhook_payment_lookup_started.
6. webhook_payment_verified, o webhook_payment_lookup_failed con upstreamStatus cuando existe.
7. VISUAL PACK ACCESS GRANTED solamente si corresponde; una vez por operación.
8. webhook_acknowledged con HTTP 200, o webhook_response_sent con el código de rechazo/error.

Para 404 se verá webhook_payment_lookup_failed → webhook_payment_not_found_no_access → webhook_acknowledged. Para conexión cerrada antes de responder: webhook_connection_closed. Los duplicados concurrentes pueden compartir la consulta: cada request tiene entrada y respuesta; solo el primero registra la consulta compartida.

Interpretación:

- Sin marker de arranque: confirmar que se desplegó este código y se están viendo los runtime logs del servicio correcto.
- Respuesta con ambos headers pero sin logs visibles: llegó al middleware de esta revisión; revisar filtros/rango de logs, instancia/servicio y entrega de stdout del hosting.
- 502 sin headers ni log de entrada, habiendo confirmado esta revisión con un POST directo: el intento no tiene evidencia de haber alcanzado este middleware. Investigar capa anterior/hosting, URL efectiva del envío, disponibilidad y datos del intento en Mercado Pago. No atribuirlo automáticamente a la firma.
- Entrada sin handler: parser/limitador o conexión; mirar respuesta/código y duración.
- Firma inválida: presencia de headers, queryIdValid y secret de la configuración correcta. No mostrar ni compartir el secret para diagnosticar.
- lookup_failed: 404 inexistente; 401/403 autorización/credencial; 429 límite; 5xx proveedor; sin upstreamStatus transporte/timeout/respuesta inválida. No se registra body del proveedor.
- payment_unrelated: no hay operación en memoria asociada (incluye reinicio/expiración o pago de otra operación).
- payment_mismatch: no coincide con los requisitos conservados de prueba, monto, moneda o collector. Nunca forzar aprobación.

## 6. Variables y URL

**No hay variables nuevas ni cambios requeridos.** Se conserva la URL:

`https://eventdeck-support-api.onrender.com/api/webhooks/mercadopago`

Mantener Webhook TEST de Pagos/payment, mismo secret y token de prueba. No tocar la Preference ni cambiar a producción. Mantener comandos de Render existentes; solo subir esta revisión y redeployar manualmente.

## 7. Repetir la prueba del simulador

1. Desplegar este ZIP y verificar server_started con code=webhook-fix-1. Abrir runtime logs, sin filtros, en rango actual.
2. Comprobar /health. Para distinguir ruta de autenticación, ejecutar desde PowerShell (curl.exe evita alias):

```powershell
curl.exe -i -X POST "https://eventdeck-support-api.onrender.com/api/webhooks/mercadopago?data.id=123456&type=payment" -H "Content-Type: application/json" --data "{}"
```

Debe dar 401 por firma ausente, junto con headers del FIX y logs de entrada/firma inválida/respuesta. No se envían credenciales ni se conceden accesos.

3. En Mercado Pago Developers → Webhooks → Modo de prueba → Simular notificación → Pagos → Data ID 123456. Enviar.
4. Si la firma es válida y el GET responde 404: **200 con `{ "received": true }`**, sin acceso. Si el GET devuelve otro error, se mantiene 502 y ahora se conoce upstreamStatus. Si falta/no coincide la firma: 401. El resultado exacto del proveedor no puede garantizarse sin ejecutar esa prueba con tu configuración.
5. Guardar hora, HTTP, traceId y eventos sanitizados; nunca copiar headers de autorización/firma ni variables secretas.

## 8. Comprobar un pago TEST real y salir de PROCESANDO

Después del redeploy, crear un **intento nuevo** desde la página TEST: la memoria de los anteriores se pierde. Completar pago sandbox con comprador/tarjeta TEST. No reiniciar el servicio durante la operación.

Buscar webhook_request_received → webhook_signature_valid → webhook_payment_lookup_started → webhook_payment_verified(status=approved) → VISUAL PACK ACCESS GRANTED → webhook_acknowledged.

El botón **Consultar estado** sigue consultando GET /api/support/status/:publicToken. Este endpoint devuelve el estado verificado en memoria; **no busca pagos en Mercado Pago al presionar el botón**. Esto es comportamiento existente y se conserva para no ampliar el FIX ni confiar en parámetros del redirect.

Si el pago TEST existe pero faltó su webhook, reenviar la notificación de ese pago desde el panel si ofrece la opción, o simular Pagos con su ID real obtenido en Mercado Pago, en vez de 123456. Ese reenvío firmado hace el GET server-side y conserva todas las verificaciones: external_reference, collector, monto, moneda, live_mode=false y approved. Luego presionar Consultar estado. El ID sirve para localizar el recurso, nunca como prueba de aprobación.

Si ya se perdió la operación en memoria, no se puede recuperar con este FIX: crear otro intento TEST. No se agregaron búsquedas por query parameters, aprobación por retorno ni concesiones manuales.

## 9. Verificación

28 tests aprobados: los 19 existentes conservados y 9 adicionales. Build y typecheck correctos. Cobertura nueva: log antes de parser/limiter, ruta y firma válidas, rechazo 401, 123456 firmado con GET 404 sin acceso, preservación de errores/reintentos, adapter, CORS, rutas/métodos erróneos y límites. Los tests previos mantienen approved una sola vez y duplicados concurrentes.

El deploy y el pago TEST real quedan pendientes de tu ejecución. Sin nuevas dependencias. Sin cambios en aprobación, frontend, Hito 10 ni Visual Pack.
