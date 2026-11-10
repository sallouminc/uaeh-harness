# Escalabilidad: de 1 a más de 1000 usuarios — preflight (uae-preflight)

Fuente de verdad: este archivo (origen: el Playbook UAEH del autor, no publicado).

**Mil usuarios registrados no equivalen a mil usuarios simultáneos.** La infraestructura se diseña con carga observada, concurrencia y SLO, no con un contador de cuentas.

## Datos que el preflight debe obtener
Lo que no se pueda medir o preguntar queda en `null` = `POR_CONFIRMAR` en `SCALE_PLAN.md`.

```yaml
registered_users: 1000
monthly_active_users: null
daily_active_users: null
peak_concurrent_users: null
requests_per_active_user_per_day: null
peak_requests_per_second: null
p95_latency_target_ms: null
p99_latency_target_ms: null
availability_slo: null
database_size_gb: null
heavy_operations: ["reports", "AI-inference"]
external_api_limits: []
monthly_infra_budget: null
rto_hours: null
rpo_minutes: null
```

## Escalado por etapas (umbrales de referencia, no límites fijos)

| Fase | Arquitectura preferente | Qué comprobar antes de crecer |
|---|---|---|
| 0. Prototipo / 1–20 usuarios | Monolito simple, DB administrada, backups, entornos separados | Auth, autorización, secretos, tests básicos, logging, esquema |
| 1. Beta / decenas a ~100 | Métricas, errores, alertas, optimización de consultas | Índices, límites de API, health checks, capacidad de restauración |
| 2. Crecimiento / ~100–1000 | CI/CD, staging, colas para tareas lentas, cache selectiva, servicios replicables cuando se requiera | Load test realista, p95/p99, recursos de DB, cuotas API, rate limits, costos |
| 3. 1000+ / concurrencia creciente | Autoscaling si la carga lo amerita, pooling, workers, observabilidad y capacidad planificada | Tests de estrés, recuperación, incidentes, failover, eficiencia por request |
| 4. Carga considerable/regulada | Separación de servicios motivada por métricas, replicación DB donde aporte, resiliencia avanzada | DR probado, seguridad independiente, trazabilidad y obligaciones sectoriales |

**No** introducir microservicios, Kubernetes, Kafka, shards o multi-region por llegar a «1000 usuarios». Escalar solo con pruebas de necesidad. A menudo una app con 1000 usuarios funciona bien con monolito, una DB bien indexada y un worker.

## Análisis técnico del cuello de botella

1. Medir p50/p95/p99, tasa de errores, CPU/RAM, conexiones DB, consultas lentas, saturación de colas.
2. Crear escenario de carga con **usuarios concurrentes**, mezcla real de endpoints y ramp-up.
3. Determinar cuello de botella: consultas N+1, locking, almacenamiento, APIs externas, GPU/IA, IO o CPU.
4. Solventar primero con índices, paginación, pooling, batching, colas, cache y límites adecuados.
5. Probar carga nuevamente. Definir umbral de ampliación/alerta e impacto en costos.
6. Modelar picos y fallas: degradación controlada, timeouts, retries con backoff, circuit breaker cuando proceda, idempotencia.
7. Revisar si el cambio altera seguridad, privacidad o integridad de datos.

## Puerta de capacidad antes de lanzar

- SLO declarado o decisión explícita de no ofrecer uno.
- Escenario de carga documentado; p95, errores y concurrencia medidos.
- Presupuesto máximo de infraestructura y proveedor de IA con alertas.
- Backups y restauración; monitoreo y respuesta a incidentes.
- Validación de límites de la plataforma y DB; nunca suponer recursos ilimitados.
