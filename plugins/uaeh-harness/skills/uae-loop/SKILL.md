---
name: uae-loop
description: Protocolo UAEH SOLO para código de la lista blanca de riesgo — dinero, cuentas, base de datos o publicar a producción con datos reales. Construye la conversación principal; revisan en paralelo un verificador y, en dinero/cuentas, un auditor de seguridad. Una sola revisión, sin bucle, con evidencia. NO para UI, textos, scripts ni bugs normales.
argument-hint: "<tarea concreta>"
---
# /uaeh-harness:uae-loop — bucle de ingeniería para la lista blanca

Tarea: $ARGUMENTS

> **Por qué es así (medido por el autor en sus sesiones):** el 71 % del tiempo el orquestador solo esperaba a subagentes, y
> ~73 % del tiempo de cada agente fresco era releer el repo. Lo barato (Codex ~2 min, escáneres < 1 min, sello < 2 min)
> no era el problema. Por eso: construye quien ya tiene el contexto, los revisores van a la vez y con tope.
> **Meta:** tarea de lista blanca ≤ 30 min de sistema. A los 60 min se para y el usuario elige.

## 0. ¿Entra o no? (en línea, sin agentes)
- **Lista blanca** (basta una): dinero · cuentas/auth · base de datos · publicar a producción con datos reales de personas o dinero. La lista efectiva es la de `listaBlanca` en `uaeh.config.json` (estas cuatro categorías por defecto; el usuario puede ampliarla o recortarla).
  - «Dinero» incluye **los precios que se cobran** dondequiera que vivan: app, servidor, landing, panel, tiendas y scripts de tiendas (el precio en la landing también es dinero).
  - «Publicar a producción con datos reales» incluye un push a la rama que despliega y un script de despliegue al servidor: la revisión única corre **antes** del push o del script, no después.
  - La **guardia de cierre** (hooks del plugin sobre `PreToolUse`, `SubagentStop` y `Stop`) avisa cuando un commit toca archivos de lista blanca (los reconoce por nombre de archivo, con los patrones de `listaBlanca`) y no deja cerrar la respuesta si no corrió ningún revisor. Falso positivo: `node "${CLAUDE_PLUGIN_ROOT}/hooks/uaeh-guardia-cierre.js" directo "motivo"` (queda con huella en `excepciones.jsonl`, en la carpeta de estado de UAEH: `UAEH_HOME`, por defecto `~/.claude/uaeh`).
- **No está en la lista → sal de este protocolo** y haz la tarea directo: cambio mínimo, pruebas del área tocada, relee el diff y muéstraselo al usuario. Sin builder, sin verificador, sin sello, sin auditores. Con duda, va directo y se anota el supuesto.
- Sí está en la lista → sigue. Riesgo `high` por defecto; `critical` si mueve dinero real, borra datos, toca datos de salud o es una migración destructiva.
- `uaeh-harness:uae-triage` solo si de verdad no puedes saber qué toca la tarea sin leer medio repo.

## Protocolo (solo lista blanca)
1. **Preflight: NO.** Solo antes de un lanzamiento o si el usuario lo pide. La línea de aviso que el plugin imprime al abrir la sesión es informativa.
2. **Checkpoint y presupuesto.**
   - `git status --short`, rama, commit base y **hora de inicio** (anótalos).
   - Dile al usuario en una línea qué vas a hacer y cuánto estimas (meta ≤ 30 min).
   - Worktree **solo** si otra terminal está escribiendo en el mismo repo ahora mismo (`referencias/concurrencia.md`). **Nunca** `reset`/`stash`/`checkout` sobre trabajo ajeno.
3. **Plan.** En `high` lo haces tú en línea, en 10 líneas (objetivo, archivos, criterios de aceptación verificables, pruebas). En `critical` → `uaeh-harness:uae-architect` (plan, rollback, pruebas) y el OK del usuario antes de construir.
4. **Construye esta conversación.** Ya tiene el contexto: sin brief de constructor y sin un agente que relea el repo.
   - Cambio mínimo + **al menos una prueba** del comportamiento nuevo (en seguridad: una regresión que falla antes y pasa después; demuéstralo en los dos estados).
   - Corre tú las pruebas del área antes de pasar a revisión.
   - `uaeh-harness:uae-builder` **solo** si: hay 2+ piezas independientes para hacer en paralelo, el cambio pasa de ~300 líneas, o es `critical`. Entonces le das el brief completo (objetivo, archivos permitidos, criterios, pruebas, commit base, prohibiciones): no ve esta conversación.
   - La garantía se conserva: **quien construye nunca verifica.**
