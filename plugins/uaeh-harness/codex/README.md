# uaeh-harness · codex/ — optional Codex templates

**Optional, and OFF by default** (`codex.habilitado = false` in `uaeh.config.json`). The harness works without Codex. These files let Codex (OpenAI) follow the same UAEH rules as Claude Code (for example, to take over when Claude's usage limit runs out) and give it the same five roles as native Codex agents.

| File | What it is |
|---|---|
| `AGENTS.md` | Template of the UAEH block that the installer inserts into `~/.codex/AGENTS.md`, between `<!-- UAEH:BEGIN v… -->` and `<!-- UAEH:END -->`; the markers let the installer find the block and replace it in place without touching the rest of the file. |
| `agents/uae_*.toml` | Five Codex agent templates: `uae_architect`, `uae_builder`, `uae_security`, `uae_triage`, `uae_verifier`. Model and effort come from `codex.modelos` (levels `profundo`, `equilibrado`, `rapido`). |
| `config.snippet.toml` | Four keys (`project_doc_fallback_filenames`, `project_doc_max_bytes`, `[agents] max_concurrent_threads_per_session`, `[windows] sandbox`) to paste **by hand** into `~/.codex/config.toml`. |

**Privacy: using Codex sends a clean copy of your repository to OpenAI.** That is why it ships disabled and needs your explicit consent: it stays off until you turn it on.

## How the templates are used

The installer renders the templates and writes them (dry-run by default; `--aplicar` writes, keeping a backup of anything it overwrites):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" codex
```

(`${CLAUDE_PLUGIN_ROOT}` is the plugin's install folder; `/uaeh-harness:setup codex` runs this for you.) It fills these placeholders:

| Placeholder | Filled with |
|---|---|
| `{{VERSION}}` | the plugin version |
| `{{UAEH_ESTABLE}}` | the stable mirror folder where the seal and ledger scripts live |
| `{{MODELO_PROFUNDO}}`, `{{ESFUERZO_PROFUNDO}}` | `codex.modelos.profundo` (agents `uae_architect`, `uae_security`) |
| `{{MODELO_EQUILIBRADO}}`, `{{ESFUERZO_EQUILIBRADO}}` | `codex.modelos.equilibrado` (agent `uae_verifier`) |
| `{{MODELO_RAPIDO}}`, `{{ESFUERZO_RAPIDO}}` | `codex.modelos.rapido` (agents `uae_builder`, `uae_triage`) |

- `~/.codex/config.toml` is **never touched automatically**: the snippet is only printed for you to paste. On Windows, the `elevated` sandbox may ask for administrator permission the first time.
- `sandbox_mode` in each agent is **not a guarantee** (measured by the author). The guarantee is the integrity seal that the orchestrator takes before and after every review.

---

# uaeh-harness · codex/ — plantillas opcionales de Codex

**Opcional y APAGADO por defecto** (`codex.habilitado = false` en `uaeh.config.json`). El arnés funciona sin Codex. Estos archivos permiten que Codex (OpenAI) siga las mismas reglas UAEH que Claude Code (por ejemplo, para relevarlo cuando se le acaba el límite de uso) y le dan los mismos cinco roles como agentes nativos de Codex.

| Archivo | Qué es |
|---|---|
| `AGENTS.md` | Plantilla del bloque UAEH que el instalador inserta en `~/.codex/AGENTS.md`, entre `<!-- UAEH:BEGIN v… -->` y `<!-- UAEH:END -->`; los marcadores permiten al instalador encontrar el bloque y reemplazarlo en su sitio sin tocar el resto del archivo. |
| `agents/uae_*.toml` | Cinco plantillas de agentes de Codex: `uae_architect`, `uae_builder`, `uae_security`, `uae_triage`, `uae_verifier`. El modelo y el esfuerzo salen de `codex.modelos` (niveles `profundo`, `equilibrado`, `rapido`). |
| `config.snippet.toml` | Cuatro claves (`project_doc_fallback_filenames`, `project_doc_max_bytes`, `[agents] max_concurrent_threads_per_session`, `[windows] sandbox`) para pegar **a mano** en `~/.codex/config.toml`. |

**Privacidad: usar Codex envía una copia limpia de tu repositorio a OpenAI.** Por eso viene desactivado y exige tu consentimiento explícito: sigue apagado hasta que lo actives.

## Cómo se usan las plantillas

El instalador las renderiza y las escribe (en seco por defecto; `--aplicar` escribe y deja respaldo de lo que pisa):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/instalar.cjs" codex
```

(`${CLAUDE_PLUGIN_ROOT}` es la carpeta donde se instala el plugin; `/uaeh-harness:setup codex` lo corre por ti.) Rellena estos marcadores:

| Marcador | Se rellena con |
|---|---|
| `{{VERSION}}` | la versión del plugin |
| `{{UAEH_ESTABLE}}` | la carpeta del espejo estable donde viven los scripts del sello y del registro |
| `{{MODELO_PROFUNDO}}`, `{{ESFUERZO_PROFUNDO}}` | `codex.modelos.profundo` (agentes `uae_architect`, `uae_security`) |
| `{{MODELO_EQUILIBRADO}}`, `{{ESFUERZO_EQUILIBRADO}}` | `codex.modelos.equilibrado` (agente `uae_verifier`) |
| `{{MODELO_RAPIDO}}`, `{{ESFUERZO_RAPIDO}}` | `codex.modelos.rapido` (agentes `uae_builder`, `uae_triage`) |

- `~/.codex/config.toml` **nunca se toca automáticamente**: el fragmento solo se imprime para que lo pegues. En Windows, el sandbox `elevated` puede pedir permiso de administrador la primera vez.
- `sandbox_mode` en cada agente **no es una garantía** (medido por el autor). La garantía es el sello de integridad que el orquestador toma antes y después de cada revisión.
