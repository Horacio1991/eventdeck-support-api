# Hito 11 — Cloudflare R2 para EventDeck Visual Pack

Base exacta: `eventdeck-support-api(4).zip`, Hito 10 aprobado. Esta entrega agrega el adaptador real y sus pruebas locales; no activa entregas, no sube el pack y no crea infraestructura. WCS-55735 sigue pendiente.

## Arquitectura

Se conserva `VisualPackStorage` y toda la autorización del Hito 10. `createApp` selecciona el proveedor una sola vez, desde la configuración validada:

- `disabled` → `UnconfiguredVisualPackStorage` existente.
- `r2` → `CloudflareR2VisualPackStorage` nuevo.

El flujo es: token válido + entitlement vigente + snapshot aprobado → `VisualPackService.resolve` → adaptador R2 → `getSignedUrl` de AWS SDK v3 → 302 con `Location` → descarga directa del cliente a R2. Node no recibe los bytes del archivo.

El adaptador construye un `GetObjectCommand` únicamente para bucket/key configurados en servidor. Usa región `auto`, endpoint explícito y `forcePathStyle:true`, por lo que el origen firmado coincide exactamente con el origen permitido. La firma es local, con credenciales explícitas; no usa descubrimiento de credenciales AWS, no llama a `client.send`, no hace HeadObject, no descarga el objeto. Su transporte SDK está bloqueado como defensa adicional frente a llamadas accidentales de red.

El seam `R2Presigner` permite inspeccionar comando y tiempos en tests. También se prueba el presigner real con identificadores sintéticos, sin red. No hay fake de R2 en código de producción.

## Variables de entorno

| Variable | Requisito y significado |
| --- | --- |
| `VISUAL_PACK_STORAGE_PROVIDER` | Ausente: `disabled`. Valores explícitos admitidos: `disabled` o `r2`. Vacío, typo u otro valor: error. |
| `R2_ENDPOINT` | Requerido en `r2`. Origen S3 API HTTPS de la cuenta, copiado de Cloudflare. |
| `R2_ACCESS_KEY_ID` | Requerido en `r2`. Access Key ID S3 de un token R2 de lectura, limitado al bucket. |
| `R2_SECRET_ACCESS_KEY` | Requerido en `r2`. Secret Access Key S3 correspondiente. Solo servidor. |
| `R2_BUCKET` | Requerido en `r2`. Nombre exacto del bucket privado. |
| `R2_VISUAL_PACK_OBJECT_KEY` | Requerido en `r2`. Key literal completa, por ejemplo `packs/v1/EventDeck-Visual-Pack-v1.zip`. No una URL. |

Decisión distinta a la propuesta: se usa `R2_ENDPOINT` en lugar de `R2_ACCOUNT_ID` para no mantener dos fuentes de verdad y permitir endpoints de jurisdicción. Se aceptan `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` y variantes `.eu`, `.us`, `.fedramp` documentadas; el ID debe tener 32 caracteres hexadecimales minúsculos. No se aceptan dominios públicos/custom, HTTP, puertos, userinfo, query ni rutas. Se permite `/` final y se normaliza al origen.

Bucket: 3–63 caracteres, minúsculas/dígitos/guiones y extremos alfanuméricos. Se rechazan espacios en extremos de las variables. Access Key ID: 16–128 caracteres alfanuméricos; Secret Access Key: 16–256 ASCII imprimibles sin espacios. Son validaciones de formato, no prueba remota de autenticidad.

Object key: hasta 1024 bytes UTF-8, relativa, sin segmentos vacíos, `.`/`..`, backslash ni caracteres de control. Se conservan literalmente mayúsculas, Unicode y espacios internos; el SDK realiza encoding. No pre-encodear la key: `%20` configurado significa los tres caracteres literales `%20`, no un espacio.

`.env.example` contiene `disabled` y campos R2 vacíos. Si está deshabilitado, los valores R2 sobrantes se ignoran. No se lee ninguna de estas variables desde frontend ni se devuelven en config/status.

