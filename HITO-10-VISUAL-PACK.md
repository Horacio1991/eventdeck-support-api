# Hito 10 — EventDeck Visual Pack

## Decisiones previas A–H

A. Un entitlement único por operación y `visual-pack-v1`, con paymentId verificado, fecha, estado y revisión. Revocación explícita terminal; un reintento no crea otro derecho.
B. Token aleatorio de 32 bytes; ligado al entitlement y su revisión. Emitir otro invalida el anterior. Solo el poseedor del status token de una operación autorizada puede solicitarlo.
C. Validez de 10 minutos, limitada además por la vida de la operación. URL del storage de hasta 60 segundos.
D. Hasta 3 resoluciones por token, para tolerar reintentos. Esto limita resoluciones, no descargas del objeto: una URL firmada puede reutilizarse hasta que venza.
E. Persistir únicamente SHA-256 del token de alta entropía. No registrar tokens, hashes, URLs firmadas ni secretos.
F. Interfaz de storage inyectable que devuelve URL HTTPS temporal y vencimiento; proveedor por defecto no configurado. Fake exclusivamente en tests.
G. Sin cambiar verificaciones de Mercado Pago: sincronizar el derecho después del grant interno existente y sus snapshots verificados. Ningún endpoint crea grants.
H. Repositorios en memoria, acotados y reemplazables. Reiniciar pierde operaciones, derechos y tokens. No es persistencia de producción ni soporta múltiples instancias.

## Alcance y flujo

Base exacta: `eventdeck-support-api(3).zip`. Sitio `EventDeck-Web-Hito9.zip` intacto; tampoco se modificó `public/` del backend. Este trabajo prepara la infraestructura; no incorpora el archivo de 1,55 GB, ningún proveedor real ni UI de descarga. WCS-55735 sigue pendiente.

Flujo: webhook autenticado por TEST → consulta server-side y validaciones existentes → snapshot verificado → `grantVisualPackAccess` existente → sincronización del entitlement → solicitud explícita de token → validación del token/derecho/pago → firma en storage → HTTP 302 directo al storage.

`SupportService.refresh` conserva todas sus validaciones de importe, moneda, collector, `live_mode`, referencia, fecha y estado. La única conexión nueva es `syncVerifiedOperation` después del grant existente. Una aprobación válida puede crear el derecho aun sin storage; no habilita descargar mientras el proveedor esté sin configurar. Los servicios internos y repositorios son una frontera de confianza del servidor, nunca entradas públicas para crear grants.

## Modelo y persistencia

`Store` sigue siendo el repositorio de operaciones. No se lo renombró ni se cambió su funcionamiento. `EntitlementRepository` y `DownloadTokenRepository` separan los nuevos registros, con implementaciones en memoria de hasta 5000 entradas cada una y limpieza al vencer.

Entitlement: `id`, `operationId`, `paymentId`, `benefitId`, `createdAt`, `expiresAt`, `status` y `revision`. La unicidad es operación + beneficio. El paymentId de origen no se sustituye por otro pago de la operación. Los duplicados conservan identidad y fecha. El derecho vence como máximo junto con la operación (24 horas en el store actual).

Revocar un derecho es terminal en esta versión: no hay API de reactivación. Si el pago de origen deja de estar aprobado —incluido un reembolso parcial verificado—, se revoca. Incluso si otro pago de la operación sigue aprobado, no se reactiva automáticamente. Esto es deliberadamente conservador: el estado de pago histórico puede decir approved mientras `benefit.available` sea false. Una futura UI debe usar el estado del beneficio para descargas, no `accessGranted` solo.

Cada descarga vuelve a comprobar el snapshot y la operación: no basta con el token ni con `grantedAt`. La revocación interna se realiza con `EntitlementRepository.revoke(id)` o `DownloadTokenRepository.revoke(hash)`; no se añadió un endpoint administrativo.

