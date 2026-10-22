# eventdeck-support-api

Backend **independiente y exclusivamente de prueba** para validar Mercado Pago Checkout Pro mediante Preferences API. No modifica EventDeck-Web-Hito9, la aplicación WPF ni implementa Hito 10. EventDeck continúa siendo gratuito. El monto aquí configurado no define un precio comercial definitivo.

La aprobación produce solamente el estado y log `VISUAL PACK ACCESS GRANTED`. No hay Visual Pack, Google Drive, descarga, correo, usuarios, login ni entrega de archivos. No se ha desplegado este proyecto ni realizado pagos reales.

## Arquitectura y requisitos

Node.js `>=22 <25` (verificado con **24.19.0**), TypeScript 5.9 y Express 5.3.0. Dependencias de ejecución: Express 5.3.0, Helmet 8.3.0 y express-rate-limit 8.7.1. Desarrollo: TypeScript, tsx, tipos de Node/Express. Versiones resueltas reproducibles en `package-lock.json`.

No se usa SDK de Mercado Pago ni SDK de navegador: se utiliza `fetch` nativo de Node con REST, timeout de 10 segundos y credencial en Authorization. Por ese motivo no se necesita Public Key. El navegador redirige al Checkout Pro alojado en Mercado Pago; EventDeck no recibe ni procesa números de tarjeta, vencimientos o CVV.

- `src/server.ts`: proceso HTTP, PORT y cierre ordenado.
- `src/app.ts`: composición HTTP, endpoints, páginas y headers.
- `src/config/env.ts`: validación de configuración y monto en centavos.
- `src/services/mercadopago.service.ts`: adapter REST y Preference.
- `src/services/webhook-signature.ts`: HMAC y comparación segura.
- `src/services/support.service.ts`: correlación, verificación y estados.
- `src/services/store.ts`: contrato Store y almacenamiento temporal en memoria.
- `src/services/access.service.ts`: concesión de prueba idempotente.
- `src/middleware/security.ts`: CORS, límites y errores.
- `src/utils/`: errores seguros y logger con campos permitidos.
- `public/`: HTML/CSS/JS mínimo de prueba, sin framework ni terceros.
- `test/support.test.ts`: pruebas HTTP y unitarias con Mercado Pago simulado.

## Instalación local

Descomprimí el ZIP y entrá en la carpeta `eventdeck-support-api`:

```sh
npm ci
cp .env.example .env
npm run typecheck
npm test
npm run build
npm start
```

En PowerShell, reemplazá `cp` por `Copy-Item .env.example .env` si lo necesitás. `npm install` también funciona; se recomienda `npm ci` para respetar el lockfile. Para desarrollo con recarga: `npm run dev`.

Abrí `http://localhost:3000` y `http://localhost:3000/health`. Con variables vacías el servicio arranca, health responde y el botón de checkout permanece deshabilitado. Health confirma que el proceso está vivo, **no que Mercado Pago esté configurado**. Valores presentes pero inválidos hacen fallar el arranque sin mostrar secretos. La ausencia de `.env` es válida; Render usa variables del proceso.

Los tests usan respuestas simuladas y secretos aleatorios efímeros. No contactan Mercado Pago ni cobran. Para un pago TEST completo se necesita un origen HTTPS público accesible por Mercado Pago; localhost no puede recibir sus webhooks. Podés usar un túnel HTTPS administrado por vos para pruebas locales, configurando ese origen en las variables y el panel. No se incluye ni se inicia un túnel automáticamente.

## Variables de entorno

`.env.example` contiene solo nombres con valores vacíos. Completá `.env` localmente o el panel Environment de Render. Nunca publiques esos valores ni subas `.env` a Git. No pegues credenciales en README, HTML, código ni comandos compartidos.

