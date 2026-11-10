# Plataforma

Esta página dice en qué sistemas operativos funciona cada capa de UAEH y con qué nivel de evidencia: usado a diario por el autor, probado en integración continua (CI), sin probar o no soportado. También detalla los requisitos de WSL2, lo que instala la capa 3 en Linux y la lista de lo que no se ha probado.

La integración continua (CI) es el robot de GitHub que ejecuta las pruebas del repositorio en cada cambio; está definida en `.github/workflows/ci.yml`.

## Tabla por sistema y capa

| Sistema | Capa 1 (`uaeh-kit`) | Capa 2 (arnés) | Capa 3: seguridad | Capa 3: visual | Capa 3: preflight |
|---|---|---|---|---|---|
| Windows 11 (con WSL2 para la capa 3) | Usado a diario por el autor; pruebas unitarias en CI (`windows-latest`) | Usado a diario por el autor; pruebas unitarias en CI | Usado a diario por el autor (motor en WSL2) | Probado solo aquí (autoprueba local con navegador real) | La skill, probada en Windows 11; huella, sello y plantillas, en CI |
| Linux (Ubuntu 24.04 x86_64) | Pruebas unitarias en CI (`ubuntu-24.04`, Node 20 y 24) | Pruebas unitarias en CI | Probado en CI de forma nativa: trabajos `linux-integracion` e `instaladores-contenedor` | Sin probar | Huella, sello y plantillas, en CI; la skill, sin probar |
| macOS | Sin probar (debería funcionar: es Node puro) | Sin probar (debería funcionar: Node más git) | No soportado en la versión 1 | Sin probar | Sin probar |

Notas sobre la tabla:

- Las pruebas unitarias corren con Node 20 y Node 24 en Windows y en Ubuntu. En macOS no corre ningún trabajo de CI.
- La puerta visual necesita descargar un Chromium de la versión fijada de Playwright; el CI no lo descarga, así que su autoprueba (`skills/uae-visual/pruebas/probar-visual.cjs`) es un paso local. Si falta ese navegador, la autoprueba sale con «SIN NAVEGADOR» y nunca con PASS.
- Una prueba omitida no cuenta como prueba pasada: en CI, `UAEH_CI=1` convierte una prueba omitida en fallo.
- `verify.ps1` (plantilla de verificación para proyectos) solo se prueba en Windows PowerShell 5.1.

## Requisitos de WSL2 (Windows 11)

El motor de Linux de la puerta de seguridad corre dentro de WSL2 (Windows Subsystem for Linux, un Linux ligero dentro de Windows). Requisitos documentados en `plugins/uaeh-harness/wsl/README.md`:

1. Distro Ubuntu 24.04 x86_64. Instalación: `wsl --install -d Ubuntu-24.04`, en PowerShell como administrador.
2. systemd activado dentro de la distro: en `/etc/wsl.conf`, la sección `[boot]` con `systemd=true`; después `wsl --shutdown` desde PowerShell.
3. Configuración de UAEH en `UAEH_HOME/uaeh.config.json`:

| Clave | Significado |
|---|---|
| `wsl.distro` | Nombre de la distro (por defecto `Ubuntu-24.04`). Solo admite letras, números, punto, guion y guion bajo |
| `wsl.usuario` | Usuario de la distro con que corre la puerta. Nunca `root`; por defecto vacío |

Ambas pueden pisarse con las variables `UAEH_WSL_DISTRO` y `UAEH_WSL_USER`. Para entrar al motor, UAEH ejecuta `wsl.exe -d <distro> [-u <usuario>] -e …`.

4. Al terminar la instalación, `wsl --terminate <distro>` para que el grupo `docker` se aplique al usuario. UAEH nunca ejecuta por su cuenta la instalación de WSL, la activación de systemd ni `wsl --terminate`: los imprime para que los ejecute el usuario.

## Qué instala la capa 3 en Linux

