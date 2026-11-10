# uaeh-harness — notas para contribuir / contributor notes

Este archivo solo aplica a quien edita ESTE repositorio. Los plugins no lo cargan (un `CLAUDE.md`
dentro de `plugins/` no se lee; las reglas del método viajan como plantilla + hook).

## Qué es
Marketplace `uaeh` con dos plugins de Claude Code: `plugins/uaeh-kit` (capa 1: método + kit de
eficiencia de tokens; solo informa) y `plugins/uaeh-harness` (capas 2 y 3: arnés de verificación y
puertas; hooks que bloquean). Diseño y hoja de ruta: `README.md`, `CHANGELOG.md`.

## Convenciones (se verifican en CI)
- **Node ≥ 20, sin dependencias.** Scripts `.cjs`/`.js` con `'use strict'`, LF, UTF-8 sin BOM.
- **Rutas de estado solo desde `scripts/lib/comun.cjs`:** `claudeHome()`, `uaehHome()`, `estableDir()`.
  Nunca `os.homedir()/.claude` suelto, nunca rutas absolutas de una máquina.
- **Los scripts se localizan entre sí con `__dirname`.** `${CLAUDE_PLUGIN_ROOT}` solo aparece en el
  cuerpo de `SKILL.md`, `agents/*.md` y `hooks.json` (ahí sí se sustituye); no existe en el Bash del modelo.
- **Hooks nunca rompen la sesión:** todo en try/catch, salida 0; los del kit no usan `onFailure`.
- **Mensajes al usuario en español (v1).** Contratos de máquina (claves JSON, estados) estables y en
  minúsculas: `OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA`.
- **Herramientas en seco por defecto:** todo lo que escribe fuera del repo exige `--aplicar` y deja respaldo.
- **Pruebas herméticas** (`tests/**/*.test.cjs`, `node --test`): casa temporal con `tests/helpers/entorno.cjs`;
  nunca leen la configuración real; una prueba omitida no es una prueba que pasó (`UAEH_CI=1` la vuelve fallo).
- **Nada personal en el repo:** `node tools/lint-publicacion.cjs` corre antes de cada commit (lista negra de
  nombres, rutas de máquina, clientes). Terceros solo en `vendor/<nombre>/` con su LICENSE y `UPSTREAM.json`; lo que es
  idéntico a su huella de origen (sin parches) queda fuera de la lista negra, lo demás de la carpeta se revisa.
- **Commits en español**, un cambio por commit, sin `--no-verify`, sin `git add -A`.

## Comandos
```
node tools/correr-pruebas.cjs            # todas las pruebas (añade --filtro <texto> para un subconjunto)
node tools/lint-publicacion.cjs          # lista negra: la pública va en el script; la de nombres propios NO vive en el repo
#   (variable UAEH_LINT_PRIVADO o tools/lista-negra.local.txt, ignorado por git; sin ella el lint lo avisa y sigue)
node tools/verificar-publicacion.cjs     # todo lo anterior + manifiesto, extensiones prohibidas, JSON, LF, BOM, fin de línea de la copia, tamaños
# secretos (lo corre el trabajo «secretos» de la CI; aquí, con el gitleaks del WSL): gitleaks git|dir --config .gitleaks.toml --redact .
#   excepciones SOLO por huella exacta en .gitleaksignore, con su motivo; nunca por carpeta
node tools/verificar-presupuesto.cjs     # descripciones de skills/agentes ≤ 350 caracteres
claude plugin validate --strict plugins/uaeh-kit
claude --plugin-dir ./plugins/uaeh-kit   # probar el kit en esta sesión sin instalarlo
node plugins/uaeh-harness/scripts/doctor.cjs [--rapido]                  # capa 2 contra esta máquina (solo lee)
node plugins/uaeh-harness/scripts/doctor-puertas.cjs [--puerta x] [--rapido]   # puertas de la capa 3 (solo lee; --vivo gasta cuota de Codex)
```

## Dónde está cada cosa
`plugins/uaeh-kit/{hooks,scripts,skills,statusline,templates}` · `plugins/uaeh-harness/{hooks,git-hooks,scripts,agents,skills,codex,templates,vendor,wsl}` ·
pruebas en `tests/kit/`, `tests/harness/` y `tests/tools/` (fuera de los plugins para no inflar la caché de instalación) ·
herramientas del repo en `tools/` · origen de cada archivo importado en `tools/manifiesto-importacion.txt`.

## Reglas propias del harness (capa 2)
- **`scripts/lib/comun.cjs` es la misma biblioteca en los dos plugins, byte a byte** (lo exige `tests/harness/comun-espejo.test.cjs`):
  se edita la del kit y se copia al harness. Lo propio del harness va en `lib/config.cjs` y `lib/runner.cjs`.
- **Espejo de ruta fija:** el kit escribe en `UAEH_HOME/estable/`; el harness en `UAEH_HOME/estable/uaeh-harness/` (con su
  `VERSION`). `git-hooks/` y `hooks/` son hermanas en el plugin y en el espejo: `guardia-commit.cjs` se busca con `$d/../hooks/`.
- **`hooks.json` en forma exec y con compuerta por identidad:** los candados aplican solo a los agentes de `hooks/candados.json`
  (`_identidad.js` quita el prefijo `uaeh-harness:`); `onFailure: block` únicamente en `guardia-git.js`.
- **Pruebas con secretos de juguete, armados por partes** (`'AKIA' + '…'`, `'pass' + 'word = …'`): la guarda de git del propio
  repo revisa cada commit y negaría el archivo de prueba si el patrón apareciera entero.
- Las suites de `guardia-git`/`guardia-commit` hacen commits reales y tardan 8–12 min en Windows; un archivo solo:
  `node --test tests/harness/<x>.test.cjs`.

## Reglas propias de la capa 3 (`wsl/`)
- **Pines solo en `wsl/herramientas.json`** (ningún script repite una versión, huella o digest: lo exige `tests/harness/wsl.test.cjs`).
- **Bloques comunes de bash** («validar» en `instalar.sh`, `instalar-bin.sh`, `bin/uaeh-sandbox`, `bin/uaeh-validar`; «conf» en los dos `bin/`):
  idénticos byte a byte; se edita uno y se copia a los demás. `uaeh-promover` repite las reglas en Python y la prueba compara los veredictos.
- Los programas de `wsl/bin/` y los instaladores se pueden cargar con `source` (solo definen funciones): así se prueban sin root ni Docker.
- Probar de verdad sin tocar el `/opt/uaeh` de la máquina: `bash tools/probar-instaladores-contenedor.sh` (Linux o WSL con Docker y red,
  ~5 min) corre los instaladores como root en un `ubuntu:24.04` desechable con el plugin en solo lectura y da PASS/FAIL por control.
  Obligatoria tras tocar `wsl/` o subir un pin. Las autopruebas de `wsl/pruebas/` salen con 77 donde no hay Docker.
