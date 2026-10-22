# FIX4 — Diagnóstico de headers RAW

Build: `webhook-raw-header-diagnostic`.
Base exacta: `eventdeck-support-api-hmac-dual-diagnostic.zip` (52 tests).

## Qué se investiga

La prueba comunicada para payment 185567845436 produjo false/false con el mismo manifest. Eso NO demuestra por sí solo que Render reescriba headers, ni excluye una clave/configuración incorrecta. FIX4 observa el límite Node/Express y los valores realmente usados; no cambia el algoritmo ni prueba nuevos manifests.

No se recuperan valores históricos. Hace falta una entrega recibida después de instalar este build, ya sea una notificación nueva o un reintento. No se realizaron pagos ni despliegues durante este trabajo.

## Captura y cadena de middleware

server.ts carga configuración y hace createApp(config).listen(). No hay middleware anterior propio ni APM implementado en este proyecto.

En app.ts, el primer middleware propio para /api/webhooks es webhookDiagnostics. Su PRIMERA instrucción ahora copia exclusivamente las ocurrencias x-request-id y x-signature desde req.rawHeaders y sus representaciones en req.headers y req.get(). La copia sucede antes de randomUUID, logger, headers de respuesta, Helmet, rate limiter y express.json. No copia Authorization, Cookie, body ni headers arbitrarios. Se conserva en memoria solo durante la solicitud.

El route handler recibe una observación del MISMO validador normal: requestId y signature de entrada, ts/v1 extraídos y, cuando existe, el manifest original. No se reconstruye un segundo manifest para diagnosticar. Si parser/limiter impide ejecutar el handler, finish registra la captura inicial con manifestBuilt=false y manifestExact=null. Solicitudes cortadas sin finish o rechazadas por Node/proxy antes de Express no garantizan este evento.

Revisión de código:
- No hay asignaciones propias que reescriban req.headers x-request-id/x-signature.
- req.get() de Express instalado consulta req.headers con nombre en minúsculas; no genera un request-id.
- Helmet configura headers de RESPUESTA; no reescribe estos headers entrantes.
- express-rate-limit usa IP/headers de proxy para su control y añade headers de respuesta; no reescribe x-request-id/x-signature en el código instalado revisado.
- express.json procesa el body; no construye el manifest.
- El logger usa una lista cerrada y no modifica el request.
- traceId se genera con randomUUID y se agrega a logs y X-EventDeck-Trace-Id de RESPUESTA. No se asigna a req.headers ni se usa como request-id del HMAC.

## Límite RAW y Render

req.rawHeaders es RAW respecto de la representación de headers que expone Node: preserva ocurrencias separadas y permite contar duplicados. NO representa los bytes originales enviados por Mercado Pago antes de TLS/proxy/parser HTTP.

Las pruebas HTTP locales con Node 24.19.0 confirman que:
- headers x-request-id/x-signature duplicados aparecen separados en rawHeaders;
- req.headers/req.get los combinan con coma y espacio;
- espacios/tab exteriores enviados en la línea HTTP pueden haber sido eliminados por el parser antes de aparecer en rawHeaders.

Por tanto, rawEqualsExpress=true prueba igualdad dentro de ese límite; no demuestra que Render haya preservado el valor de extremo a extremo. Desde Node no podemos observar el valor recibido por el edge de Render antes del proxy, su TLS ni los valores usados por Mercado Pago al firmar. Para demostrar alteración anterior hace falta comparar esta captura con evidencia del emisor/proxy del MISMO intento. No atribuimos a Render una reescritura sin esa comparación.

Fuentes oficiales y código instalado revisado:
- https://nodejs.org/api/http.html#messagerawheaders
- https://nodejs.org/api/http.html#messageheaders
- node_modules/express/lib/request.js
- node_modules/helmet/index.cjs
- node_modules/express-rate-limit/dist/index.cjs

## Parser existente: qué transforma y qué no

Se conserva exactamente la regex y la política anteriores:

`/^\s*(ts|v1)\s*=\s*([^\s,]+)\s*$/`

El parser separa componentes por coma y acepta whitespace delimitador alrededor de nombre, = y valor; captura el valor sin ese whitespace. No usa Number(ts), date_created ni timestamp convertido. Conserva ts como string. Rechaza duplicados y componentes desconocidos.

