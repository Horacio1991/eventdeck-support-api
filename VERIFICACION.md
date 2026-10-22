# Verificación — webhook-fix-1 — 22/10/2026

Base exacta: eventdeck-support-api(3).zip.

- npm run build: OK.
- npm run typecheck: OK.
- npm test: 28 tests, 28 aprobados, 0 fallos.
- 19 tests originales conservados íntegramente; solo se extendió su import para los 9 nuevos tests.
- Smoke HTTP con JavaScript compilado: health 200, webhook sin firma 401, headers del FIX y log temprano comprobados.
- Comprobación sobre despliegue ANTERIOR al FIX: health 200; POST sin firma en ruta exacta 401 INVALID_SIGNATURE (22/10/2026, aproximadamente 12:31 Argentina). No se solicitó ni utilizó ninguna credencial.
- Comparación binaria con ZIP recibido: HMAC, grantVisualPackAccess, store, configuración, .env.example, frontend completo, package.json y lockfile sin modificaciones.
- Contenido de preferenceBody y sandboxUrl idéntico al original.
- No hay dependencias nuevas, .env, node_modules o credenciales reales en el ZIP.
- Warning ambiental de npm: http-proxy desconocido. No afecta build/tests ni es un cambio del proyecto.

El FIX no fue desplegado. No se hicieron pagos, ni checkout real ni simulado contra Mercado Pago. Las verificaciones autenticadas son mocks locales. No hay acceso a los runtime logs privados de Render ni a los intentos de entrega de Mercado Pago. La causa de ausencia total de logs en esos intentos sigue pendiente de confirmación mediante la instrumentación y el procedimiento de FIX-WEBHOOK.md.

Las dos correcciones comprobables son: log de ingreso anterior a parser/limiter y clasificación de errores de consulta para reconocer exclusivamente un 404 autenticado sin conceder acceso. Firma, condiciones de approved e idempotencia permanecen intactas.
