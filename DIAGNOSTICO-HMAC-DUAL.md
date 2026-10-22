# Diagnóstico HMAC dual — EventDeck Support API

Base: proyecto entregado con DIAGNOSTICO-WEBHOOK-3.md. Esta entrega es una prueba diagnóstica, no un arreglo del webhook ni una nueva versión funcional de EventDeck. Los documentos FIX/DIAGNOSTICO anteriores se conservan como historial; este documento describe el build actual.

## Objetivo y garantía

Comparar la misma notificación contra dos claves sin aceptar automáticamente ninguna clave alternativa. El parser se ejecuta una vez, buildManifest se llama una vez y ambas comparaciones reutilizan el mismo string UTF-8 y el mismo v1 decodificado. Se utiliza HMAC-SHA256 y timingSafeEqual.

La propiedad valid procede EXCLUSIVAMENTE de MP_WEBHOOK_SECRET. La comparación productiva solo genera telemetría. Si únicamente coincide PROD, el flujo normal responde HTTP 401 INVALID_SIGNATURE, sin consultar el payment ni conceder acceso. Si coincide la clave normal, continúan todas las validaciones posteriores originales; una firma válida sola nunca concede acceso.

No cambiaron Preference, sandbox_init_point, notification_url, back_urls, monto, external_reference, status token, consulta de payment, reglas approved/live_mode, idempotencia, frontend o dependencias.

## Variables

- MP_WEBHOOK_SECRET: clave normal existente, actualmente copiada del modo prueba. Se denomina testSecretMatch por esa configuración manual, NO porque el código pueda detectar su origen.
- MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC: nueva, opcional. Cargar manualmente en Render la clave de Webhooks → Modo productivo de la aplicación correspondiente. No es Access Token ni Public Key. No tiene valor real en archivos ni en el ZIP.

Ambas se leen con trim exterior, igual que la configuración normal existente. La nueva variable no participa en ready(), ni es necesaria para startup. Si está ausente o vacía: productionSecretConfigured=false y productionSecretMatch=null. La clave normal y MP_ACCESS_TOKEN siguen siendo requeridos por el endpoint como antes; esta comparación no permite suplirlos.

## Por qué hace falta una entrega nueva

Los logs históricos no conservan x-request-id/ts/v1 completos. No se puede reconstruir su HMAC. La comparación se realizará en memoria durante la próxima entrega recibida, sin persistir secretos, manifest, headers completos ni hashes calculados. Puede ser una entrega nueva o un reintento recibido después del deploy; los resultados corresponden a esa entrega concreta y a las claves entonces cargadas.

## Procedimiento manual para una prueba

1. Desplegar este ZIP por el procedimiento habitual, cuando decidas hacerlo. Esta tarea NO realizó despliegues.
2. Mantener MP_WEBHOOK_SECRET y MP_ACCESS_TOKEN actuales. Agregar únicamente MP_WEBHOOK_SECRET_PRODUCTION_DIAGNOSTIC en Render con la clave indicada arriba; nunca pegar claves en chat, comandos o repositorio.
3. Confirmar server_started con code webhook-hmac-dual-diagnostic. Ingreso y los dos headers diagnósticos también identifican este build.
4. Realizar UNA operación Checkout Pro sandbox controlada y esperar su notificación. No usar el simulador para concluir el contexto de firma de un checkout real. No se realizó ningún pago durante el desarrollo de esta entrega.
5. Buscar webhook_dual_secret_diagnostic y correlacionar paymentId y traceId con webhook_signature_components, webhook_signature_invalid/valid y webhook_response_sent/acknowledged.
6. Conservar solo el registro diagnóstico no sensible y el estado HTTP para el análisis. No repetir pagos antes de interpretar ese resultado.
7. Tras obtener la evidencia, retirar la variable productiva diagnóstica de Render. Esto desactiva la segunda comparación, sin alterar la validación normal. No reemplazar automáticamente la clave normal según el resultado.

No es necesario cambiar la URL de Mercado Pago ni seleccionar otro evento. No modificar Pagos (legacy) para esta prueba.

## Log esperado

Ejemplo ilustrativo parcial, no resultado observado de Mercado Pago:

```json
{
  "event": "webhook_dual_secret_diagnostic",
  "paymentId": "123456",
  "testSecretConfigured": true,
  "productionSecretConfigured": true,
  "testSecretMatch": false,
  "productionSecretMatch": true,
  "sameManifestUsed": true,
  "manifestVariant": "query-id_request-id_ts_exact-v2"
}
```