| Variable | Uso y configuración |
| --- | --- |
| `PORT` | Puerto de escucha. Default local 3000; en Render dejá el valor administrado por Render. Se escucha en `0.0.0.0`. |
| `NODE_ENV` | `development` local o `production` en Render. Production configura seguridad HTTP; **no activa pagos reales**. |
| `MP_ACCESS_TOKEN` | Access Token de **Pruebas** de tu aplicación EventDeck, Checkout Pro / Preferences, Argentina. Cargar solo como secreto. |
| `MP_WEBHOOK_SECRET` | Firma secreta proporcionada al configurar Webhooks en Mercado Pago. No es el Access Token ni la Public Key. |
| `BASE_URL` | Origen HTTPS público del backend, sin rutas, parámetros ni credenciales. |
| `FRONTEND_URL` | Para este proyecto, el mismo origen HTTPS que BASE_URL: las páginas de prueba se sirven desde este backend. Default BASE_URL. |
| `SUPPORT_AMOUNT` | Monto de prueba positivo en pesos, con punto decimal y hasta dos decimales. Por ejemplo `1000`; no es un precio definitivo. |
| `SUPPORT_CURRENCY` | `ARS`; se rechazan otras monedas. Default ARS. |
| `CORS_ORIGIN` | Origen exacto autorizado; en esta prueba debe coincidir con FRONTEND_URL. Default FRONTEND_URL; sin wildcard. |
| `TRUST_PROXY_HOPS` | `0` local; `1` para el despliegue detrás de un único proxy de Render. No agregar otros proxies sin revisar la cadena y los límites por IP. |

Para crear checkout hacen falta token, secret, monto y URLs HTTPS. HTTP localhost se admite en la configuración de desarrollo para health/UI, pero **no habilita Checkout Pro**. Las URLs deben ser orígenes, no incluir `/api` ni rutas. Para la interfaz incluida, mantené BASE_URL, FRONTEND_URL y CORS_ORIGIN iguales; no apuntes FRONTEND_URL a la landing aprobada porque no implementa estas páginas ni este JS.

La documentación actual indica que el prefijo del token de prueba puede variar por solución. Por eso no se deduce el ambiente a partir del prefijo. **Seleccioná siempre la credencial de Pruebas en el panel**. El proyecto únicamente redirige a `sandbox_init_point` en dominios sandbox oficiales, nunca hace fallback a `init_point`, y solo admite pagos verificados con `live_mode: false`. Si tu configuración no devuelve un sandbox válido, se rechaza la operación: revisá la aplicación/credencial y la documentación, no sustituyas por una URL productiva.

## Flujo y API de Mercado Pago

1. La página obtiene configuración pública mínima y envía `POST /api/support/create-checkout` con `{}`.
2. El servidor valida la configuración, fija monto/moneda y genera UUID interno y token público aleatorio de 256 bits. Solo guarda el hash SHA-256 del token.
3. Crea una Preference con `POST https://api.mercadopago.com/checkout/preferences` usando bearer token exclusivamente del servidor.
4. La Preference contiene un ítem: Apoyo a EventDeck, descripción Apoyo al desarrollo de EventDeck, cantidad 1, ARS y `SUPPORT_AMOUNT`. Usa UUID en `external_reference`, retornos controlados por backend, `auto_return: approved`, notification_url y vencimiento de 24 horas.
5. Guarda Preference ID y collector ID. Devuelve al navegador solo `checkoutUrl` sandbox y `publicToken`.
6. La persona paga con cuenta/tarjeta de prueba en Mercado Pago. Nunca envía datos de tarjeta a EventDeck.
7. El retorno muestra estado, pero **no acredita el pago**. En paralelo, un webhook firmado hace que el backend consulte `GET https://api.mercadopago.com/v1/payments/{id}`.
8. Solo una respuesta auténtica y consistente con `status: approved` permite la concesión de prueba.

No se reintenta automáticamente el POST de Preference ante timeout: podría haberse creado aunque no haya llegado la respuesta. Un nuevo clic genera un intento diferente. La idempotencia implementada corresponde al procesamiento del pago y concesión, no a repetir solicitudes de creación.