## Arranque y fallo cerrado

Sin variables nuevas, el servidor inicia como antes. Con `disabled`, un entitlement puede existir y mostrar `available:true`, pero `downloadReady:false`; la emisión de token devuelve 503 `DOWNLOAD_UNAVAILABLE`, sin inventar URL. Un token desconocido sigue siendo 404.

Si se pide `r2` con configuración incompleta o formato inválido, `loadConfig` lanza `StorageConfigurationError` antes de escuchar HTTP. El proceso termina con código 1 y un mensaje que nombra solamente la variable a revisar. No imprime su valor, credenciales ni excepción del SDK. No hay fallback de R2 a disabled.

`configured:true` / `downloadReady:true` significa que existe un adaptador configurado, **no** que Cloudflare haya validado credenciales, permisos, bucket, privacidad u objeto. Firmar localmente no prueba que el objeto exista. Una clave con formato correcto pero revocada puede generar una URL que R2 luego rechace. Esas comprobaciones remotas quedan para la habilitación manual posterior, no para este arranque ni para estos tests.

Build general: `hito11-r2-visual-pack-storage`. El evento separado `webhook_diagnostics_version` y los diagnósticos existentes conservan `webhook-raw-url-diagnostic`.

## Expiración y archivo grande

Se mantiene el máximo de **60 segundos** del Hito 10, limitado también por el token. La firma usa segundos completos: signingDate se trunca hacia abajo y el TTL se calcula sin exceder el deadline solicitado. El resultado informa el vencimiento realmente firmado. Una ventana restante sin al menos un segundo representable se rechaza; nunca se redondea hacia arriba para extender el token.

Los 60 segundos son una ventana para iniciar/autenticar el GET, no un tiempo máximo para transferir 1,55 GB. Amazon S3 documenta que una descarga iniciada antes del vencimiento puede continuar después, pero reconectar/reanudar con una nueva solicitud después del vencimiento falla. R2 documenta compatibilidad SigV4 y acceso temporal por solicitud; su documentación consultada no ofrece una garantía específica equivalente sobre todas las transferencias largas. Por eso no se afirma haber comprobado una descarga real de R2 de 1,55 GB: esa prueba queda pendiente y debe incluir interrupción/reanudación. No hay evidencia que justifique ampliar ahora el TTL.

Si una nueva solicitud a R2 ocurre después de vencer la URL, se necesita otra resolución autorizada. Se conservan tokens de 10 minutos, hasta 3 resoluciones y emisión explícita de reemplazo. Una URL prefirmada es reutilizable hasta vencer: revocar el token de EventDeck no retira URLs ya entregadas ni cancela transferencias en curso. Reiniciar el backend tampoco invalida una firma R2 ya emitida.

## Nombre de descarga

El adaptador establece `ResponseContentDisposition` de GetObject como:

```text
attachment; filename="EventDeck-Visual-Pack-v1.zip"
```

Es una constante ASCII del servidor, sin entrada de usuario. El SDK la incluye como parámetro firmado `response-content-disposition`. No se concatena manualmente una URL ni se permite inyección de cabeceras.

La API S3 documenta este override. La tabla de compatibilidad R2 consultada no enumera individualmente todos los `response-*`; la verificación remota del header queda pendiente. Al subir manualmente el archivo, guardar también el mismo Content-Disposition como metadata del objeto (R2 documenta su soporte), y comprobar la respuesta real antes de habilitar entregas. No se añadió un fallback ni un proxy para resolver esta comprobación pendiente.

## Seguridad y precisión sobre credenciales

**La prohibición literal de que aparezca cualquier identificador de credencial en una respuesta no es compatible con una URL prefirmada S3.** SigV4 incluye obligatoriamente el Access Key ID dentro de `X-Amz-Credential`, además de una firma temporal. También serán visibles cuenta, bucket y key dentro del destino. No se puede ocultarlos manteniendo este protocolo de descarga directa; eliminar ese parámetro invalidaría la firma.

