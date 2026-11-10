# Security policy / Política de seguridad

**English first; español más abajo.**

## Supported versions

Security fixes go to the latest published version of each plugin (`uaeh-kit` and `uaeh-harness`). Older versions do not receive fixes: update with `claude plugin marketplace update uaeh` and `claude plugin update <plugin>@uaeh`, then reopen every Claude Code session.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability** at `https://github.com/sallouminc/uaeh-harness/security/advisories/new`. Do not open a public issue for a vulnerability.

A useful report includes: the plugin and version, the operating system, the exact steps, what was expected and what happened, and the output of the doctor with `--json` (review it first: remove anything private). Never attach real secrets or third-party code.

Reports are acknowledged within 7 days. A confirmed vulnerability is fixed in a new version and credited in the changelog unless the reporter prefers otherwise.

## What a plugin can do on a machine

A Claude Code plugin runs with the privileges of the user who installed it. Before installing, read the hook tables in [`plugins/uaeh-kit/README.md`](plugins/uaeh-kit/README.md) and [`plugins/uaeh-harness/README.md`](plugins/uaeh-harness/README.md): they list every hook and the exact command it runs. What leaves the machine, and under which consent, is documented in [`docs/en/privacidad.md`](docs/en/privacidad.md).

## What counts as a vulnerability here

In scope:

- A way to make a reviewer's result read as passed when the integrity seal should have been `ROTA` or `DESCONOCIDO`, or to alter the seal's records without detection.
- A commit that carries a secret or a `.env` file past the git-layer guard (`guardia-commit.cjs`) when the guard is installed and active.
- The Codex auditor sending anything to its provider while `codex.habilitado` is `false`, or sending files outside the clean copy.
- The sandbox running proof-of-concept code with network access, or with write access to the real repository.
- An installer writing outside the paths it reports, or writing without `--aplicar`.
- A secret printed unredacted in evidence, logs or reports.

Declared limits, not vulnerabilities (they are documented behaviour):

- **The text-layer guard (`guardia-git.js`) and the read-only locks are best effort.** They read command text and can be bypassed by an obfuscated command. The guarantees are the git-layer guard, which inspects the real content of each commit, and the integrity seal around each reviewer.
- On Windows, the read-only sandbox of the Codex CLI does not restrict *reading* to the clean copy. The clean copy is the main defence.
- The security gate's filter discards denial-of-service and resource-exhaustion findings by design.
- Findings in the vendored third-party components belong upstream (see `THIRD_PARTY_NOTICES.md`), unless the problem comes from how this repository uses them.

---

## Versiones con soporte

Los arreglos de seguridad se publican en la última versión de cada plugin (`uaeh-kit` y `uaeh-harness`). Las versiones anteriores no reciben arreglos: se actualiza con `claude plugin marketplace update uaeh` y `claude plugin update <plugin>@uaeh`, y después se reabren todas las sesiones de Claude Code.

## Cómo reportar una vulnerabilidad

Por el reporte privado de vulnerabilidades de GitHub en este repositorio: **Security → Report a vulnerability**, en `https://github.com/sallouminc/uaeh-harness/security/advisories/new`. No se abre un issue público para una vulnerabilidad.

Un reporte útil incluye: el plugin y su versión, el sistema operativo, los pasos exactos, qué se esperaba y qué ocurrió, y la salida del doctor con `--json` (revisarla antes: quitar todo lo privado). Nunca se adjuntan secretos reales ni código de terceros.

Los reportes se responden en un máximo de 7 días. Una vulnerabilidad confirmada se corrige en una versión nueva y se acredita en el registro de cambios, salvo que quien reporta prefiera lo contrario.

## Qué puede hacer un plugin en una máquina

Un plugin de Claude Code corre con los permisos del usuario que lo instaló. Antes de instalar conviene leer las tablas de hooks de [`plugins/uaeh-kit/README.es.md`](plugins/uaeh-kit/README.es.md) y [`plugins/uaeh-harness/README.es.md`](plugins/uaeh-harness/README.es.md): listan cada hook y el comando exacto que ejecuta. Qué sale de la máquina, y con qué consentimiento, está en [`docs/es/privacidad.md`](docs/es/privacidad.md).

## Qué cuenta como vulnerabilidad aquí

Dentro del alcance:

- Una forma de que el resultado de un revisor se lea como aprobado cuando el sello de integridad debió ser `ROTA` o `DESCONOCIDO`, o de alterar los registros del sello sin que se detecte.
- Un commit que pase un secreto o un archivo `.env` por la guarda de la capa de git (`guardia-commit.cjs`) con la guarda instalada y activa.
- Que el auditor Codex envíe algo a su proveedor con `codex.habilitado` en `false`, o que envíe archivos de fuera de la copia limpia.
- Que la caja de arena corra código de prueba con acceso a la red o con escritura sobre el repositorio real.
- Un instalador que escriba fuera de las rutas que informa, o que escriba sin `--aplicar`.
- Un secreto impreso sin enmascarar en evidencias, registros o reportes.

Límites declarados, no vulnerabilidades (es comportamiento documentado):

- **La guarda de texto (`guardia-git.js`) y los candados de solo lectura son de mejor esfuerzo.** Leen el texto del comando y un comando ofuscado puede esquivarlos. Las garantías son la guarda de la capa de git, que revisa el contenido real de cada commit, y el sello de integridad alrededor de cada revisor.
- En Windows, el sandbox de solo lectura de Codex CLI no restringe la *lectura* a la copia limpia. La copia limpia es la defensa principal.
- El filtro de la puerta de seguridad descarta por diseño los hallazgos de denegación de servicio y de agotamiento de recursos.
- Los hallazgos en los componentes de terceros incluidos corresponden a su proyecto de origen (ver `THIRD_PARTY_NOTICES.md`), salvo que el problema venga de cómo este repositorio los usa.
