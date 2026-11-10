# El arnés de verificación (capa 2)

Esta página describe la capa 2 del método UAEH, que viaja en el plugin `uaeh-harness`: qué cambios obligan a una revisión independiente, cómo es esa revisión, qué hooks bloquean y cómo salir de un bloqueo. El principio es «quien construye nunca verifica». A diferencia de la capa 1, los hooks de esta capa **bloquean**.

## La lista blanca: qué entra al circuito

Solo cuatro tipos de cambio pasan por el circuito de revisión. Todo lo demás (interfaz, textos, scripts, páginas, errores corrientes) se hace directo: cambio mínimo, pruebas del área tocada y relectura del diff.

| Tipo | Ejemplos |
|---|---|
| Dinero | comisiones, cobros, suscripciones, pagos y los precios que se cobran, vivan donde vivan |
| Cuentas | inicio de sesión, contraseñas, permisos, roles, tokens |
| Base de datos | esquema, migraciones, reglas de acceso por fila, borrados masivos |
| Producción | publicar algo que toca datos reales de personas o dinero |

La guardia de cierre reconoce estos archivos **por nombre de ruta**, con patrones de fábrica. Por eso puede dar falsos positivos (ver «Cómo salir de un bloqueo»). Los patrones se ajustan en `uaeh.config.json`, bloque `listaBlanca`:

| Clave | Efecto |
|---|---|
| `listaBlanca.agregar` | suma patrones a una categoría (`dinero`, `cuentas`, `baseDeDatos`, `produccion` o una nueva) |
| `listaBlanca.categorias` | reemplaza los patrones de fábrica de esa categoría |
| `listaBlanca.excluirRutas` | carpetas que no cuentan, además de las de fábrica (`tasks`, `docs`, `output`, `node_modules`, entre otras) |
| `listaBlanca.excluirExtensiones` | extensiones que no cuentan, además de las de fábrica (`md`, `txt`, imágenes, `css`, entre otras) |

Los patrones son expresiones regulares sobre la ruta relativa en minúsculas.

## El circuito `uae-loop`

La skill `/uaeh-harness:uae-loop <tarea>` es el protocolo para la lista blanca. Una sola pasada, sin bucle de reintentos:

1. **Checkpoint:** estado de git, rama, commit base y hora de inicio. Meta: la tarea completa en 30 minutos o menos.
2. **Plan:** en riesgo `high`, diez líneas en la propia conversación; en `critical` (dinero real, borrado de datos, salud, migración destructiva) lo escribe el agente `uae-architect` y el usuario da el visto bueno antes de construir.
3. **Construye la conversación principal**, que ya tiene el contexto, con al menos una prueba del comportamiento nuevo. El agente `uae-builder` solo entra con dos o más piezas independientes en paralelo, más de unas 300 líneas o riesgo `critical`.
4. **Commit de trabajo:** los revisores miran ese estado exacto.
5. **Revisión en paralelo:** `uae-verifier` (siempre) a la vez que el revisor de seguridad (si el cambio toca dinero o cuentas), bajo el sello de integridad. Cada uno recibe un mapa de lectura y un tope de 15 minutos; si no alcanza, devuelve `UNKNOWN` con lo que faltó.
6. **Si falla:** no hay reparación automática. El hallazgo se presenta al usuario en pocas líneas y **él decide**. Si decide arreglar, se vuelve a verificar solo el criterio que falló.

A los 60 minutos desde el inicio el circuito se detiene y el usuario elige entre seguir, recortar o dejarlo. Los hallazgos fuera de lo pedido van a una lista en `tasks/todo.md` y se presentan al cerrar; nunca abren un ciclo por sí solos.

## Los agentes

| Agente | Qué hace |
|---|---|
| `uae-verifier` | verificación independiente: corre las pruebas del área y revisa el diff contra los criterios; no edita |
| `uae-security` | auditor de seguridad independiente sobre el diff y las rutas de ejecución; no edita |
| `uae-builder` | implementa un brief ya definido; nunca aprueba su propio trabajo |
| `uae-architect` | define plan, rollback y pruebas de cambios críticos antes de escribir código; no implementa |
| `uae-triage` | decide si una tarea entra a la lista blanca cuando no se sabe qué toca sin leer medio repositorio |
| `browser-verifier` | verificación visual en navegador bajo una lista blanca de comandos (ver [visual.md](visual.md)) |
| `design-auditor` | auditoría visual de solo lectura (ver [visual.md](visual.md)) |

## El sello de integridad

Un revisor no puede aprobar algo que él mismo cambió. Antes y después de cada revisión, `scripts/uaeh-integridad.cjs` toma una «foto» por bytes crudos de: el commit y la rama, todos los archivos rastreados y los no rastreados, las entradas ignoradas que parecen código o credenciales, la configuración efectiva de git y sus hooks, y el propio arnés (el plugin, el espejo de la guarda y la configuración de Claude Code y de Codex). Se compara el resultado, no el comando; por eso no depende de cómo cada shell corte los argumentos.

