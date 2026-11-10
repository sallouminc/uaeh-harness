#!/bin/bash
# Regresión: preparar-deps NO debe cargar el .pnpmfile.cjs del repo auditado (pnpm lo carga aunque haya
# --ignore-scripts; por eso uaeh-sandbox usa --ignore-pnpmfile). Control negativo: pnpm SIN --ignore-pnpmfile
# sí lo carga (así la prueba es significativa). Arma su propio repo de juguete dentro de la carpeta de corridas.
# Uso (como el usuario de UAEH_USER, del grupo docker; necesita red para bajar pnpm):
#   <prefijo del motor> bash /opt/uaeh/pruebas/probar-pnpmfile.sh
# Salida: PNPMFILE_OK (código 0) · PNPMFILE_FALLA (1) · 77 (omitida) si falta la capa 3, Docker o la red.
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
DOCKER=/usr/bin/docker
CONF=/opt/uaeh/uaeh.conf
SB=/opt/uaeh/bin/uaeh-sandbox
omitir(){ echo "SKIP: $*"; exit 77; }
[ -x "$SB" ] || omitir "falta $SB (capa 3 sin instalar)"
[ -f "$CONF" ] || omitir "falta $CONF (correr wsl/instalar-bin.sh)"
[ -f /opt/uaeh/imagenes.json ] || omitir "falta /opt/uaeh/imagenes.json (correr wsl/instalar.sh)"
"$DOCKER" info >/dev/null 2>&1 || omitir "Docker no responde para $(id -un)"
curl -fsS --max-time 10 -o /dev/null https://registry.npmjs.org/ 2>/dev/null || omitir "sin red hacia registry.npmjs.org"
BASE=$(sed -n 's/^UAEH_BASE=//p' "$CONF" | head -1)
[ -n "$BASE" ] || { echo "PNPMFILE_FALLA ($CONF sin UAEH_BASE)"; exit 1; }
IMG=$(/usr/bin/python3 -I -c 'import json;print(json.load(open("/opt/uaeh/imagenes.json"))["node"])')
R="$BASE/uaeh-prueba-pnpmfile-$$"
RUN="$R/run-1"
limpiar(){ case "$R" in "$BASE"/uaeh-prueba-pnpmfile-*) rm -rf -- "$R" ;; esac; }
trap limpiar EXIT
FALLOS=0

mkdir -p "$RUN/fuente"
cat > "$RUN/fuente/.pnpmfile.cjs" <<'EOF'
// Prueba inocua: si pnpm carga este archivo, deja una marca en el directorio de trabajo.
require('fs').writeFileSync(require('path').join(process.cwd(), 'PNPMFILE_CORRIO'), '1');
module.exports = { hooks: {} };
EOF
cat > "$RUN/fuente/package.json" <<'EOF'
{
  "name": "uaeh-prueba-pnpmfile",
  "version": "1.0.0",
  "private": true
}
EOF
cat > "$RUN/fuente/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}
EOF

echo "== control negativo: pnpm sin --ignore-pnpmfile =="
SALIDA=$("$DOCKER" run --rm --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --mount "type=bind,src=$RUN/fuente,dst=/src,readonly" --tmpfs /w:rw,exec --tmpfs /tmp:rw,exec \
  -e HOME=/tmp/home -e COREPACK_HOME=/tmp/corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e CI=1 \
  "$IMG" sh -c 'mkdir -p /tmp/home && cp -a --no-preserve=ownership /src/. /w/ && cd /w && corepack pnpm install --frozen-lockfile --ignore-scripts >/dev/null 2>&1; ls /w' 2>&1)
if echo "$SALIDA" | grep -q PNPMFILE_CORRIO; then echo "OK   control: sin la bandera, pnpm SÍ carga .pnpmfile.cjs"
else echo "FALLA control: la marca no apareció sin la bandera (la prueba no demuestra nada)"; echo "$SALIDA"; FALLOS=$((FALLOS+1)); fi

echo "== uaeh-sandbox preparar-deps (con --ignore-pnpmfile) =="
VOL=$("$SB" preparar-deps --run "$RUN" --gestor pnpm 2>/dev/null | tail -n1)
if [ -z "$VOL" ]; then echo "PNPMFILE_FALLA (preparar-deps no devolvió volumen)"; exit 1; fi
LISTA=$("$DOCKER" run --rm --network none --cap-drop ALL --user 1000:1000 \
  --mount "type=volume,src=$VOL,dst=/deps,readonly" "$IMG" ls -A /deps/app 2>&1)
if echo "$LISTA" | grep -q PNPMFILE_CORRIO; then echo "FALLA: preparar-deps cargó .pnpmfile.cjs"; FALLOS=$((FALLOS+1))
else echo "OK   preparar-deps no cargó .pnpmfile.cjs"; fi
"$DOCKER" volume rm "$VOL" >/dev/null 2>&1 && echo "volumen $VOL borrado"

[ "$FALLOS" -eq 0 ] && echo "PNPMFILE_OK" || { echo "PNPMFILE_FALLA ($FALLOS)"; exit 1; }
