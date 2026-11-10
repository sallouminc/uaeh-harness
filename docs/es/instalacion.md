# Instalación

Esta página explica qué se necesita antes de instalar UAEH, cómo instalar el marketplace y los dos plugins, qué hace cada paso de `setup`, cómo comprobar el resultado con los doctores y cómo actualizar. Cada instalador trabaja primero «en seco»: muestra qué cambiaría y solo escribe con `--aplicar`.

## Requisitos por capa

| Capa | Requisitos |
|---|---|
| Todas | Node 20 o posterior en el `PATH`; Claude Code 2.1.295 o posterior |
| 1. `uaeh-kit` | Solo Node. Los hooks son scripts de Node y no requieren Git Bash |
| 2. `uaeh-harness` (arnés) | Git 2.31 o posterior. En Windows, Git for Windows (su `sh` ejecuta los hooks de git) |
| 3. Puerta de seguridad | Ubuntu 24.04 x86_64: en Windows 11, WSL2 con systemd; o Linux directo. Además Docker y Python 3 (el instalador de Linux pide `python3`). Ver [plataforma.md](plataforma.md) |
| 3. Puerta visual | Playwright (Chromium de la versión fijada), `playwright-cli` y Chrome |
| Opcional | Codex CLI 0.163.0 o posterior, solo para el auditor Codex. Ver [codex.md](codex.md) |

Node es imprescindible y se comprueba antes de instalar con `node --version` en la terminal: los doctores son scripts de Node y sin Node no pueden correr. Sin Node, `uaeh-kit` deja la sesión funcionando pero sin inyectar nada (cada hook queda como error no bloqueante: `Executable not found in $PATH: "node"`). Con `uaeh-harness`, **todo comando de Bash y PowerShell queda bloqueado** con el mensaje `PreToolUse:Bash hook error: […guardia-git.js]: failed; blocking because onFailure is "block"`: es intencional, porque la guarda falla cerrada. La solución es instalar Node 20 o posterior y reabrir las sesiones, o desactivar el plugin con `/plugin disable uaeh-harness`.

## Instalar los plugins

Un plugin es un paquete que Claude Code carga para añadir skills (comandos como `/uaeh-kit:setup`), agentes y hooks. En una sesión de Claude Code:

```
/plugin marketplace add sallouminc/uaeh-harness
/plugin install uaeh-kit@uaeh
/plugin install uaeh-harness@uaeh
```

Después se ejecuta el `setup` de cada plugin y, al final, el doctor de cada uno:

```
/uaeh-kit:setup
/uaeh-harness:setup
/uaeh-kit:doctor
/uaeh-harness:doctor
```

Para probar un plugin sin instalarlo, desde un clon del repositorio: `claude --plugin-dir ./plugins/uaeh-kit` (o `./plugins/uaeh-harness`).

Si la instalación de `uaeh-harness` falla con `EPERM` sobre un archivo de `vendor/`, la causa probable es un antivirus de equipo que toma por malware un ejemplo de código vulnerable de las guías de seguridad incluidas. La solución y el detalle están en [diagnostico.md](diagnostico.md).

## Cerrar y reabrir todas las sesiones

> **Tras instalar o actualizar es obligatorio cerrar y reabrir TODAS las sesiones de Claude Code**: cada terminal abierta y la app de escritorio de Claude.

Una sesión abierta antes de la instalación no carga los hooks ni los agentes nuevos, y `/clear` no lo arregla. El síntoma típico es que las guardas no se aplican en esa sesión aunque el doctor diga que todo está bien. Pasos:

1. Cerrar cada sesión (`/exit` en las terminales; cerrar la ventana de la app de escritorio).
2. Abrir una sesión nueva en la carpeta del proyecto.
3. Ejecutar `/uaeh-kit:doctor` y comprobar que la inyección de contexto aparece en `OK`.

## Qué hace `setup` en la capa 1

`/uaeh-kit:setup [todo | claude-md | settings | statusline | proyecto [carpeta]]` ejecuta `plugins/uaeh-kit/scripts/instalar.cjs`. Sin argumento equivale a `todo`, que son `claude-md` (global) + `settings` + `statusline`. `proyecto` no entra en `todo`.

| Subcomando | Qué escribe |
|---|---|
| `claude-md` | El bloque de reglas entre `<!-- UAEH:BEGIN -->` y `<!-- UAEH:END -->` al final del `CLAUDE.md` global (`--proyecto <dir>` lo pone en el de un proyecto). `--idioma es\|en`. `--quitar` retira el bloque |
| `settings` | En `settings.json` de Claude Code, solo las claves que falten: `env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet"` y `autoCompactWindow = 700000` |
| `statusline` | Copia la barra de estado a `UAEH_HOME/estable/` y la registra como `statusLine` en `settings.json` solo si no hay otra barra |
| `proyecto <dir>` | Crea `CLAUDE.md` y `tasks/context-map.md`, `tasks/todo.md`, `tasks/lessons.md` desde plantillas, sin pisar nada existente |

