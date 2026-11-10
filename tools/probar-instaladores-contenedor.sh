#!/usr/bin/env bash
# Prueba REAL de los instaladores de la capa 3 (plugins/uaeh-harness/wsl/) sin tocar el /opt/uaeh de la máquina: los
# corre como root dentro de un contenedor ubuntu:24.04 desechable, con el plugin montado en solo lectura
# (UAEH_SOLO_ESCANERES=1: escáneres, reglas, uaeh.conf, validaciones de la caja de arena, promotor real).
# Correrla tras cambiar algo de wsl/ y siempre al subir un pin de herramientas.json.
# Uso (Linux o dentro de WSL, con Docker y red; ~5 min):  bash tools/probar-instaladores-contenedor.sh
#   Desde Windows:  wsl -d <distro> -e bash tools/probar-instaladores-contenedor.sh   (desde la raíz del repo)
# Salida: PASS/FAIL por control y PROBAR_INSTALADORES_OK (0) | PROBAR_INSTALADORES_FALLA <n> (1) | 77 sin Docker.
set -uo pipefail
RAIZ=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
IMAGEN=${UAEH_IMAGEN_PRUEBA:-ubuntu:24.04}
docker info >/dev/null 2>&1 || { echo "SKIP: Docker no responde"; exit 77; }
exec docker run --rm \
  -v "$RAIZ/plugins/uaeh-harness:/plugin:ro" \
  -v "$RAIZ/tools/contenedor:/verif:ro" \
  "$IMAGEN" bash /verif/verificar-instaladores.sh