Al reiniciar Render se pierden operaciones, status tokens, snapshots, grants, entitlements y download tokens. Los enlaces antiguos de la API dejan de funcionar. No hay recuperación automática ni garantías entre múltiples procesos/instancias. Antes de distribución real se necesitan persistencia durable y unicidad/transacciones atómicas que cubran pago, grant y entitlement; los repositorios en memoria solo son atómicos dentro de un proceso. No se implementó DB, outbox ni migraciones en este hito.

## Tokens y entrega

Se usan 32 bytes de `randomBytes`, codificados en hexadecimal (256 bits), distintos del status token. Solo el hash SHA-256 se guarda en el repositorio. No es un hash de contraseña: la resistencia viene de la alta entropía del token. La respuesta de emisión contiene el bearer token dentro de un path relativo y se devuelve únicamente al poseedor del status token existente. Quien posea cualquiera de estas capacidades debe tratarla como privada.

Vencimiento: mínimo de 10 minutos desde emisión, vencimiento de operación y entitlement. Máximo 3 intentos de resolución por token, reservados sin `await` antes de acceder al storage. Los fallos del proveedor consumen el intento reservado. Se puede pedir un token nuevo mientras el derecho siga vigente, sujeto a rate limiting. El límite no es un máximo vitalicio de descargas por derecho.

Emitir un token nuevo reemplaza el anterior. Revocación, rotación, cambio de revisión y vencimiento se comprueban también después del await de firma. HEAD devuelve 405 y no consume usos. Invalidaciones tienen respuesta genérica 404, sin revelar operaciones o pagos.

La URL del proveedor tiene como máximo 60 segundos, y nunca más que el token. El adaptador debe respetar ese vencimiento al firmar y devolver su vencimiento real. La API valida URL HTTPS, origen permitido exacto, ausencia de userinfo/fragmento y fecha dentro del límite. No descarga, no hace fetch al objeto, no proxy ni stream. Devuelve 302 con `Location`, cuerpo vacío, `Cache-Control: no-store` y `Referrer-Policy: no-referrer`.

Una URL ya emitida por object storage es otra capacidad: puede reutilizarse hasta su vencimiento. Revocar el token de EventDeck no puede retirar una URL firmada ya entregada ni detener una transferencia iniciada. Los 3 usos limitan resoluciones de la API, no el número de GETs al storage. Las reglas de vencimiento de transferencias y reanudaciones dependerán del proveedor elegido. El adaptador futuro debe contemplar descargas grandes y conexiones lentas sin pasar el archivo por Node.

## Endpoints

| Endpoint | Resultado |
| --- | --- |
| `GET /api/support/status/:publicToken` | Respuesta existente sin cambios: status y accessGranted. |
| `GET /api/support/status/:publicToken?include=benefit` | Agrega `{id:"visual-pack-v1", available, downloadReady}`. No emite token ni llama al storage. |
| `POST /api/support/download-token/:publicToken` | JSON vacío `{}` obligatorio; 201 con `{downloadPath, expiresAt}`. Requiere derecho vigente y storage configurado. |
| `GET /api/downloads/:token` | 302 al storage solo después de autorizar; 404 para token/derecho inválido; 503 si storage no disponible o respuesta inválida. |
| `HEAD /api/downloads/:token` | 405, sin consumo. |

`available` expresa derecho vigente; `downloadReady` requiere además proveedor configurado (no es un health check remoto). Con la configuración de esta entrega: un derecho válido da `available:true`, `downloadReady:false`; emitir token devuelve 503 `DOWNLOAD_UNAVAILABLE`. No hay URL ficticia en producción.

El POST de emisión hereda CORS restrictivo de `/api/support`, límite de JSON 1 KB y admite solo objeto vacío; no acepta benefitId, paymentId, estado, monto ni asset proporcionado por navegador. Rate limit: emisión 10/15 minutos por IP; resolución 60/minuto por IP. El GET de descarga es navegación estándar mediante token, no requiere JavaScript ni cookies.

## Storage desacoplado

