#!/bin/bash
# desinstalar.sh — capa 3 de uaeh-harness: quita lo que instalar.sh e instalar-bin.sh pusieron en este Linux.
#
# POR DEFECTO ES EN SECO: lista lo que quitaría, sin root y sin escribir nada. Con --aplicar (como root) lo quita.
# Niveles:
#   (sin más opciones)  solo lo propio de UAEH: /opt/uaeh completo (programas, reglas, imagenes.json, instalado.json,
#                       uaeh.conf, validadores) y los enlaces uaeh-* de /usr/local/bin que apuntan a él.
#   --con-escaneres     además gitleaks, osv-scanner y semgrep, SOLO si lo instalado coincide con lo que anotó
#                       /opt/uaeh/instalado.json (huella del binario; versión del entorno de semgrep). Si no coincide
#                       (o no hay registro), es del usuario: se deja y se dice. La huella vive en /opt/uaeh/instalado.json:
#                       usar esta opción en la MISMA corrida que quita /opt/uaeh, o antes.
#   --con-imagenes      además las imágenes de contenedor de la caja de arena (por digest, y su etiqueta si es la misma imagen).
# Docker Engine NUNCA se desinstala (puede ser del usuario). Las carpetas de corridas y bases de auditorías que señala
# uaeh.conf fuera de /opt/uaeh (evidencias del usuario) NUNCA se borran: solo se nombran.
# Idempotente: una segunda corrida no encuentra nada que quitar y sale con 0.
# Uso:
#   Windows:  wsl -d <distro> -u root -e bash <carpeta wsl del plugin>/desinstalar.sh --aplicar [--con-escaneres] [--con-imagenes]
#   Linux:    sudo bash <carpeta wsl del plugin>/desinstalar.sh --aplicar [...]
#   Ver antes (sin root; no escribe nada):  bash desinstalar.sh [--con-escaneres] [--con-imagenes]
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin   # sin el PATH de Windows
umask 022

AQUI=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
PINS="$AQUI/herramientas.json"
OPT=/opt/uaeh
PIPX=/opt/pipx
VENV=/opt/pipx/venvs/semgrep
BIN=/usr/local/bin
MAN=/usr/local/share/man

err(){ echo "desinstalar.sh: ERROR: $*" >&2; exit 1; }

