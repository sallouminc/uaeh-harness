# Capa 1: el kit de eficiencia

Esta página describe `uaeh-kit`, el plugin de la capa 1: qué hace cada pieza, qué hooks instala, por qué ninguno bloquea nada y cómo quitar cada cosa. Es la capa de la que sale el ahorro medido; las otras dos compran control, no ahorro.

El kit solo informa. Ningún hook bloquea una herramienta, edita un archivo por su cuenta ni manda datos fuera de la máquina. Los hooks siempre terminan con código 0 y, si algo falla, callan.

## Piezas

| Pieza | Qué hace |
|---|---|
| Inyección de contexto | Al abrir cada sesión, antepone la marca `[uaeh-kit ctx v1]`, las reglas compactas del método (unos 900 caracteres) y el `tasks/context-map.md` del proyecto (hasta 7,500 caracteres, buscado en la carpeta de trabajo y hasta 4 carpetas por encima). Las reglas compactas se omiten si algún `CLAUDE.md` cargado ya trae el bloque `UAEH:BEGIN…END` o si `reglas.inyectar` es `false`. Sin mapa, una línea apunta a `/uaeh-kit:setup proyecto` |
| Vigía de la ventana de contexto | Al abrir la sesión avisa si algún `CLAUDE.md` que Claude Code va a cargar pasa de 40,000 caracteres. En cada mensaje lee la última línea de uso de la transcripción y avisa una vez por sesión al 80 % y otra al 90 % del tope de compactación |
| Mapa de contexto por proyecto | Un archivo corto (`tasks/context-map.md`) con qué es el proyecto, comandos, archivos clave, qué no leer y trampas. Se inyecta solo, así la sesión arranca sin redescubrir el proyecto |
| Bloque de reglas | Las reglas completas del método entre `<!-- UAEH:BEGIN v… -->` y `<!-- UAEH:END -->`, en el `CLAUDE.md` global o de un proyecto |
| Ajustes recomendados | `CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` (los subagentes usan el modelo más económico) y `autoCompactWindow = 700000`, el tope medido por el autor con ventana de 1M; en ventanas menores conviene ajustarlo |
| Barra de estado | Modelo, esfuerzo, límites de 5 horas y 7 días, duración de la sesión, carpeta y una barra de contexto medida contra el tope de compactación, no contra la ventana cruda. Rojo significa cerrar el bloque de trabajo |
| Dieta de CLAUDE.md | Mueve la crónica fechada de un `CLAUDE.md` demasiado grande a `tasks/bitacora.md`, sin perder ni reescribir líneas |
| Medición | Cuatro scripts de solo lectura sobre las transcripciones locales. Ver [medicion.md](medicion.md) |

La razón de la dieta: el `CLAUDE.md` de un proyecto se relee completo en cada turno de cada sesión y de cada subagente, y gran parte del gasto de una sesión larga es releer contexto, no escribir.

## Skills

Una skill es un comando que Claude Code ofrece al instalar el plugin.

| Skill | Qué hace |
|---|---|
| `/uaeh-kit:setup [todo\|claude-md\|settings\|statusline\|proyecto [carpeta]]` | Plan en seco, confirmación y aplicación con respaldos; llena el mapa del proyecto con contenido real del repositorio. Ver [instalacion.md](instalacion.md) |
| `/uaeh-kit:doctor` | 15 comprobaciones con estados `OK \| AVISO \| FALLÓ \| OMITIDA \| NO_INSTALADA \| NO_APLICA`. Con `--proponer` deja un `settings.uaeh-propuesto.json` sin hooks duplicados y no toca el original |
| `/uaeh-kit:medir [días]` | Ejecuta los cuatro scripts de medición y recomienda como máximo tres acciones |
| `/uaeh-kit:dieta` | Adelgaza un `CLAUDE.md` por encima de 40,000 caracteres y demuestra, línea por línea contra git, que no se perdió nada. Debe terminar con `RESULTADO: PASS` |

Solo `dieta` puede invocarla el modelo por su cuenta; `setup`, `doctor` y `medir` se ejecutan a mano.

