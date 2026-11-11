#!/bin/bash
# Regresión: preparar-deps NO debe cargar el .pnpmfile.cjs del repo auditado (pnpm lo carga aunque haya
# --ignore-scripts; por eso uaeh-sandbox usa --ignore-pnpmfile). Control negativo: pnpm SIN --ignore-pnpmfile
# sí lo carga (así la prueba es significativa). Arma su propio repo de juguete dentro de la carpeta de corridas.
# Segunda regresión (abajo): el .npmrc del repo no puede elegir el «git» que npm lanza (npm_config_git fijo).
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

# ---------------------------------------------------------------------------------------------------------------
# Segunda regresión: el .npmrc del repo auditado NO debe elegir el programa «git» que npm lanza para una dependencia
# por git (--ignore-scripts no lo cubre). uaeh-sandbox fija npm_config_git=git: la variable gana al .npmrc del proyecto.
RUN2="$R/run-2"
MARCA=NPMRC_GIT_CORRIO
REF='git+https://uaeh-prueba.invalid/a/b.git#0123456789abcdef0123456789abcdef01234567'
mkdir -p "$RUN2/fuente"
printf 'git=/deps/app/x.sh\n' > "$RUN2/fuente/.npmrc"
printf '#!/bin/sh\necho %s >&2\nexit 1\n' "$MARCA" > "$RUN2/fuente/x.sh"
chmod 755 "$RUN2/fuente/x.sh"
printf '{"name":"uaeh-prueba-npmrc","version":"1.0.0","private":true,"dependencies":{"dep":"%s"}}\n' "$REF" > "$RUN2/fuente/package.json"
printf '{"name":"uaeh-prueba-npmrc","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"uaeh-prueba-npmrc","version":"1.0.0","dependencies":{"dep":"%s"}},"node_modules/dep":{"version":"1.0.0","resolved":"%s"}}}\n' "$REF" "$REF" > "$RUN2/fuente/package-lock.json"

echo "== control negativo: npm ci sin fijar npm_config_git =="
SALIDA=$("$DOCKER" run --rm --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
  --mount "type=bind,src=$RUN2/fuente,dst=/src,readonly" --tmpfs /deps:rw,exec --tmpfs /tmp:rw,exec \
  -e HOME=/tmp/home -e npm_config_cache=/tmp/npm -e CI=1 \
  "$IMG" sh -c 'mkdir -p /deps/app /tmp/home && cp -a --no-preserve=ownership /src/. /deps/app/ && cd /deps/app && npm ci --ignore-scripts --no-audit --no-fund' 2>&1)
if echo "$SALIDA" | grep -q "$MARCA"; then echo "OK   control: sin la variable, npm SÍ corre el «git» del .npmrc"
else echo "FALLA control: la marca no apareció sin la variable (la prueba no demuestra nada)"; echo "$SALIDA" | tail -n 15; FALLOS=$((FALLOS+1)); fi

echo "== uaeh-sandbox preparar-deps (con npm_config_git fijo) =="
SALIDA=$("$SB" preparar-deps --run "$RUN2" --gestor npm 2>&1)
if echo "$SALIDA" | grep -q "$MARCA"; then echo "FALLA: preparar-deps corrió el «git» del .npmrc del repo"; FALLOS=$((FALLOS+1))
else echo "OK   preparar-deps no corrió el «git» del .npmrc del repo"; fi
VOL2=$(echo "$SALIDA" | grep -E '^uaeh-deps-[a-z0-9-]+$' | tail -n1)
if [ -n "$VOL2" ]; then "$DOCKER" volume rm "$VOL2" >/dev/null 2>&1 || true; fi

[ "$FALLOS" -eq 0 ] && echo "PNPMFILE_OK" || { echo "PNPMFILE_FALLA ($FALLOS)"; exit 1; }