## Qué hace `setup` en el arnés

`/uaeh-harness:setup [config | git-guard | codex | visual | todo | puertas <puerta>]` ejecuta `plugins/uaeh-harness/scripts/instalar.cjs`. `todo` es `config` + `git-guard` (+ `codex` si `codex.habilitado` es `true`). `visual` y `puertas` no entran en `todo`.

| Subcomando | Qué hace |
|---|---|
| `config` | Crea `UAEH_HOME/uaeh.config.json` desde la plantilla; nunca pisa uno existente |
| `git-guard` | Copia la guarda de git al espejo `UAEH_HOME/estable/uaeh-harness/`, la prueba en un repositorio temporal (un commit limpio pasa; un `.env` y un secreto falso se niegan) y solo si la prueba pasa fija la configuración global de git para que apunte al espejo. Un valor ajeno ya fijado (husky u otra guarda) no se pisa: se reporta; `--reemplazar` lo sustituye y lo anota para poder restaurarlo |
| `codex` | Opcional. Escribe el bloque UAEH en `~/.codex/AGENTS.md` y los agentes `uae_*.toml`; imprime el fragmento de `config.toml` para pegar a mano. Ver [codex.md](codex.md) |
| `visual --proyecto <carpeta>` | Copia a un proyecto las plantillas de Playwright y axe, y el `DESIGN.md` si falta. Ver [visual.md](visual.md) |
| `puertas [seguridad\|visual\|codex\|preflight\|todas]` | Instala o repara solo lo que el doctor de puertas encontró faltante. Ver abajo |

En la capa 1 el respaldo tiene la forma `<archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss>`, junto al archivo original. Los instaladores no borran nada.

### Dos decisiones de `config`

Tras crear `uaeh.config.json`, `setup` pregunta dos cosas: si se prohíbe el crédito de Claude en los mensajes de commit y con qué firma (`commits.credito`, `commits.firma`), y qué nombres de archivo propios cuentan siempre como dinero, cuentas, base de datos o producción (`listaBlanca.agregar`). El resto de claves está en [configuracion.md](configuracion.md).

### Instalar las puertas de la capa 3

```
node "<plugin>/scripts/instalar.cjs" puertas seguridad
node "<plugin>/scripts/instalar.cjs" puertas seguridad --aplicar
```

En Windows, con `--aplicar`, el instalador copia primero `/opt/uaeh` a `/opt/uaeh-respaldo/<fecha>` y ejecuta los instaladores de Linux como root dentro de WSL. En Linux imprime los comandos con `sudo` para que los ejecute el usuario. Lo que pide administrador, contraseña o cierra otras sesiones (instalar WSL, `wsl --terminate`, `codex login`) se imprime y nunca se ejecuta. Detalle del motor de Linux en [plataforma.md](plataforma.md).

## Comprobar con los doctores

Los doctores solo leen; las autopruebas trabajan en carpetas temporales que se borran.

| Comando | Qué revisa |
|---|---|
| `/uaeh-kit:doctor` | 15 comprobaciones de la capa 1, incluida la prueba de que la inyección de contexto llegó al modelo |
| `/uaeh-harness:doctor arnes` | Capa 2: git, guarda global y su espejo, hooks duplicados, copias personales de agentes, tres autopruebas (`--rapido` las salta) |
| `/uaeh-harness:doctor puertas` | Un veredicto por puerta: `LISTA`, `NO_INSTALADA`, `NO_LISTA` o `APAGADA` |

Los estados de cada comprobación son `OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA`. Una `OMITIDA` no se midió y nunca equivale a `OK`. Cómo interpretar cada falla: [diagnostico.md](diagnostico.md).

## Actualizar

```
claude plugin marketplace update uaeh
claude plugin update uaeh-kit@uaeh
claude plugin update uaeh-harness@uaeh
```

Antes de seguir, conviene confirmar que ninguna otra terminal tenga una revisión en curso: instalar mientras hay un sello abierto cambia el arnés medido y anula el veredicto de esa revisión. Los comandos con `--aplicar` del arnés se niegan en ese caso; esperar o repetir con `--forzar` ([arnes.md](arnes.md)).

Después, desde la copia instalada del plugin:

```
node "<plugin>/scripts/instalar.cjs" git-guard --aplicar
node "<plugin>/scripts/instalar.cjs" puertas seguridad --actualizar --aplicar
```

El primero refresca el espejo de la guarda de git. El segundo solo hace falta si existe la capa 3: `--actualizar` vuelve a copiar los programas de `/opt/uaeh` (y `--reparar` fuerza los dos instaladores de Linux). Al terminar, cerrar y reabrir todas las sesiones (sección anterior).

## Ver también

- [kit.md](kit.md)
- [arnes.md](arnes.md)
- [plataforma.md](plataforma.md)
- [diagnostico.md](diagnostico.md)
- [desinstalar.md](desinstalar.md)
