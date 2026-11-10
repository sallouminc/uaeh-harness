# Inventario, salidas y formato de hallazgos — preflight (uae-preflight)

Fuente de verdad: este archivo (origen: el Playbook UAEH del autor, no publicado).

El preflight transforma un proyecto desconocido en un perfil verificable.

## Cuándo conviene pedirlo
La skill no se dispara sola: la pide el usuario. Momentos en que conviene:

1. Antes de abrir el producto al público (la lista previa al lanzamiento lo exige).
2. Al incorporar un repositorio al arnés.
3. Antes de desarrollar un producto nuevo (auditoría de diseño).
4. Tras cambiar infraestructura, autenticación, datos, proveedores o modelo de negocio, y periódicamente según el riesgo.

## Inventario: qué inspeccionar

- Repositorio, ramas, scripts, gestores de paquetes, monorepo, CI, dependencias y versiones.
- Frontend, backend, APIs, DB, colas, almacenamiento, despliegue, dominios e integraciones.
- Actores y roles: público, usuario, soporte, admin, proveedor, tenant, propietario.
- Autenticación actual: sesiones, JWT, refresh, MFA, recuperación, revocación, RBAC/ABAC.
- Flujo de datos: qué se captura, dónde se guarda, a quién se transmite, por cuánto tiempo.
- Secretos, privilegios de infraestructura, exposición de servicios, pruebas y observabilidad.
- Riesgos legales/comerciales: región, consumidores, cobros, IA, salud, finanzas, menores, biometría y terceros.
- Supuestos de escala: MAU, DAU, concurrencia, solicitudes por usuario, operaciones pesadas, presupuesto y RTO/RPO.

## Salidas obligatorias

```text
docs/harness/
  PROJECT_PROFILE.md       descripción, stack y dependencias
  ASSET_DATA_MAP.md        activos, datos, transferencias y responsables
  THREAT_MODEL.md          superficies y amenazas priorizadas
  SECURITY_BASELINE.md     requisitos aplicables y evidencia
  LEGAL_MATRIX.md          requisitos legales aplicables / validar
  SCALE_PLAN.md            arquitectura, cuellos de botella y umbrales
  ACCEPTANCE_MATRIX.md     requisito -> prueba -> evidencia
  AUDIT_REPORT.md          hallazgos, impacto, prioridad y responsable
  ROUTING_LESSONS.md       fallos y reglas aprendidas
```

## Formato de hallazgos

| Campo | Ejemplo |
|---|---|
| ID | `SEC-007` |
| Evidencia | `src/auth/session.ts:52`, token guardado en `localStorage` |
| Amenaza | Exfiltración de sesión por XSS |
| Severidad | Alta |
| Probabilidad / impacto | Media / alta |
| Acción | Migrar a sesión server-side o BFF con cookies seguras; corregir XSS |
| Prueba | E2E comprueba ausencia de token en Web Storage; cookie `HttpOnly` |
| Responsable | Backend + seguridad |
| Estado | Abierto / mitigado / aceptado con justificación |
| Decisión | Bloquea release hasta verificación |

## Decidir qué vale la pena auditar

**Siempre:** dependencias, permisos, exposición accidental de secretos, accesos administrativos, rutas públicas, protección mínima de datos, respaldo si hay persistencia, y cumplimiento elemental aplicable.

**Según el producto:** aislamiento multi-tenant, obligaciones de salud/finanzas, antifraude, KYC, PCI DSS, riesgo por IA, contenido de usuarios, upload de archivos, biometría, menores, telemedicina, suscripciones, analítica y publicidad.

**No exigir indiscriminadamente:** mTLS entre microservicios inexistentes; SIEM de escala empresarial en un prototipo local; KYC en una calculadora sin actividad financiera regulada; SOC 2 en una herramienta interna sin compromiso contractual; PCI DSS completo si no almacena ni procesa tarjetas directamente (aun así evaluar el alcance real); certificaciones como si fueran requisitos legales universales.

## Lecciones de ruta (`ROUTING_LESSONS.md`)

```markdown
| Fecha | Tipo de tarea | Ruta inicial | Falla | Ruta efectiva | Nueva regla/test |
|---|---|---|---|---|---|
| AAAA-MM-DD | RBAC API | quick | faltó probar IDOR | deep + security | agregar test cross-user |
```

**Cadencia:** revisar rutas al cambiar de modelo, al encontrar errores repetidos y periódicamente (por ejemplo cada 2–4 semanas). Si la mayoría escala, el nivel inicial es incorrecto; si el verificador es carísimo, simplificar checks automáticos antes de bajar seguridad.
