# Diagnóstico y solución de problemas

Esta página describe los tres doctores de UAEH (programas de diagnóstico que solo leen), la herramienta que limpia las corridas de seguridad y una tabla de problemas frecuentes con su causa y su remedio. Es el primer lugar donde mirar cuando algo no se comporta como se espera.

## Los tres doctores

| Doctor | Skill | Script | Qué revisa |
|---|---|---|---|
| Capa 1 | `/uaeh-kit:doctor` | `plugins/uaeh-kit/scripts/doctor.cjs` | El kit: Node, Claude Code, hooks, config, inyección de reglas, `CLAUDE.md`, barra de estado. |
| Capa 2 | `/uaeh-harness:doctor` | `plugins/uaeh-harness/scripts/doctor.cjs` | El arnés: git, guarda de git, espejo, candados, sello, guardia de cierre. |
| Capa 3 | `/uaeh-harness:doctor puertas` | `plugins/uaeh-harness/scripts/doctor-puertas.cjs` | Las puertas: seguridad, visual, codex y preflight. |

`/uaeh-harness:doctor` corre los dos del arnés (capa 2 y puertas). Ambas skills solo se invocan a mano.

**Estados de cada comprobación** (comunes a los tres): `OK` · `AVISO` (funciona, pero no como recomienda el método) · `FALLÓ` (algo roto) · `OMITIDA` (no se midió; nunca cuenta como OK) · `NO_INSTALADA` · `NO_APLICA`. Las salidas de `--json` y los estados no se traducen.

### Doctor de la capa 1 (kit)

```
node "<plugin>/scripts/doctor.cjs" [--capa kit|todo] [--cwd <dir>] [--json] [--proponer]
```

`--capa todo` equivale a `kit`. Códigos de salida: 0 sin `FALLÓ` · 1 con `FALLÓ` · 2 uso incorrecto. Solo lee; la única escritura posible es la de `--proponer`, que deja junto a cada `settings.json` con hooks duplicados un archivo aparte `<nombre>.uaeh-propuesto.json` sin los duplicados. **El original nunca se toca**; adoptar la propuesta es decisión del usuario.

Comprobaciones: `node` (≥ 20) · `claude-code` (versión recomendada ≥ 2.1.295) · `rutas` (carpetas de estado escribibles) · `hooks-json` (cada hook apunta a un script que existe) · `duplicados` (hooks de una instalación manual anterior en `settings.json`) · `config` (validez de `uaeh.config.json`) · `tope-compactacion` (tope del contexto; recomendado 700000) · `transcripciones` (formato legible) · `inyeccion` (la marca de reglas aparece en transcripciones recientes) · `claude-md-tamano` (aviso sobre el límite de caracteres) · `bloque-reglas` (bloque del método al día) · `statusline` · `espejo` (versión del espejo igual a la del plugin) · `skills-listado` · `subagente-modelo`.

### Doctor de la capa 2 (arnés)

```
node "<plugin>/scripts/doctor.cjs" [--cwd <dir>] [--json] [--rapido]
```

`--rapido` salta las tres autopruebas, que quedan `OMITIDA`. Sin él tarda unos segundos más. Códigos: 0 sin `FALLÓ` · 1 con `FALLÓ` · 2 uso incorrecto. Solo lee: las autopruebas trabajan en carpetas temporales propias que se borran, y el doctor nunca edita `settings.json`, agentes ni skills; solo señala duplicados y copias.

Comprobaciones: `node` · `git` (≥ 2.31) · `rutas` · `config` · `hooks-json` · `duplicados` (hooks de `settings.json` que el plugin ya registra) · `copias-personales` (agentes o skills personales con el mismo nombre que los del plugin) · `guarda-git` (el `core.hooksPath` global apunta al espejo) · `espejo` (igual al plugin) · `humo` (autoprueba de la guarda en un repo temporal) · `candado` (autoprueba: un revisor se niega a borrar, la sesión principal pasa) · `sello` (autoprueba: `INTACTO` y luego `ROTA`) · `guardia-cierre` (encendida o apagada) · `politica-commits` (crédito y firma vigentes) · `sellos-abiertos` (`OK` sin revisiones abiertas en otras terminales; `AVISO` con N abiertas, porque instalar o cambiar la configuración en ese momento anularía su veredicto).

