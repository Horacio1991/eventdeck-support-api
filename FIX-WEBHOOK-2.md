# FIX2 — diagnóstico de autenticación Payments

Base exacta: `eventdeck-support-api-webhook-fix(2).zip` (webhook-fix-1). Fecha: 22/10/2026. No se desplegó, no se usaron credenciales reales y no se cambió infraestructura externa.

## Resultado y límite de la evidencia

**No se puede afirmar todavía la causa criptográfica exacta del rechazo del pago real.** Los logs adjuntos no contienen los componentes necesarios para reproducir su firma ni distinguen fallos de parseo de un HMAC calculado que no coincide. Este FIX corrige la preservación del ID conforme a las fuentes oficiales actuales y elimina esa ambigüedad con diagnósticos seguros. No promete que un cambio de código haga validar el pago observado.

Lo demostrado por tus logs:

- Simulador 123456: firma válida y consulta que devuelve 404. El secret configurado valida ESA notificación.
- Payment 185544391474: ID numérico presente en query, tipo payment, headers presentes y rechazo 401 antes de consultar el pago.
- Otras solicitudes: sin data.id/type detectables en query. No se pueden llamar IPN con certeza porque los logs anteriores no registraban su forma. Ahora se clasifican como candidatas cuando hay topic/id o resource/topic.
- El simulador cierra la conexión a los 287 ms, antes del 404 del proveedor (~658 ms). Esto explica por qué ese intento no produjo webhook_acknowledged: no terminó de enviarse un ACK por esa conexión. No prueba quién la cerró y es un incidente distinto del 401 del pago. Este FIX no cambia ACK, cola ni procesamiento síncrono.

**Lowercase no explica la diferencia observada:** ambos IDs contienen solo dígitos, por lo que convertirlos a minúsculas deja exactamente los mismos bytes. No hay evidencia para sustituir el query por el body, probar múltiples manifests ni cambiar automáticamente el secret.

## Documentación oficial consultada

Consulta del 22/10/2026:

