---
name: uae-security
description: Auditoría de seguridad de un repositorio (security audit, pentest de código, secretos filtrados, dependencias vulnerables), revisión de un diff de riesgo alto, re-prueba de un arreglo y puerta antes de lanzar. Escáneres primero, auditor independiente de otra familia (Codex, solo lectura) y confirmación con prueba en una caja de arena sin red.
argument-hint: "[quick|standard|deep|diff <base>|incremental <categorías>|reprobar <id>|lanzamiento] [ruta-repo]"
---
# /uaeh-harness:uae-security — UNA auditoría de seguridad real

Corre en la conversación principal (orquesta subagentes). Responde al usuario en su idioma y en llano; los archivos `findings.json` y `coverage-ledger.json` van en inglés porque los validadores lo exigen.

**Plataformas:** la caja de arena (capa 3) corre en Windows 11 con WSL2 (probado) y en Linux Ubuntu 24.04 x86_64 (probado en la CI, de forma nativa). En macOS no está soportada: la confirmación queda `UNKNOWN`.

**Las 4 garantías (no negociables):**
1. **Independencia:** ningún auditor ve la conversación que construyó el código; solo el repo, el diff y la evidencia. Codex (otra familia) revisa **a ciegas**, sin ver los hallazgos de Claude.
2. **Herramientas sin opinión primero:** la pasada determinista corre siempre y antes que cualquier modelo.
3. **Confirmado = reproducido** en la caja de arena (`uaeh-sandbox`: sin red, solo lectura, datos ficticios). Sin reproducción → `needs_validation`. Nunca contra producción.
4. **Corregido = re-probado por el auditor** (un agente fresco, nunca el que arregló) + prueba de regresión que falla sin el arreglo y pasa con él.

## Prefijos (se definen una vez; el resto del documento los usa)
- `<runs>` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" runs-dir --repo <repo>` (carpeta de corridas del repo, fuera de él).
- `<PREFIJO_MOTOR>` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" prefijo-motor` (lo que va antes de un programa de Linux; en Linux es una línea vacía).
- `<PREFIJO_CAJA>` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" prefijo-caja` (la caja de arena: `<PREFIJO_MOTOR>` + `/opt/uaeh/bin/uaeh-sandbox ejecutar`).
- `<RUN_MOTOR>` = `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" ruta-motor <run>` (la ruta del run como la ve el motor de Linux).
- Los agentes se citan siempre con prefijo (`uaeh-harness:uae-security`, `uaeh-harness:uae-verifier`). `Explore` y `/security-review` (comando integrado de Claude Code) van tal cual.

## 0. Preparación (todos los modos)
- **Repo** = argumento o el directorio actual (raíz git). **Nombre** = carpeta. **Run** = `<runs>/run-<N>` (siguiente N libre; nunca dentro del repo).
- **Riesgo del proyecto:** salud o dinero → `critico` · datos personales → `alto` · lo demás → `medio`. **Perfil por defecto:** crítico → `deep`, alto → `standard`, medio → `quick` (o el que pida el usuario).
- **Motor y Docker** (el primer arranque tarda 5-10 s): `node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor-puertas.cjs" --puerta seguridad --rapido` (motor, escáneres contra los pines, Docker, caja de arena igual al plugin, `uaeh.conf`). Si la puerta no sale `LISTA` → lo que falte queda `UNKNOWN` (sin Docker o sin caja de arena, toda la confirmación); dilo con el comando de arreglo que imprime y sigue solo con fuente.
- **Modelo de amenazas primero:** lee `docs/harness/THREAT_MODEL.md`; si no existe, respóndelo por escrito ANTES de abrir código (qué datos y de qué clase, quién entra y quién no, quién atacaría y para qué, el peor día) y guárdalo ahí.
- **Corridas previas:** `<runs>/estado-hallazgos.json`, `<runs>/run-*/findings.json` y `<runs>/run-*/coverage-ledger.json`, más `docs/harness/AUDIT_REPORT.md`. Entran al libro de cobertura según `${CLAUDE_PLUGIN_ROOT}/vendor/security-audit/SKILL.md` líneas 96-105 (nunca se reaudita lo mismo sin cambios; nunca «lo demás está bien»).
- **Repo ajeno o de un cliente:** si `docs/harness/` no debe entrar a su git, usa el archivo privado del clon: `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-ignorar.cjs" --repo <repo> --local --aplicar` (sin `--aplicar` solo informa). Eso cubre la evidencia de las puertas, no `docs/harness/`: esa carpeta se añade a mano a `.git/info/exclude`.

