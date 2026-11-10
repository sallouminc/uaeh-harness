# Third-party notices / Avisos de terceros

This repository includes code from the projects listed below. Each one lives in its own folder under
`plugins/<plugin>/vendor/<name>/`, together with its original `LICENSE` (and `NOTICE`, when the project has one) and an
`UPSTREAM.json` that records the source repository, the commit and the sha256 of every copied file. Local changes are
kept as separate patches in `PATCHES/`. These folders are not registered as skills.

Este repositorio incluye código de los proyectos de abajo. Cada uno vive en su carpeta `plugins/<plugin>/vendor/<nombre>/`,
con su `LICENSE` original (y su `NOTICE`, si el proyecto lo tiene) y un `UPSTREAM.json` con el repositorio de origen, el
commit y el sha256 de cada archivo copiado. Los cambios locales van como parches aparte en `PATCHES/`. Estas carpetas no
se registran como skills.

---

## cyber-neo

- Source / Origen: https://github.com/Hainrixz/cyber-neo — commit `535d0df7802ad2b8add28bde959cf954484a8449`
- Folder / Carpeta: `plugins/uaeh-harness/vendor/cyber-neo/`
- Copied / Se copió: the two scanning scripts (`scripts/scan_secrets.py`, `scripts/check_lockfiles.py`) and the 14 files of
  `references/` / los dos scripts de escaneo y los 14 archivos de `references/`.
- Local changes / Cambios locales: `PATCHES/0001-redactar-secretos-en-evidence.patch` (masks the detected secret in the
  `evidence` field / enmascara el secreto detectado en el campo `evidence`) and / y
  `PATCHES/0002-literales-con-forma-de-llave.md` (key-shaped example literals split so that secret scanners do not take
  them for real keys; no change in behaviour / literales de ejemplo con forma de llave partidos para que los escáneres de
  secretos no los tomen por llaves reales; sin cambio de comportamiento) and / y
  `PATCHES/0003-ejemplo-que-dispara-antivirus.md` (one space added to a vulnerable-code example that made an endpoint
  antivirus block the file and break the plugin installation; same Python call / un espacio añadido a un ejemplo de
  código vulnerable que hacía que un antivirus de escritorio bloqueara el archivo y rompiera la instalación del plugin;
  la misma llamada de Python).
- Notice / Aviso: the project's `NOTICE` is kept unchanged in that folder; it credits Enrique Rocha (@soyenriquerocha),
  tododeia.com, github.com/Hainrixz / el `NOTICE` del proyecto se conserva sin cambios en esa carpeta.
- License / Licencia: MIT

```
MIT License

Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
Copyright (c) 2026 Cyber Neo Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## security-audit

- Source / Origen: https://github.com/cloudflare/security-audit-skill — commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- Folder / Carpeta: `plugins/uaeh-harness/vendor/security-audit/`
- Copied / Se copió: the whole `skills/security-audit/` folder (`SKILL.md`, the 14 companion guides, `report-schema.json`, the
  two validators and their tests) and the root `LICENSE`, unchanged / la carpeta `skills/security-audit/` entera y el `LICENSE` de
  la raíz, sin cambios.
- Local changes / Cambios locales: none / ninguno.
- Use / Uso: the `uae-security` skill follows its audit protocol; `wsl/instalar-bin.sh` copies the validators to
  `/opt/uaeh/validadores` / la skill `uae-security` sigue su protocolo de auditoría; `wsl/instalar-bin.sh` copia los validadores
  a `/opt/uaeh/validadores`.
- License / Licencia: MIT

```
MIT License

Copyright (c) 2025-2026 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## web-interface-guidelines

- Source / Origen: https://github.com/vercel-labs/web-interface-guidelines — commit `e3d624baaf29dc1fc645aff3e38f03e564d2d6b1`
- Folder / Carpeta: `plugins/uaeh-harness/vendor/web-interface-guidelines/`
- Copied / Se copió: `command.md` (the guidelines) and `LICENSE`, unchanged / `command.md` (las guías) y `LICENSE`, sin cambios.
- Local changes / Cambios locales: none / ninguno.
- Use / Uso: a pinned copy read as reference data by the design auditor; it is not registered as a command / copia fijada que
  el auditor de diseño lee como dato de referencia; no se registra como comando.
- License / Licencia: MIT

```
MIT License

Copyright (c) 2025 Vercel Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Not included: downloaded at install time / No incluido: se descarga al instalar

The layer 3 installer (`plugins/uaeh-harness/wsl/instalar.sh`) downloads these to the user's machine. None of them is
part of this repository or redistributed by it; each keeps its own licence, which the user accepts by installing it.

El instalador de la capa 3 (`plugins/uaeh-harness/wsl/instalar.sh`) descarga lo siguiente a la máquina del usuario. Nada
de esto forma parte de este repositorio ni se redistribuye desde él; cada pieza conserva su licencia, que el usuario
acepta al instalarla.

- gitleaks, osv-scanner, Semgrep (the engine / el motor), Docker Engine and the sandbox container images / y las
  imágenes de contenedor de la caja de arena: each under its project's licence / cada uno bajo la licencia de su proyecto.
- **Semgrep rules / Reglas de Semgrep** (downloaded from / descargadas de `semgrep.dev`): Semgrep Rules License v. 1.0,
  https://semgrep.dev/legal/rules-license/. It allows using the rules for one's own internal business purposes and does
  not allow distributing them or making them available to others as a service. Anyone who audits third-party code as a
  service with this gate should read that licence first. / Permite usar las reglas para fines internos propios y no
  permite distribuirlas ni ofrecerlas a terceros como servicio. Quien audite código de terceros como servicio con esta
  puerta debe leer antes esa licencia.