1. [Checkout Pro Preferences: notificaciones de pago](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/payment-notifications): Payments llega por HTTPS POST JSON, con data.id/type en query, además del body y los headers de firma. La clave pertenece a la aplicación configurada. La URL de notificación del recurso puede prevalecer sobre la del panel.
2. [SDK oficial Node: Webhooks](https://github.com/mercadopago/sdk-nodejs/blob/master/docs/webhooks.md): pasar data.id del query y los headers sin normalizarlos ni convertir arrays en strings.
3. [Releases del SDK oficial Node](https://github.com/mercadopago/sdk-nodejs/releases): 3.2.0 incorpora el cambio explícito de preservar el case de data.id, PR #439.
4. [SDK oficial PHP: Webhooks](https://mercadopago.github.io/sdk-php/docs/webhooks.html): también pide preservar los valores recibidos, sin trim/normalización adicional.
5. [Notificaciones y manifiesto](https://www.mercadopago.com.uy/developers/en/docs/checkout-pro-preferences/additional-settings/optional-notifications): HMAC-SHA256, orden id/request-id/ts, separadores y punto y coma final, comparación constante; pares ausentes omitidos en el constructor general.
6. [IPN oficial](https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/ipn): es un mecanismo distinto. La presencia de x-signature en IPN no implica que se pueda validar con el secret de Webhooks. No se implementa IPN como mecanismo alternativo de aprobación.

Hay páginas generales que todavía describen lowercase, mientras las guías y releases actuales del SDK oficial piden preservar el valor. Este FIX sigue las guías actuales del SDK. **En este endpoint exclusivamente Payments los IDs admitidos siguen siendo numéricos**, así que esa discrepancia documental no altera el ID del caso observado. No se instaló SDK ni dependencia nueva.

## Manifest antes y ahora

Antes:

```text
id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};
```

Ahora, función exportada y testeable `buildManifest`:

```text
id:${dataId};request-id:${requestId};ts:${ts};
```

- Fuente: un solo `req.query['data.id']` de tipo string. No body.data.id, body.id (ID de notificación), query.id legacy ni resource.
- Se utiliza el valor del query entregado por Express sin otra decodificación, trim, lowercase o conversión numérica. Ceros iniciales no se eliminan.
- request-id y timestamp se conservan. No se cambia case del request-id ni se convierten segundos/milisegundos.
- ts y v1 se extraen sin depender del orden y tolerando whitespace alrededor de delimitadores del header. Componentes duplicados, desconocidos o malformados se rechazan, como antes.
- El digest recibido debe ser hex válido de 32 bytes y se compara con timingSafeEqual. El secret no se registra ni modifica en este FIX.
- El constructor general omite pares ausentes según la especificación, pero **la política del endpoint no cambia: exige ID Payments numérico, request-id, ts y v1 válidos**. Un manifest incompleto no habilita consultar un pago.
- Se mantienen límites de formato/tamaño del validador anterior (incluidos request-id alfanumérico/guion/underscore y ts de 10–16 dígitos). Ahora, si alguno rechaza la forma real, se identifica su motivo en lugar de llamarlo simplemente firma inválida. No se ampliaron sin evidencia.
- No se intentan variants, múltiples secrets, lowercase alternativo ni fallback al body si HMAC falla.

## Nuevos diagnósticos seguros

Se conserva la instrumentación anterior. Después de webhook_handler_entered aparece **webhook_signature_components** con:

- traceId, paymentId numérico seguro, paymentIdSource, paymentIdLength y queryIdValid.
- bodyIdPresent y bodyIdMatchesQuery; sin registrar el body ni usarlo para autenticar.
- requestIdPresent/requestIdLength; timestampPresent/timestampLength; signatureVersionPresent/signatureLength.
- manifestVariant y manifestLength; nunca manifest completo, HMAC recibido/esperado o secret.
- eventType, bodyEventType y notificationShape como categorías acotadas.
- legacyQueryPresent/bodyLegacyPresent.
- claimedApplicationId, claimedUserId y claimedLiveMode únicamente si tienen tipos seguros. **Son datos no autenticados del body** hasta verificar firma; sirven para contrastar la aplicación/cuenta del panel, nunca para seleccionar secret ni decidir permisos.
- signatureCheck con el resultado preciso.

Códigos importantes:

| signatureCheck / código de rechazo | Qué significa |
| --- | --- |
| MATCH | HMAC coincide para los componentes elegidos. Además el endpoint exige ID Payments procesable. |
| HMAC_MISMATCH | Formato válido y HMAC calculado distinto. Revisar correspondencia de aplicación/secret y componentes entregados. No implica automáticamente secret incorrecto. |
| SIGNATURE_HEADER_FORMAT | Formato del header no admitido; también componentes extra desconocidos. |
| DUPLICATE_SIGNATURE_COMPONENT | ts o v1 repetido. No elegir arbitrariamente uno. |
| TIMESTAMP_FORMAT / DIGEST_FORMAT | Falta o formato inválido de ts/v1. |
| REQUEST_ID_FORMAT / MISSING_REQUEST_ID | Request-id no admitido o ausente. |
| MISSING_QUERY_DATA_ID | El validador no recibió un data.id único del query. |
| MISSING_OR_AMBIGUOUS_QUERY_ID | Rechazo de la ruta por ID ausente, array u otro tipo. |
| INVALID_PAYMENT_ID | ID no numérico o fuera del límite del endpoint. |

Una categoría no constituye autenticación. `payments_webhook` describe la forma del query. `legacy_ipn_candidate` y `body_only_candidate` describen solicitudes que no cumplen el contrato de este endpoint: sin ID firmado del query se rechazan con 401, no se consulta Mercado Pago ni se otorga acceso. No se transforma una IPN en webhook. Para un evento no-payment con firma válida e ID admitido, se conserva ACK 200 sin consulta, ahora con webhook_event_ignored. Una firma inválida nunca recibe ese tratamiento de evento autenticado.

El log server_started ahora tiene code=webhook-fix-2. Se conserva X-EventDeck-Webhook-Fix: webhook-fix-1 para identificar la instrumentación anterior, y se agrega **X-EventDeck-Signature-Fix: webhook-fix-2**. Los logs de ingreso anteriores conservan code=webhook-fix-1; el marcador nuevo identifica esta revisión sin alterar los 28 tests recibidos.

## Secret, cuenta y configuración

**No cambiar MP_WEBHOOK_SECRET a ciegas.** La documentación consultada describe una clave exclusiva de la aplicación; no establece dos algoritmos HMAC distintos para simulador y payment TEST real ni justifica probar claves alternativas.

Que el simulador valide demuestra que su firma coincide con la clave cargada. No demuestra que el Access Token que creó la Preference pertenezca a esa misma aplicación/configuración de Webhooks. Esa correspondencia debe comprobarse privadamente en el panel; no se puede deducir del prefijo del token ni de los logs actuales.

Si el próximo request real arroja HMAC_MISMATCH, revisar en Mercado Pago que la aplicación asociada al Access Token de pruebas sea la misma donde se configuró la URL y se obtuvo el secret. Contrastar application_id/user_id cuando estén presentes con los datos del panel, teniendo presente que el body aún no está autenticado. Si la correspondencia es correcta y el formato es válido, corresponde consultar el historial de entregas/soporte de Mercado Pago con hora y traceId; no desactivar HMAC.

No hay variables nuevas ni cambios automáticos de Render/Mercado Pago. URL idéntica. Mantener credenciales de prueba; no activar pagos productivos ni rotar secrets como experimento. No se cambia notification_url ni se agregan parámetros para alterar el mecanismo de notificaciones. No se necesita volver a diagnosticar DNS, CORS, ruta o connectivity, que tus logs ya comprobaron.

## Archivos del FIX2

Modificados:

- `src/services/webhook-signature.ts`: buildManifest, preservación exacta del ID y diagnóstico de validación; wrapper validSignature conservado.
- `src/app.ts`: extracción/clasificación, log de componentes, motivos de rechazo y log de evento ignorado.
- `src/utils/logger.ts`: allowlist explícita de campos seguros.
- `src/middleware/webhook-diagnostics.ts`: header adicional del FIX2; mantiene la instrumentación anterior.
- `src/server.ts`: marcador de versión del FIX2.
- `README.md`, `VERIFICACION.md`: alcance y resultado actualizado.

Agregados:

- `src/services/webhook-input.ts`: fuente oficial del ID y categorías diagnósticas.
- `test/signature-fix2.test.ts`: 16 tests nuevos.
- `FIX-WEBHOOK-2.md`: este documento.

Sin cambios: 28 tests originales (archivo idéntico), Preference/adapter de Mercado Pago, monto, external_reference/UUID, tokens, store, grants/idempotencia, reglas de verificación server-side, configuración/env, frontend/result, CORS/rate limit, package.json y lockfile. FIX-WEBHOOK.md se mantiene como registro de la revisión anterior; para autenticación actual prevalece este documento.

## Tests y limitaciones

**44 tests: 28 anteriores + 16 nuevos, todos aprobados. Build y typecheck correctos.**

Los nuevos tests cubren orden/separadores/punto y coma, ejemplos con forma del simulador y Payments, fuente query, preservación de case/cero inicial, orden/whitespace del header, errores de parseo, componentes ausentes, secret incorrecto, ausencia de fallback, clasificación legacy/body-only, approved + duplicados + status, HMAC inválido sin lookup, 404 sin acceso, body contradictorio y otros tópicos.

Las firmas se generan con secretos efímeros de prueba. El test con ID 185544391474 reproduce **la forma** observada, no la firma real rechazada: no se dispone de sus valores y no se inventa un fixture supuestamente capturado. Los tests prueban la implementación, no certifican que la configuración real ya coincida.

## Procedimiento exacto posterior al deploy manual

1. Subir esta revisión sin .env y desplegar con los comandos existentes. Confirmar server_started code=webhook-fix-2. No cambiar variables.
2. Opcional: repetir una sola simulación 123456 para comparar webhook_signature_components del simulador. Debe MATCH si conserva los componentes válidos. Un 404 del lookup sigue sin conceder acceso; si el cliente cierra antes, no esperar ACK recibido.
3. Crear **una Preference nueva** desde la página TEST, completar **un pago TEST real** con la cuenta compradora y mantener el proceso sin reinicios. La memoria de intentos previos al deploy no existe.
4. En logs, buscar webhook_signature_components y comparar con el simulador. Primero revisar paymentIdSource=query, queryIdValid=true, manifestVariant=query-id_request-id_ts_exact-v2 y signatureCheck.
5. Si MATCH: esperar webhook_signature_valid → webhook_payment_lookup_started → webhook_payment_verified con approved → VISUAL PACK ACCESS GRANTED → webhook_acknowledged (si la conexión sigue abierta).
6. Presionar Consultar estado. Debe reflejar aprobado solamente después de la verificación completa del backend. No se cambió el botón ni el redirect.
7. Si 401: revisar el código específico. Si es de formato, enviar únicamente las líneas diagnósticas sanitizadas para determinar el ajuste necesario. Si es HMAC_MISMATCH, comprobar la correspondencia privada aplicación/credencial/configuración indicada arriba. No enviar secretos, token, headers completos ni firmas.
8. Para solicitudes legacy_ipn_candidate/body_only_candidate: no esperar aprobación; revisar los envíos Payments con ID en query. Si no existen envíos procesables, revisar la configuración de eventos del panel sin transformar IPN en un bypass.

Este FIX2 se detiene aquí. No implementa Hito 10, entrega de Visual Pack ni persistencia productiva.