## 1. Modo completo (`quick` | `standard` | `deep`)
1. **Pasada determinista** (cero tokens): `node "${CLAUDE_PLUGIN_ROOT}/skills/uae-security/scripts/pasada-determinista.cjs" <repo> <run>`. Crea la copia limpia `<run>/fuente/` (sin `.env` ni archivos ignorados: los datos privados no salen) y `<run>/deterministico.json`. Corre gitleaks (historial y carpeta, siempre con `--redact`), semgrep, osv-scanner, `npm audit`/`pnpm audit` y, con Python del equipo, los dos scripts de cyber-neo vendorizados (secretos y lockfiles). Salida 0 = OK · 3 = `UNKNOWN` (una herramienta `FALLÓ` o `NO_INSTALADA`: el estado global no puede ser PASS) · 2 = uso o entorno. Antes de usar cyber-neo comprueba que su copia vendorizada esté íntegra y parcheada (el parche enmascara la evidencia de secretos); si no, esa herramienta queda `FALLÓ`. Verificación manual: `node "${CLAUDE_PLUGIN_ROOT}/scripts/aplicar-parche-cyber-neo.cjs" --verificar` → `PARCHEADO` (0) · `SIN_PARCHE` (3) · `DESCONOCIDO` (4). Si además usas cyber-neo como skill propia, aplícale el parche con `--aplicar --destino <carpeta>` (`--revertir` lo deshace).
2. **Codex en segundo plano** (Bash con `run_in_background`; opcional, ver `referencias/codex.md`): `node "${CLAUDE_PLUGIN_ROOT}/skills/uae-security/scripts/auditor-codex.cjs" <run> completa --modelo <profundo en standard/deep | equilibrado en quick> --amenazas <repo>/docs/harness/THREAT_MODEL.md`. Codex envía la copia limpia a OpenAI: solo corre si el usuario dio su consentimiento (`codex.habilitado`); si no, sale con 3 (`NO_HABILITADO`) sin enviar nada: esa pieza no se reintenta y se reporta como no corrida. En el repo de un tercero, confirma además con su responsable.
3. **Dependencias para las PoC** (si hay lockfile y la confirmación lo necesitará): `<PREFIJO_MOTOR> /opt/uaeh/bin/uaeh-sandbox preparar-deps --run <RUN_MOTOR> --gestor <npm|pnpm>` → nombre del volumen. Si falla (scripts de instalación) → las PoC que lo requieran quedan `needs_validation` con ese motivo.
4. **Auditoría con `security-audit` en modo full audit** — lee `${CLAUDE_PLUGIN_ROOT}/vendor/security-audit/SKILL.md` y sigue sus 6 fases tal cual (libro de cobertura, olas, validación, `findings.json`, verificación independiente, reporte). Lo propio de esta skill:
   - el **run, la fuente y el `run-metadata.json`** son los de los pasos anteriores; `execution_capability` = «uaeh-sandbox (Docker en el motor de Linux, --network none, ver referencias/caja-de-arena.md); dependencias preparadas con --ignore-scripts por el padre»;
   - **roles y modelos:** `referencias/roles-y-presupuesto.md` (reconocimiento con `Explore` en sonnet; cazadores y verificadores `uaeh-harness:uae-security` con `model:"sonnet"`; crítico y verificación final de lo crítico/alto con `uaeh-harness:uae-security` en opus);
   - **semillas de candidatos:** los hallazgos de `deterministico.json` y, cuando termine, los de `<run>/codex/hallazgos.json` entran como candidatos con su fingerprint; NUNCA se confirman solos;
   - **material de caza** por tecnología: las referencias de `${CLAUDE_PLUGIN_ROOT}/vendor/cyber-neo/references/` (`lang-javascript`, `lang-python`, `auth-authz-patterns`, `web-security-patterns`, `crypto-patterns`, `cicd-security`, `iac-docker`, `secrets-patterns`, `supply-chain`, `owasp-top-10`, `cwe-top-25`, `error-handling-patterns`, `logging-patterns`, `report-template`), además de las companion de `security-audit`;
   - **sello de integridad** alrededor de cada agente `uaeh-harness:uae-security` (cazador, verificador, crítico): `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-integridad.cjs" foto <repo>` antes y `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-integridad.cjs" comparar <id> <repo>` después; `ROTA` anula su veredicto;
   - **dinero:** si el proyecto mueve dinero, la unidad `referencias/dinero-toctou.md` es obligatoria en el libro;
   - **filtro contra falsos positivos** antes de validar: `referencias/filtro-falsos-positivos.md`;
   - **confirmación:** el verificador corre la PoC con la caja de arena (guía y línea de uso en `referencias/caja-de-arena.md`) y guarda en el registro el comando exacto, la entrada y los límites; solo el padre promueve evidencia con `uaeh-promover`;
   - **validadores:** `<PREFIJO_MOTOR> /opt/uaeh/bin/uaeh-validar <RUN_MOTOR>` (los validadores originales, con Node de Linux). Deben pasar los dos.