| Resultado | Código de salida | Significado |
|---|---|---|
| `INTACTO` | 0 | nada cambió durante la revisión |
| `ROTA` | 3 | algo cambió: el veredicto queda anulado |
| `DESCONOCIDO` | 4 | no se pudo medir |

La regla de diseño: «no se pudo medir» es `DESCONOCIDO`, nunca `INTACTO`. Una foto `ROTA` equivale a `UNKNOWN`: el revisor debe reportar `UNKNOWN` o `BLOCKED`, jamás PASS. En el circuito, una revisión con sello `ROTA` o sin la foto del orquestador se repite una vez; si reincide, queda `BLOCKED`. Los seis revisores (todos los agentes de la tabla salvo `uae-builder`) tienen foto automática por hook, además de la foto manual del circuito:

```
node "<plugin>/scripts/uaeh-integridad.cjs" foto <carpeta del proyecto>
node "<plugin>/scripts/uaeh-integridad.cjs" comparar <id> <carpeta del proyecto>
```

### Revisiones abiertas en otra terminal

Como el sello mide también el propio arnés, instalar o cambiar la configuración mientras otra terminal tiene una revisión en curso (verificador o auditor con sello abierto) cambia lo medido y anula el veredicto de esa revisión: el sello queda `ROTA`. Para evitarlo, el instalador del arnés (`instalar.cjs config`, `git-guard`, `codex`, `todo` y `puertas`) revisa antes si hay revisiones abiertas:

- En seco muestra un `AVISO` con las revisiones abiertas.
- Con `--aplicar` **se niega**: no escribe nada, sale con código 1 y dice qué revisión está abierta y desde hace cuántos minutos. Esto incluye `git-guard --quitar`.
- Las opciones son esperar a que la revisión termine o repetir el comando con `--forzar`, que continúa, deja el aviso y anula el veredicto de esa revisión.

Una revisión cuenta como abierta si tiene una foto del sello de menos de 90 minutos sin cierre en el registro. Límite: una revisión que murió sin cerrar bloquea hasta 90 minutos, o hasta usar `--forzar`. El doctor de la capa 2 lo muestra en la comprobación `sellos-abiertos` ([diagnostico.md](diagnostico.md)).

El instalador del kit (`uaeh-kit`) también escribe en cosas que el sello mide (`settings.json`, el `CLAUDE.md` global y la carpeta `estable/`), pero no depende del arnés: cuando encuentra fotos del sello de los últimos 90 minutos solo lo avisa con una `NOTA` y continúa. Conviene esperar a que la revisión termine.

## Estados finales

| Estado | Significado |
|---|---|
| `PASS_TECHNICAL` | código y verificación automática correctos; no autoriza producción |
| `PASS_RELEASE_READY` | todas las puertas exigibles aprobadas y autorización humana obtenida |
| `PENDING_HUMAN_REVIEW` | decisión regulada, sensible o irreversible pendiente |
| `BLOCKED_SECURITY` | vulnerabilidad crítica o alta abierta |
| `FAIL` | prueba o requisito incumplido |
| `UNKNOWN` | falta evidencia |

**UNKNOWN nunca es PASS.** Un código de salida 0 sin pruebas ejecutadas tampoco es PASS: se reporta `UNKNOWN` o `FAIL`.

## El registro de tareas

Al llegar los veredictos, el mismo turno anota una línea por tarea en `registro.jsonl` (dentro de `UAEH_HOME`, por defecto `~/.claude/uaeh`):

```
node "<plugin>/scripts/uaeh-registro.cjs" --proyecto <carpeta> --ruta <build|deep> --riesgo <high|critical> --ciclos <n> --minutos <min> --estado <ESTADO> --tarea "<resumen corto>"
```

`--ruta` vale `quick`, `build` o `deep`; `--estado` es uno de los seis estados finales; `--tarea` admite hasta 120 caracteres. El resumen del registro se obtiene con `node "<plugin>/scripts/uaeh-resumen.cjs" 7` (últimos 7 días); ver [medicion.md](medicion.md).

## Qué corre y qué bloquea

Todos los hooks van en forma exec (`node` con argumentos, sin shell).