### Doctor de las puertas (capa 3)

```
node "<plugin>/scripts/doctor-puertas.cjs" [--puerta seguridad|visual|codex|preflight] [--todas] [--rapido | --vivo] [--json]
```

Sin `--puerta` revisa las cuatro; `--puerta` admite varias, repetidas o separadas por comas. `--rapido` y `--vivo` no van juntas.

| Bandera | Efecto |
|---|---|
| `--rapido` | Solo lo barato (~5 s con WSL despierto): salta autopruebas, el tamaño de las corridas y el catálogo visual. Es lo que corre la puerta de seguridad antes de cada auditoría. |
| `--vivo` | Suma lo caro y real: la prueba de aislamiento de Codex (**gasta uso de Codex**, ~2 min) y la autoprueba visual con navegador (~2 min). Pedir el visto bueno antes. |

Cada puerta recibe un estado: `LISTA` (sin `FALLÓ` ni `NO_INSTALADA`; puede llevar `AVISO`) · `NO_INSTALADA` (falta una pieza) · `NO_LISTA` (algo falló) · `APAGADA` (solo Codex, sin consentimiento: es opcional). El veredicto global es `LISTA` si todas las pedidas están `LISTA` o `APAGADA`. Códigos: 0 `LISTA` · 1 `NO_LISTA` · 2 uso incorrecto. La única escritura posible es, con `--vivo`, el recuerdo de la prueba de Codex en `UAEH_HOME/cache/doctor-ultimo.json`.

| Puerta | Comprobaciones |
|---|---|
| seguridad | `plataforma`, `motor`, `wsl-version`, `sistema`, `systemd`, `escaneres`, `reglas-semgrep`, `docker`, `imagenes`, `programas`, `validadores`, `uaeh-conf`, `python`, `parche-cyber-neo`, `vendor`, `corridas` |
| visual | `node`, `playwright-cli`, `chrome`, `config-global`, `candado-navegador`, `guias`, `catalogo`, `autoprueba` |
| codex | `consentimiento`, `cli`, `sesion`, `modelos`, `agents-md`, `aislamiento` |
| preflight | `skill`, `plantillas`, `huella`, `jurisdiccion` |

## Corridas de seguridad: uaeh-runs.cjs

La puerta de seguridad guarda una copia del código auditado en cada corrida, y la carpeta crece sin límite. `plugins/uaeh-harness/scripts/uaeh-runs.cjs` la administra:

```
node "<plugin>/scripts/uaeh-runs.cjs" listar|tamano|limpiar [--base <carpeta>] [--aplicar] [--json]
```

| Orden | Hace |
|---|---|
| `listar` | Enumera las corridas por repo. |
| `tamano` | Tamaño por repo y total; avisa si pasa de `datos.retencion.avisoGB`. |
| `limpiar` | Aplica la política de retención. **En seco por defecto**: sin `--aplicar` no cambia ni un byte. |

Política (`datos.retencion`, ver [configuracion.md](configuracion.md)): se conservan siempre completas las `mantenerUltimas` corridas más recientes de cada repo (3); del resto, pasadas `completasDias` (30) se compactan (se borran solo las copias del código y se conservan hallazgos, informes y evidencia) y pasadas `borrarDias` (365) se borra la carpeta entera. Nunca toca `estado-hallazgos.json`, nunca sigue enlaces simbólicos ni uniones, y no toca los volúmenes de Docker. Códigos: 0 bien · 1 error (base peligrosa, fallo al borrar) · 2 uso incorrecto.

## Problemas frecuentes

