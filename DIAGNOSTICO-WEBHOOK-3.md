# DIAGNÓSTICO WEBHOOK 3 — EventDeck Support API
Fecha: 22 de octubre de 2026. Base exacta: eventdeck-support-api-webhook-fix2(2).zip.

## Conclusión
**No se confirmó la causa raíz del HMAC_MISMATCH. No se encontró un defecto funcional demostrado que justifique cambiar la autenticación.** La hipótesis principal es que la notificación real y el simulador no comparten el mismo contexto de firma (cuenta/aplicación/configuración), o que la clave efectiva no corresponde a esa entrega. Es una hipótesis, no una conclusión de que se necesite el secret productivo.

Recopiar el secret TEST y redesplegar reduce la probabilidad de una clave vieja; no demuestra que esa clave corresponda a la configuración que emitió el evento real. Tampoco tener el mismo user_id identifica inequívocamente una aplicación o su clave.

**Esta entrega no arregla el rechazo de firmas reales.** Incluye la investigación y exclusivamente la corrección solicitada de una etiqueta de log obsoleta. No requiere desplegar para realizar la siguiente investigación.

## Evidencia real y alcance
- Deploy FIX2 y operación nueva posteriores al cambio manual de secret.
- Preference: 3784985330-180476dd-335f-4a3a-be93-79d3ee2fd03d.
- Operación: 8d4268e9-70ea-484a-90c5-92ce7c981536.
- Payment: 184511367467.
- Dos entregas Payments alcanzan el validador, construyen manifest de 78 bytes y terminan en HMAC_MISMATCH / HTTP 401.
- No fallan por ausencia de headers, parser, CORS, ruta o formato. No se consulta el payment tras la firma inválida.
- Hay solicitudes adicionales con forma legacy/IPN y sin query data.id.
- El simulador validado previamente prueba una combinación concreta de mensaje y clave; no autentica las entregas reales posteriores.
- No tengo acceso a las configuraciones privadas de Mercado Pago/Render ni a los headers completos de esas entregas. Los logs contienen longitudes, no x-request-id, ts y v1 completos. No permiten recalcular esa firma.

El 502 del incidente original no es la respuesta de estas nuevas entregas. La evidencia actual es un rechazo de autenticación controlado 401.

## Comparación con el SDK oficial ACTUAL
Se leyó el código fuente, no solamente la documentación:
mercadopago/sdk-nodejs, commit bf920b9415ba19986b7ffdbf83a5aa21b589a6e0,
src/utils/webhook/index.ts [1].

| Aspecto | FIX2 | SDK oficial leído | Relevancia |
|---|---|---|---|
| Fuente data.id | Query Express simple, solo string | Parámetro del validador; ejemplo oficial pasa query data.id | Misma fuente prevista |
| Normalización ID/request-id | Conserva string; rechaza caracteres fuera de whitelist | Toma primer elemento si array y aplica trim | NO son implementaciones idénticas |
| Casing del ID | Conserva | Conserva | ID observado numérico: lowercase no tiene efecto |
| Manifest | id, request-id, ts, cada par terminado en ; | Mismo orden y terminadores | Coincide para los valores aceptados del incidente |
| Algoritmo/encoding | HMAC-SHA256, string UTF-8 | HMAC-SHA256, string UTF-8 | Coincide |
| Parser | Solo ts/v1, rechaza duplicados y componentes extra | Normaliza nombre de componente, ignora desconocidos, admite versiones; duplicado sobrescribe | FIX2 más restrictivo; estos eventos llegaron a HMAC_MISMATCH, no error de parser |
| Digest | Decodifica hex y timingSafeEqual sobre 32 bytes | Compara strings hex con timingSafeEqual | Mismo resultado con hex minúscula normal; FIX2 también acepta hex mayúscula equivalente |
| Ausentes | Endpoint exige id/request-id/ts | Constructor omite pares ausentes; exige timestamp | No explica eventos con todos presentes |
| Antigüedad | No impone tolerancia | Tolerancia opcional | No explica este rechazo |
| Secret | Config lee MP_WEBHOOK_SECRET con trim | SDK usa secret recibido directamente | Sin valor privado no se puede comparar bytes; un secret con espacios significativos sería un caso distinto, no demostrado |