### Endpoints propios

| Método / ruta | Resultado |
| --- | --- |
| `GET /health` | `{ "status": "ok", "service": "eventdeck-support-api" }` |
| `GET /api/support/config` | `testMode`, monto, moneda y `ready`; sin secretos. |
| `POST /api/support/create-checkout` | JSON `{}` obligatorio; 201 con `checkoutUrl` y `publicToken`. Campos extras, monto, URLs o moneda enviados por el cliente se rechazan. |
| `POST /api/webhooks/mercadopago` | Notificación autenticada de tipo payment; 200 al terminar la verificación. |
| `GET /api/support/status/:publicToken` | Solo `{ "status": "approved", "accessGranted": true }` o el estado actual sin acceso. Token inexistente/vencido: 404. |
| `GET /` | Página de prueba. |
| `GET /support/success/:publicToken` | Página de comprobación, no acreditación. |
| `GET /support/pending/:publicToken` | Misma comprobación segura. |
| `GET /support/failure/:publicToken` | Misma comprobación segura. |

El token de estado es un secreto de capacidad: quien posee ese enlace puede consultar ese estado mínimo. No se permiten IDs secuenciales, búsqueda ni listado de operaciones. No se devuelve payer, correo, tarjeta, collector, monto del pago ni credenciales. No compartas el enlace y evitá guardar URLs completas en logs de infraestructura.

### Retorno y status

`auto_return: approved` facilita volver desde Mercado Pago, pero no reemplaza al webhook. `success`, `payment_id`, `collection_status` y otros query parameters no otorgan acceso. El JS elimina parámetros de retorno del historial y consulta status cada 4 segundos, hasta 30 veces; después permite actualizar manualmente.

Antes del webhook: `processing`. Pending/in_process/authorized: `pending` sin acceso. Rejected/cancelled/refunded/charged_back o estados desconocidos: sin acceso. La UI distingue procesando, pendiente, aprobado y no aprobado.

Status lee el último estado verificado en memoria; no busca pagos por datos del navegador ni realiza reconciliación automática. Si falta el webhook, se conserva processing. Si memoria expiró o se reinició, se muestra operación inexistente/vencida, nunca aprobación inventada.

## Firma y verificación del webhook

Configurar notificaciones **Pagos / payment** de Checkout Pro Preferences. No usar Orders API, IPN ni validar una notificación solo por su origen o su body.

El endpoint toma `data.id` del query (un único ID numérico), `x-request-id` y `ts`/`v1` de `x-signature`. Construye el manifiesto oficial:

```text
id:<data.id en minúsculas>;request-id:<x-request-id>;ts:<ts>;
```

Calcula HMAC-SHA256 con MP_WEBHOOK_SECRET y compara el digest hexadecimal con `v1` mediante `timingSafeEqual`. Exige todos los campos que usa este flujo, rechaza duplicados y formato inválido. Conserva el timestamp literal para calcular la firma; admite segundos o milisegundos. La firma **no autentica todo el JSON**, por eso el body nunca decide el estado del pago. Si contiene data.id, debe coincidir con el query.

No hay ventana de caducidad por reloj en esta prueba: se toleran reintentos diferidos del proveedor. Una firma repetida solo provoca una nueva consulta auténtica al pago; no puede duplicar la concesión. Existen límites de solicitudes y concurrencia. Para producción se deberá revisar una política de replay compatible con reintentos, persistencia y cola.

Después de validar la firma se consulta el pago por API y se comprueba:

- ID consultado coincide con el devuelto.
- external_reference coincide con una operación interna existente.
- collector_id coincide con la Preference de esa operación.
- live_mode es exactamente false.
- transaction_amount coincide en centavos con el monto guardado al crear el intento; moneda ARS coincide.
- date_last_updated es válida; no se aplican snapshots anteriores al ya guardado.
- El estado es approved y no existe monto reembolsado para conceder acceso.