El registro también incluye time, traceId, notificationShape y manifestLength. No incluye las claves, Access Token, Public Key, x-signature, x-request-id completo, ts completo, v1 ni hashes calculados.

Si no hay datos válidos suficientes para construir el manifest (por ejemplo legacy/IPN sin data.id, firma malformada o duplicada), NO se emite este evento dual. Se conserva el motivo en webhook_signature_components. Un error de formato no debe confundirse con false/false tras una comparación criptográfica. Si un middleware rechaza antes, continúan los logs de ingreso existentes.

## Interpretación de resultados

| TEST | PROD | Interpretación | Flujo normal |
|---|---|---|---|
| true | false | La firma coincide con MP_WEBHOOK_SECRET, configurado manualmente como TEST. | Firma válida; continúa verificaciones habituales. |
| false | true | La misma firma coincide con la clave cargada como productiva. Evidencia directa para investigar el contexto firmante de una entrega sandbox. | 401, cero consultas de payment, cero acceso. |
| false | false | Ninguna de las claves actuales valida los valores recibidos. Volver a soporte con la evidencia. Revisar aplicación, configuración/rotación o posibles diferencias de valores; no demuestra por sí solo que exista una tercera clave. | 401, cero consultas de payment, cero acceso. |
| true | true | Ambas claves validan. Normalmente significa valores iguales o claves HMAC equivalentes; no permite distinguir modo. Una colisión con claves independientes sería extraordinariamente improbable. | Firma normal válida; continúan verificaciones habituales. |
| true/false | null | Clave productiva diagnóstica no configurada; no fue comparada. | Comportamiento normal intacto. |

Si testSecretMatch=true y en el MISMO trace aparece HMAC_MISMATCH, habría una inconsistencia interna: ambos se derivan de la misma variable valid. No confundirlo con un rechazo por payment ID inválido, body inconsistente, recurso ajeno, modo live, importe, estado o fallo upstream. Esos controles siguen siendo independientes y necesarios.

Un PROD_MATCH demuestra correspondencia con el valor configurado, no certifica por sí solo el nombre del modo/cuenta del proveedor. Esa identificación depende de haber copiado la clave de la configuración correcta. No utilizar live_mode del body para escoger clave.

## Archivos modificados

- .env.example: nombre de variable opcional sin valor.
- src/config/env.ts: lectura de variable diagnóstica opcional.
- src/services/webhook-signature.ts: segundo HMAC sobre el mismo manifest/v1; valid sigue siendo exclusivamente normal; identificación del build y corrección de comentario descriptivo.
- src/app.ts: pasar clave diagnóstica y registrar resultado seguro antes del rechazo normal.
- src/utils/logger.ts: ampliar lista cerrada con cinco campos diagnósticos.
- src/middleware/webhook-diagnostics.ts: unificar marcador de build, eliminando fix1 residual en runtime.
- test/support.test.ts: actualizar únicamente dos expectativas del identificador de build. Se conservan los casos y demás aserciones.
- test/hmac-dual.test.ts: ocho tests nuevos.
- DIAGNOSTICO-HMAC-DUAL.md: esta guía.

src/server.ts ya utiliza el identificador compartido: no fue necesario modificarlo. package.json y package-lock.json permanecen idénticos a la base. Documentación histórica anterior sin cambios.

## Verificaciones

- npm run build: OK.
- npm run typecheck: OK.
- npm test: 52/52 PASS, 0 fallos; los 44 casos existentes más ocho nuevos.
- Casos nuevos A–F: comparaciones, HTTP, estado sin acceso, ausencia de consulta upstream en rechazos y acceso único con duplicados válidos.
- Firma malformada: no se confunde con un diagnóstico false/false.
- Logger real: conserva booleanos/null y excluye secretos/digests fuera de la lista cerrada.
- Fixtures exclusivamente sintéticos y gateway local simulado; ninguna credencial real ni llamada de pago.
- Node local: 24.19.0. Warning ambiental npm: Unknown env config "http-proxy". Sin errores de compilación/typecheck.

No se desplegó, no se modificó Render/Mercado Pago y no se efectuaron pagos. No se avanzó con Hito 10 ni Visual Pack.