Todo se instala como root bajo `/opt/uaeh`, fuera del alcance de los agentes. Lo hacen dos programas de `plugins/uaeh-harness/wsl/`:

| Programa | Qué instala |
|---|---|
| `instalar.sh` | Docker Engine, gitleaks (con su configuración por defecto), osv-scanner, semgrep, las reglas de semgrep y las imágenes de contenedor, verificando cada descarga contra los pines de `herramientas.json` (versión, huella sha256, digest de imagen). Es idempotente y deja `/opt/uaeh/instalado.json`. `--comprobar` revisa sin instalar, sin root y sin escribir nada |
| `instalar-bin.sh` | Copia los programas a `/opt/uaeh/{bin,contenedor,pruebas,validadores}` (incluida la caja de arena `uaeh-sandbox`) y escribe `/opt/uaeh/uaeh.conf` con la carpeta de corridas y el usuario |
| `desinstalar.sh` | Lo inverso: en seco por defecto, y con `--aplicar` (como root) quita `/opt/uaeh` y los programas `uaeh-*` de `/usr/local/bin`. `--con-escaneres` y `--con-imagenes` suman los escáneres que instaló UAEH y las imágenes de la caja de arena. Nunca desinstala Docker Engine. Pasos en [desinstalar.md](desinstalar.md) |

Variables de `instalar.sh`: `UAEH_USER`, `UAEH_SKIP_DOCKER=1` (usa el Docker que ya hay), `UAEH_SOLO_ESCANERES=1` (sin Docker ni imágenes), `UAEH_REGLAS_NUEVAS=1` y `UAEH_TZ`. La carpeta de corridas (`UAEH_BASE`) es una ruta absoluta de Linux con reglas estrictas, detalladas en el README de `wsl/`.

Las autopruebas de `/opt/uaeh/pruebas/*.sh` terminan con 0 (verde), 1 (falla) o 77 (omitida: falta la capa 3, Docker o la red). El camino completo está en [seguridad.md](seguridad.md) y los pasos de instalación en [instalacion.md](instalacion.md).

## Lo que no está probado

- Capas 1 y 2 en macOS.
- La puerta visual en Linux y en macOS.
- La skill de preflight en Linux y en macOS.
- El auditor Codex en Linux con `-s read-only`: el autor no lo midió.
- La autenticación de Codex por clave de API en lugar de `codex login`, y la disponibilidad de los modelos por defecto (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`) en otras cuentas o planes. Ver [codex.md](codex.md).
- Un perfil real de usuario de Windows cuyo nombre lleve acentos, eñes o espacios. Solo se probó con la carpeta temporal y de estado de las pruebas en una ruta con esos caracteres.
- Fuera de Ubuntu 24.04 x86_64 (otra distribución, otra versión u otra arquitectura) no hay plataforma declarada para la capa 3.

Probado en Windows con la carpeta temporal en una ruta con espacios, acentos y eñes: las pruebas del kit (218) y las del arnés (611), salvo las dos suites largas de la guarda de git. Esa corrida encontró y corrigió un fallo: la autoprueba de la puerta visual copiaba su sitio de prueba con una función de Node que en Windows falla sin avisar con rutas no ASCII. Además, la instalación desde el repositorio remoto en un perfil limpio se probó con `node tools/probar-perfil-limpio.cjs --desde-github`, que añade el marketplace e instala los dos plugins en un perfil temporal y comprueba la inyección sin `--plugin-dir`. Es una herramienta del repositorio, para quien contribuye. En Windows, Codex se midió con la CLI 0.163.0 y `codex login`: `--probar-sandbox` responde `SANDBOX_OK`.

Lo que sí se probó en Linux, de forma nativa, es la capa 3 de seguridad completa en el CI: instalación del motor, caja de arena, validadores, escáneres como usuario y el doctor de la puerta.

## Ver también

- [instalacion.md](instalacion.md)
- [seguridad.md](seguridad.md)
- [visual.md](visual.md)
- [configuracion.md](configuracion.md)
- [diagnostico.md](diagnostico.md)