Para el diagnóstico, ts RAW/v1 RAW significan el substring después del primer = hasta la próxima coma, INCLUYENDO espacios exteriores. Su extracción sirve únicamente para contar/comparar; nunca alimenta autorización. Así, con `ts= 1792684550 ` el rawTsLength es 12, parsedTsLength es 10 y rawTsEqualsManifestTs=false. Eso demuestra el tratamiento de whitespace del parser actual, no necesariamente un defecto de firma.

El request-id no se recorta: si el string usado contiene espacios/coma falla su whitelist y no se construye manifest. v1 se valida como 64 caracteres hex y se convierte mediante Buffer.from(v1,'hex') para comparación timingSafeEqual. No se modifica el HMAC, encoding UTF-8 ni buildManifest.

## Activación temporal

Valor por defecto y .env.example:

```text
MP_WEBHOOK_RAW_DIAGNOSTIC=false
```

Solo el string literal `true` activa la exposición. Ausente, vacío, false, TRUE, 1 o espacios alrededor NO la activan. La variable no es necesaria para iniciar.

Procedimiento manual para UNA prueba:
1. Cuando decidas instalar este build, conservar las claves, checkout y configuración Mercado Pago actuales.
2. Activar temporalmente MP_WEBHOOK_RAW_DIAGNOSTIC=true en Render y confirmar server_started code=webhook-raw-header-diagnostic. Esta entrega NO realizó esos pasos.
3. Recibir una única prueba sandbox controlada o un reintento identificable; no mezclar headers de distintas entregas del mismo payment.
4. Buscar webhook_raw_header_diagnostic. Correlacionar mediante traceId con webhook_signature_components, webhook_dual_secret_diagnostic y webhook_response_sent.
5. Guardar privadamente la línea JSON completa necesaria para soporte. JSON escapa tabulaciones/comillas; para recuperar caracteres exactos se debe interpretar JSON, no copiar sus secuencias escapadas como texto literal. No hacer trim del manifest.
6. Volver inmediatamente MP_WEBHOOK_RAW_DIAGNOSTIC a false (y aplicar el reinicio/deploy que requiera Render). Confirmar rawDiagnosticEnabled=false y ausencia de los tres campos RAW en una solicitud posterior. Desactivar no borra logs históricos ya retenidos: manejar esa captura como evidencia privada de autenticación.
7. Entregar a soporte SOLO la evidencia de ese intento por su canal privado. No agregar secretos ni Access Tokens. No repetir pagos sin revisar primero el resultado.

## Evento y datos

Evento exacto: `webhook_raw_header_diagnostic`.

Siempre contiene métricas y booleanos, tanto ON como OFF:
- rawRequestIdCount, rawRequestIdLengths, expressRequestIdLength, manifestRequestIdLength.
- rawEqualsExpress, rawEqualsManifest, nodeRequestIdEqualsExpress, nodeRequestIdIsArray.
- requestIdCombined, requestIdHasLeadingWhitespace, requestIdHasTrailingWhitespace, requestIdContainsComma, expressRequestIdContainsComma, expressRequestIdEqualsValidator.
- rawSignatureCount, rawSignatureLengths, expressSignatureLength, validatorSignatureLength, expressSignatureEqualsValidator.
- rawSignatureEqualsExpress, nodeSignatureEqualsExpress, nodeSignatureIsArray, signatureCombined.
- signatureContainsComma, signatureContainsWhitespace, tsComponentCount, v1ComponentCount.
- rawTsLength/rawTsLengths, parsedTsLength, rawTsEqualsManifestTs.
- rawV1Length/rawV1Lengths, parsedV1Length, rawV1EqualsComparedV1, rawV1HasUnexpectedCharacters.
- manifestBuilt, signatureCompared, rawDiagnosticEnabled; time y traceId del logger.

Longitudes de headers/substrings: longitud de string JavaScript; en estos campos ASCII equivale a bytes. manifestLength en el evento de firma existente usa bytes UTF-8.