`VisualPackStorage`: `configured`, `allowedOrigins` y `createDownloadUrl(benefitId, expiresAt)`. `UnconfiguredVisualPackStorage` es el único proveedor de aplicación incluido. El fake vive exclusivamente en `test/helpers/fake-storage.ts` y usa un dominio `.invalid`, sin red ni archivo.

Para integrar posteriormente: elegir proveedor, implementar un adaptador que mapee `visual-pack-v1` a un objeto privado fijo, configurar sus orígenes de confianza y credenciales solo en servidor e inyectarlo en `createApp`. El adaptador debe firmar descargas temporales, aplicar timeout en sus llamadas y fallar si no puede respetar el vencimiento solicitado. No aceptar claves de objeto/URLs del cliente. Evaluar persistencia, revocación y comportamiento de descarga grande antes de habilitarlo. No se instaló SDK ni se configuró R2/S3/Supabase.

## Mercado Pago y diagnósticos

No se modificaron algoritmo, manifest, secretos, Preferences, checkout, `notification_url`, eventos ni configuración de MP. TEST inválido sigue en HTTP 401 antes del lookup. PROD diagnostic match nunca autoriza. Redirect, payload aprobado del navegador e IPN/legacy rechazado no generan derechos. No existen endpoints de desarrollo para grants.

Cuando WCS-55735 se resuelva, la conexión al flujo verificado ya está implementada: no hace falta añadir un bypass ni aceptar otra firma. La comprobación externa futura deberá respetar autorización explícita para pruebas/configuración/despliegue. Esta entrega solo ejecutó fixtures locales, no pagos reales ni TEST.

Startup general: `server_started` con `code:"hito10-visual-pack-entitlement"`. Se agrega `webhook_diagnostics_version` con `code:"webhook-raw-url-diagnostic"`. Los headers y eventos diagnósticos del webhook permanecen idénticos; `MP_WEBHOOK_RAW_DIAGNOSTIC` sigue false por defecto. No se requieren variables nuevas.

El código de descarga no registra tokens, hashes, status tokens, URLs firmadas ni errores crudos del proveedor. Los diagnósticos RAW existentes conservan exactamente su opt-in y alcance. Las URLs con bearer tokens pueden aparecer en historial o access logs del proxy: antes de producción habrá que configurar su redacción en infraestructura. No se cambió Render en esta tarea.

## Verificación y archivos

Comandos: `npm ci --ignore-scripts`, `npm run build`, `npm run typecheck`, `npm test`.

Resultado: build OK, typecheck OK, **120/120 tests** (81 existentes intactos + 39 nuevos). Los nuevos cubren grant único, verificación/HMAC/PROD-only, negativos de autorización, hashing, rotación, expiración, revocación, concurrencia, límite de usos, proveedores inválidos, revocación durante firma, respuesta 302 vacía, CORS/rate limits, status mínimo y pérdida en reinicio. No usan MP ni storage reales. npm avisa que la configuración ambiental `http-proxy` se deprecará; no afecta los comandos ni proviene de dependencias agregadas.

Modificados: `src/app.ts` (inyección y endpoints), `src/services/support.service.ts` (sincronización después de verificación/grant), `src/server.ts` (identificador general y trazabilidad), `README.md` (estado y enlace a este documento).

Nuevos: `src/benefits/repositories.ts`, `src/benefits/storage.ts`, `src/benefits/visual-pack.service.ts`, `test/visual-pack.test.ts`, `test/visual-pack-http.test.ts`, `test/helpers/fake-storage.ts`, `HITO-10-VISUAL-PACK.md`.

Conservados byte a byte respecto de la base: tests originales, package.json/lockfile, frontend público, configuración, validadores y diagnósticos del webhook, gateway de MP y grant existente. El ZIP contiene fuentes completas, tests y documentación; excluye historial Git, node_modules y build regenerable. No contiene secretos ni archivo del pack. No se desplegó, no se realizaron pagos, no se modificaron Render ni Mercado Pago.

Referencias técnicas: [Node crypto.randomBytes](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback) y [comportamiento de URLs prefirmadas de S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html), esta última como ejemplo de limitaciones, sin seleccionar ese proveedor.
