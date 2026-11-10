# Seguridad por diseño: controles y pruebas — preflight (uae-preflight)

Fuente de verdad: este archivo (origen: el Playbook UAEH del autor, no publicado).

**Referencias guía:** OWASP ASVS, OWASP Top 10, OWASP Cheat Sheets, NIST SSDF; elegir requisitos por nivel de garantía y superficie real. La seguridad en un navegador no puede depender de que el frontend o un LLM «se comporte bien».

## Identidad, autenticación y sesiones

| Control | Cuándo | Evidencia mínima |
|---|---|---|
| Sesión web en cookie `HttpOnly`, `Secure`, `SameSite` apropiado o patrón BFF | Web con login | Cookies verificadas; ningún ID/token de sesión en `localStorage`/`sessionStorage` |
| Protecciones XSS y CSRF | Web autenticada | Escapado/Trusted Types/CSP cuando proceda; tests CSRF en requests mutantes con cookies |
| MFA para administradores y operaciones sensibles | Sistemas con acceso privilegiado | Prueba de login sin 2FA bloqueado; soporte TOTP/passkeys/FIDO2 |
| Hash seguro de contraseñas | Credenciales propias | Argon2id u opción moderna calibrada; nunca hash simple |
| Rotación/revocación de sesiones y recuperación segura | Login / refresh / dispositivos | Tests de logout, expiración, revocación y reutilización inválida |
| Rate limiting por IP/cuenta con respuesta antiabuso | Login, reset, OTP, APIs | Tests de límites sin bloqueo accidental de usuarios legítimos |
| Reautenticación para acciones sensibles | Cambio de email, roles, retiro/exportación | Prueba que sesión antigua no basta |

**Caso de referencia: token en `localStorage`.** Cualquier JavaScript con acceso al origen puede leerlo y exfiltrarlo tras un XSS. La solución habitual en web es usar sesión de servidor o BFF con cookie `HttpOnly` + `Secure` + `SameSite` configurado según flujo, controles CSRF y mitigación XSS. **`HttpOnly` reduce el robo directo del token, pero no elimina XSS ni impide que un script malicioso actúe como usuario durante la sesión**. En móvil nativo usar mecanismos de almacenamiento seguro del sistema (Keychain/Keystore), no copiar literalmente la estrategia del navegador.

## Autorización siempre en backend

**Antipatrón:** ocultar un botón «Admin» en React/Angular y considerar eso control de acceso.

**Implementación exigida:** identidad validada, roles/atributos verificables del lado servidor, **deny by default**, autorización por cada recurso/operación/tenant, y políticas administradas server-side. La UI solo mejora experiencia.

**Tests indispensables:** usuario común intenta llamar endpoint admin directamente → `403`; usuario de tenant A intenta leer/editar registro de tenant B → `403`/`404` sin fuga; usuario autenticado intenta acceso a objeto ajeno (BOLA/IDOR) → denegado. Probar también roles, operadores internos y caminos alternativos.

## API, backend y datos

- Validación **server-side** con esquemas y límites de tamaño; no confiar en tipos TypeScript del frontend.
- Queries parametrizadas/ORM correctamente usado; prohibir concatenación SQL insegura.
- Autenticación y autorización **en cada endpoint sensible**, incluidas rutas internas expuestas por error.
- Rate limiting proporcional a endpoint, identidad, IP y coste de operación; no usar CAPTCHA como única defensa.
- CORS restrictivo acorde a orígenes permitidos; nunca combinar orígenes arbitrarios con credenciales.
- Webhooks: firma, timestamp, ventana anti-replay e idempotencia.
- Subida de archivos: tipo real, tamaño, permisos, análisis cuando aplique, almacenamiento fuera de webroot, URLs caducables.
- Errores públicos genéricos, logs privados útiles y redacción de información sensible.
- SSRF: allowlists de destinos y protección de redes privadas/metadata si la app consulta URLs aportadas por usuarios.
- Admin APIs no públicas o fuertemente autenticadas/autorizadas; separación de permisos de servicio.
- En sistemas multi-tenant: separación explícita, pruebas cross-tenant, RLS si el motor y el diseño lo justifican; RLS no sustituye pruebas de aplicación.

## Base de datos, migraciones y respaldo

- Migraciones versionadas, probadas en staging y con estrategia de vuelta atrás o compensación.
- Antes de una migración destructiva: respaldo/restauración **probados**, evaluación de bloqueo, volumen de datos, índices y compatibilidad entre versiones.
- Backups cifrados y aislados; comprobar restauración con periodicidad adecuada.
- Datos mínimos, retención, exportación, borrado/anonimización según obligación legal.
- Cifrado de datos sensibles con gestión de llaves y rotación por riesgo; no guardar llaves en repo.
- Separación de usuarios/credenciales de DB por entorno y mínimo privilegio; producción no accesible por agentes de implementación rutinaria.
- Operaciones de dinero: idempotencia, ledger/auditoría, reconciliación y reglas transaccionales si la plataforma realmente mueve fondos.

## Infraestructura, SDLC y respuesta

- TLS, configuración segura de headers, secretos fuera de Git, CI con mínimo privilegio.
- SAST y SCA (dependencias), análisis de secrets, controles IaC/contenedor si se usan.
- Protección de ramas, PR con revisión, artefactos y despliegues trazables.
- Logs de seguridad (sin tokens/contraseñas/PII innecesaria), alertas y procedimientos de incidente.
- WAF/CDN, mitigación DDoS, segmentación y límites de egreso según exposición.
- Gestión de vulnerabilidades y actualizaciones por severidad; plan de respuesta y recuperación.
- Testing de seguridad autorizado: DAST en staging, pentest externo cuando nivel de riesgo/cliente lo amerite.
- IA/LLM: prompt injection, acceso indebido a herramientas, filtrado de datos, costos máximos por usuario, permisos de acciones y revisión humana en acciones sensibles.

## Puertas de seguridad por nivel

**Básico (producto con usuarios):** auth/session, autorización server-side, rate limits, validación, secretos, dependencias, TLS, logs prudentes, backups cuando hay persistencia.

**Alto (datos personales, pagos, multi-tenant, API pública):** modelado de amenazas, pruebas BOLA/IDOR, MFA de administradores, SAST/SCA, revisión de migraciones y aislamiento, auditoría de cambios y alertas.

**Crítico (salud, órdenes financieras, fondos, grandes conjuntos de datos sensibles):** revisión independiente especializada, pentest orientado a riesgos, pruebas de restauración y continuidad, aprobación humana, controles regulatorios específicos y evidencias de cumplimiento.
