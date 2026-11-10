# Caja de arena (`uaeh-sandbox`) — cómo confirmar una PoC

Docker Engine dentro del motor de Linux (WSL2 en Windows; Linux directo). La versión de Docker y las imágenes (por digest) las fija la lista de pines de la capa 3 (`wsl/herramientas.json` del plugin). Los programas viven en `/opt/uaeh/bin` (propiedad de root: nadie más los cambia) y se instalan con `wsl/instalar.sh` + `wsl/instalar-bin.sh` del plugin (guía: `wsl/README.md`). La carpeta de corridas que la caja acepta y el usuario salen SOLO de `/opt/uaeh/uaeh.conf` (de root; se cambia volviendo a correr `instalar-bin.sh`): si la corrida no cuelga de ahí, la caja la rechaza con código 64. Autoprueba: `<PREFIJO_MOTOR> env PROBAR_DISCO=1 bash /opt/uaeh/pruebas/probar-sandbox.sh`.

Los marcadores `<PREFIJO_MOTOR>`, `<PREFIJO_CAJA>` y `<RUN_MOTOR>` se definen en SKILL.md (sección «Prefijos»). En Linux el prefijo del motor es vacío.

## Lo que garantiza
- **Sin red:** `--network none` (solo loopback). Con `--bd`, postgres comparte ese loopback (`--network container:`); tampoco tiene salida.
- **Entorno vacío:** solo PATH/NODE de la imagen + `HOME=/work/home`, `TMPDIR=/tmp`, `CI=1` y las `--env` explícitas (nunca HOME, PATH, LD_*, DATABASE_URL).
- **Solo lectura:** raíz del contenedor, `/src` (copia limpia), `/deps` y `/uaeh`. Usuario 1000, sin capacidades, `no-new-privileges`, sin `docker.sock`, sin el disco del anfitrión.
- **Escritura:** `/work` y `/tmp` (tmpfs, se pierden) y `/scratch` = `<run>/agents/<id>/scratch` (lo único que persiste).
- **Límites:** 3 GB RAM, 2 CPU, 256 procesos, 256 MB por archivo, 1 GB total de scratch (vigía cada 2 s), tiempo ≤ 900 s (código 124 al vencer).
- **Imágenes fijadas por digest:** lista blanca `/opt/uaeh/imagenes.json`. Agregar otra = mismo método (≥ 14 días de antigüedad, digest) por el padre.

## Uso (un agente verificador; UNA línea; el código entre comillas SIMPLES; con la herramienta Bash)
Desde Git Bash en Windows va SIEMPRE el prefijo `MSYS_NO_PATHCONV=1` (sin él, Git Bash convierte `/opt/...` en rutas de Windows y falla). En Linux no hace falta. PowerShell 5.1 rompe las comillas dobles dentro de argumentos: no usarlo para PoC con código.
```
MSYS_NO_PATHCONV=1 <PREFIJO_CAJA> --run <RUN_MOTOR> --agente v01 [--deps <volumen>] [--bd] [--segundos 120] [--env CLAVE=valor] -- sh -c 'sh /uaeh/armar.sh && cd /work/app && node poc.js'
```
- Fuera de Git Bash se omite `MSYS_NO_PATHCONV=1 `.
- `sh /uaeh/armar.sh` copia `/deps/app` (dependencias preparadas) y encima `/src` a `/work/app`.
- La PoC se escribe dentro: `node -e '<código que usa comillas dobles>'`, o se genera en `/work` y se corre. Resultados que deban conservarse → `/scratch/`.
- Servidor + cliente en el mismo contenedor: `node app.js & sleep 2; node -e 'fetch("http://127.0.0.1:3000/...")…'`.
- Fuera de comillas simples el candado niega `; & | < > $ ( ) { } @ # % \` y saltos de línea (no se puede encadenar nada del lado del anfitrión).

## Etapas del padre (la conversación principal)
- **Dependencias:** `<PREFIJO_MOTOR> /opt/uaeh/bin/uaeh-sandbox preparar-deps --run <RUN_MOTOR> --gestor npm|pnpm` → volumen `uaeh-deps-<repo>-<hash del lockfile>`. Es la única etapa con red y usa `--ignore-scripts` (no corre código del proyecto). Si falla porque algo necesita scripts de instalación (prisma generate, sharp, bcrypt nativo) → la PoC queda `needs_validation` con ese motivo; no se improvisa.
- **Promoción de evidencia:** `<PREFIJO_MOTOR> /opt/uaeh/bin/uaeh-promover --run <RUN_MOTOR> --agente <id> --max-archivo <bytes> --max-total <bytes> --archivo <ruta-en-scratch> …` (los 11 pasos de la fase de validación de `security-audit`, con O_NOFOLLOW; rechaza enlaces, enlaces duros, FIFO y rutas con `..`).
- **Validadores:** `<PREFIJO_MOTOR> /opt/uaeh/bin/uaeh-validar <RUN_MOTOR>` (y `--pruebas` para sus suites).

## Lo que NO hace (límites conocidos)
- **El candado `solo-lectura.js` de los revisores es mejor esfuerzo, no frontera** (auditorías del autor: Codex y `uaeh-harness:uae-security` lo evadieron con comandos armados a propósito). La frontera dura es el contenedor: usuario 1000, raíz y `/src` de solo lectura, sin disco del anfitrión, sin `docker.sock`, `CapEff` 0 y sin red. Para el revisor, la garantía es el **sello de integridad** (`uaeh-integridad.cjs` del plugin): foto del repo y del arnés antes y después de cada revisor; si algo cambió, su veredicto se anula. Un sandbox de solo lectura del sistema no se usa para el verificador: rompería sus pruebas (escriben cachés y builds).
- **Scratch puede traer enlaces** creados por el código del contenedor: se promueve **solo** con `uaeh-promover`, que los rechaza. Nunca usar `cp -r`, glob ni `cat` sobre `scratch/`.
- **`preparar-deps`:** corre con `--ignore-scripts` y con `--ignore-pnpmfile` (regresión: `<PREFIJO_MOTOR> bash /opt/uaeh/pruebas/probar-pnpmfile.sh` → `PNPMFILE_OK`). Es la única etapa con red y solo la corre el padre.
- No prueba despliegue, proveedor, CDN, headers de producción ni identidad real: eso es `needs_validation` con plan seguro.
- Sin navegador en la imagen node: un XSS se confirma con el HTML o la respuesta renderizada (o queda `needs_validation`).
- Las imágenes php/mariadb/python no están fijadas aún: se agregan cuando un proyecto las pida.