Si hay cero o más de una ocurrencia, una igualdad singular RAW se registra null (ambigua/no aplicable), no se elige silenciosamente la primera. rawTsLengths/rawV1Lengths conservan las longitudes de todas las ocurrencias. Sin manifest o sin comparación, las igualdades correspondientes son null. requestIdCombined/signatureCombined solo son true si había múltiples ocurrencias y el valor Express coincide exactamente con su unión mediante coma-espacio.

ON agrega SOLAMENTE estos tres campos con valores originales:
- rawRequestIdValues: array de cada ocurrencia de x-request-id, sin deduplicar ni recortar.
- rawSignatureValues: array de cada ocurrencia de x-signature, sin deduplicar ni recortar.
- manifestExact: string exacto utilizado, o null si no se construyó.

No se añaden campos separados con ts/v1, pues los substrings exactos están dentro de rawSignatureValues. El logger aplica además una whitelist: esos tres campos solo salen en este evento con rawDiagnosticEnabled=true.

Jamás se leen para este log las variables secret/token ni se incluyen HMAC calculados, Authorization, cookies, Public Key o body. Por autorización expresa, ON sí contiene la FIRMA RECIBIDA dentro de x-signature; no confundirla con un HMAC calculado localmente. La captura es de campos entrantes, por lo que un remitente podría escribir texto arbitrario dentro de ellos: el alcance seguro es la selección estricta de los dos headers, no una garantía de reconocer el significado de cualquier texto recibido.

## Cómo interpretar la siguiente prueba

- rawRequestIdCount=1, rawEqualsExpress=true, rawEqualsManifest=true: mismo request-id visible en Node, Express y manifest.
- rawRequestIdCount>1: headers duplicados llegan a Node. Si requestIdCombined=true, la representación combinada es observable; no se intenta validar cada variante.
- rawEqualsExpress=false: diferencia entre captura RAW única y representación Express inicial.
- expressRequestIdEqualsValidator=false o expressSignatureEqualsValidator=false: cambio entre la captura inicial y entrada al validador.
- rawTsEqualsManifestTs=false/rawV1EqualsComparedV1=false con longitudes distintas: inspeccionar whitespace/substrings capturados; no cambiar el algoritmo automáticamente.
- manifestBuilt=false: hubo un rechazo anterior a su construcción. manifestExact=null es correcto; no inventar un manifest para soporte.
- Todas las igualdades true y dual false/false: no hay evidencia de transformación local en esos valores. Sigue pendiente contrastar emisor/proxy/configuración de claves; no identifica automáticamente al responsable.

## Seguridad y autorización intactas

TEST inválido continúa 401 sin GET payment ni acceso, incluso si PROD coincide. PROD es diagnóstico solamente. No se prueban manifests alternativos. El callback de observación no devuelve una decisión de autorización. La firma normal válida continúa los controles server-side existentes. Checkout/Preferences/notification_url/back_urls/importe/tokens/idempotencia no cambiaron.

## Cambios y validaciones

Modificados: .env.example; src/config/env.ts; src/services/webhook-signature.ts (observación del cálculo existente + build identifier); src/middleware/webhook-diagnostics.ts (captura inicial y emisión si no llega al handler); src/app.ts (conexión con el observador); src/utils/logger.ts (whitelist diagnóstica); test/support.test.ts (solo dos expectativas del build identifier).

Nuevos: src/services/webhook-raw-diagnostic.ts; test/raw-headers.test.ts; DIAGNOSTICO-RAW-HEADERS.md.

server.ts no requiere modificación porque utiliza el identificador compartido. Los 52 casos previos se mantienen; el identificador de build se actualiza donde corresponde. Los documentos anteriores quedan como historial y sus identificadores corresponden a esos builds.

Tests nuevos: 18. Incluyen los 15 escenarios pedidos y pruebas HTTP reales locales de duplicados, recorte del parser Node y rechazo JSON antes del handler. Los tests no llaman Mercado Pago: gateway simulado, claves sintéticas. Resultado: npm run build OK; npm run typecheck OK; npm test 70/70 PASS (52 previos + 18 nuevos), 0 fallos. Node local 24.19.0. Único warning de npm: configuración ambiental http-proxy desconocida.

Sin nuevas dependencias. Sin despliegue, cambios externos, pagos, Hito 10 o Visual Pack.