| Síntoma | Causa | Remedio |
|---|---|---|
| Tras instalar o actualizar, los hooks o los agentes `uaeh-harness:*` no aparecen. | Una sesión abierta antes de instalar no carga los hooks ni los agentes nuevos, y `/clear` no lo corrige. | Cerrar y reabrir **todas** las sesiones de Claude Code (terminales y app de escritorio). |
| El doctor del kit marca `inyeccion` como `AVISO`: «no vista en transcripciones recientes». | Aún no hubo una sesión nueva con el plugin cargado, o la inyección no llega. Se comprueba en la transcripción, no en la salida del hook. | Abrir una sesión nueva con el plugin cargado y volver a correr el doctor. Si `reglas.inyectar` es `false` y no hay bloque en ningún `CLAUDE.md`, el estado es `FALLÓ`: activar la clave o correr `/uaeh-kit:setup claude-md`. |
| `duplicados` en `AVISO`: hooks de `settings.json` que el plugin ya registra y «correrían dos veces». | Quedó una instalación manual anterior del método. | Quitar esos hooks de `settings.json` a mano (el doctor no edita). El del kit puede generar antes una propuesta con `--proponer`. |
| `guarda-git`: «sin guarda de git», o «otra guarda: …». | No hay `core.hooksPath` global, o apunta a otra guarda (por ejemplo husky). | `/uaeh-harness:setup git-guard`. Una guarda ajena no se pisa sola: sustituirla requiere `--reemplazar`, y `git-guard --quitar --aplicar` restaura la anterior. |
| `espejo`: «desactualizado …; instalar.cjs git-guard --aplicar», o `NO_INSTALADA`. | Se actualizó el plugin y el espejo de ruta fija quedó con la versión anterior. | `node "<plugin>/scripts/instalar.cjs" git-guard --aplicar` desde la copia nueva del plugin, y reabrir las sesiones. |
| `claude plugin install uaeh-harness@uaeh` falla entera con `EPERM: operation not permitted, copyfile …` sobre un archivo de `vendor/`. | Un antivirus de equipo toma por malware un ejemplo de código vulnerable de las guías de seguridad incluidas y bloquea la copia. Medido en Windows 11 con Bitdefender, con `vendor/cyber-neo/references/lang-python.md`; corregido con un cambio de un carácter documentado en `vendor/cyber-neo/PATCHES/0003-ejemplo-que-dispara-antivirus.md`. Otro antivirus u otra versión de firmas puede marcar otro archivo. | Crear una excepción del antivirus para la carpeta de plugins de Claude Code (`~/.claude/plugins`) y repetir la instalación. Conviene reportar el archivo marcado. |
| Todo comando de Bash y PowerShell se bloquea con `PreToolUse:Bash hook error: […guardia-git.js]: failed; blocking because onFailure is "block"`. O, con solo `uaeh-kit`, los hooks muestran `Executable not found in $PATH: "node"` y no se inyecta nada. | Node no está en el `PATH`. Con `uaeh-harness` el bloqueo es intencional: la guarda falla cerrada. Los doctores son scripts de Node y tampoco pueden correr. | Comprobar `node --version` en la terminal. Instalar Node 20 o posterior y reabrir las sesiones, o desactivar con `/plugin disable uaeh-harness`. |
| Un comando con `--aplicar` del arnés se niega diciendo que hay una revisión abierta. | Otra terminal tiene un verificador o auditor con el sello abierto; instalar ahora anularía su veredicto. | Esperar a que termine, o repetir con `--forzar` (anula el veredicto de esa revisión). Una revisión que murió sin cerrar bloquea hasta 90 minutos. Ver [arnes.md](arnes.md). |
| Un `git commit` se niega. | La guarda revisa dentro de git el contenido real del commit: secretos en líneas añadidas, archivos sensibles tipo `.env`, evidencias del navegador y, con `commits.credito=prohibir`, el crédito o la identidad de Claude. El mensaje de la guarda indica el tipo y el `ruta:línea`, nunca el valor. | Sacar el secreto o el archivo del commit, o ajustar el mensaje a la política (`commits.firma`). La guarda se aplica también con `--no-verify`; no se salta. |
| La guardia de cierre no deja terminar la respuesta. | Corrieron revisores sin registrar la tarea, o hubo un commit de lista blanca sin revisión. Bloquea una sola vez por pendiente y por sesión. | Registrar la tarea con `uaeh-registro.cjs`. Si es un falso positivo: `node "<plugin>/hooks/uaeh-guardia-cierre.js" directo "motivo"`; si fue una re-verificación ya registrada: `descartar "motivo"`. Quedan con huella en `excepciones.jsonl`. Para apagarla: crear `UAEH_HOME/guardia-cierre.apagada`. |
| El sello de un revisor queda `ROTA`, o el revisor reporta `UNKNOWN`. | Algo cambió en el repo o en el arnés mientras el revisor trabajaba (incluso otra sesión). | Repetir la revisión sin tocar el repo ni el arnés durante la ronda. Una revisión con sello `ROTA` o `DESCONOCIDO` nunca es PASS. |
| `wsl-version` en `FALLÓ`: «está en WSL 1: Docker necesita WSL 2». | La distro quedó en WSL 1. | `wsl --set-version <distro> 2`, comando que corre el usuario en su terminal. |
| `systemd` en `AVISO`: «el proceso 1 es …». | La distro no usa systemd, que el Docker de la puerta necesita. | Poner `[boot]` con `systemd=true` en `/etc/wsl.conf` de la distro y ejecutar `wsl --shutdown`. |
| `programas`, `validadores` o `imagenes` en `AVISO`, `FALLÓ` o `NO_INSTALADA`; versiones distintas del pin; algo de la capa 3 «desactualizado» tras actualizar el plugin. | La capa 3 instalada en el motor de Linux no coincide con el plugin. | En seco primero: `node "<plugin>/scripts/instalar.cjs" puertas seguridad --actualizar` y luego con `--aplicar`; para versiones distintas o imágenes faltantes, `--reparar`. Lo que pide administrador (instalar WSL, `sudo`, `wsl --terminate`) lo imprime el instalador y lo corre el usuario. |
| La autoprueba visual sale con 3, o el doctor dice «autoprueba sin dependencias o sin navegador (no se probó nada)». | Faltan las dependencias de la autoprueba o el Chromium exacto de la versión de Playwright fijada. | `node "<plugin>/skills/uae-visual/pruebas/probar-visual.cjs" --instalar`, o `instalar.cjs puertas visual --aplicar`. Un 3 nunca es éxito. |
| `cli` en `NO_INSTALADA`: «sin Codex CLI». O `sesion` en `FALLÓ`: «sin sesión de Codex». | Codex no está instalado o no tiene sesión iniciada. | `npm i -g @openai/codex`, `codex login` en la terminal del usuario, o `CODEX_JS` con la ruta a `codex.js`. Codex es opcional. |
| La puerta codex aparece `APAGADA`; el auditor sale con `NO_HABILITADO`. | `codex.habilitado` es `false` (valor de fábrica): sin consentimiento no se envía código a OpenAI. | Es lo esperado. Para usarlo: `instalar.cjs puertas codex --consiento --aplicar` (ver [codex.md](codex.md)). |

## Qué adjuntar al reportar un problema

1. La salida del doctor que corresponda, en JSON: `node "<plugin>/scripts/doctor.cjs" --json` (y `doctor-puertas.cjs --json` si el problema es de una puerta).
2. La versión de Claude Code (`claude --version`).
3. El sistema operativo y, en Windows, la versión de WSL y la distro.

Antes de enviar, revisar que la salida no lleve datos privados: rutas con nombres de usuario o de proyectos, nombres de repositorios o cualquier valor sensible. El doctor nunca imprime valores de secretos, pero las rutas sí aparecen.

## Ver también

- [instalacion.md](instalacion.md) — instalación y actualización.
- [configuracion.md](configuracion.md) — claves y variables que usan los doctores.
- [arnes.md](arnes.md) — guarda de git, sello y guardia de cierre.
- [seguridad.md](seguridad.md) y [plataforma.md](plataforma.md) — requisitos del motor de Linux.
- [visual.md](visual.md) — autoprueba visual.