| Evento | Hook | ¿Bloquea? | Cuándo |
|---|---|---|---|
| `PreToolUse` (Bash, PowerShell) | `guardia-git.js` | **Sí** | niega `reset --hard`, `push --force`, `--no-verify` y `commit -n`, `clean -f` y cualquier intento de quitar la guarda de git; en `git commit` busca secretos y archivos tipo `.env`. Con `onFailure: block`: si Node falla, todo Bash y PowerShell queda bloqueado hasta reparar el hook o desactivar el plugin |
| `PreToolUse` | `uaeh-guardia-cierre.js commit` | No | anota un `git commit` que toca archivos de lista blanca y se lo recuerda al modelo |
| `PreToolUse` | `solo-lectura.js` | **Sí, solo a revisores** | candado de solo lectura para `uae-verifier`, `uae-security` y `browser-verifier`; en la sesión principal y en otros agentes sale en silencio |
| `PreToolUse` | `solo-navegador.js` | **Sí, solo a `browser-verifier`** | lista blanca de comandos del verificador de navegador; en cualquier otro sitio sale en silencio |
| `SubagentStart` | `uaeh-integridad.cjs hook-inicio` | No | toma la foto de integridad de los seis revisores |
| `SubagentStop` | `uaeh-integridad.cjs hook-fin` | **Sí** | si la foto está `ROTA` o no se pudo medir, el revisor debe reportar `UNKNOWN` o `BLOCKED` |
| `SubagentStop` | `uaeh-guardia-cierre.js revisor` | No | anota que corrió un revisor en esta sesión |
| `Stop` | `uaeh-guardia-cierre.js cierre` | **Sí, una vez por sesión** | no deja cerrar la respuesta si corrieron revisores y la tarea no está en el registro, o si hubo un commit de lista blanca sin ningún revisor |
| `SessionStart` | `linea-inicio.cjs` | No | una línea si la guarda de git falta o está desactualizada, o si la configuración tiene avisos; si no, silencio |

## La guarda de git, en dos capas

| Capa | Dónde corre | Qué niega |
|---|---|---|
| Texto (`guardia-git.js`) | antes de ejecutar el comando | `reset --hard`, `push --force` (y variantes), `--no-verify`, `commit -n`, `clean -f`, y los intentos de quitar la guarda (`core.hooksPath`, variables `GIT_CONFIG_*`, escribir `.git/config`) |
| Git (`guardia-commit.cjs`, por `core.hooksPath` global) | dentro del proceso real de git, con su índice y su mensaje | secretos en las líneas añadidas (solo tipo y `ruta:línea`, nunca el valor), archivos sensibles, evidencias del navegador y, según la política, el crédito o la identidad de Claude; vale también con `--no-verify`, `cherry-pick`, `rebase` y `am` |

Cada despachador de la capa de git encadena después el hook local del propio repositorio. La política de commits vive en `uaeh.config.json`:

| Clave | Valores | Efecto |
|---|---|---|
| `commits.credito` | `permitir` (defecto) \| `prohibir` | con `prohibir` se niega el crédito de Claude en el mensaje y que Claude figure como autor o committer |
| `commits.firma` | texto (vacío por defecto) | línea final exigida cuando se prohíbe el crédito; vacía = sin firma |

Variables equivalentes: `UAEH_COMMIT_CREDITO` y `UAEH_COMMIT_FIRMA`. Secretos, archivos sensibles y evidencias se revisan siempre, con cualquier política.

## Límites declarados

- Los filtros de texto (`guardia-git.js`, `solo-lectura.js`) son de **mejor esfuerzo**: un comando armado para evadirlos puede pasar. `solo-navegador.js` es más estrecho porque es una lista blanca con una sola gramática.
- **La garantía es el sello**, que mide el resultado y no el comando.
- La capa de git no ve la plomería (`commit-tree`, `update-ref`); un `core.hooksPath` local (por ejemplo, de husky) gana al global, caso que la capa de texto detecta para volverse estricta. Binarios reales y archivos de más de 20 MiB no se escanean por contenido.
- Un usuario con la misma cuenta puede reescribir el plugin o el espejo: es el residual declarado de esta capa.

## Cómo salir de un bloqueo

| Situación | Salida |
|---|---|
| La guardia de cierre marca un commit de lista blanca que era falso positivo | `node "<plugin>/hooks/uaeh-guardia-cierre.js" directo "motivo"` |
| Los revisores eran una re-verificación de una tarea ya registrada | `node "<plugin>/hooks/uaeh-guardia-cierre.js" descartar "motivo"` |
| La guardia de cierre estorba en general | crear el archivo vacío `~/.claude/uaeh/guardia-cierre.apagada` |
| La guarda de git estorba | `node "<plugin>/scripts/instalar.cjs" git-guard --quitar --aplicar` |
| La guarda de git estorba y Node no corre | en la terminal del usuario: `git config --global --unset core.hooksPath` |
| Todo Bash está bloqueado porque el hook falla | `/plugin disable uaeh-harness` |

Cada `directo` y `descartar` deja una huella en `excepciones.jsonl` (dentro de `UAEH_HOME`) que se presenta al cerrar. La guardia de cierre avisa una sola vez por pendiente y por sesión, y nunca bloquea dos veces seguidas.

## Ver también

- [seguridad.md](seguridad.md): la puerta de seguridad que el circuito invoca en dinero y cuentas.
- [visual.md](visual.md): `browser-verifier` y `design-auditor`.
- [configuracion.md](configuracion.md): todas las claves de `uaeh.config.json`.
- [diagnostico.md](diagnostico.md): `doctor` y sus autopruebas.
- [desinstalar.md](desinstalar.md): reversa completa.
