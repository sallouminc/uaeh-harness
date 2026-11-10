# uaeh-kit — capa 1 de UAEH: el método + kit de eficiencia de tokens

**[Read in English → README.md](README.md)**

`uaeh-kit` empaqueta la parte del método UAEH de donde sale el ahorro medido: reglas que mantienen chica la conversación principal, un mapa de contexto que se inyecta al arrancar cada sesión, un vigía que avisa cuándo cerrar la sesión, una «dieta» de CLAUDE.md con un verificador que demuestra que no se perdió nada, scripts de medición sobre tus propias transcripciones locales y una barra de estado opcional con barra de contexto.

**Solo informa.** Nada en este plugin bloquea una herramienta, edita un archivo por su cuenta ni manda nada fuera de tu máquina. Los hooks siempre salen con código 0; si algo falla, callan.

## Instalar

```
/plugin install uaeh-kit --marketplace sallouminc/uaeh-harness
```

(o bien `/plugin marketplace add sallouminc/uaeh-harness` y luego `/plugin install uaeh-kit@uaeh`). Requiere **Node ≥ 20** en el PATH (los hooks son scripts de Node; no hace falta Git Bash). Después:

```
/uaeh-kit:setup       # plan en seco → confirmas → bloque de reglas, ajustes, barra opcional, mapa del proyecto
/uaeh-kit:doctor      # qué hay instalado, qué falta y si la inyección llega de verdad al modelo
```

Para probarlo sin instalar: `claude --plugin-dir ./plugins/uaeh-kit` desde un clon de este repositorio.

## Qué añade a una sesión

| Pieza | Dónde | Qué hace |
|---|---|---|
| **Inyección de contexto** | hook `SessionStart` | Antepone la marca `[uaeh-kit ctx v1]`, luego las reglas compactas del método (≈ 900 caracteres; se omiten si tu CLAUDE.md ya trae el bloque completo `UAEH:BEGIN…END` o si `reglas.inyectar` es `false`) y luego el `tasks/context-map.md` del proyecto (hasta 7,500 caracteres, buscado hasta 5 carpetas por encima de la carpeta de trabajo). Sin mapa, imprime una línea que apunta a `/uaeh-kit:setup proyecto`. |
| **Vigía de contexto** | hooks `SessionStart`, `UserPromptSubmit` | Al arrancar, avisa si algún CLAUDE.md que Claude Code va a cargar (cadena del proyecto o global) pasa de 40,000 caracteres. En cada prompt, lee la última línea de uso del transcript y avisa **una vez por sesión** al 80 % y otra al 90 % del tope de compactación. |
| **Bloque de reglas** | `templates/bloque-claude-md.md` (ES) / `.en.md` | Las reglas completas del método entre `<!-- UAEH:BEGIN v… -->` y `<!-- UAEH:END -->`, al final de tu CLAUDE.md global o de proyecto (`setup claude-md`). Volver a correrlo reemplaza el bloque en su sitio; `--quitar` lo retira. |
| **Ajustes recomendados** | `templates/settings-snippet.json` | `env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` y `autoCompactWindow = 700000`. `setup settings` añade solo las claves que no tengas, con respaldo. 700,000 es el valor medido por el autor con ventana de 1M; ajústalo en ventanas menores. |
| **Plantillas de proyecto** | `templates/proyecto/` | `CLAUDE.md`, `tasks/context-map.md`, `tasks/todo.md`, `tasks/lessons.md`. `setup proyecto` las copia sin pisar nada y la skill llena el mapa con contenido real de tu repo. |
| **Barra de estado** | `statusline/` | Modelo, esfuerzo, límites de 5 horas y 7 días, duración de la sesión, carpeta y una barra de contexto medida contra el **tope de compactación**, no contra la ventana cruda (rojo = «cierra el bloque ya»). Opcional; `setup statusline` la copia a una ruta fija (`UAEH_HOME/estable/`) y la registra solo si no tienes otra barra. |
| **Medición** | `scripts/uso-*.cjs`, `uaeh-listado-skills.cjs` | Tokens releídos por modelo y proyecto, pasos sueltos vs en paralelo, agentes y skills usados, y el tamaño del listado de skills que se inyecta en cada sesión. Solo lectura sobre tus transcripciones locales; nunca imprimen contenido de conversaciones. `/uaeh-kit:medir` corre los cuatro y los interpreta. |
| **Dieta** | `/uaeh-kit:dieta` + `scripts/verificar-dieta-claudemd.cjs` | Mueve la crónica fechada de un CLAUDE.md gordo a `tasks/bitacora.md`. El verificador demuestra, línea por línea contra git, que no se perdió ni se parafraseó nada. |