## Hooks que instala

Los tres hooks están en `plugins/uaeh-kit/hooks/hooks.json`. Usan la forma exec (`command` es `node` y el script va en `args`), sin shell intermedia, así que no dependen de Git Bash ni de rutas con espacios.

| Evento | Script | Tiempo máximo |
|---|---|---|
| `SessionStart` | `hooks/inyectar-contexto.js` | 5 s |
| `SessionStart` | `hooks/vigia-contexto.js inicio` | 5 s |
| `UserPromptSubmit` | `hooks/vigia-contexto.js prompt` | 5 s |

Ninguno bloquea: no usan `onFailure`, un hook que falla se ignora a propósito y ninguno sale con código 2 (el que bloquearía un mensaje).

## Qué escribe el kit y qué lee

- Lee: la transcripción de la sesión (para la línea de uso), `settings.json` (para el tope de compactación), los `CLAUDE.md` que Claude Code cargaría y `tasks/context-map.md`.
- Escribe solo con `setup --aplicar` (siempre con respaldo `<archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss>`) y con `--proponer` del doctor; además marcas de una línea («ya avisé») en la carpeta temporal del sistema y cachés en `UAEH_HOME/cache/` solo si se activan.
- Red: ninguna, salvo que `statusline.estadoClaude` sea `true` (apagado por defecto): entonces un script en segundo plano consulta `status.claude.com` como máximo cada 90 segundos.

Más detalle en [privacidad.md](privacidad.md).

## Configuración propia de esta capa

En `UAEH_HOME/uaeh.config.json` (por defecto `~/.claude/uaeh/uaeh.config.json`):

| Clave | Efecto |
|---|---|
| `idioma` | `auto` (español en la versión 1), `es` o `en` para las reglas inyectadas y el bloque |
| `zonaHoraria` | Zona IANA para las fechas de respaldos e informes; vacío usa la del sistema |
| `reglas.inyectar` | En `false`, nunca se inyectan las reglas compactas (el mapa sí) |
| `statusline.estadoClaude` | En `true`, la barra muestra el estado oficial de Claude (hace peticiones de red) |
| `statusline.guardarLimites` | En `true`, escribe los porcentajes de límite en `UAEH_HOME/cache/rate-limits-cache.json` |

Las claves desconocidas se reportan como aviso y se ignoran; un archivo roto cae a los valores por defecto. La referencia completa está en [configuracion.md](configuracion.md).

## Cómo quitar cada cosa

| Qué | Cómo |
|---|---|
| Todos los hooks y skills del kit | Desactivar el plugin con `/plugin disable uaeh-kit` |
| Solo la inyección de reglas compactas | `reglas.inyectar: false` en `uaeh.config.json` |
| Bloque de reglas del `CLAUDE.md` | `node "<plugin>/scripts/instalar.cjs" claude-md --quitar --aplicar` (con `--proyecto <dir>` para el de un proyecto) |
| Claves de `settings.json` (`CLAUDE_CODE_SUBAGENT_MODEL`, `autoCompactWindow`) | `node "<plugin>/scripts/instalar.cjs" settings --quitar --aplicar`. Solo las quita si conservan el valor que puso el kit |
| Barra de estado | `node "<plugin>/scripts/instalar.cjs" statusline --quitar --aplicar`. Quita `statusLine` si apunta a la barra del kit y borra los archivos que el kit copió a `UAEH_HOME/estable/` |
| Todo lo anterior de una vez | `node "<plugin>/scripts/instalar.cjs" todo --quitar --aplicar` |
| Archivos de proyecto (`CLAUDE.md`, `tasks/*`) | No hay comando; son archivos normales del proyecto y se borran o editan como cualquier otro |

El orden completo para retirar todo UAEH está en [desinstalar.md](desinstalar.md).

## Ver también

- [instalacion.md](instalacion.md)
- [medicion.md](medicion.md)
- [configuracion.md](configuracion.md)
- [arnes.md](arnes.md)
- [privacidad.md](privacidad.md)
