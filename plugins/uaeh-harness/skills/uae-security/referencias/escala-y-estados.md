# Escala y estados únicos de /uaeh-harness:uae-security

## Gravedad (solo para lo `confirmado`)
| UAEH | CVSS v3.1/v4 (base) | security-audit | cyber-neo / checklist de seguridad | Ancla |
|---|---|---|---|---|
| **crítico** | 9.0 – 10.0 | critical | CRITICAL / CRÍTICO | actor sin autenticar logra ejecución de código, acceso total a datos o toma de cuentas arbitrarias |
| **alto** | 7.0 – 8.9 | high | HIGH / ALTO | derrota completa de un control explícito con consecuencias reales: bypass de auth, lectura/escritura entre usuarios o inquilinos, XSS almacenado que afecta a otros, RCE autenticado |
| **medio** | 4.0 – 6.9 | medium | MEDIUM / MEDIO | violación real de frontera con radio limitado o precondiciones poco comunes |
| **bajo** | 0.1 – 3.9 | low · informational | LOW · INFO / BAJO | revela internos no secretos o requiere esfuerzo sostenido para ganancia mínima; `informational` se reporta como **bajo (nota)** |

- Discriminador alto/medio (de `security-audit`): ¿el resultado demostrado DERROTA un control explícito con consecuencias reales, o solo lo debilita? Si no se puede decir el daño concreto, la gravedad es menor de lo que parece.
- La gravedad no puede exceder el impacto demostrado. Probabilidad e impacto se escriben aparte en el formato de 10 campos.
- Dependencias de solo desarrollo: medio como máximo. CVSS < 4.0 sin exploit conocido: no se reporta (filtro).
- En salud o dinero, una exposición de datos de pacientes o de montos sube un nivel solo si el impacto demostrado lo justifica; nunca por la etiqueta del proyecto.

## Estados de un hallazgo
| UAEH (AUDIT_REPORT.md, estado-hallazgos.json) | `findings.json` (inglés, validadores) | Significado | Quién lo pone |
|---|---|---|---|
| **confirmado** | `confirmed` | reproducido en `uaeh-sandbox` con comando, entrada y límites registrados | verificador fresco |
| **por_validar** | `needs_validation` | hipótesis con cadena en código, bloqueada por un hecho fuera del alcance (despliegue, proveedor, sin caja de arena); sin gravedad | verificador |
| **rechazado** | `rejected` | refutado con evidencia | verificador |
| **corregido-verificado** | (no existe en el esquema; el registro sigue `confirmed` en su run) | la PoC exacta ya no se reproduce Y la prueba de regresión falla en la base y pasa con el arreglo | `uaeh-harness:uae-security` fresco en `reprobar`, nunca el builder |
| **aceptado** | — | riesgo aceptado por el responsable, con justificación y fecha | solo el responsable |

- **Abierto** = confirmado sin `corregido-verificado` ni `aceptado`. Un crítico o alto abierto → `BLOCKED_SECURITY`.
- Las IDs son `SEC-NNN` (secuencia por repo, en `estado-hallazgos.json`), y cada una apunta a su `fingerprint` de `security-audit`.

## Estado global de una corrida
`BLOCKED_SECURITY` (crítico o alto abierto) · `UNKNOWN` (faltó herramienta obligatoria, caja de arena o Codex; run `incomplete`; 0 archivos revisados) · `PASS` (nada de lo anterior). `UNKNOWN ≠ PASS`.
