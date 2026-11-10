---
name: setup
description: Instala la capa 2 del método UAEH (arnés de verificación) paso a paso y primero en seco. Crea uaeh.config.json, copia la guarda de git a su espejo estable, la prueba con un repo temporal y la activa; opcionalmente prepara Codex. Úsala tras instalar el plugin uaeh-harness, o cuando linea-inicio avise que la guarda falta o está desactualizada.
argument-hint: "[git-guard | codex | config | visual | todo | puertas <puerta>] [--aplicar] [--quitar] [--reemplazar]"
disable-model-invocation: true
---
# UAEH · setup del arnés (capa 2)

Argumentos: $ARGUMENTS

Ejecuta el instalador del plugin **primero en seco** (sin `--aplicar`) y muéstrale al usuario qué cambiaría. Solo con su OK repite con `--aplicar`. El instalador deja respaldo de todo archivo que pisa y nunca borra nada.

## Pasos

1. **Configuración** (`config`): crea `UAEH_HOME/uaeh.config.json` (por defecto `~/.claude/uaeh/uaeh.config.json`) a partir de la plantilla si no existe. Nunca pisa uno existente.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" config
   ```
   Pregunta al usuario solo dos cosas y edita el archivo con sus respuestas: ¿prohibir el crédito de Claude en los commits y con qué firma? (`commits.credito`, `commits.firma`); ¿hay nombres de archivo propios que siempre sean dinero/cuentas/base de datos/producción? (`listaBlanca.agregar`).

2. **Guarda de git** (`git-guard`): copia `git-hooks/`, `hooks/guardia-commit.cjs`, `hooks/guardia-git.js` y los scripts del sello al espejo `UAEH_HOME/estable/uaeh-harness/`, corre una **prueba de humo** en un repo temporal (un commit limpio pasa; un `.env` y un secreto falso se niegan) y, solo si la prueba pasa, fija `core.hooksPath` global al espejo. Si ya hay otro `core.hooksPath` (husky, otra guarda) no lo pisa: lo reporta y el usuario decide. Solo si el usuario lo pide, `--reemplazar` lo sustituye tras la prueba de humo y lo anota (la reversa lo restaura); nunca lo quites con `git config` a mano: el valor anterior se perdería para la reversa.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" git-guard
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" git-guard --aplicar
   ```
   Reversa: `node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" git-guard --quitar --aplicar` (quita el `core.hooksPath` solo si apunta al espejo, o restaura el anterior si quedó anotado; el espejo se conserva). Emergencia sin Node: `git config --global --unset core.hooksPath` en la terminal del usuario.

3. **Codex** (`codex`, opcional; solo si el usuario quiere un auditor independiente de otra familia de modelos): renderiza el bloque UAEH de `~/.codex/AGENTS.md` (entre marcadores, con respaldo) y los agentes `uae_*.toml` con los modelos de `codex.modelos`; imprime el fragmento de `config.toml` para pegar a mano (nunca se edita automáticamente). Explica antes que usar Codex envía una copia limpia del repo a OpenAI.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" codex
   ```

4. **Todo junto** (`todo`): `config` + `git-guard` (+ `codex` si `codex.habilitado` es `true`).

5. **Puerta visual** (`visual`, opcional y por proyecto; no entra en `todo`): `--proyecto <carpeta>` copia al proyecto las plantillas de Playwright + axe y el `DESIGN.md` si falta, sin pisar nunca un archivo suyo, y agrega las exclusiones de evidencia (`--local` las pone en el archivo privado del clon, para repos ajenos). `--registrar-skills` arma el borrador del catálogo visual propio desde las skills instaladas (no pisa uno existente; `--reemplazar` lo regenera con respaldo).
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" visual --proyecto <carpeta>
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" visual --registrar-skills
   ```
   Después, una vez por máquina, la autoprueba de la puerta: `node "${CLAUDE_PLUGIN_ROOT}/skills/uae-visual/pruebas/probar-visual.cjs" --instalar`.

6. **Puertas de la capa 3** (`puertas [seguridad|visual|codex|preflight|todas]`, no entra en `todo`): parte del diagnóstico de `doctor-puertas.cjs` y propone solo lo que falta.
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" puertas seguridad
   node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" puertas seguridad --aplicar
   ```
   - **Seguridad:** en Windows corre como root dentro de WSL `instalar.sh` (escáneres, reglas, Docker, imágenes) y/o `instalar-bin.sh` (caja de arena, validadores y `uaeh.conf`), después de copiar `/opt/uaeh` a `/opt/uaeh-respaldo/<fecha>`. Tras actualizar el plugin: `--actualizar` (solo `instalar-bin.sh`); `--reparar` fuerza los dos. En Linux imprime los comandos con `sudo` para que el usuario los corra. Instalar WSL, activar systemd y `wsl --terminate` los hace el usuario: dale los pasos que imprime el instalador.
   - **Visual:** `playwright-cli` global con el pin y las dependencias de la autoprueba en la caché.
   - **Codex — consentimiento:** el auditor Codex manda a OpenAI la copia limpia de cada repo auditado. Explícaselo al usuario y pregúntale si lo acepta; **solo con su sí explícito en esta conversación** corre `puertas codex --consiento --aplicar` (pone `codex.habilitado=true` y la fecha en `codex.consentimiento`). Para apagarlo: `--retirar --aplicar`. Sin consentimiento el auditor no corre (sale `NO_HABILITADO`) y la puerta de seguridad sigue sin él. `npm i -g @openai/codex` y `codex login` los hace el usuario.
   - **Preflight:** viene completo en el plugin; solo se diagnostica.
   Al terminar: `/uaeh-harness:doctor puertas`. Las corridas de la puerta de seguridad guardan copias del código: `node "${CLAUDE_PLUGIN_ROOT}/scripts/uaeh-runs.cjs" tamano` y `… limpiar` (en seco; `--aplicar` compacta a los 30 días, borra a los 365 y conserva siempre las 3 más recientes de cada repo).

## Después
- **Reabrir todas las sesiones.** Tras instalar o actualizar el plugin, el usuario debe cerrar y volver a abrir TODAS las sesiones de Claude Code (cada terminal y la aplicación de escritorio). Una sesión abierta antes sigue sin las guardas ni los agentes `uaeh-harness:*`, y `/clear` no lo corrige. Tras actualizar, además: `git-guard --aplicar` refresca el espejo de la guarda.
- Dile al usuario qué hooks del plugin BLOQUEAN y cómo desactivarlos: `/plugin disable uaeh-harness`. Si Node falla, el hook `guardia-git.js` (con `onFailure: block`) bloquea todo Bash/PowerShell hasta reparar o desactivar el plugin.
- Si el usuario tenía una instalación manual del método (hooks en `settings.json`), recuérdale que quedan duplicados y que los puede quitar; el doctor del kit (`/uaeh-kit:doctor`) los señala.
- Reporta en una lista corta: qué se escribió, qué se respaldó, el resultado de la prueba de humo y el estado de `core.hooksPath`.
