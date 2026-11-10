# Configuración

Esta página es la referencia de `uaeh.config.json`, el único archivo de configuración de UAEH, y de las variables de entorno y los subcomandos de `uaeh-config.cjs` que lo acompañan. Sirve para consultar qué hace cada clave, su valor de fábrica y cómo se valida.

## Dónde vive y cómo se crea

El archivo es `UAEH_HOME/uaeh.config.json`; por defecto, `~/.claude/uaeh/uaeh.config.json`. Es **el único archivo de configuración y nunca es por proyecto**: las guardas no pueden depender de un archivo que el propio repo revisado podría cambiar.

Se crea con el instalador, que lo copia desde la plantilla `plugins/uaeh-harness/templates/uaeh.config.example.json` y nunca pisa uno existente:

```
node "<plugin>/scripts/instalar.cjs" config            # en seco: muestra qué haría
node "<plugin>/scripts/instalar.cjs" config --aplicar  # lo crea
```

Sin archivo, todo funciona con los valores de fábrica. `/uaeh-harness:setup` hace este paso como parte de la instalación.

## Precedencia y validación

De mayor a menor: **bandera de línea de comandos > variable `UAEH_*` > archivo > valor de fábrica.**

La carga nunca lanza una excepción por una configuración rota. Una clave desconocida de primer nivel produce el aviso «clave desconocida en uaeh.config.json … (se ignora)»; un JSON que no parsea, un valor del tipo equivocado o fuera de rango producen un aviso y se usa el valor de fábrica. Los avisos los muestra el doctor ([diagnostico.md](diagnostico.md)) y la línea que el plugin imprime al abrir una sesión. Las claves que empiezan con `_` (por ejemplo `_comentario`) en la plantilla son notas y no tienen efecto.

## Ejemplo mínimo

```json
{
  "version": 1,
  "commits": { "credito": "prohibir", "firma": "Authored By: ejemplo.com" },
  "zonaHoraria": "America/Mexico_City",
  "preflight": { "jurisdiccion": "México" }
}
```

El resto de las claves toma su valor de fábrica; las secciones anidadas se fusionan con las de fábrica.

## Claves

### Generales

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `version` | número | `1` | Versión del formato del archivo. |
| `idioma` | `auto`, `es`, `en` | `auto` | Idioma de los textos que inyecta el kit; `auto` equivale a español en esta versión. Otro valor da aviso y cae a `auto`. |
| `zonaHoraria` | zona IANA | `""` | Zona de las fechas que escriben los scripts. Vacía: la del sistema. Una zona inválida da aviso. |

### `commits`

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `commits.credito` | `permitir`, `prohibir` | `permitir` | Con `prohibir`, la guarda de git niega la identidad o el crédito de Claude en autor, committer y mensaje. Secretos y archivos sensibles se revisan siempre. |
| `commits.firma` | texto | `""` | Línea final exigida en los mensajes cuando el crédito está prohibido. Vacía: sin firma. |

### `listaBlanca`

Define qué archivos obligan a pasar por el arnés (dinero, cuentas, base de datos, producción). Los patrones son expresiones regulares insensibles a mayúsculas sobre la ruta relativa en minúsculas; uno inválido se ignora con aviso.

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `listaBlanca.excluirRutas` | lista de textos | `[]` | Nombres de carpeta que no cuentan; se suman a los de fábrica (`tasks`, `docs`, `output`, `builds`, `node_modules`, `.git`, `respaldo`, `respaldos`, `captura`, `capturas`). |
| `listaBlanca.excluirExtensiones` | lista de textos | `[]` | Extensiones que no cuentan; se suman a las de fábrica (documentos, imágenes, video, `lock`, `css`, `scss`, `map`). |
| `listaBlanca.categorias` | objeto `{ categoría: [patrones] }` | `{}` | **Reemplaza** los patrones de fábrica de esa categoría. Las de fábrica: `dinero`, `cuentas`, `baseDeDatos`, `produccion`. |
| `listaBlanca.agregar` | objeto `{ categoría: [patrones] }` | `{}` | **Añade** patrones a una categoría de fábrica o nueva. |