**Corrección a una afirmación del FIX2:** el comentario que atribuye al SDK ausencia de trim no describe el código actual leído. No se cambió la política del endpoint para imitar un parser más permisivo: no explica estos fallos.

Para el mensaje observado, data.id y request-id pasaron whitelist y ts pasó regex. Por tanto no contienen espacios que el trim del SDK pudiera eliminar. No hay evidencia de un cambio de ID dentro del backend.

Formato literal:
`id:184511367467;request-id:<valor exacto del header>;ts:<valor exacto ts>;`

Longitud: 3+12+1 + 11+36+1 + 3+10+1 = 78 bytes ASCII/UTF-8. Sin espacios, saltos de línea, JSON, comillas, body, URL completa ni timestamp convertido. Los nombres son minúsculos; el casing de los valores se preserva. La longitud correcta no demuestra por sí sola que los valores coincidan con los utilizados por el emisor.

## live_mode=true: lo demostrado y lo pendiente
La documentación actual describe live_mode como indicador de producción/pruebas en otros flujos [5], y los ejemplos específicos de notificaciones Preferences usan false [2]. **No encontré una regla oficial específica de Checkout Pro + Preferences que documente que las cuentas TEST deban producir live_mode=true.**

Por ello:
- A / C / D: no se puede afirmar que sea normal con test credentials, seller TEST o Preferences.
- B: el campo declara modo live en ese body; no demuestra dinero real ni un payment productivo verificado.
- E: no identifica el secret firmante y no está incluido en el manifest.
- F: una mezcla de contextos es compatible con la evidencia, pero falta confirmación.
- G: no se encontró otra explicación documentada aplicable a esta entrega.

El body todavía es NO autenticado. Incluso una firma válida de este esquema no reemplaza la consulta posterior a la API: el manifest no firma todos los campos del body.

La documentación de QR/Point contiene instrucciones específicas de configurar modo producción dentro de una cuenta de prueba [6]. **No se extrapolan a Preferences.** Su existencia muestra por qué no debe confundirse cuenta TEST con un contexto universal de notificaciones.

Si posteriormente el payment consultado de forma autenticada devuelve live_mode=true, la validación actual de EventDeck lo rechaza con 422. Cambiar la clave no garantiza resolver todo el flujo. No se relajó esta regla.

## Pagos (legacy), Webhooks e IPN
Para Checkout Pro/Preferences, el tópico documentado es payment [2][3]. Es el tópico recibido. No hay fundamento para cambiarlo a orders. La etiqueta exacta «Pagos (legacy)» del panel no está explicada literalmente en las páginas consultadas: su correspondencia con payment es coherente con el evento real y la API Payments, pero no prueba por sí sola configuración completa.

No hay evidencia documental de que el adjetivo legacy seleccione una HMAC distinta ni de que equivalga a IPN.

IPN es un mecanismo separado. Mercado Pago documenta que puede configurarse mediante notification_url y que su x-signature no se valida mediante la clave Webhooks [4]. Las solicitudes clasificadas legacy_ipn_candidate son compatibles con IPN; esos logs no certifican quién las emitió ni qué configuración las originó.

La Preference contiene notification_url sin selector. Esto proporciona una explicación plausible de la segunda familia, además de la posible configuración IPN de cuenta. No se demostró causalidad ni duplicación de configuraciones privadas. Dos Payments pueden ser actualizaciones o reintentos: dos entregas tampoco prueban configuración duplicada. No se añadió source_news por ensayo y error ni se aceptó IPN.

## Payload de Preference y credencial
Código: src/services/mercadopago.service.ts y src/config/env.ts.

