# Desinstalar

Esta página da el orden para retirar UAEH sin dejar la máquina a medias, y explica qué retira cada comando y qué se quita a mano. El orden importa: la guarda de git debe retirarse mientras el plugin sigue instalado.

Los instaladores no borran archivos propios del usuario. Cada comando de retiro es en seco por defecto: solo con `--aplicar` escribe, y repetirlo responde «nada que hacer».

## Orden recomendado

| Paso | Qué se retira | Cómo |
|---|---|---|
| 1 | Guarda de git | `instalar.cjs git-guard --quitar --aplicar` |
| 2 | Bloque de reglas, ajustes y barra de estado | `instalar.cjs todo --quitar --aplicar` del kit (o cada subcomando por separado) |
| 3 | Codex | `puertas codex --retirar --aplicar` y `instalar.cjs codex --quitar --aplicar` |
| 4 | Capa 3 en Linux o WSL | `desinstalar.sh --aplicar` |
| 5 | Los plugins | Desactivar o desinstalar |
| 6 | Estado en `UAEH_HOME` | Decisión del usuario |

## 1. Guarda de git (antes de desactivar el plugin)

La guarda de git está fijada en la configuración global de git, que apunta a una copia (el espejo) en `UAEH_HOME/estable/uaeh-harness/git-hooks`. Si se desactiva o desinstala el plugin primero, esa configuración global seguiría apuntando al espejo y el comando que la deshace (`instalar.cjs`) ya no estaría a mano. Por eso se retira antes:

```
node "<plugin>/scripts/instalar.cjs" git-guard --quitar
node "<plugin>/scripts/instalar.cjs" git-guard --quitar --aplicar
```

El primer comando es en seco y el segundo escribe. Qué hace `--quitar`:

- Si la configuración global apunta al espejo, la quita; o la restaura al valor anterior si se había sustituido con `--reemplazar` (el valor anterior queda anotado en `git-guard.estado.json`, dentro del espejo).
- Si apunta a otro lugar, no la toca y lo informa.
- El espejo se conserva en disco. No se borra.

Cuando el plugin está instalado se puede usar su skill: `/uaeh-harness:setup git-guard --quitar --aplicar`.

Si el comando con `--aplicar` se niega porque hay una revisión abierta en otra terminal, se espera a que termine o se repite con `--forzar` (ver [arnes.md](arnes.md)).

## 2. Bloque de reglas, ajustes y barra de estado

Las tres reversas del kit se pueden hacer de una vez. El comando `todo --quitar` las aplica en orden inverso (barra de estado, ajustes, bloque de `CLAUDE.md` global) y deja un solo respaldo por archivo:

```
node "<plugin-kit>/scripts/instalar.cjs" todo --quitar
node "<plugin-kit>/scripts/instalar.cjs" todo --quitar --aplicar
```

El primero es en seco y el segundo escribe. Cada pieza también tiene su comando propio:

```
node "<plugin-kit>/scripts/instalar.cjs" claude-md --quitar --aplicar
node "<plugin-kit>/scripts/instalar.cjs" claude-md --proyecto <carpeta del proyecto> --quitar --aplicar
node "<plugin-kit>/scripts/instalar.cjs" settings --quitar --aplicar
node "<plugin-kit>/scripts/instalar.cjs" statusline --quitar --aplicar
```

- `claude-md --quitar` actúa sobre el `CLAUDE.md` global; con `--proyecto`, sobre el de un proyecto. Solo se quita el bloque entre `UAEH:BEGIN` y `UAEH:END`.
- `settings --quitar` quita `env.CLAUDE_CODE_SUBAGENT_MODEL` y `autoCompactWindow` de `settings.json` (por defecto `~/.claude/settings.json`) **solo si conservan el valor que puso el kit** (`sonnet` y `700000`). Si el usuario los cambió, se respetan y el instalador lo dice con una `NOTA`. `env` se quita únicamente si queda vacío; ninguna otra clave se toca. Límite: no puede distinguir un valor igual puesto a mano por el usuario.
- `statusline --quitar` quita `statusLine` de `settings.json` solo si apunta a la barra del kit, y borra de `UAEH_HOME/estable/` únicamente los archivos que el kit copió. La carpeta del otro plugin, `estable/uaeh-harness/`, queda intacta.

Cada archivo que el instalador modificó tiene a su lado un respaldo con nombre `<archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss>`. Restaurarlo es copiarlo sobre el original. Si el instalador muestra una `NOTA` sobre fotos del sello de los últimos 90 minutos, hay una revisión en curso en otra terminal; conviene esperar a que termine.

## 3. Codex

Apagar el auditor Codex (pone `codex.habilitado` en `false` y borra la fecha de `codex.consentimiento`):

```
node "<plugin>/scripts/instalar.cjs" puertas codex --retirar --aplicar
```

Las plantillas que escribió `instalar.cjs codex` se retiran con:

```
node "<plugin>/scripts/instalar.cjs" codex --quitar
node "<plugin>/scripts/instalar.cjs" codex --quitar --aplicar
```

El primero es en seco y el segundo escribe, en la carpeta de Codex (por defecto `~/.codex`, o la de la variable `CODEX_HOME`):

- En `AGENTS.md`, quita solo el bloque entre `<!-- UAEH:BEGIN v… -->` y `<!-- UAEH:END -->`, con respaldo. El resto del archivo no es de UAEH.
- Borra los `agents/uae_*.toml` (cinco: `uae_architect`, `uae_builder`, `uae_security`, `uae_triage`, `uae_verifier`) que sean idénticos a los que el plugin genera hoy. Los que se modificaron se dejan, con una `NOTA`.
- `config.toml` nunca se toca: si el fragmento se pegó a mano, se quita a mano.