### `arnes`, `reglas`, `statusline`

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `arnes.extra` | lista de `[carpeta, patrón, recursivo?]` | `[]` | Carpetas extra que el sello de integridad vigila. Solo rutas absolutas; las relativas o con `~` se ignoran con aviso. |
| `reglas.inyectar` | booleano | `true` | Si el kit inyecta las reglas del método por hook. Con `false` y sin bloque en un `CLAUDE.md`, el doctor del kit marca `FALLÓ`. |
| `statusline.estadoClaude` | booleano | `false` | La barra de estado muestra el punto de estado oficial de Claude y activa el vigilante. |
| `statusline.guardarLimites` | booleano | `false` | La barra guarda los límites 5h/7d en la caché. |

### `datos`

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `datos.runs` | ruta | `""` | Carpeta de las corridas de la puerta de seguridad. Vacía: `UAEH_HOME/runs`. |
| `datos.retencion.completasDias` | número | `30` | Edad desde la cual una corrida se compacta (se borran solo las copias del código). |
| `datos.retencion.borrarDias` | número | `365` | Edad desde la cual se borra la corrida entera. |
| `datos.retencion.mantenerUltimas` | número | `3` | Corridas más recientes de cada repo que se conservan siempre completas. |
| `datos.retencion.avisoGB` | número | `5` | Tamaño total a partir del cual se avisa que conviene limpiar. |

### `wsl`

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `wsl.distro` | texto | `Ubuntu-24.04` | Distro de WSL2 donde corren las piezas de Linux. Solo letras, números, `.`, `_` y `-`; si no, cae al defecto. |
| `wsl.usuario` | texto | `""` | Usuario de la distro. Minúsculas; nunca `root`; si no, se deja vacío. |

### `codex`

Codex es opcional y está **apagado por defecto**. Encenderlo envía a OpenAI una copia limpia del repo auditado (ver [codex.md](codex.md) y [privacidad.md](privacidad.md)).

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `codex.habilitado` | booleano | `false` | Sin `true`, el auditor Codex sale con `NO_HABILITADO` sin lanzar nada. |
| `codex.consentimiento` | texto | `""` | Fecha del consentimiento; la escribe `instalar.cjs puertas codex --consiento --aplicar`. |
| `codex.modelos.profundo` | `{ modelo, esfuerzo }` | `gpt-6-astra`, `high` | Modelo del nivel profundo. `esfuerzo`: `low`, `medium`, `high` o `xhigh`; un nivel incompleto cae al defecto. |
| `codex.modelos.equilibrado` | `{ modelo, esfuerzo }` | `gpt-6-sol`, `medium` | Nivel equilibrado. |
| `codex.modelos.rapido` | `{ modelo, esfuerzo }` | `gpt-6-luna`, `medium` | Nivel rápido. |
| `codex.timeoutDiffMin` | número entre 1 y 240 | `10` | Tope, en minutos, de una corrida del auditor Codex en modo `diff`. |
| `codex.timeoutCompletaMin` | número entre 1 y 240 | `40` | Tope, en minutos, de una corrida del auditor Codex en modo `completa`. |

Ambos topes se aplican cuando el auditor se lanza sin `--timeout-min N`; si se pasa, `--timeout-min` manda. Un valor fuera de rango o que no sea número da un aviso y se usa el defecto. Al vencer el tope se mata el árbol de procesos, y el tope usado queda en `codex/resumen.json` (`tope_min`).

La exigencia de la segunda familia (Codex) en el modo `lanzamiento` de la puerta de seguridad no es una clave: es una regla fija de la skill, que solo el responsable puede descartar de forma explícita.

Las claves `codex.exigir`, `visual.viewports` y `proyectos` se retiraron de la configuración. Un archivo antiguo que aún las tenga sigue cargando sin avisos: se ignoran y se pueden borrar.

### `visual`, `preflight`

| Clave | Tipo | Defecto | Qué controla |
|---|---|---|---|
| `visual.catalogo` | ruta absoluta | `""` | Catálogo visual propio. Vacía: `catalogo-visual.md` en `UAEH_HOME` si existe; si no, el genérico del plugin. |
| `preflight.jurisdiccion` | texto | `""` | Jurisdicción de la matriz legal del preflight. Vacía: se deduce del repo y se marca por confirmar. |

