#!/bin/sh
# armar.sh — dentro de la caja de arena UAEH: arma /work/app con las dependencias preparadas
# (si se montó /deps) y encima la fuente vigente de /src (solo lectura). Uso: sh /uaeh/armar.sh
set -eu
mkdir -p /work/app
if [ -d /deps/app ]; then cp -a --no-preserve=ownership /deps/app/. /work/app/; fi
cp -a --no-preserve=ownership /src/. /work/app/
echo "armar.sh: /work/app listo"
