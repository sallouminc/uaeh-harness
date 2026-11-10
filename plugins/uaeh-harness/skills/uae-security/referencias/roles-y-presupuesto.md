# Roles de security-audit → agentes y modelos

Un subagente no lanza subagentes: la conversación principal (padre) lanza a todos y es la ÚNICA que escribe los archivos compartidos del run.

| Rol de `security-audit` | Agente | Modelo | Por qué |
|---|---|---|---|
| reconocimiento (`research`, 4 en paralelo) | `Explore` | `model:"sonnet"` | lectura y mapa; barato |
| cazador `hNN` (`general`) | `uaeh-harness:uae-security` | `model:"sonnet"` | aislado, solo lectura + caja de arena; volumen alto |
| verificador de candidato `vNN` | `uaeh-harness:uae-security` fresco | `sonnet`; **`opus`** si el candidato puede ser crítico o alto | independencia por candidato |
| crítico de cobertura `cNN` | `uaeh-harness:uae-security` | opus (por defecto) | juicio de cobertura |
| verificación final de registros (fase 5) | `uaeh-harness:uae-security` fresco | opus para crítico/alto, sonnet el resto | |
| revisión de diff (modo `diff`) | `uaeh-harness:uae-security` sin rol | opus | formato `SEC-NNN` |
| re-prueba (`reprobar`) | `uaeh-harness:uae-security` fresco | opus | nunca el builder |
| segunda familia | Codex (`auditor-codex.cjs`) | `profundo` / `equilibrado` | ver `codex.md` |

- Cada prompt de agente lleva el bloque de rol de `HUNTING.md` o `VALIDATION-AND-REPORTING.md` (de `security-audit`) **tal cual**, su `agent_id`, su `run`, su `scratch/`, la línea exacta de la caja de arena (`caja-de-arena.md`) y NADA de la conversación que construyó el código.
- El `agent_id` del prompt es el mismo que se pasa a `--agente` de la caja de arena.

## Presupuesto inicial (agentes por corrida; ajustable según lo que mida cada equipo)
| Perfil | Presupuesto | Notas |
|---|---|---|
| quick | 40 | caso medido por el autor: 40 se agotaron en validación; con la caja de arena, reservar ≥ 35 % para verificadores |
| standard | 80 | |
| deep | 140 | |
| diff | 3 | 1 `uaeh-harness:uae-security` (tope 15 min) + verificador solo para candidatos alto/crítico dentro del diff |
| reprobar | 1-2 | |

La regla de reservas y paro de `security-audit` (cita textual: `security-audit/SKILL.md:119-134`) aplica tal cual: nunca exceder en silencio; `incomplete` con motivo.