La Secret Access Key nunca aparece en la URL, el JSON, el body HTTP, los logs ni errores. No se serializa el objeto de credenciales ni se entrega un API token de Cloudflare. El Access Key ID aparece exclusivamente en el destino firmado autorizado como identificador público del protocolo, no en status/config/emisión de tokens ni logs. La URL completa sí es una capacidad sensible: no compartirla ni registrarla. Tests verifican esa distinción explícitamente.

El bucket debe permanecer privado: sin `r2.dev`, dominio público ni política que permita lectura anónima. El backend no verifica/cambia esa configuración remota. Las credenciales del backend serán Object Read only y limitadas al bucket. Las de carga manual serán separadas, con escritura y fuera de Render.

El cliente no elige bucket, key, beneficio, nombre ni TTL. `GET /api/downloads/:token` rechaza cualquier parámetro adicional con 400 y rutas extendidas con 404. La emisión conserva su body vacío. Tokens inválidos, vencidos, revocados o con derecho incorrecto no llegan al presigner. Una excepción del SDK se traduce a 503 sin `Location`, sin otro proveedor y sin devolver errores crudos.

Se conservan no-store, no-referrer, HEAD sin consumo, rate limits, CORS y comprobación posterior a la firma frente a revocación/rotación. No se tocó Mercado Pago/HMAC, grants ni repositorios. TEST inválido y PROD-only match siguen devolviendo 401 sin consultar el pago ni crear derechos.

## Procedimiento manual futuro — NO ejecutado

1. Crear un bucket en R2 desde el dashboard y mantenerlo privado. Registrar el nombre y endpoint S3, incluyendo jurisdicción si aplica. No activar r2.dev ni conectar dominio público.
2. Preparar localmente `EventDeck-Visual-Pack-v1.zip`. Validar integridad y tamaño. El repositorio y Render no deben contenerlo.
3. Crear credenciales R2 separadas para carga, limitadas al bucket con Object Read & Write; conservarlas localmente de forma segura. Para el backend, crear otro token Object Read only, limitado al mismo bucket, y guardar su Access Key ID y Secret Access Key.
4. Cargar desde la PC directamente a R2 con un cliente S3 compatible. Ejemplo con AWS CLI local: crear un perfil mediante `aws configure --profile eventdeck-r2-upload`, introducir las credenciales de **carga**, región `auto`, y usar el siguiente comando sustituyendo placeholders. No introducir credenciales en la línea de comando ni guardarlas en este proyecto.

```text
aws s3 cp "EventDeck-Visual-Pack-v1.zip" "s3://<BUCKET>/packs/v1/EventDeck-Visual-Pack-v1.zip" --endpoint-url "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" --profile eventdeck-r2-upload --content-type application/zip --content-disposition 'attachment; filename="EventDeck-Visual-Pack-v1.zip"'
```

5. Verificar objeto, tamaño/integridad y metadata con las herramientas de administración. Registrar la key exacta para `R2_VISUAL_PACK_OBJECT_KEY`. No asumir que el dashboard o el nombre local definieron el prefijo correcto.
6. Tras revisar este hito, configurar en Render las cinco variables R2 y `VISUAL_PACK_STORAGE_PROVIDER=r2` como configuración privada. El despliegue/reinicio se hará manualmente en una tarea posterior autorizada. No cambiar variables de Mercado Pago. Tener presente que reiniciar elimina el estado en memoria.
7. Antes de distribución, comprobar con un flujo autorizado: 302, GET directo R2, header attachment/nombre, rechazo sin firma, vencimiento y comportamiento de transferencia larga/reanudación. No pegar URLs firmadas en logs/tickets públicos. Una navegación normal a la descarga no exige JavaScript; si en el futuro se implementa fetch cross-origin, evaluar CORS específico sin hacerlo ahora.

