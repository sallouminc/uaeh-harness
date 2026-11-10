# Qué sale de la máquina, cuándo y con qué permiso

Esta página reúne, en un solo lugar, todo lo que los plugins `uaeh-kit` y `uaeh-harness` pueden enviar o descargar por red, qué guardan en disco y qué no hacen. No hay telemetría. Cada salida de datos tiene un interruptor o ocurre solo durante una instalación que el usuario ejecuta.

## Resumen

| Componente | Qué se envía o descarga | A quién | Cuándo | Cómo se controla |
|---|---|---|---|---|
| Telemetría | nada | nadie | nunca | no existe código de telemetría |
| Barra de estado | una consulta `GET` a `https://status.claude.com/api/v2/summary.json`, sin credenciales (solo una cabecera `User-Agent` con el nombre del kit) | status.claude.com | solo con `statusline.estadoClaude=true`; como máximo cada 90 s | apagado por defecto; sin esa clave el kit no hace ninguna petición de red |
| Auditor Codex | una copia limpia del repositorio auditado (sin `.env*` ni archivos ignorados por git) | OpenAI | solo con `codex.habilitado=true`, al correr la puerta de seguridad | consentimiento explícito: `instalar.cjs puertas codex --consiento --aplicar`; se retira con `--retirar --aplicar` ([codex.md](codex.md)) |
| osv-scanner | se invoca como `osv-scanner scan source -r` sobre la copia limpia y envía los identificadores de las dependencias que encuentra en manifiestos y archivos de bloqueo: ecosistema, nombre y versión de cada paquete (y, en las dependencias fijadas por commit, el hash del commit). No envía código fuente ni el contenido de los archivos; el detalle está en la documentación de la herramienta | OSV.dev, servicio público de vulnerabilidades (de Google) | en la pasada determinista de cada auditoría | requiere red; sin red queda `FALLÓ` y la corrida en `UNKNOWN` |
| `npm audit` / `pnpm audit` | lo que cada gestor envía a su registro para consultar avisos de seguridad | registro de npm | en la pasada determinista, si el repositorio tiene archivo de bloqueo | requiere red; sin red queda `FALLÓ` |
| Semgrep | nada: corre con `--metrics=off` y `--disable-version-check`, con reglas locales fijadas | nadie | las reglas se descargan una sola vez, al instalar la capa 3 | las reglas viven en `/opt/uaeh/reglas`; no se piden en cada corrida |
| gitleaks | nada: corre local, siempre con `--redact` | nadie | en la pasada determinista | no imprime nunca el valor de un secreto |
| Instalación de la capa 3 | descargas de herramientas, reglas e imágenes (ver tabla siguiente) | los sitios de cada proyecto | solo al ejecutar `instalar.sh` o `instalar.cjs puertas … --aplicar` | cada descarga se compara contra una huella fijada; por defecto los instaladores corren en seco |
| Puerta visual | instalación de dependencias con `npm ci`, descarga del navegador de Playwright y Lighthouse con `npx` | registro de npm y repositorio del navegador | al preparar la puerta o correr su autoprueba; Lighthouse en cada auditoría que lo use | `--sin-lighthouse` en la autoprueba evita la descarga de Lighthouse; los sitios que se prueban son locales (`localhost`) |
| Caja de arena | nada: contenedores con `--network none` | nadie | durante la confirmación de pruebas de concepto | la única etapa con red es preparar las dependencias del proyecto (`preparar-deps`, con `--ignore-scripts`) |

## Descargas al instalar la capa 3

`plugins/uaeh-harness/wsl/instalar.sh` descarga y verifica contra las versiones y huellas fijadas en `wsl/herramientas.json`:

| Pieza | De dónde |
|---|---|
| Paquetes del sistema (`ca-certificates`, `curl`, `gnupg`, `pipx`, `python3`) | repositorios de Ubuntu (`apt-get`) |
| Docker Engine | repositorio oficial de Docker (`download.docker.com`), con la huella de su llave fijada |
| gitleaks y su configuración por defecto | publicaciones de GitHub del proyecto, con huella `sha256` fijada |
| osv-scanner | publicaciones de GitHub del proyecto, con huella `sha256` fijada |
| Semgrep | `pipx` en una versión fijada |
| Reglas de Semgrep | `https://semgrep.dev/c/p/<paquete>`; se guardan con sumas de verificación y se reutilizan |
| Imágenes de la caja de arena (`node`, `postgres`) | `docker pull` por digest fijado |

Las reglas de Semgrep no vienen en el repositorio: `instalar.sh` las descarga de `semgrep.dev` a la máquina del usuario. Están bajo la «Semgrep Rules License v. 1.0» (https://semgrep.dev/legal/rules-license/), que permite usarlas para fines internos propios y no permite distribuirlas ni ofrecerlas a terceros como servicio. Quien use la puerta de seguridad para auditar código de terceros como servicio debe revisar esa licencia. El motor Semgrep es LGPL-2.1.

## Qué se guarda en disco

Todo el estado vive bajo `UAEH_HOME` (por defecto `~/.claude/uaeh`):

| Elemento | Contenido |
|---|---|
| `uaeh.config.json` | la configuración única del usuario |
| `registro.jsonl` | una línea por tarea: proyecto, ruta, riesgo, minutos, estado y un resumen de hasta 120 caracteres |
| `integridad/` | las fotos del sello (resúmenes criptográficos de archivos, no su contenido) |
| `sesiones/` | estado por sesión de la guardia de cierre |
| `excepciones.jsonl` | las excepciones `directo` y `descartar`, con su motivo |
| `runs/` | corridas de la puerta de seguridad (carpeta configurable con `datos.runs`) |
| `cache/` | cachés, como el estado de Claude, los límites de uso (solo con `statusline.guardarLimites`) y la autoprueba visual |
| `estable/` | espejos de ruta fija de la barra de estado y de la guarda de git; dentro del espejo de la guarda, `git-guard.estado.json` anota el estado de su instalación |

**Las evidencias de auditoría en `runs/` pueden contener fragmentos del código auditado**: cada corrida guarda una copia limpia del código y los hallazgos citan líneas. Se gestionan con `uaeh-runs.cjs` ([seguridad.md](seguridad.md)). Además, los mensajes de la guarda de git citan solo tipo y `ruta:línea` de un secreto, nunca su valor.

## Qué no hace

- No envía transcripciones ni conversaciones a ningún servidor. Los scripts de medición leen localmente las transcripciones `.jsonl` de Claude Code y solo extraen números de uso y nombres de herramientas, agentes y skills.
- No instala telemetría ni analítica de ningún tipo.
- No toca `~/.codex/config.toml`: el fragmento se imprime para que el usuario lo pegue.
- No ejecuta código del proyecto auditado fuera de la caja de arena.

## Cómo trabajar sin red

| Funciona sin red | Queda `FALLÓ`, `OMITIDA` o `UNKNOWN` |
|---|---|
| capa 1 completa (kit, doctor, línea de uso) | osv-scanner y `npm audit`/`pnpm audit`: `FALLÓ`, y el estado global de la pasada determinista pasa a `UNKNOWN` |
| capa 2 completa: hooks, sello, registro, guarda de git | auditor Codex: sin red no puede correr y se reporta como no corrido |
| gitleaks, Semgrep (reglas ya instaladas) y cyber-neo | preparación de dependencias para las pruebas de concepto: esas pruebas quedan `needs_validation` |
| caja de arena con imágenes ya descargadas | instalación o actualización de la capa 3 y de la puerta visual |
| puerta visual contra sitios locales | Lighthouse, la primera vez que se descarga con `npx` |

## Ver también

- [codex.md](codex.md): el único componente que envía código a un tercero.
- [seguridad.md](seguridad.md): corridas, evidencias y retención.
- [kit.md](kit.md): la barra de estado y sus claves.
- [visual.md](visual.md): la puerta visual.
- [configuracion.md](configuracion.md): las claves que controlan cada interruptor.