| Campo | Valor/comportamiento |
|---|---|
| Endpoint | POST https://api.mercadopago.com/checkout/preferences |
| Credencial | Authorization Bearer, únicamente config.accessToken procedente de MP_ACCESS_TOKEN |
| Alternativa/fallback | No hay token embebido ni otra variable de token |
| items | eventdeck-support-test, Apoyo a EventDeck, cantidad 1, moneda y monto server-side |
| external_reference | UUID de operación |
| notification_url | https://eventdeck-support-api.onrender.com/api/webhooks/mercadopago con BASE_URL informado |
| Query especial | Ninguna |
| back_urls | FRONTEND_URL + /support/success/{publicToken}, /support/pending/{publicToken}, /support/failure/{publicToken} |
| auto_return | approved |
| expires | true; fechas desde creación hasta expiración de operación |
| metadata / payer / binary_mode / live_mode | No enviados |
| URL abierta | Solo sandbox_init_point validado; no fallback a init_point |

El código no puede certificar el modo del token solo por su nombre de variable. La documentación advierte que el prefijo TEST puede variar por solución [7]; no se agregó clasificación engañosa por prefijo. No se inspeccionaron secretos privados.

No hay un campo en el payload que fuerce live_mode=true. El origen de notificaciones sí puede depender de notification_url y del contexto externo.

## H1–H12
Los descartes se limitan al código y a la forma de los eventos observados.

| Hipótesis | Resultado | Evidencia / límite |
|---|---|---|
| H1 Secret incorrecto/viejo | NO DEMOSTRABLE AÚN | Recopiado recientemente; no prueba correspondencia con entrega. No asumir «viejo». |
| H2 TEST vs firma productiva | NO DEMOSTRABLE AÚN | Plausible, no inferible de claimedLiveMode. |
| H3 Payment realmente productivo | NO DEMOSTRABLE AÚN | Body no confiable; no respuesta API autenticada del recurso. |
| H4 live_mode=true normal con TEST | NO DEMOSTRABLE AÚN | No hallada regla oficial específica de Preferences. |
| H5 Pagos (legacy) causa HMAC mismatch | NO DEMOSTRABLE AÚN | payment es tópico apropiado; no evidencia de relación causal con etiqueta. |
| H6 Webhooks + IPN simultáneos | NO DEMOSTRABLE AÚN | CONFIRMADA la coexistencia de dos formas; origen IPN exacto sigue siendo candidato. |
| H7 notification_url causa segunda familia | NO DEMOSTRABLE AÚN | Mecanismo documentado compatible; configuración de cuenta no accesible. |
| H8 Manifest difiere del oficial | DESCARTADA para los valores aceptados observados | Igual orden, separators, UTF-8 y terminador; parsers NO son idénticos en general. |
| H9 request-id distinto al firmado | NO DEMOSTRABLE AÚN | Header directo, sin transformación en app; falta captura emisor/receptor completa. |
| H10 Transformación incorrecta de data.id | DESCARTADA en backend para este ID | Query string de 12 dígitos preservado; sin Number/lowercase/body fallback. |
| H11 Simulador y real usan contextos/claves diferentes | NO DEMOSTRABLE AÚN | Principal hipótesis a verificar, no basta MATCH versus MISMATCH. |
| H12 Test/producción duplicados misma URL | NO DEMOSTRABLE AÚN | Requiere inspección del panel, no aparece en logs. |

## Próxima prueba: una entrega existente, sin nuevo pago
Objetivo: identificar el contexto que firmó **una misma entrega**, no volver a generar transacciones.

1. En la aplicación EventDeck, abrir el historial/detalle de notificaciones y localizar payment 184511367467, 22/10/2026 alrededor de 16:26:36 UTC (13:26:36 Argentina). Revisar ambos modos sin guardar cambios. Registrar cuenta/aplicación, modo, URL y el intento exacto; no mezclar headers de reintentos.
2. Si el panel permite ver/exportar los headers completos de ese intento, obtener privadamente query data.id, x-request-id y x-signature. No compartir claves ni firmas por chat. No reconstruir valores desde longitudes.
3. Con esos valores, ejecutar el comparador offline de abajo con la clave TEST vigente en ese momento. No hace llamadas API ni concede acceso.
4. Si el historial identifica esa entrega como productiva y existe una clave correspondiente ya configurada, comparar la MISMA captura localmente con esa clave. **No copiarla a Render por sospecha, no activar credenciales productivas, no rotar claves.** Si el panel usa una única clave compartida, tratarla como tal: no presumir que existen dos.
5. TEST_MATCH únicamente: investigar clave efectiva/configuración del proceso o diferencia entre captura y solicitud recibida; no cambiar manifest.
   PROD_MATCH únicamente, con identidad de aplicación/mode verificada: confirma cuál clave autentica esa captura. Reconciliar emisor y configuración de prueba antes de modificar Render.
   Ambas: claves iguales/equivalentes para esa firma; la comparación no discrimina modo.
   Ninguna: no demuestra secreto productivo; revisar identidad, rotación y exactitud de captura con soporte.
