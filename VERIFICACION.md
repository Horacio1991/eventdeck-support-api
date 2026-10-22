# Verificación — webhook-fix-2 — 22/10/2026

Base exacta: eventdeck-support-api-webhook-fix(2).zip.

- npm run build: OK.
- npm run typecheck: OK.
- npm test: 44 aprobados, 0 fallos (28 originales + 16 nuevos).
- No hay dependencias nuevas, credenciales reales, cambios de infraestructura ni despliegue.
- No se contactó el endpoint de Render para repetir diagnósticos que ya están comprobados en los logs del usuario.
- Los tests sintéticos de firma no son una reproducción criptográfica del header real rechazado: los logs recibidos no contienen esos componentes.
- La corrección de case preservation no explica el ID numérico rechazado. Se agregan códigos que distinguen rechazo de formato de HMAC_MISMATCH y una clasificación segura de notificaciones. Sigue pendiente confirmar la causa exacta con la nueva evidencia del entorno real.
- Advertencia ambiental de npm: http-proxy desconocido; no impide validaciones ni forma parte del proyecto.

Ver FIX-WEBHOOK-2.md para causa demostrada/límites, fuentes oficiales, archivos modificados y procedimiento de prueba. No hay promesa de aprobación ni relajación de las condiciones de acceso.

- Comparación binaria: 15 archivos protegidos idénticos al ZIP base, incluido el archivo de los 28 tests originales.
- Smoke del servidor compilado: 401 sin firma, header FIX2 y diagnóstico MISSING_SIGNATURE correctos.