No se agregó un endpoint para crear derechos de prueba ni un bypass para probar R2. Mientras WCS-55735 bloquee el flujo verificado, los tests internos permiten comprobar la integración; no habilitar grants por redirect, PROD ni firma inválida.

## Rollback

En una operación manual futura, volver a `VISUAL_PACK_STORAGE_PROVIDER=disabled` y reiniciar/desplegar mediante el proceso habitual. No hace falta borrar el bucket ni cambiar Mercado Pago. Esto detiene nuevas emisiones/resoluciones, pero las URLs previamente firmadas seguirán siendo utilizables hasta su vencimiento. Si hubiera una exposición de credenciales, su revocación en Cloudflare sería una acción separada autorizada. No se realizó aquí.

También puede volver al código Hito 10 si lo necesita; el estado in-memory se pierde en ambos casos. Persistencia durable, varias instancias, UI final, usuarios, emails y reconciliación de pagos continúan fuera de alcance.

## Dependencias y verificaciones

Dependencias directas nuevas (versiones exactas):

- `@aws-sdk/client-s3@3.1156.0`: S3Client y GetObjectCommand compatibles con R2.
- `@aws-sdk/s3-request-presigner@3.1156.0`: firma SigV4 local mantenida por AWS; evita implementar criptografía propia.

No se instaló el SDK monolítico `aws-sdk`, SDK de Cloudflare, uploader ni librería de base de datos. El lockfile agrega 27 paquetes y no cambia la versión de ninguna dependencia anterior. Ambas dependencias admiten la versión de Node del proyecto.

Ejecutar localmente: `npm ci --ignore-scripts`, `npm run build`, `npm run typecheck`, `npm test`, `npm audit`. No se necesitan variables R2 reales para estos comandos/tests.

Resultado al 23/10/2026: build OK, typecheck OK, **149/149 tests** (120 existentes sin modificar + 29 nuevos). Auditoría npm: **0 vulnerabilidades**, incluidas dependencias de desarrollo. Se incluye `AUDITORIA-HITO-11.json`. Aviso ambiental de npm sobre `http-proxy` deprecado, sin fallos de compilación ni de tests.

Los nuevos tests cubren configuración/arranque, disabled, endpoint seguro, bucket/key y encoding, presigning real offline, TTL y precisión de segundos, Content-Disposition, ausencia de secretos, errores del SDK, selección de proveedor, redirect vacío, rechazo de selección de objetos, todos los negativos de token/entitlement y HMAC/PROD-only. Ningún test hace una solicitud a Cloudflare.

Modificados: `.env.example`, `package.json`, `package-lock.json`, `src/config/env.ts`, `src/app.ts`, `src/server.ts`, `README.md`.

Nuevos: `src/config/storage-env.ts`, `src/benefits/r2-storage.ts`, `src/benefits/storage-factory.ts`, `test/r2-storage.test.ts`, `test/r2-http.test.ts`, `test/helpers/r2-fixture.ts`, `HITO-11-R2-STORAGE.md`, `AUDITORIA-HITO-11.json`.

Conservados: interfaz de storage, autorización/entitlements/tokens Hito 10, código Mercado Pago, diagnósticos, frontend y tests anteriores. No se configuró una cuenta, no se creó bucket, no se subieron archivos a R2, no se ejecutaron comandos contra Cloudflare, no se realizaron pagos, no se modificó Render y no se desplegó.

## Documentación oficial consultada

- [R2: URLs prefirmadas y SigV4](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [R2: AWS SDK v3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
- [R2: autenticación, permisos y endpoints](https://developers.cloudflare.com/r2/api/tokens/)
- [R2: compatibilidad S3 y metadata](https://developers.cloudflare.com/r2/api/s3/api/)
- [R2: crear buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [R2: acceso público](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [R2: carga de objetos](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [S3: expiración durante transferencias](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [S3 GetObject: Content-Disposition](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