### Cada hook, con el comando exacto que ejecuta

De `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}` es la carpeta donde se instala el plugin). Usan la *forma exec* (`command` es el ejecutable y el script va en `args`): no interviene ninguna shell, así que no hay problemas con rutas con espacios ni con máquinas sin Git Bash.

| Evento | Ejecutable | Argumentos | Tiempo máximo |
|---|---|---|---|
| `SessionStart` | `node` | `${CLAUDE_PLUGIN_ROOT}/hooks/inyectar-contexto.js` | 5 s |
| `SessionStart` | `node` | `${CLAUDE_PLUGIN_ROOT}/hooks/vigia-contexto.js inicio` | 5 s |
| `UserPromptSubmit` | `node` | `${CLAUDE_PLUGIN_ROOT}/hooks/vigia-contexto.js prompt` | 5 s |

Ninguno usa `onFailure`: un hook que falla se ignora, a propósito, y ninguno sale jamás con código 2 (que bloquearía un prompt).

## Skills

| Skill | ¿El modelo puede invocarla? | Qué hace |
|---|---|---|
| `/uaeh-kit:setup [todo\|claude-md\|settings\|statusline\|proyecto [dir]]` | no | Plan en seco, confirmación y aplicación con respaldos; llena el mapa del proyecto con contenido real. |
| `/uaeh-kit:doctor` | no | 15 comprobaciones con estados `OK · AVISO · FALLÓ · OMITIDA · NO_INSTALADA · NO_APLICA`; `--proponer` deja una propuesta de `settings.json` sin hooks duplicados (nunca edita el original). |
| `/uaeh-kit:medir [días]` | no | Corre los cuatro scripts de medición en un comando y recomienda como máximo tres acciones. |
| `/uaeh-kit:dieta` | sí | La dieta de CLAUDE.md, verificada. |

## Configuración (opcional)

Un único archivo de usuario `UAEH_HOME/uaeh.config.json` (`UAEH_HOME` por defecto es `<carpeta de configuración de Claude>/uaeh`, es decir `~/.claude/uaeh`; se respeta `CLAUDE_CONFIG_DIR`). Claves que usa esta capa:

```json
{
  "idioma": "auto",
  "zonaHoraria": "",
  "reglas": { "inyectar": true },
  "statusline": { "estadoClaude": false, "guardarLimites": false }
}
```

- `idioma`: `auto` (español en v1), `es` o `en` para las reglas inyectadas y el bloque de reglas.
- `zonaHoraria`: zona IANA para las fechas de respaldos e informes; vacío = la del sistema (`UAEH_TZ` manda).
- `reglas.inyectar`: en `false` nunca se inyectan las reglas compactas (el mapa sí).
- `statusline.estadoClaude`: en `true`, la barra muestra el punto del estado oficial de Claude y un script en segundo plano consulta `status.claude.com` como mucho cada 90 s. **Apagado por defecto: así el kit no hace ninguna petición de red.**
- `statusline.guardarLimites`: en `true`, escribe tus porcentajes de límite en `UAEH_HOME/cache/rate-limits-cache.json` para tableros externos. Apagado por defecto.

Las claves desconocidas las reporta el doctor como aviso y se ignoran. Un archivo roto cae a los valores por defecto.

## Privacidad y huella

- Lee: el transcript de la sesión (la `transcript_path` que entrega Claude Code) para la línea de uso; tu `settings.json` para el tope de compactación; los CLAUDE.md que Claude Code cargaría; `tasks/context-map.md`. Los scripts de medición leen transcripciones `.jsonl` bajo la carpeta de configuración de Claude y solo extraen números de uso y nombres de herramientas, agentes y skills.
- Escribe: solo con `setup --aplicar` (con respaldos) y con `--proponer` del doctor; marcas de una línea («ya avisé») en la carpeta temporal del sistema; cachés en `UAEH_HOME/cache/` solo si lo activas.
- Red: ninguna, salvo que `statusline.estadoClaude` sea `true`.

## Plataforma

Probado por el autor en Windows 11 (Node 24). Linux y macOS: la capa 1 es Node puro y debería funcionar; las pruebas unitarias corren en `ubuntu-24.04` y `windows-latest` en CI. Prompts y mensajes en español en la v1; los contratos JSON (`--json` del doctor y de los scripts de medición) son estables.