Un pago ajeno se ignora sin acceso; discrepancias fallan cerradas. Un webhook válido no obtiene 200 hasta terminar la consulta/verificación; errores devuelven no-2xx para permitir reintentos. El timeout de API es 10 s, debajo de los 22 s documentados por Mercado Pago para responder. Un simulador con un ID ficticio puede validar conectividad/firma pero no genera un pago auténtico: un 502/404 aguas arriba no demuestra un pago aprobado. La prueba decisiva es un checkout TEST creado por este backend.

## Idempotencia, memoria y refunds

Las notificaciones simultáneas del mismo payment ID comparten una consulta. Las posteriores vuelven a consultar Mercado Pago para captar cambios. Se comparan fechas de actualización y un snapshot terminal con igual fecha no se reactiva con un approved contradictorio. `grantOnce` hace check y escritura sin await en un único proceso; `grantedAt` evita duplicar el log de concesión de una operación incluso con múltiples notificaciones.

`grantVisualPackAccess` comprueba un snapshot approved, registra identificador interno (también external_reference), payment ID, timestamp y estado. **No entrega nada**. Un refund incluso parcial, cancelación o contracargo actualizado desactiva el acceso público si no queda otro pago completo aprobado de la misma operación. grantedAt se conserva como historial. La futura revocación real se conectaría al cambio de estado en SupportService y al servicio de acceso, junto con persistencia transaccional.

La interfaz Store permite sustituir la memoria por PostgreSQL/SQLite/Supabase, pero no implementa todavía esa persistencia. Límites: 24 h por intento, 5000 operaciones, 50 pagos por operación y 100 verificaciones concurrentes. Una instancia/proceso solamente. Render puede reiniciar, redeployar o dormir: se pierde todo el estado y la idempotencia histórica. Los eventos de operaciones perdidas se ignoran. **ESTO NO ES APTO PARA PRODUCCIÓN**.

Cada pago debe cubrir el monto completo. Pagos divididos entre dos medios, conciliación de merchant_orders y reconciliación de eventos perdidos no están implementados; no uses esa modalidad en esta prueba. No se suman pagos parciales para conceder acceso.

## Seguridad y logs

CORS permite un origen exacto; sin wildcard ni cookies. Solicitudes sin Origin, como curl y servicios, pueden llegar: CORS no es autenticación ni evita abuso fuera del navegador. El webhook usa firma, no CORS. Rate limits por IP en memoria: creación 10/15 min, status 90/min y webhook 180/min. Respuesta al límite: 429. Revisar la IP real detrás del proxy antes de exponer ampliamente.

Helmet aplica CSP self, bloqueo de framing y demás headers; sin scripts inline/terceros, no-referrer y no-store. Body máximo 1 KB para checkout y 16 KB para webhook. Errores públicos seguros sin stack ni respuesta cruda del proveedor. El token y secret nunca se envían al frontend ni se registran.

Logs JSON: checkout_creation_started, preference_created, webhook_received, webhook_signature_valid/invalid, payment_query, payment_verified, payment_mismatch, payment_unrelated y VISUAL PACK ACCESS GRANTED. El logger acepta solo IDs, estado y códigos; operationId es external_reference. No registra cuerpos, headers, tokens públicos, credenciales ni datos personales de Mercado Pago. Los logs del hosting pueden tener otras reglas: no habilites captura de cuerpos/headers ni URLs sensibles.

## Despliegue manual en Render

Este ZIP no ejecuta un deploy. Los siguientes pasos son para que vos los realices:

1. Subí el proyecto a un repositorio independiente, sin .env. No lo mezcles con la web o WPF.
2. En Render creá un **Web Service**, runtime Node, conectado al repositorio. Root Directory debe ser la carpeta que contiene package.json (vacío si está en la raíz).
3. Configurá:

| Campo | Valor |
| --- | --- |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Instancias | Una sola, sin cluster/autoscaling en este prototipo. |
| Node | Rango engines >=22 <25; usar Node 24 compatible. |

4. En Environment configurá NODE_ENV=production, SUPPORT_CURRENCY=ARS, SUPPORT_AMOUNT con tu monto de prueba y TRUST_PROXY_HOPS=1 para un único proxy. MP_ACCESS_TOKEN se carga manualmente como secreto desde **Pruebas**. No necesitás Public Key.
5. Podés hacer el primer despliegue sin BASE_URL ni secret: health funciona pero checkout no. Obtené el origen HTTPS real de Render.
6. Establecé BASE_URL, FRONTEND_URL y CORS_ORIGIN con ese mismo origen. No se asume una URL pública en el código.
7. En Mercado Pago Developers abrí Tus integraciones → EventDeck → Webhooks. Configurá la URL de pruebas `https://TU-SERVICIO/api/webhooks/mercadopago`, sustituyendo TU-SERVICIO por el host real. Elegí el evento **Pagos** de Preferences. No actives pagos productivos. La Preference también incluye esta URL.
8. Guardá la configuración, obtené la firma secreta de Webhooks y cargala en MP_WEBHOOK_SECRET de Render. Si el panel todavía no muestra el secret, completá primero el alta de la URL/configuración; no inventes uno ni desactives la firma.
9. Guardá/redeployá y verificá /health y la página raíz. El monto debe coincidir y el botón quedar habilitado. Un redeploy borra operaciones previas: creá el intento después de completar todas las variables.
10. Hacé la prueba end-to-end descrita abajo. No hay que editar código ni configurar webhooks por cada intento.

Si usás un plan que duerme, despertá el servicio antes de probar. Cold starts y reinicios pueden demorar/perder estado. No dejes cobros reales habilitados en este prototipo.

## Prueba manual completa con Mercado Pago

Usá exclusivamente las cuentas y tarjetas provistas por Mercado Pago Developers para Argentina. Comprador distinto del vendedor. Abrí ventana incógnita para evitar sesión de tu cuenta real. Obtené usuario, contraseña y eventual código de validación en el panel de cuentas de prueba; no los guardes en el proyecto.

1. Abrí la página TEST de Render; comprobá el monto configurado.
2. Presioná APOYAR EVENTDECK. Confirmá que se abre el Checkout Pro sandbox oficial.
3. Iniciá sesión con el comprador de prueba e ingresá datos de tarjeta **solo en Mercado Pago**. Usá los datos actuales del panel/documentación oficial, no tarjetas reales.
4. Para aprobación utilizá el escenario documentado APRO. Para rechazo, OTHE. Para pendiente, CONT si el método de prueba elegido lo admite, o un medio offline de prueba admitido por el panel. No todos los métodos simulan todos los estados; no fuerces la aprobación cambiando URLs ni la firma.
5. Al retornar, la página puede decir PROCESANDO PAGO hasta que llegue el webhook. Revisá logs: firma válida → payment_query → payment_verified → VISUAL PACK ACCESS GRANTED solo en approved.
6. Confirmá que status retorna accessGranted true únicamente para approved. Rechazado/pendiente no deben registrar concesión.
7. Reenvío del mismo webhook desde herramientas de Mercado Pago, si están disponibles: puede volver a verificar pero no genera un segundo log de concesión.
8. Probá una URL success con parámetros que digan approved en un intento pendiente: debe seguir sin acceso. No compartas el token del enlace.
9. Si no vuelve automáticamente, usá el retorno que ofrece Checkout Pro; el retorno por sí mismo no acredita nada.

No se incluyen números de tarjeta ni credenciales. Para verificar fallos de firma, diferencias de monto, fraude en body, duplicados concurrentes y refunds sin depender del panel, ejecutá `npm test`.

### Diagnóstico