5. **Congela el estado.** Commit de trabajo en la rama de la tarea (mensaje que sigue la política de commits del usuario: `commits.credito` y `commits.firma` de `uaeh.config.json`); si el proyecto no lo admite, no edites nada mientras revisan. Los revisores miran ese estado exacto.
6. **Revisión en paralelo — en UN solo mensaje**, los dos en segundo plano:
   - **`uaeh-harness:uae-verifier`** (siempre).
   - **`uaeh-harness:uae-security`** si toca dinero o cuentas → si la capa 3 está instalada, sigue `/uaeh-harness:uae-security diff <commit base>` (la pasada determinista y Codex arrancan antes, en segundo plano; el agente sale en el mismo mensaje que el verificador); si no, `uaeh-harness:uae-security` revisa el diff sin caja de arena y sus hallazgos quedan `needs_validation`.
   - **Sello:** toma la foto antes de lanzarlos (imprime un id) y compárala cuando terminen los dos; además, cada revisor tiene su foto automática por agente.
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-integridad.cjs" foto <repo>
     node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-integridad.cjs" comparar <id> <repo>
     ```
     `ROTA` anula y se repite UNA vez; si reincide, `BLOCKED`. **Sin foto del orquestador, o con el sello de un revisor en `ROTA`, el veredicto no vale: se repite UNA vez o se reporta `UNKNOWN`, nunca PASS** (el autor midió casos en que se reportó PASS con sellos ROTA y sin foto: no se repite). Termina toda edición de la configuración de Claude Code y de Codex antes de la foto y cierra la app de Codex si está abierta.
   - **Brief de cada revisor = mapa de lectura:** comando exacto del diff, archivos cambiados, ≤ 5 archivos de contexto que de verdad necesita, comandos exactos de las pruebas del área, criterios de aceptación y **tope de 15 min**. Si no le alcanza → `UNKNOWN` con lo que faltó; no se repite para «conseguir» un PASS.
   - **Pruebas:** solo las del área. La batería completa del proyecto corre **únicamente** antes de publicar.
   - Base de datos/migraciones → el verificador revisa reversibilidad, bloqueos y borrados del diff; `claude-db:audit` (si está instalado) solo en `critical`.
   - Cambia qué datos personales se recogen o para qué → `legal:compliance-check` (si está instalado), en línea, mientras revisan.
   - **Visual: ninguna puerta.** Si también cambia una pantalla, captura al usuario; la puerta visual (capa 3) solo si el usuario la pide.
7. **Si falla: NO hay bucle.**
   - Ante FAIL o UNKNOWN: al usuario el hallazgo exacto en 3-5 líneas (qué, dónde, qué prueba lo demuestra) y una recomendación; **él decide**.
   - Si decide arreglar: lo arregla esta conversación; se re-verifica **solo el criterio que falló** (un `uaeh-harness:uae-verifier` con ese criterio y sus pruebas). Seguridad se repite solo si el arreglo toca lógica de seguridad; un `SEC-NNN` cerrado exige la re-prueba de la puerta de seguridad (capa 3): `/uaeh-harness:uae-security reprobar SEC-NNN`.
   - Regresión → se preserva el trabajo (sin reset) y se pide decisión.
   - **Hallazgos fuera del brief** (de quien sea, incluidos los anteriores al diff): a una lista en `tasks/todo.md` + se le presentan al usuario al cerrar. **Jamás** abren un ciclo, una versión ni una tarea por sí solos.
   - Un crítico o alto confirmado dentro del diff = `BLOCKED_SECURITY`.

## Estado final (siempre, con evidencia: comando, código de salida y número de pruebas)
- `PASS_TECHNICAL`: código y verificación automática correctos. **No** autoriza producción.
- `PASS_RELEASE_READY`: todas las puertas exigibles aprobadas y la autorización humana obtenida.
- `PENDING_HUMAN_REVIEW`: decisión regulada, sensible o irreversible pendiente.
- `BLOCKED_SECURITY`: vulnerabilidad crítica o alta abierta.
- `FAIL`: prueba o requisito incumplido.
- `UNKNOWN`: falta evidencia. **Jamás** se reporta como PASS.

Entrega: estado, evidencias, archivos, riesgos residuales, minutos que tardó y siguiente acción. Sin push ni deploy salvo la regla del proyecto o una orden explícita del usuario. Nunca muestres secretos.

## Registro (OBLIGATORIO en cuanto llegan los veredictos)
En el mismo turno en que recibes los veredictos, antes de contárselo al usuario y con el estado de ESE momento (también `PENDING_HUMAN_REVIEW` o `FAIL`); una línea por tarea:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-registro.cjs" --proyecto <carpeta> --ruta <build|deep> --riesgo <high|critical> --ciclos <n> --minutos <min desde la hora de inicio> --escalamiento <ninguno|detalle> --estado <ESTADO> --tarea "<resumen corto>"
```
(`--ruta`: `build` = construyó esta conversación; `deep` = hubo arquitecto o builder.) Si pasó de 60 min o entró por error, anota la causa en `tasks/lessons.md`.
- La **guardia de cierre** (hook `Stop`) no deja terminar la respuesta mientras haya revisores sin registro; avisa una sola vez por sesión y después calla. Una re-verificación de una tarea ya registrada NO se registra otra vez: `node "${CLAUDE_PLUGIN_ROOT}/hooks/uaeh-guardia-cierre.js" descartar "motivo"`. Las excepciones quedan en `excepciones.jsonl` (carpeta de estado de UAEH) y se le presentan al usuario al cerrar.
- Medir: `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-resumen.cjs" 7` (meta ≤ 30 min por tarea; a los 60 se para).

## Referencias (solo si hacen falta)
- `referencias/estados-y-paro.md`: flujo, condiciones de paro y cuándo está terminada una tarea.
- `referencias/puertas.md`: qué puerta corre según lo que toca la tarea y cuándo está prohibido publicar.
- `referencias/concurrencia.md`: varias terminales en el mismo repo, worktrees y relevo Claude → Codex.