6. **Límite real:** no consta que el panel exponga todos los headers históricos. Si no los expone, esta comparación no se puede ejecutar con los logs actuales. La siguiente acción única es abrir un caso al soporte de Mercado Pago por ESA entrega, solicitando cuenta/application_id/configuración y modo firmante, y headers de firma/request-id o validación interna con la clave configurada. No hacer otro pago ni prometer que otro deploy de logs resolverá el origen.

Texto del caso: «Checkout Pro Preferences, vendedor 3784985330, payment 184511367467, Preference 3784985330-180476dd-335f-4a3a-be93-79d3ee2fd03d; entregas 22/10/2026 16:26 UTC a /api/webhooks/mercadopago. Simulador TEST valida, entregas payment dan HMAC_MISMATCH, body live_mode=true. Clave TEST recopiada y redeploy antes de generar la operación. Confirmar aplicación/contexto firmante, si corresponde a configuración TEST o productiva, y por qué llegan además formas IPN. No solicitamos desactivar autenticación.»

Esta prueba es concluyente sobre **qué clave valida la captura** cuando existe MATCH y captura exacta; no garantiza que cualquier resultado permita atribuir toda la causa raíz. Sin esos datos no sería honesto prometer una prueba universal concluyente desde los logs disponibles.

### Comparador local opcional
Guardar el bloque como comparar_firma.py y ejecutar con Python 3 desde una terminal local. Solo biblioteca estándar. No usa argumentos de secretos, variables de entorno, archivos de datos ni red. Entrada oculta; aborta si la terminal no puede ocultarla. No sustituye autenticación productiva ni comprueba estado/importe. No ingresar Access Tokens.

```python
import getpass
import hashlib
import hmac
import re
import warnings

def check(data_id, request_id, ts, signature_hex, secret):
    manifest = f"id:{data_id};request-id:{request_id};ts:{ts};"
    digest = hmac.new(secret.encode("utf-8"),
                      manifest.encode("utf-8"), hashlib.sha256).digest()
    return hmac.compare_digest(digest, bytes.fromhex(signature_hex))

def main():
    warnings.simplefilter("error", getpass.GetPassWarning)
    data_id = getpass.getpass("data.id exacto del query: ")
    request_id = getpass.getpass("x-request-id exacto: ")
    raw = getpass.getpass("x-signature completo del MISMO intento: ")
    fields = {}
    for part in raw.split(","):
        match = re.fullmatch(r"\s*(ts|v1)\s*=\s*([^\s,]+)\s*", part)
        if not match or match[1] in fields:
            raise ValueError()
        fields[match[1]] = match[2]
    ts, digest = fields.get("ts", ""), fields.get("v1", "")
    if not (re.fullmatch(r"[0-9]{1,20}", data_id)
            and re.fullmatch(r"[A-Za-z0-9_-]{1,200}", request_id)
            and re.fullmatch(r"[0-9]{10,16}", ts)
            and re.fullmatch(r"[a-fA-F0-9]{64}", digest)):
        raise ValueError()
    secret = getpass.getpass("Secret TEST de esa configuración: ")
    if not secret:
        raise ValueError()
    print("TEST_MATCH" if check(data_id, request_id, ts, digest, secret)
          else "TEST_NO_MATCH")
    secret = None
    # Solo si se identificó otra configuración firmante en el historial.
    secret = getpass.getpass("Secret otra configuración identificada (Enter omite): ")
    if secret:
        print("OTHER_MATCH" if check(data_id, request_id, ts, digest, secret)
              else "OTHER_NO_MATCH")
    secret = None

if __name__ == "__main__":
    try:
        main()
    except (ValueError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print("ABORTADO: entrada inválida o terminal sin entrada oculta.")
```