5. **Informe** (sección 6).

## 2. Modo `diff <base>` (desde `/uaeh-harness:uae-loop`, cuando la tarea toca dinero o cuentas)
Versión rápida. Medido por el autor: la seguridad de un diff tomó 6 min cuando corrió una sola vez; lo caro eran las repeticiones y el revisor duplicado.
- **Primero, en segundo plano:** `pasada-determinista.cjs <repo> <run> --base <base>` y luego `auditor-codex.cjs <run> diff --repo <repo> --base <base> --modelo profundo` (mismas rutas del plugin que en el modo completo).
- **UN agente `uaeh-harness:uae-security` (opus)** sobre el diff (sin rol de `security-audit`: formato `SEC-NNN`), lanzado **en el mismo mensaje que el `uaeh-harness:uae-verifier`** de `/uaeh-harness:uae-loop`. Su brief lleva el mapa de lectura (diff exacto, archivos cambiados, ≤ 5 de contexto) y un **tope de 15 min**.
- **`/security-review` no corre siempre** (duplicaba al agente): solo en `critical` o si Codex y el agente discrepan sobre un candidato alto o crítico.
- **Sello de integridad** alrededor de cada `uaeh-harness:uae-security` (modos completo, `diff` y `reprobar`): `foto` antes y `comparar` después, con los comandos de la sección 1; `ROTA` anula su veredicto.
- **Caja de arena solo para candidatos alto/crítico DENTRO del diff.** Lo que ya existía antes del diff va a la lista de `tasks/todo.md` (o la del proyecto) como `por_validar` para que el responsable decida, sin corrida de confirmación ahora. Cada candidato del diff pasa el filtro de falsos positivos. Sin `coverage-ledger` completo: es una corrida **parcial** y así se reporta.
- Si Codex no terminó en su tope (`codex.timeoutDiffMin`, 10 min por defecto) → esa pieza queda `UNKNOWN`, se dice y no se repite.
- Devuelve a `/uaeh-harness:uae-loop`: `PASS` | `BLOCKED_SECURITY` (crítico o alto confirmado en el diff) | `UNKNOWN`, con los IDs.

## 3. Modo `incremental <categorías>` (desde `/uaeh-harness:uae-preflight`, cuando cambió la huella)
El preflight solo corre antes de lanzar o a pedido del usuario. Este modo es igual que el completo pero acotado (corrida *scoped* de `security-audit`): solo las unidades del libro que tocan las categorías cambiadas (`git diff <commit del sello>..HEAD`). Todo lo demás queda `out_of_scope`, nunca `covered`.