Los anchos de la puerta visual son 360 y 1440, fijos en sus plantillas.

## Variables de entorno

Pisan al archivo. Solo se listan las que un usuario puede necesitar.

| Variable | Qué hace | Dónde se lee |
|---|---|---|
| `UAEH_HOME` | Carpeta de estado de UAEH. Defecto: `<CLAUDE_CONFIG_DIR>/uaeh`. | `scripts/lib/comun.cjs` |
| `CLAUDE_CONFIG_DIR` | Carpeta de Claude Code. Defecto: `~/.claude`. | `scripts/lib/comun.cjs` |
| `CODEX_HOME` | Carpeta de Codex. Defecto: `~/.codex`. | `scripts/lib/comun.cjs`, `instalar.cjs` |
| `UAEH_TZ` | Zona horaria IANA; gana a `zonaHoraria`. | `scripts/lib/comun.cjs` |
| `UAEH_COMMIT_CREDITO` | `permitir` o `prohibir`; pisa `commits.credito`. | `scripts/lib/config.cjs` |
| `UAEH_COMMIT_FIRMA` | Texto; pisa `commits.firma`. | `scripts/lib/config.cjs` |
| `UAEH_RUNS_DIR` | Carpeta de corridas; pisa `datos.runs`. | `scripts/lib/config.cjs` |
| `UAEH_WSL_DISTRO` | Distro de WSL; pisa `wsl.distro`. | `scripts/lib/config.cjs` |
| `UAEH_WSL_USER` | Usuario de WSL; pisa `wsl.usuario`. | `scripts/lib/config.cjs` |
| `CODEX_JS` | Ruta a `@openai/codex/bin/codex.js` si el auditor no encuentra el CLI de Codex. | `skills/uae-security/scripts/auditor-codex.cjs` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Tope de compactación del contexto (acepta `700000`, `700k`, `1M`); gana a lo que diga `settings.json`. | `uaeh-kit/scripts/ventana-contexto.cjs` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Modelo fijo para subagentes. Se define en la sección `env` de `settings.json`; el doctor del kit lo comprueba y `/uaeh-kit:setup settings` lo propone. | `uaeh-kit/scripts/doctor.cjs` |

## Subcomandos de uaeh-config.cjs

`plugins/uaeh-harness/scripts/uaeh-config.cjs` entrega a las skills valores de la configuración sin escribir rutas de una máquina. Cada subcomando imprime **una línea** y sale con 0; un uso incorrecto escribe el mensaje en stderr y sale con 64. No crea carpetas ni escribe nada.

| Subcomando | Imprime |
|---|---|
| `runs-dir [--repo <carpeta>]` | La carpeta de corridas (`datos.runs`, `UAEH_RUNS_DIR` o `UAEH_HOME/runs`); con `--repo`, la subcarpeta de ese repo. |
| `ahora-local` | Fecha y hora actuales en la zona configurada (ISO 8601 con desfase). |
| `prefijo-motor` | Lo que va antes de un programa de Linux: en Windows, `wsl.exe -d <distro> [-u <usuario>] -e`; en Linux, una línea vacía. |
| `prefijo-caja` | El prefijo anterior más `/opt/uaeh/bin/uaeh-sandbox ejecutar` (la caja de arena). |
| `ruta-motor <ruta>` | La ruta como la ve el motor de Linux (en Windows, `/mnt/<letra>/…`; en Linux, igual). |
| `catalogo-visual` | Ruta del catálogo visual vigente. |
| `jurisdiccion` | `preflight.jurisdiccion` en una línea; vacía si no está configurada. |

## Ver también

- [instalacion.md](instalacion.md) — cómo se crea el archivo durante la instalación.
- [arnes.md](arnes.md) — guarda de git, lista blanca y sello, que leen estas claves.
- [codex.md](codex.md) — consentimiento y modelos de Codex.
- [visual.md](visual.md) y [preflight.md](preflight.md) — claves `visual` y `preflight`.
- [diagnostico.md](diagnostico.md) — cómo ver los avisos de configuración.
