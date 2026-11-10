# Estados, gravedad y formatos — puerta visual (uae-visual)

## Estados de un chequeo y de una corrida visual
| Estado | Cuándo |
|---|---|
| `PASS` | Todos los chequeos aplicables se ejecutaron y aprobaron, con evidencia (comando, código de salida, número de pruebas, captura). |
| `FAIL` | Incumplimiento demostrado (axe, desborde, fuente, consola/red, diferencia de píxeles o hallazgo del auditor con evidencia). |
| `BLOCKED` | El entorno impide verificar: la app no arranca, falta la herramienta o el navegador no abre. **Nunca** se convierte en PASS. |
| `NOT_CHECKED` | El control no se pudo comprobar: falta la baseline aprobada, el proyecto no tiene `@playwright/test`/axe, o quedó fuera de alcance. |

**Hacia `/uaeh-harness:uae-loop`:** `PASS` aporta a `PASS_TECHNICAL`. Un `BLOCKED` o `NOT_CHECKED` en un chequeo **exigido** por la ruta → `UNKNOWN`. Un cambio de marca o identidad → `PENDING_HUMAN_REVIEW` hasta el OK del responsable, una captura a la vez.

Para pasar el JSON de Playwright a estos estados de forma determinista está el clasificador de la skill (`scripts/clasificar-resultados.cjs`; el comando completo, en SKILL.md §4). Sin snapshot → `NOT_CHECKED`; conexión rechazada → `BLOCKED`; 0 pruebas → `UNKNOWN`.

## Escala de gravedad (la misma de la puerta de seguridad)
| Gravedad | Ejemplos | Efecto |
|---|---|---|
| **crítico** | Pantalla rota o ilegible en la ruta principal · datos de otra persona visibles · flujo de pago o login inutilizable. | Bloquea publicar. |
| **alto** | Contraste que falla WCAG AA en texto principal · desborde a 360 px · foco invisible · pérdida de información · CLS > 0.25. | Bloquea publicar. |
| **medio** | Estados faltantes (loading, empty, error) · inconsistencia con el `DESIGN.md` · LCP > 4 s o TBT > 600 ms en Lighthouse. | Decide el dueño. |
| **bajo** | Detalle de pulido verificable. | Va al backlog. |

Lo de **gusto** (preferencias sin regla del `DESIGN.md` ni guía) va en `notas_de_gusto`, nunca bloquea y no lleva gravedad.

**Prioridad de arreglo** (una sola ronda; el responsable decide qué se arregla): funcionalidad > seguridad y privacidad > accesibilidad grave > pérdida de información > responsive > marca y consistencia > gusto.

## Formato de `browser-verifier` (devuelve SOLO este YAML)
```yaml
status: "PASS|FAIL|BLOCKED|NOT_CHECKED"
app:
  url: "http://127.0.0.1:3000"
  http: 200            # o el error de conexión
deterministico:
  comando: "<comando exacto>"
  exit_code: 0
  executed_tests: 20
  estado_clasificado: "PASS|FAIL|BLOCKED|NOT_CHECKED|UNKNOWN"
  diffs_pixel: []      # pruebas de captura que fallaron
  axe_violations: []   # id y número de nodos
  desborde_360: []     # rutas con scrollWidth > clientWidth
  fuente: []           # rutas con fuente prohibida o distinta al DESIGN.md
pantallas:
  - ruta: "/"
    viewport: "360x800"
    captura: "reports/visual-audit/<AAAAMMDD-HHMM>/inicio-360.png"
    errores_consola: 0
    peticiones_fallidas: 0
findings:
  - id: "NAV-001"
    gravedad: "critico|alto|medio|bajo"
    ruta: "/"
    viewport: "360x800"
    evidencia: "<captura o salida literal>"
    issue: "<qué falla>"
    signature: "<firma corta y estable, sin números de línea>"
evidencia_dir: "reports/visual-audit/<AAAAMMDD-HHMM>/"
next_action: "audit|repair|human_review|done"
```

## Formato de `design-auditor` (devuelve SOLO este YAML)
```yaml
status: "PASS|FAIL|BLOCKED|NOT_CHECKED"
checks:
  - criterio: "marca|tipografia|responsive|accesibilidad|estados|movimiento|reduced-motion"
    resultado: "PASS|FAIL|NOT_CHECKED"
    evidencia: "<captura o archivo:línea>"
findings:
  - id: "VIS-001"
    gravedad: "critico|alto|medio|bajo"
    pantalla: "/"
    viewport: "360x800"
    ubicacion: "<archivo:línea o selector>"
    evidencia: "reports/visual-audit/<AAAAMMDD-HHMM>/inicio-360.png"
    regla: "DESIGN.md §<sección> | web-design-guidelines: <regla> | WCAG <criterio>"
    arreglo: "<qué cambiar, concreto>"
    signature: "<firma corta y estable>"
top3_siguiente_ronda: ["VIS-001", "VIS-003", "NAV-002"]   # los tres primeros a arreglar, por la prioridad de arriba
notas_de_gusto: []
requires_human_approval: false   # true si el cambio toca marca o identidad
baselines_tocadas_sin_autorizacion: []
```

## Sección en `docs/harness/AUDIT_REPORT.md` (modo `audit-only`)
`## Visual (uae-visual)`, con:
- fecha y hora en la zona configurada (`<ahora>` de SKILL.md) y commit;
- ruta, viewports y pantallas revisadas;
- estado global;
- tabla de hallazgos `VIS-/NAV-NNN` con gravedad, evidencia, regla, acción y estado (`abierto | corregido-verificado`).

Un hallazgo visual pasa a `corregido-verificado` solo cuando un `browser-verifier` o `design-auditor` **fresco** lo vuelve a comprobar tras el arreglo.
