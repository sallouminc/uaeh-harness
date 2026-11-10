# Auditor Codex (otra familia de modelo, solo lectura)

En la puerta de seguridad **Codex solo lee** y da una segunda opinión independiente: quien construyó el código nunca se califica a sí mismo, y un modelo de otra familia ve cosas distintas. Es opcional y está apagado por defecto (`codex.habilitado` en `uaeh.config.json`); necesita la sesión de Codex CLI iniciada (`codex login`).

## Privacidad y consentimiento
Codex manda a OpenAI el código de la copia limpia que se le da (`<run>/fuente/`). La copia limpia no lleva `.env` ni archivos ignorados por git. **Sin consentimiento no corre:** con `codex.habilitado` en `false`, `auditor-codex.cjs` sale con 3 (`NO_HABILITADO`) sin lanzar Codex. El consentimiento lo da el usuario con `instalar.cjs puertas codex --consiento --aplicar` (deja la fecha en `codex.consentimiento`) y lo retira con `--retirar --aplicar`. Aun habilitado, nunca con código que no se pueda compartir con ese proveedor ni sin el visto bueno del responsable de un repo ajeno. `doctor-puertas.cjs --puerta codex` muestra el estado.

## Cómo corre
`node <plugin>/skills/uae-security/scripts/auditor-codex.cjs <run> completa|diff [--repo <repo> --base <commit>] [--modelo profundo|equilibrado|rapido] [--amenazas <archivo>] [--timeout-min N] [--prompt <plantilla>]`
- Por debajo: `codex exec --ignore-user-config -m <modelo> -c model_reasoning_effort=<e> -s read-only [-c windows.sandbox="elevated"] --ephemeral --skip-git-repo-check -C <run>/fuente --output-schema referencias/codex-salida.schema.json -o <run>/codex/hallazgos.json --json -` (el prompt va por stdin).
- `--ignore-user-config`: sin MCP, plugins ni uso del equipo (solo leer y razonar). El modelo y el esfuerzo vienen de `codex.modelos` de `uaeh.config.json`, no de la configuración de Codex.
- **Windows:** `windows.sandbox="elevated"` es obligatorio (medido por el autor con Codex 0.157.0 y de nuevo con 0.163.0, la versión mínima que exige el doctor): sin él, `-s read-only` bloquea hasta la lectura y el auditor queda ciego; con él, lee y la escritura da «Acceso denegado». **Linux:** `-s read-only` sin argumentos extra (no probado por el autor).
- **Nivel:** `profundo` en auditorías estándar o profundas y en diffs de dinero o cuentas; `equilibrado` (por defecto) en las rápidas e incrementales. Alias heredados: `astra` = `profundo`, `sol` = `equilibrado`. El nivel profundo suele tener una cuota corta por ventana: resérvalo para lo que lo merece.
- Corre en segundo plano. Medido por el autor en diffs reales: 1.5-2 min por corrida. Tope: el de la configuración según el modo — `codex.timeoutDiffMin` (**10 min** por defecto) en `diff` y `codex.timeoutCompletaMin` (**40 min** por defecto) en auditorías completas —, salvo que se pase `--timeout-min N`; al vencer mata el árbol de procesos.
- Salidas: `<run>/codex/{hallazgos.json, eventos.jsonl, stderr.txt, resumen.json}`; en diff también `cambios.patch` (sin archivos `.env`).

## Reglas
- **A ciegas:** el prompt (`referencias/prompt-codex.md`, o `prompt-codex.en.md` con `--prompt` si el proyecto trabaja en inglés) solo lleva la fuente, el alcance, el modelo de amenazas y el parche. Nunca los hallazgos de Claude.
- **Copia limpia:** Codex trabaja sobre `<run>/fuente/` (sin `.env` ni archivos ignorados: los datos personales que no están en git no salen). Nunca `codex exec review --uncommitted` (incluye no rastreados).
- **Límite conocido:** el sandbox de solo lectura de Windows NO restringe la lectura a la copia; el prompt lo instruye, pero un modelo desobediente podría leer otras rutas del disco. Por eso la copia limpia es la defensa principal y nunca se le da a Codex una ruta del repo real.
- **Sus hallazgos son candidatos:** entran al libro con su huella, pasan el filtro y la confirmación en la caja de arena como cualquier otro. Coincidencia Claude + Codex sube la prioridad, no el estado.
- **Antes de confiar en él (y tras cada actualización de Codex):** `node auditor-codex.cjs --probar-sandbox` → debe decir `SANDBOX_OK` (lee y no escribe). Si no → auditor Codex `UNKNOWN` y se reporta. `doctor-puertas.cjs --puerta codex --vivo` la corre y recuerda el resultado; sin `--vivo` avisa si Codex cambió de versión desde la última prueba.
