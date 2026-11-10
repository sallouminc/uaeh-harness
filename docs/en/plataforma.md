# Platform

This page states on which operating systems each UAEH layer works and with what level of evidence: used daily by the author, tested in continuous integration (CI), untested, or unsupported. It also details the WSL2 requirements, what layer 3 installs on Linux, and the list of what has not been tested.

Continuous integration (CI) is the GitHub robot that runs the repository's tests on every change; it is defined in `.github/workflows/ci.yml`.

## Table by system and layer

| System | Layer 1 (`uaeh-kit`) | Layer 2 (harness) | Layer 3: security | Layer 3: visual | Layer 3: preflight |
|---|---|---|---|---|---|
| Windows 11 (with WSL2 for layer 3) | Used daily by the author; unit tests in CI (`windows-latest`) | Used daily by the author; unit tests in CI | Used daily by the author (engine in WSL2) | Tested only here (local self-test with a real browser) | The skill, tested on Windows 11; fingerprint, seal, and templates, in CI |
| Linux (Ubuntu 24.04 x86_64) | Unit tests in CI (`ubuntu-24.04`, Node 20 and 24) | Unit tests in CI | Tested natively in CI: jobs `linux-integracion` and `instaladores-contenedor` | Untested | Fingerprint, seal, and templates, in CI; the skill, untested |
| macOS | Untested (should work: it is pure Node) | Untested (should work: Node plus git) | Not supported in version 1 | Untested | Untested |

Notes on the table:

- The unit tests run with Node 20 and Node 24 on Windows and Ubuntu. No CI job runs on macOS.
- The visual gate needs to download a Chromium of the pinned Playwright version; CI does not download it, so its self-test (`skills/uae-visual/pruebas/probar-visual.cjs`) is a local step. If that browser is missing, the self-test exits with «SIN NAVEGADOR» ("no browser") and never with PASS.
- A skipped test does not count as a passed test: in CI, `UAEH_CI=1` turns a skipped test into a failure.
- `verify.ps1` (verification template for projects) is only tested on Windows PowerShell 5.1.

## WSL2 requirements (Windows 11)

The Linux engine of the security gate runs inside WSL2 (Windows Subsystem for Linux, a lightweight Linux inside Windows). Requirements documented in `plugins/uaeh-harness/wsl/README.md`:

1. Ubuntu 24.04 x86_64 distro. Installation: `wsl --install -d Ubuntu-24.04`, in PowerShell as administrator.
2. systemd enabled inside the distro: in `/etc/wsl.conf`, the `[boot]` section with `systemd=true`; then `wsl --shutdown` from PowerShell.
3. UAEH configuration in `UAEH_HOME/uaeh.config.json`:

| Key | Meaning |
|---|---|
| `wsl.distro` | Name of the distro (default `Ubuntu-24.04`). Only accepts letters, digits, period, hyphen, and underscore |
| `wsl.usuario` | Distro user the gate runs as. Never `root`; empty by default |

Both can be overridden with the variables `UAEH_WSL_DISTRO` and `UAEH_WSL_USER`. To enter the engine, UAEH runs `wsl.exe -d <distro> [-u <usuario>] -e …`.

4. When the installation finishes, `wsl --terminate <distro>` so that the `docker` group applies to the user. UAEH never runs the WSL installation, the systemd activation, or `wsl --terminate` on its own: it prints them for the user to run.

## What layer 3 installs on Linux

Everything is installed as root under `/opt/uaeh`, out of reach of the agents. Two programs in `plugins/uaeh-harness/wsl/` do it:

| Program | What it installs |
|---|---|
| `instalar.sh` | Docker Engine, gitleaks (with its default configuration), osv-scanner, semgrep, the semgrep rules, and the container images, verifying each download against the pins in `herramientas.json` (version, sha256 fingerprint, image digest). It is idempotent and leaves `/opt/uaeh/instalado.json`. `--comprobar` (check) reviews without installing, without root, and without writing anything |
| `instalar-bin.sh` | Copies the programs to `/opt/uaeh/{bin,contenedor,pruebas,validadores}` (including the `uaeh-sandbox` sandbox) and writes `/opt/uaeh/uaeh.conf` with the runs folder and the user |
| `desinstalar.sh` | The inverse: a dry run by default, and with `--aplicar` (as root) it removes `/opt/uaeh` and the `uaeh-*` programs from `/usr/local/bin`. `--con-escaneres` and `--con-imagenes` add the scanners UAEH installed and the sandbox images. It never uninstalls Docker Engine. Steps in [desinstalar.md](desinstalar.md) |

`instalar.sh` variables: `UAEH_USER`, `UAEH_SKIP_DOCKER=1` (uses the Docker already present), `UAEH_SOLO_ESCANERES=1` (no Docker or images), `UAEH_REGLAS_NUEVAS=1`, and `UAEH_TZ`. The runs folder (`UAEH_BASE`) is an absolute Linux path with strict rules, detailed in the README of `wsl/`.

The self-tests in `/opt/uaeh/pruebas/*.sh` end with 0 (green), 1 (failure), or 77 (skipped: layer 3, Docker, or the network is missing). The full path is in [seguridad.md](seguridad.md) and the installation steps in [instalacion.md](instalacion.md).

## What has not been tested

- Layers 1 and 2 on macOS.
- The visual gate on Linux and macOS.
- The preflight skill on Linux and macOS.
- The Codex auditor on Linux with `-s read-only`: the author did not measure it.
- Codex authentication by API key instead of `codex login`, and the availability of the default models (`gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`) on other accounts or plans. See [codex.md](codex.md).
- A real Windows user profile whose name contains accents, the letter ñ or spaces. It was tested only with the tests' temporary and state folders on a path with those characters.
- Outside Ubuntu 24.04 x86_64 (another distribution, another version, or another architecture) there is no declared platform for layer 3.

Tested on Windows with the temporary folder on a path with spaces, accents and the letter ñ: the kit's tests (218) and the harness tests (611), except the two long git guard suites. That run found and fixed one defect: the visual gate's self-test copied its test site with a Node function that fails silently on Windows with non-ASCII paths. In addition, installation from the remote repository into a clean profile was tested with `node tools/probar-perfil-limpio.cjs --desde-github`, which adds the marketplace, installs both plugins in a temporary profile and checks the injection without `--plugin-dir`. It is a repository tool, for contributors. On Windows, Codex was measured with CLI 0.163.0 and `codex login`: `--probar-sandbox` answers `SANDBOX_OK`.

What was tested natively on Linux is the complete layer 3 security in CI: engine installation, sandbox, validators, scanners as a user, and the gate doctor.

## See also

- [instalacion.md](instalacion.md)
- [seguridad.md](seguridad.md)
- [visual.md](visual.md)
- [configuracion.md](configuracion.md)
- [diagnostico.md](diagnostico.md)