- Botón deshabilitado / 503: falta configuración o HTTPS; health no garantiza readiness.
- Error al crear Preference / 502: revisar credencial de Pruebas, aplicación Preferences Argentina, monto permitido y URL sandbox devuelta. Nunca cambiar por credenciales productivas para destrabar.
- 401 del webhook: comprobar secret de esa configuración, x-signature, x-request-id y query data.id; no desactivar validación.
- Processing persistente: comprobar entregas/reintentos del webhook, servicio despierto y ausencia de redeploy. El simulador no sustituye un pago real de prueba.
- 422: monto, moneda, collector, live_mode u otros datos verificados no coinciden. No conceder manualmente acceso.
- 404 en status: token inválido, vencido o memoria perdida. Crear un nuevo intento TEST.
- 429: esperar el período del límite y verificar configuración de proxy/IP.

## Verificaciones incluidas y alcance

`npm run build`, `npm run typecheck` y `npm test`. La suite cubre health sin secretos, monto/inputs, IDs aleatorios, Preference, status, retorno falsificado, pending/approved, firma inválida, idempotencia, cambios fuera de orden, refund parcial, pago ajeno, discrepancias, fallos del proveedor, CORS/headers, rate limit, expiración/memoria y adapter REST.

Las pruebas usan mocks: no certifican credenciales, configuración de tu aplicación, disponibilidad de sandbox, webhook público ni pago TEST real. Esa validación queda pendiente de tu despliegue manual. No se incluyeron credenciales reales, .env ni node_modules en la entrega.

## ANTES DE PRODUCCIÓN

- Sustituir memoria por persistencia durable con transacciones, restricciones únicas e idempotencia compartida; backups y restauración.
- Incorporar cola/reintentos y reconciliación de pagos/eventos perdidos; revisar políticas de expiración, replay, refunds, contracargos y pagos divididos si se admiten.
- Definir monto/modelo definitivo y revisar el tratamiento legal/contable del aporte.
- Revisar y habilitar explícitamente un flujo productivo, con credenciales productivas, dominio, webhook y secret correspondientes. No basta cambiar el token: esta versión solo acepta checkout sandbox y pagos live_mode false.
- Confirmar CORS exacto, proxy/IP real, límites distribuidos, monitoreo, alertas y redacción/retención de logs.
- Diseñar entrega segura del Visual Pack, autorización, expiración/revocación y límites de descarga; no publicar un enlace permanente de Drive.
- Resolver términos/licencia del Visual Pack y política de privacidad cuando corresponda.
- Ejecutar pruebas de integración y revisión de seguridad con la infraestructura real.

Ninguna de estas funciones productivas está implementada en esta entrega.

## Documentación oficial consultada

Consulta: **22 de octubre de 2026**, Checkout Pro **vía Preferences API**, Argentina. Se conserva ese flujo; no se migró a Orders API. Las instrucciones del panel pueden cambiar: verificar la documentación antes del despliegue.

- [Crear Preference (POST /checkout/preferences)](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro-preferences/create-preference/post)
- [Consultar pago (GET /v1/payments/{id})](https://www.mercadopago.com.ar/developers/es/reference/online-payments/checkout-pro-preferences/get-payment/get)
- [Notificaciones de pago](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/payment-notifications)
- [Firma HMAC y manifiesto](https://www.mercadopago.com.uy/developers/en/docs/checkout-pro-preferences/additional-settings/optional-notifications)
- [Credenciales y prefijos de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/additional-content/credentials)
- [URLs de retorno y auto_return](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/configure-back-urls)
- [Redirección externa](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/additional-settings/opening-schema)
- [Ambiente y cuentas de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/integration-test/introduction)
- [Compras y escenarios de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/integration-test/test-purchases)
- [Render: Node/Express](https://render.com/docs/deploy-node-express-app), [Web Services](https://render.com/docs/web-services), [versión de Node](https://render.com/docs/node-version).