# >>> bloque común «validar» (idéntico en instalar.sh, instalar-bin.sh, bin/uaeh-sandbox y bin/uaeh-validar;
#     tests/harness/wsl.test.cjs exige que sea el mismo byte a byte; uaeh-promover repite las reglas en Python)
usuario_valido(){  # $1 → 0 si es un usuario aceptable; si no, 1 con el motivo en MOTIVO
  MOTIVO=""
  if [[ ! "${1-}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then MOTIVO="usuario «${1-}» no válido (minúsculas, cifras, _ o -)"; return 1; fi
  if [ "$1" = root ]; then MOTIVO="el usuario no puede ser root"; return 1; fi
  return 0
}
base_valida(){  # $1 carpeta de corridas, $2 usuario → 0 si cumple; si no, 1 con el motivo en MOTIVO
  local b="${1-}" u="${2-}" c n=0 primera="" segunda=""
  MOTIVO=""
  if [[ ! "$b" =~ ^/[A-Za-z0-9._/-]+$ ]]; then MOTIVO="«$b» debe ser una ruta absoluta de Linux con solo letras sin acento, cifras, . _ - y /"; return 1; fi
  if [[ "$b" == *//* || "$b" == */ ]]; then MOTIVO="«$b» no puede llevar «//» ni terminar en «/»"; return 1; fi
  local IFS=/
  for c in ${b#/}; do
    n=$((n + 1))
    if [ "$c" = . ] || [ "$c" = .. ]; then MOTIVO="«$b» no puede llevar componentes «.» ni «..»"; return 1; fi
    if [ "$n" = 1 ]; then primera=$c; fi
    if [ "$n" = 2 ]; then segunda=$c; fi
  done
  if [ "$n" -lt 3 ]; then MOTIVO="«$b» es demasiado amplia: hacen falta 3 niveles o más (p. ej. /home/<usuario>/runs o /mnt/c/<carpeta>/runs)"; return 1; fi
  case "$primera" in
    mnt|srv) ;;
    home) if [ "$segunda" != "$u" ]; then MOTIVO="bajo /home solo vale la carpeta del propio usuario (/home/$u/…)"; return 1; fi ;;
    *) MOTIVO="«$b» debe colgar de /mnt, /home/<usuario> o /srv"; return 1 ;;
  esac
  return 0
}
resolver_usuario(){  # UAEH_USER > SUDO_USER (si no es root) > el usuario con uid 1000
  if [ -n "${UAEH_USER-}" ]; then printf '%s' "$UAEH_USER"
  elif [ -n "${SUDO_USER-}" ] && [ "$SUDO_USER" != root ]; then printf '%s' "$SUDO_USER"
  else { getent passwd 1000 2>/dev/null || true; } | cut -d: -f1; fi
}
# <<< bloque común «validar»

# ---------------------------------------------------------------------------------------------------------------
FALLAS=0
QUITAR=0
APLICAR=0
ESCANERES=0
IMAGENES_OPT=0
BASE_CONF=""
declare -A REG=()
declare -A ETQ=()
PASO=0
informe(){ printf '%-6s %s\n' "$1" "$2"; if [ "$1" = FALLA ]; then FALLAS=$((FALLAS + 1)); fi; }
paso(){ PASO=$((PASO + 1)); printf '\n== %s. %s\n' "$PASO" "$*"; }

# Lista cerrada de lo que este programa puede quitar. Todo borrado pasa por quitar(), y quitar() por aquí: una variable
# vacía, con «..» o armada con el entorno nunca llega a rm.
ruta_permitida(){  # $1 ruta → 0 si es una de las rutas que UAEH instala
  local r="${1-}"
  if [ -z "$r" ] || [[ "$r" == */./* || "$r" == */../* || "$r" == */. || "$r" == */.. ]]; then return 1; fi
  case "$r" in
    /opt/uaeh|/opt/pipx|/opt/pipx/venvs/semgrep|/usr/local/bin/gitleaks|/usr/local/bin/osv-scanner) return 0 ;;
  esac
  if [[ "$r" =~ ^/usr/local/bin/[A-Za-z0-9._-]+$ ]]; then return 0; fi
  if [[ "$r" =~ ^/usr/local/share/man/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then return 0; fi
  return 1
}

quitar(){  # $1 ruta, $2 qué es, $3 dir|archivo
  local r="${1-}"
  if ! ruta_permitida "$r"; then informe FALLA "ruta no permitida «$r»: error del desinstalador, no se toca"; return 0; fi
  QUITAR=$((QUITAR + 1))
  if [ "$APLICAR" = 0 ]; then informe QUITA "$2 ($r)"; return 0; fi
  if [ "$3" = dir ]; then
    if rm -rf --one-file-system -- "$r"; then informe QUITO "$2 ($r)"; else informe FALLA "no se pudo quitar $r"; fi
  else
    if rm -f -- "$r"; then informe QUITO "$2 ($r)"; else informe FALLA "no se pudo quitar $r"; fi
  fi
}

enlaces_hacia(){  # $1 carpeta, $2 prefijo del destino, $3 profundidad → rutas de enlaces simbólicos que apuntan bajo $2
  local f t
  while IFS= read -r -d '' f; do
    t=$(readlink -- "$f" 2>/dev/null || true)
    if [[ "$t" == "$2"/* ]]; then printf '%s\n' "$f"; fi
  done < <(find "$1" -maxdepth "$3" -type l -print0 2>/dev/null)
}

verificar_opt(){
  local real
  if [ -L "$OPT" ]; then err "$OPT es un enlace simbólico: no se toca (revisar a dónde apunta antes de seguir)"; fi
  if [ -e "$OPT" ]; then
    [ -d "$OPT" ] || err "$OPT existe pero no es una carpeta"
    real=$(realpath -e -- "$OPT" 2>/dev/null || true)
    [ "$real" = "$OPT" ] || err "$OPT no es una carpeta real (resuelve a «${real:-nada}»)"
  fi
}

# ---------------------------------------------------------------------------------------------------------------
# Lecturas de lo anotado. Todo se valida; python3 es opcional (sin él, esas partes se dejan y se dice).
py_registro(){  # $1 instalado.json → líneas «clave=valor» validadas
  python3 -I - "$1" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
def campo(ruta, patron):
    v = d
    for k in ruta.split("/"):
        if not isinstance(v, dict) or k not in v:
            return None
        v = v[k]
    return v if isinstance(v, str) and re.fullmatch(patron, v) else None
for nombre, ruta, patron in (("gitleaks", "gitleaks/sha256_binario", r"[0-9a-f]{64}"),
                             ("osv-scanner", "osv-scanner/sha256_binario", r"[0-9a-f]{64}"),
                             ("semgrep", "semgrep/version", r"[0-9A-Za-z.+-]{1,40}")):
    v = campo(ruta, patron)
    if v:
        print("%s=%s" % (nombre, v))
PY
}

py_imagenes(){  # $1 herramientas.json $2 imagenes.json (puede no existir) → líneas «ref|etiqueta» (etiqueta vacía si no se sabe)
  python3 -I - "$1" "$2" <<'PY'
import json, re, sys
REF = r"[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}"
ETQ = r"[a-z0-9._/-]+:[A-Za-z0-9._-]+"
salida = {}
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        for i in json.load(f).get("imagenes", {}).values():
            e, g = i.get("etiqueta", ""), i.get("digest", "")
            if re.fullmatch(ETQ, e) and re.fullmatch(r"sha256:[0-9a-f]{64}", g):
                salida["%s@%s" % (e.rsplit(":", 1)[0], g)] = e
except Exception:
    pass
try:
    with open(sys.argv[2], encoding="utf-8") as f:
        for r in json.load(f).values():
            if isinstance(r, str) and re.fullmatch(REF, r):
                salida.setdefault(r, "")
except Exception:
    pass
for r in sorted(salida):
    print("%s|%s" % (r, salida[r]))
PY
}

leer_conf(){  # nombra la carpeta de corridas de uaeh.conf (sin «source»: se lee línea a línea y se valida con el bloque común)
  local f="$OPT/uaeh.conf" l base="" usr=""
  if [ ! -f "$f" ] || [ -L "$f" ]; then return 0; fi
  while IFS= read -r l || [ -n "$l" ]; do
    case "$l" in
      UAEH_BASE=*) base=${l#UAEH_BASE=} ;;
      UAEH_USER=*) usr=${l#UAEH_USER=} ;;
    esac
  done < "$f"
  if usuario_valido "$usr" && base_valida "$base" "$usr"; then BASE_CONF=$base; fi
}

leer_registro(){
  local f="$OPT/instalado.json" salida linea
  if [ ! -f "$f" ] || [ -L "$f" ]; then return 0; fi
  command -v python3 >/dev/null 2>&1 || return 0
  salida=$(py_registro "$f" || true)
  while IFS= read -r linea; do
    if [ -n "$linea" ]; then REG["${linea%%=*}"]=${linea#*=}; fi
  done <<< "$salida"
}

# ---------------------------------------------------------------------------------------------------------------
quitar_imagen(){  # $1 referencia (etiqueta o repo@digest)
  local salida
  QUITAR=$((QUITAR + 1))
  if [ "$APLICAR" = 0 ]; then informe QUITA "imagen de contenedor $1"; return 0; fi
  if salida=$(docker image rm "$1" 2>&1); then informe QUITO "imagen de contenedor $1"
  else informe AVISO "imagen $1: no se quitó, se deja ($(head -n 1 <<< "$salida"))"; QUITAR=$((QUITAR - 1)); fi
}

quitar_imagenes(){
  local salida linea ref etq id idt
  if ! command -v docker >/dev/null 2>&1; then informe INFO "Docker no está instalado: no hay imágenes que quitar"; return 0; fi
  if ! command -v python3 >/dev/null 2>&1; then informe AVISO "falta python3: no se pudo saber qué imágenes puso UAEH; no se tocó ninguna"; return 0; fi
  if ! docker info >/dev/null 2>&1; then informe AVISO "Docker no responde (apagado o sin permisos): no se tocó ninguna imagen"; return 0; fi
  salida=$(py_imagenes "$PINS" "$OPT/imagenes.json" || true)
  while IFS= read -r linea; do
    if [ -n "$linea" ]; then ETQ["${linea%%|*}"]=${linea#*|}; fi
  done <<< "$salida"
  if [ "${#ETQ[@]}" = 0 ]; then informe AVISO "no se pudo leer la lista de imágenes (pines ni imagenes.json): no se tocó ninguna"; return 0; fi
  for ref in "${!ETQ[@]}"; do
    etq=${ETQ[$ref]}
    id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
    if [ -z "$id" ]; then informe INFO "imagen $ref: no está"; continue; fi
    if [ -n "$etq" ]; then
      idt=$(docker image inspect --format '{{.Id}}' "$etq" 2>/dev/null || true)
      if [ "$idt" = "$id" ]; then quitar_imagen "$etq"; fi
    fi
    quitar_imagen "$ref"
  done
}

# ---------------------------------------------------------------------------------------------------------------
quitar_binario(){  # $1 nombre (gitleaks u osv-scanner)
  local f="$BIN/$1" esperado="${REG[$1]-}" h
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then informe INFO "$1: no está instalado"; return 0; fi
  if [ -z "$esperado" ]; then informe AVISO "$1: se deja (sin huella anotada en $OPT/instalado.json: no se puede saber si lo puso UAEH)"; return 0; fi
  if [ -L "$f" ] || [ ! -f "$f" ]; then informe AVISO "$1: se deja ($f no es el archivo que instaló UAEH)"; return 0; fi
  h=$(sha256sum "$f" | cut -c1-64)
  if [ "$h" = "$esperado" ]; then quitar "$f" "$1 (la huella coincide con la anotada)" archivo
  else informe AVISO "$1: se deja, su huella no coincide con la que anotó UAEH (es del usuario o de otra versión)"; fi
}

quitar_semgrep(){
  local ver="${REG[semgrep]-}" d=() f otros e
  if [ ! -e "$VENV" ] && [ ! -L "$VENV" ]; then
    if [ -e "$BIN/semgrep" ] || [ -L "$BIN/semgrep" ]; then informe AVISO "semgrep: se deja ($BIN/semgrep no viene del entorno de UAEH)"
    else informe INFO "semgrep: no está instalado"; fi
    return 0
  fi
  if [ -L "$VENV" ] || [ ! -d "$VENV" ]; then informe AVISO "semgrep: se deja ($VENV no es una carpeta real)"; return 0; fi
  if [ -z "$ver" ]; then informe AVISO "semgrep: se deja (sin versión anotada en $OPT/instalado.json: no se puede saber si lo puso UAEH)"; return 0; fi
  d=( "$VENV"/lib/python3*/site-packages/semgrep-"$ver".dist-info )
  if [ ! -d "${d[0]}" ]; then informe AVISO "semgrep: se deja, la versión instalada no coincide con la que anotó UAEH"; return 0; fi
  while IFS= read -r f; do
    if [ -n "$f" ]; then quitar "$f" "enlace de semgrep" archivo; fi
  done <<< "$(enlaces_hacia "$BIN" "$VENV" 1)"
  while IFS= read -r f; do
    if [ -n "$f" ]; then quitar "$f" "página de manual de semgrep" archivo; fi
  done <<< "$(enlaces_hacia "$MAN" "$VENV" 2)"
  # /opt/pipx lo creó instalar.sh solo para semgrep: si no hay otro entorno, se va completo.
  otros=""
  if [ -d "$PIPX/venvs" ] && [ ! -L "$PIPX" ] && [ ! -L "$PIPX/venvs" ]; then
    for e in "$PIPX"/venvs/* "$PIPX"/venvs/.[!.]*; do
      if [ -e "$e" ] || [ -L "$e" ]; then if [ "$e" != "$VENV" ]; then otros="$otros $e"; fi; fi
    done
  fi
  if [ -z "$otros" ] && [ -d "$PIPX" ] && [ ! -L "$PIPX" ]; then quitar "$PIPX" "entorno de pipx de semgrep (solo había ese)" dir
  else
    quitar "$VENV" "entorno de semgrep" dir
    if [ -n "$otros" ]; then informe INFO "$PIPX se deja: tiene otros entornos de pipx (${otros# })"; fi
  fi
}

quitar_propio(){
  local f
  while IFS= read -r f; do
    if [ -n "$f" ] && [[ "${f##*/}" == uaeh-* ]]; then quitar "$f" "programa de UAEH fuera de $OPT" archivo; fi
  done <<< "$(enlaces_hacia "$BIN" "$OPT" 1)"
  if [ -e "$OPT" ]; then
    informe INFO "$OPT contiene: $(ls -A -- "$OPT" | tr '\n' ' ')"
    quitar "$OPT" "carpeta de UAEH completa" dir
  else
    informe INFO "$OPT: no existe"
  fi
}

notas(){
  paso "Lo que NO se toca"
  if [ -n "$BASE_CONF" ]; then
    if [ -d "$BASE_CONF" ]; then informe INFO "evidencias de auditorías (se dejan; borrarlas es decisión del usuario): $BASE_CONF"
    else informe INFO "carpeta de corridas anotada en uaeh.conf: $BASE_CONF (no existe)"; fi
  fi
  informe INFO "paquetes base (ca-certificates, curl, gnupg, pipx, python3) y lo que root guardó en su casa (p. ej. caché de semgrep): se dejan"
  if [ -e /etc/apt/sources.list.d/docker.list ] || command -v docker >/dev/null 2>&1; then
    informe INFO "Docker Engine NUNCA se desinstala (puede ser del usuario). A mano, como root: apt-mark unhold docker-ce docker-ce-cli containerd.io && apt-get purge -y docker-ce docker-ce-cli containerd.io && rm -f /etc/apt/sources.list.d/docker.list /etc/apt/keyrings/docker.asc"
  fi
  if [ "$ESCANERES" = 0 ]; then informe INFO "gitleaks, osv-scanner y semgrep se dejan (para quitarlos: --con-escaneres)"; fi
  if [ "$IMAGENES_OPT" = 0 ]; then informe INFO "las imágenes de contenedor se dejan (para quitarlas: --con-imagenes)"; fi
}

principal(){
  while [ $# -gt 0 ]; do
    case "$1" in
      --aplicar) APLICAR=1 ;;
      --con-escaneres) ESCANERES=1 ;;
      --con-imagenes) IMAGENES_OPT=1 ;;
      -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
      *) err "argumento desconocido: $1 (uso: desinstalar.sh [--aplicar] [--con-escaneres] [--con-imagenes])" ;;
    esac
    shift
  done
  if [ "$APLICAR" = 1 ] && [ "$(id -u)" != 0 ]; then err "--aplicar necesita root (Windows: wsl -d <distro> -u root …; Linux: sudo …)"; fi
  verificar_opt
  if [ "$APLICAR" = 1 ]; then echo "MODO: APLICAR (se quita de verdad)"; else echo "MODO: EN SECO (no se quita ni se escribe nada; --aplicar para quitar)"; fi
  leer_conf
  if [ "$ESCANERES" = 1 ]; then leer_registro; fi
  if [ "$IMAGENES_OPT" = 1 ]; then paso "Imágenes de contenedor (--con-imagenes)"; quitar_imagenes; fi
  if [ "$ESCANERES" = 1 ]; then
    paso "Escáneres (--con-escaneres): solo si coinciden con lo anotado por UAEH"
    quitar_binario gitleaks
    quitar_binario osv-scanner
    quitar_semgrep
  fi
  paso "Lo propio de UAEH"
  quitar_propio
  notas
  echo
  if [ "$FALLAS" != 0 ]; then echo "DESINSTALAR_FALLA $FALLAS"; exit 1; fi
  if [ "$QUITAR" = 0 ]; then echo "NADA_QUE_QUITAR"
  elif [ "$APLICAR" = 0 ]; then echo "EN_SECO: $QUITAR cosa(s) se quitarían con --aplicar"
  else echo "DESINSTALAR_OK $QUITAR"; fi
}

# Cargado con «source» (pruebas del plugin) solo define funciones; ejecutado, corre principal.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then principal "$@"; fi