Más sobre Codex en [codex.md](codex.md).

## 4. Capa 3 en Linux o WSL

El motor de Linux se retira con `plugins/uaeh-harness/wsl/desinstalar.sh`, que se corre dentro de Linux o de WSL, con la carpeta `wsl/` del plugin como ubicación del script. Esto es lo que la instalación dejó:

- Bajo `/opt/uaeh`, como root: los programas de la caja de arena, los validadores, `uaeh.conf` y `instalado.json`.
- Docker Engine, gitleaks, osv-scanner, semgrep, sus reglas y las imágenes de contenedor (los escáneres quedan en `/usr/local/bin`).
- Respaldos que crea `instalar.cjs puertas seguridad --aplicar` antes de actualizar: copias de `/opt/uaeh` en `/opt/uaeh-respaldo/<fecha>`.

El script es en seco por defecto: sin root y sin escribir nada, lista lo que quitaría.

```
bash desinstalar.sh
sudo bash desinstalar.sh --aplicar
```

- Sin más opciones, `--aplicar` quita `/opt/uaeh` completo y los programas `uaeh-*` de `/usr/local/bin`.
- `--con-escaneres` quita además gitleaks, osv-scanner y semgrep, **solo si son exactamente los que instaló UAEH**. Lo comprueba contra `/opt/uaeh/instalado.json` (huella del binario en gitleaks y osv-scanner; versión del entorno en semgrep). Si no coinciden, son del usuario: se dejan y se avisa. Debe ir en la **misma corrida** que quita `/opt/uaeh`, porque después ya no hay registro contra el cual comprobar.
- `--con-imagenes` quita las imágenes de contenedor de la caja de arena, identificadas por digest. Una imagen en uso se deja, con aviso.

Ejemplo completo:

```
sudo bash desinstalar.sh --con-escaneres --con-imagenes --aplicar
```

Lo que el script nunca hace:

- Desinstalar Docker Engine, que puede estar en uso para otros fines. Imprime el comando para quitarlo a mano.
- Quitar los paquetes base (`ca-certificates`, `curl`, `gnupg`, `pipx`, `python3`).
- Borrar las carpetas de corridas y evidencias de auditorías: solo las nombra.
- Tocar los respaldos `/opt/uaeh-respaldo/<fecha>`.

Es repetible: la segunda vez dice que no hay nada que quitar. Se probó en un contenedor `ubuntu:24.04` desechable (trabajo `instaladores-contenedor` de la integración continua).

La puerta visual deja además `playwright-cli` global y, en `UAEH_HOME/cache/visual-fixture`, las dependencias de su autoprueba. En cada proyecto donde se ejecutó `instalar.cjs visual --proyecto`, se copiaron `playwright.visual.config.ts`, `tests/visual/visual.spec.ts`, el `DESIGN.md` si faltaba y exclusiones de evidencia: son archivos del proyecto y se retiran a mano. El preflight escribe sus documentos en `docs/harness/` de cada repositorio auditado.

## 5. Desactivar o desinstalar los plugins

Con la guarda ya retirada:

```
/plugin disable uaeh-harness
/plugin disable uaeh-kit
```

`/plugin disable` desactiva el plugin sin borrarlo. Para quitarlo del todo se usa el gestor de plugins de Claude Code (`/plugin`). Después, cerrar y reabrir todas las sesiones, como al instalar ([instalacion.md](instalacion.md)).

Los hooks de `uaeh-harness` pueden bloquear: si Node falla, el hook `guardia-git.js` bloquea todo Bash y PowerShell hasta reparar el hook o desactivar el plugin.

## 6. Qué queda en `UAEH_HOME`

`UAEH_HOME` es por defecto `~/.claude/uaeh` (o `UAEH_HOME`, o la carpeta de `CLAUDE_CONFIG_DIR` más `uaeh`). Los instaladores nunca lo borran.

| Elemento | Qué es |
|---|---|
| `uaeh.config.json` | La configuración del usuario |
| `registro.jsonl` | El registro de tareas |
| `integridad/`, `sesiones/`, `excepciones.jsonl` | Fotos del sello, estado de sesiones y excepciones de la guardia de cierre |
| `runs/` | Corridas de la puerta de seguridad, con copias del código auditado |
| `cache/` | Cachés |
| `estable/` | Espejos de la barra de estado y de la guarda de git |

Parte de este contenido son evidencias de auditorías y del registro de tareas. Borrarlo es decisión del usuario; si se quiere reducir solo `runs/`, `node "<plugin>/scripts/uaeh-runs.cjs" limpiar` actúa en seco y `--aplicar` compacta o borra según la retención configurada.

## 7. Emergencia sin Node

Si Node no está disponible, `instalar.cjs` no puede ejecutarse y las confirmaciones de commit pueden fallar. En la terminal del usuario, la configuración global de git se deshace con:

```
git config --global --unset core.hooksPath
```

Esto quita la guarda pero no restaura un valor anterior que se hubiera sustituido con `--reemplazar`; si existía, hay que volver a fijarlo a mano.

## Ver también

- [instalacion.md](instalacion.md)
- [arnes.md](arnes.md)
- [codex.md](codex.md)
- [plataforma.md](plataforma.md)
- [diagnostico.md](diagnostico.md)