No se promete borrado seguro de memoria de Python; los secretos existen transitoriamente en memoria. No se registra ni imprime su contenido.

## Cambios, verificaciones y comportamiento
1. src/middleware/webhook-diagnostics.ts: code del evento webhook_request_received usa SIGNATURE_FIX (webhook-fix-2), igual que startup. El header histórico X-EventDeck-Webhook-Fix conserva fix1 como marcador del primer cambio; X-EventDeck-Signature-Fix identifica fix2. No se inventó una versión funcional fix3.
2. test/support.test.ts: una aserción adicional comprueba ese code. Se mantienen los 44 casos y todas las aserciones anteriores.
3. DIAGNOSTICO-WEBHOOK-3.md: este documento, nuevo.

Sin cambios de HMAC, permisos, rutas, Preference, frontend, dependencias, variables ni URL. El cambio de etiqueta es cosmético y no requiere desplegar para investigar la entrega existente.

Build, typecheck y 44 tests: ejecutados antes y después del cambio. Resultado final: build OK, typecheck OK, 44/44 tests aprobados, 0 fallos. Node local 24.19.0; logs de Render indican 24.22.1. Warning npm de entorno: Unknown env config "http-proxy". No warning del compilador. No se realizó un pago real ni una verificación criptográfica con secretos reales.

El simulador correctamente firmado con recurso ficticio inexistente conserva 200 y ningún acceso. Firma inválida conserva 401. Otros fallos upstream transitorios conservan respuesta reintentable; no se silencian con un 2xx.

PROCESANDO PAGO continúa porque no llegó una confirmación autenticada/verificada. Consultar estado lee el estado seguro almacenado: no convierte el redirect en confirmación. Tras resolver firma, deben verificarse payment, collector, importe, moneda, external_reference, live_mode=false y approved; acceso una vez. Un redeploy reinicia memoria y puede perder la operación previa: no interpretar eso como otro fallo HMAC. Primero resolver firma con evidencia existente; recién después, si se necesita comprobar el flujo completo, una operación TEST nueva controlada.

## Fuentes oficiales consultadas
[1] SDK Node, código fijado por commit:
https://github.com/mercadopago/sdk-nodejs/blob/bf920b9415ba19986b7ffdbf83a5aa21b589a6e0/src/utils/webhook/index.ts
Código recuperado desde raw.githubusercontent.com; el visor web de GitHub no estuvo disponible.
https://github.com/mercadopago/sdk-nodejs/blob/master/docs/webhooks.md

[2] Checkout Pro Preferences: notificaciones y ejemplo payment:
https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/payment-notifications

[3] Tabla de tópicos y modos Webhooks:
https://www.mercadopago.com.ar/developers/es/docs/checkout-api-payments/additional-content/your-integrations/notifications/webhooks
Distingue pruebas con credenciales de prueba del usuario productivo que creó la aplicación. No demuestra qué cuenta/configuración firmó nuestra entrega.

[4] IPN:
https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/ipn

[5] Definición live_mode, **otra API; no prueba excepción Preferences**:
https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-orders/optional-notifications?scope=prod

[6] Configuración de cuentas TEST en **QR/Point**, no extrapolada:
https://www.mercadopago.com.ar/developers/es/docs/qr-code/notifications
https://www.mercadopago.com.ar/developers/es/docs/mp-point-v2/notifications?scope=prod

[7] Credenciales Preferences:
https://www.mercadopago.com.ar/developers/es/docs/checkout-pro-preferences/additional-content/credentials

No se accedió a secretos ni se modificaron cuentas, Render o Mercado Pago. Fin del alcance; sin Hito 10 ni entrega de Visual Pack.

