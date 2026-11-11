# `wsl/` — motor de Linux de la puerta de seguridad (capa 3)

[English below](#english)

Lo que la puerta de seguridad (`uae-security`) necesita del lado de Linux: los escáneres (gitleaks, osv-scanner, semgrep y sus reglas), Docker y la caja de arena (`uaeh-sandbox`) donde se confirman las pruebas de concepto. Plataforma: **Ubuntu 24.04 x86_64**, en WSL2 (Windows 11, con systemd) o Linux directo. Todo se instala como root en `/opt/uaeh`, fuera del alcance de los agentes.

| Archivo | Qué hace |
|---|---|
| `herramientas.json` | **Solo pines**: versión, huella sha256 de cada descarga, digest de cada imagen, huella de la llave de Docker. Nada de una instalación concreta. |
| `instalar.sh` | Instala Docker Engine, gitleaks (+ su configuración por defecto), osv-scanner, semgrep, las reglas y las imágenes, verificando cada descarga contra los pines. Idempotente. Deja `/opt/uaeh/instalado.json`. |
| `instalar-bin.sh` | Copia los programas a `/opt/uaeh/{bin,contenedor,pruebas,validadores}` y escribe `/opt/uaeh/uaeh.conf` (carpeta de corridas y usuario). |
| `desinstalar.sh` | Quita lo que instalaron los dos instaladores. **En seco por defecto** (lista, sin root, sin escribir); `--aplicar` (root) quita `/opt/uaeh` y los enlaces `uaeh-*`; `--con-escaneres` añade gitleaks, osv-scanner y semgrep solo si coinciden con la huella de `instalado.json`; `--con-imagenes` añade las imágenes por digest. Nunca desinstala Docker Engine ni borra las carpetas de corridas. Idempotente. |
| `bin/uaeh-sandbox` · `bin/uaeh-promover` · `bin/uaeh-validar` | Caja de arena sin red · promoción de evidencia con `O_NOFOLLOW` · validadores de `security-audit` en Docker. Leen SOLO `/opt/uaeh/uaeh.conf`. |
| `pruebas/*.sh` | Autopruebas contra lo instalado. Código 0 = verde, 1 = falla, **77 = omitida** (falta la capa 3, Docker o la red). |

## Instalar (Windows + WSL2)
1. `wsl --install -d Ubuntu-24.04` y, dentro de la distro, `[boot]` `systemd=true` en `/etc/wsl.conf`; luego `wsl --shutdown`.
2. Revisar sin instalar: `wsl -d <distro> -e bash <wsl del plugin>/instalar.sh --comprobar` (la ruta del plugin en Linux: `wslpath -u "<ruta de Windows>"`).
3. `wsl -d <distro> -u root -e env UAEH_USER=<usuario de la distro> bash <wsl del plugin>/instalar.sh`
4. Carpeta de corridas en ruta de Linux: `node <plugin>/scripts/uaeh-config.cjs ruta-motor "$(node <plugin>/scripts/uaeh-config.cjs runs-dir)"`
5. `wsl -d <distro> -u root -e env UAEH_BASE=<esa ruta> UAEH_USER=<usuario> bash <wsl del plugin>/instalar-bin.sh`
6. `wsl --terminate <distro>` (para que el grupo `docker` aplique) y `wsl -d <distro> -e bash /opt/uaeh/pruebas/probar-sandbox.sh`.

En Linux directo: los mismos pasos con `sudo bash …/instalar.sh` y `sudo env UAEH_BASE=… bash …/instalar-bin.sh` (el usuario sale de `SUDO_USER`).

**Variables de `instalar.sh`:** `UAEH_USER` · `UAEH_SKIP_DOCKER=1` (usa el Docker que ya hay) · `UAEH_SOLO_ESCANERES=1` (sin Docker ni imágenes) · `UAEH_REGLAS_NUEVAS=1` (vuelve a bajar las reglas de semgrep) · `UAEH_SEMGREP_REEMPLAZAR=1` (reemplaza un `/usr/local/bin/semgrep` de otra versión que no instaló UAEH; sin ella, el instalador se detiene antes de empezar y no lo toca) · `UAEH_TZ` (zona del sello).

**Reglas de `UAEH_BASE`:** ruta absoluta con solo `A-Z a-z 0-9 . _ - /`; sin `.`, `..`, `//` ni `/` final; 3 niveles o más; bajo `/mnt/…`, `/srv/…` o `/home/<UAEH_USER>/…`. La caja de arena compara la ruta de cada corrida con la base **literalmente** (nunca como expresión regular).

**Subir un pin:** última versión estable publicada hace 14 días o más; huella tomada del archivo oficial de sumas del proyecto; `tests/harness/wsl.test.cjs` y las autopruebas en verde antes de publicar.

<a id="english"></a>
## English

What the security gate (`uae-security`) needs on the Linux side: the scanners (gitleaks, osv-scanner, semgrep and its rules), Docker and the sandbox (`uaeh-sandbox`) where proofs of concept are confirmed. Platform: **Ubuntu 24.04 x86_64**, on WSL2 (Windows 11, with systemd) or plain Linux. Everything is installed as root under `/opt/uaeh`, out of the agents' reach.

- `herramientas.json` — **pins only** (versions, sha256 of each download, image digests, Docker key fingerprint).
- `instalar.sh` — installs Docker Engine, gitleaks (+ its default config), osv-scanner, semgrep, rules and images, verifying every download against the pins. Idempotent. Writes `/opt/uaeh/instalado.json`. `--comprobar` checks without installing (no root, writes nothing).
- `instalar-bin.sh` — copies the programs to `/opt/uaeh` and writes `/opt/uaeh/uaeh.conf` (runs folder `UAEH_BASE` and user `UAEH_USER`), the only configuration the sandbox programs read.
- `desinstalar.sh` — removes what both installers put in place. **Dry run by default** (lists, no root, writes nothing); `--aplicar` (root) removes `/opt/uaeh` and the `uaeh-*` links; `--con-escaneres` also removes gitleaks, osv-scanner and semgrep only if they match the fingerprint recorded in `instalado.json`; `--con-imagenes` also removes the digest-pinned images. It never uninstalls Docker Engine nor deletes the runs folders. Idempotent.
- `pruebas/*.sh` — self-tests against the installed layer: exit 0 = green, 1 = failure, **77 = skipped** (layer 3, Docker or network missing).

Install order (WSL2): enable systemd → `instalar.sh` as root with `UAEH_USER` → `instalar-bin.sh` as root with `UAEH_BASE` (the runs folder as a Linux path: `uaeh-config.cjs ruta-motor "$(uaeh-config.cjs runs-dir)"`) → `wsl --terminate` → `probar-sandbox.sh`. On plain Linux, use `sudo`.
