# Puerta de seguridad antes de lanzar (`/uaeh-harness:uae-security lanzamiento`)

Bloqueante y manual (nunca se auto-dispara): corre antes de publicar al público algo con datos personales, salud o dinero.

## Condiciones para pasar (todas)
1. **Cero críticos o altos abiertos** en `estado-hallazgos.json` (abiertos = confirmados sin `corregido-verificado` ni `aceptado` por el responsable del proyecto).
2. **Ningún `por_validar` crítico sin plan**: cada uno tiene dueño y plan seguro de validación en el despliegue real.
3. **Pasada determinista de hoy** (`pasada-determinista.cjs`) con `ESTADO_GLOBAL OK` y sin secretos nuevos en el historial.
4. **Auditoría completa vigente** (el preflight corre justo ahora, antes de lanzar: si no hay sello, o cambió auth, esquema, env, rutas o manifiestos desde el último → incremental primero). Este es el único momento en que el preflight es obligatorio.
5. **Lista previa** (fases de `checklist-prelanzamiento.md`, revisadas contra el código, con cita): superficie de ataque censada · secretos en historial · dependencias de producción · CI/CD (`pull_request_target`, permisos del token) · infraestructura oculta (endpoints temporales de mantenimiento ELIMINADOS y 404 verificado) · webhooks firmados · IA/LLM con tope de gasto · OWASP Top 10 · STRIDE · clasificación de datos (PII fuera de git y de los paquetes de despliegue).
6. **Legal mínimo** presente (términos y privacidad reales, consentimiento, transferencias declaradas) → si falta, se pide una revisión de cumplimiento antes de lanzar.
7. **Humano:** en salud o dinero, recomendación explícita de un **pentest humano externo** antes de escalar usuarios. Los agentes no lo sustituyen.
8. **Segunda familia:** la auditoría de Codex forma parte de la puerta, salvo que el responsable la descarte de forma explícita (por privacidad, Codex envía la copia limpia a OpenAI); el descarte queda escrito en el informe.

## Salida
`PASS_RELEASE_READY` solo si 1-6 y 8 se cumplen; si no, `BLOCKED_SECURITY` (crítico/alto abierto) o `PENDING_HUMAN_REVIEW` (lo demás), con la lista de lo que falta. La decisión de publicar es del responsable del proyecto.