## 4. Modo `reprobar <id>` (tras un arreglo)
Lo hace un `uaeh-harness:uae-security` **fresco** (opus), nunca el builder ni quien lo diseñó:
1. Run nuevo con la fuente del commit del arreglo (`pasada-determinista.cjs`), y otra fuente del commit base en `<run>/fuente-base/` (misma copia limpia, desde un `git worktree` temporal o `git archive` del commit base; nunca tocar el árbol de trabajo).
2. Re-ejecuta **la PoC exacta** guardada en el hallazgo (`execution.payloads/instructions` + línea de la caja de arena) contra la fuente del arreglo → **no debe reproducirse**.
3. Corre la **prueba de regresión** del arreglo en la caja de arena sobre la fuente base (**debe fallar**) y sobre la del arreglo (**debe pasar**).
4. Solo si 2 y 3 se cumplen → `corregido-verificado` con fecha y hora (zona configurada: `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-config.cjs" ahora-local`) en `estado-hallazgos.json` y `AUDIT_REPORT.md`. Si no → sigue abierto, con la evidencia.

## 5. Modo `lanzamiento` (puerta antes de publicar al público)
`referencias/lanzamiento.md`: cero críticos o altos `confirmados` abiertos; nada `por_validar` crítico sin plan; pasada determinista de hoy en `OK`; las fases de la lista previa al lanzamiento (`referencias/checklist-prelanzamiento.md`) revisadas; en salud o dinero, **recomendar un pentest humano externo** antes de escalar usuarios (los agentes no lo sustituyen). Este modo exige la segunda familia (Codex) salvo que el responsable la descarte de forma explícita (por privacidad: Codex envía la copia limpia a OpenAI).

## 6. Informe y estado (todos los modos)
- **Escala y estados únicos:** `referencias/escala-y-estados.md` (crítico/alto/medio/bajo con bandas CVSS; `confirmado` · `por_validar` · `rechazado` · `corregido-verificado` · `aceptado`). La gravedad solo va en lo confirmado.
- `docs/harness/AUDIT_REPORT.md` → sección «Seguridad (/uaeh-harness:uae-security)» con cada hallazgo en el formato de 10 campos del preflight (ID `SEC-NNN`, evidencia `archivo:línea`, amenaza, gravedad, probabilidad/impacto, acción, prueba, responsable, estado, decisión).
- `<runs>/estado-hallazgos.json` → `{ "<SEC-NNN>": {fingerprint, estado, gravedad, run, fecha, poc_comando} }`: la memoria entre corridas.
- **Sello:** solo en completo o incremental Y si ya existe `docs/harness/.preflight.json` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-huella.cjs" sellar <repo> --tipo <completa|incremental> --riesgo <r> --hallazgos <IDs abiertos> --nuevos <n> --cerrados <m> --categorias <auditadas>` (agrega la fila del «Historial de corridas»). Sin preflight → dilo: «falta `/uaeh-harness:uae-preflight`».
- **Estado global:** `BLOCKED_SECURITY` si queda un crítico o alto confirmado y abierto · `UNKNOWN` si faltó una herramienta obligatoria, la caja de arena o Codex, o el run quedó `incomplete` · si no, `PASS`.
- **Registro:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-registro.cjs" --proyecto <repo> --ruta deep --riesgo <medio|alto|critico> --ciclos 1 --minutos <min> --estado <PASS_TECHNICAL|BLOCKED_SECURITY|UNKNOWN> --tarea "seguridad <modo>"`. En modo `diff` lanzado desde `/uaeh-harness:uae-loop` no se registra aparte: lo registra `/uaeh-harness:uae-loop` al cerrar.
- **Respuesta al usuario** (≤ 25 líneas): estado global, conteo por estado y gravedad, los 3-5 más graves con `archivo:línea` y qué sigue (cada arreglo es su propia tarea con `/uaeh-harness:uae-loop`, que termina con `reprobar`).

## Reglas duras
- Nunca imprimir un secreto: los escáneres corren con `--redact`; cita la ubicación, nunca el valor.
- Nunca ejecutar código del proyecto fuera de `uaeh-sandbox`; nunca `docker` directo desde un agente (el candado lo niega).
- Nunca auditar ni probar contra producción, cuentas reales, terceros o datos reales. Las bases son desechables y los datos ficticios.
- Ningún hallazgo de un modelo (Claude o Codex) se confirma sin reproducción. Ningún hallazgo se cierra sin `reprobar`.
- La auditoría no modifica el repo salvo `docs/harness/`; los arreglos van por `/uaeh-harness:uae-loop`.
