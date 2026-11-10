#!/bin/bash
# instalar.sh — capa 3 de uaeh-harness: prepara el motor de Linux de la puerta de seguridad.
#
# Instala, como root y con las versiones FIJADAS en herramientas.json (junto a este archivo): Docker Engine,
# gitleaks (con su configuración por defecto, para que un repo auditado no pueda apagar reglas con su propio
# .gitleaks.toml), osv-scanner, semgrep, las reglas de semgrep y las imágenes de la caja de arena (por digest).
# Cada descarga se verifica (huella de la llave o sha256) antes de usarse. Idempotente. Al terminar deja
# /opt/uaeh/instalado.json (qué quedó instalado y cuándo) e imprime INSTALAR_OK.
#
# Plataforma: Ubuntu 24.04 (noble) x86_64 — WSL2 en Windows (con systemd) o Linux directo.
# Uso:
#   Windows:  wsl -d <distro> -u root -e env UAEH_USER=<usuario de la distro> bash <carpeta wsl del plugin>/instalar.sh
#   Linux:    sudo bash <carpeta wsl del plugin>/instalar.sh          (el usuario sale de SUDO_USER)
#   Revisar sin instalar (sin root; no escribe nada):  bash instalar.sh --comprobar [--pins <archivo>]
# Después: instalar-bin.sh (programas de la caja de arena y /opt/uaeh/uaeh.conf).
# Variables:
#   UAEH_USER=<usuario>    quien usará Docker (por defecto SUDO_USER o el usuario con uid 1000; nunca root)
#   UAEH_SKIP_DOCKER=1     no instala Docker Engine: usa el que ya responde (p. ej. el de un runner de CI)
#   UAEH_SOLO_ESCANERES=1  solo gitleaks, osv-scanner, semgrep y sus reglas (sin Docker ni imágenes)
#   UAEH_REGLAS_NUEVAS=1   vuelve a bajar las reglas de semgrep aunque ya haya unas vigentes y sanas
#   UAEH_TZ=<zona IANA>    zona del sello de instalación (por defecto, la del sistema)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin   # sin el PATH de Windows
umask 022

AQUI=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
PINS="$AQUI/herramientas.json"
OPT=/opt/uaeh

err(){ echo "instalar.sh: ERROR: $*" >&2; exit 1; }

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
# Pines: herramientas.json se lee con Python (sin dependencias) y sale como líneas CLAVE=valor ya validadas.
leer_pines(){  # $1 archivo de pines → stdout
  [ -f "$1" ] || err "no existe el archivo de pines: $1"
  command -v python3 >/dev/null 2>&1 || err "falta python3 (apt-get install python3)"
  python3 -I - "$1" <<'PY'
import json, re, sys

def falla(m):
    sys.stderr.write("instalar.sh: ERROR: pines: %s\n" % m)
    sys.exit(1)

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        p = json.load(f)
except Exception as e:
    falla("no se pudo leer %s (%s)" % (sys.argv[1], e))
if not isinstance(p, dict) or p.get("esquema") != 1:
    falla("esquema desconocido (se esperaba 1)")

def campo(ruta, patron):
    v = p
    for k in ruta.split("/"):
        if not isinstance(v, dict) or k not in v:
            falla("falta %s" % ruta)
        v = v[k]
    if not isinstance(v, str) or not re.fullmatch(patron, v):
        falla("%s no es válido: %r" % (ruta, v))
    return v

VER, SHA = r"[0-9]+\.[0-9]+\.[0-9]+", r"[0-9a-f]{64}"
out = [
    ("UBUNTU", campo("plataforma/ubuntu", r"[a-z]{3,20}")),
    ("ARQUITECTURA", campo("plataforma/arquitectura", r"x86_64")),
    ("DOCKER_VER", campo("docker/version", VER)),
    ("DOCKER_FPR", campo("docker/llave_fpr", r"[0-9A-F]{40}")),
    ("GITLEAKS_VER", campo("gitleaks/version", VER)),
    ("GITLEAKS_ARCHIVO", campo("gitleaks/archivo", r"[A-Za-z0-9._-]{1,100}")),
    ("GITLEAKS_SHA256", campo("gitleaks/sha256", SHA)),
    ("GITLEAKS_CONFIG_SHA256", campo("gitleaks/config_sha256", SHA)),
    ("OSV_VER", campo("osv-scanner/version", VER)),
    ("OSV_ARCHIVO", campo("osv-scanner/archivo", r"[A-Za-z0-9._-]{1,100}")),
    ("OSV_SHA256", campo("osv-scanner/sha256", SHA)),
    ("SEMGREP_VER", campo("semgrep/version", VER)),
]
d = dict(out)
if d["GITLEAKS_ARCHIVO"] != "gitleaks_%s_linux_x64.tar.gz" % d["GITLEAKS_VER"]:
    falla("gitleaks/archivo no corresponde a gitleaks/version")
if d["OSV_ARCHIVO"] != "osv-scanner_linux_amd64":
    falla("osv-scanner/archivo debe ser osv-scanner_linux_amd64")
paq = p.get("semgrep", {}).get("paquetes")
if not isinstance(paq, list) or not 1 <= len(paq) <= 40 or len(set(paq)) != len(paq) \
        or not all(isinstance(x, str) and re.fullmatch(r"[a-z0-9-]{1,40}", x) for x in paq):
    falla("semgrep/paquetes debe ser una lista de nombres de paquete sin repetir")
out.append(("SEMGREP_PAQUETES", " ".join(paq)))
img = p.get("imagenes")
if not isinstance(img, dict) or not {"node", "postgres"} <= set(img):
    falla("imagenes debe traer al menos node y postgres")
for clave in sorted(img):
    if not re.fullmatch(r"[a-z0-9-]{1,32}", clave):
        falla("clave de imagen no válida: %r" % clave)
    etiqueta = campo("imagenes/%s/etiqueta" % clave, r"[a-z0-9._/-]+:[A-Za-z0-9._-]+")
    digest = campo("imagenes/%s/digest" % clave, r"sha256:[0-9a-f]{64}")
    out.append(("IMAGEN", "%s|%s|%s" % (clave, etiqueta, digest)))
for k, v in out:
    print("%s=%s" % (k, v))
PY
}

IMAGENES=()
cargar_pines(){
  local salida linea k v
  salida=$(leer_pines "$PINS") || exit 1
  while IFS= read -r linea; do
    k=${linea%%=*}; v=${linea#*=}
    case "$k" in
      UBUNTU|ARQUITECTURA|DOCKER_VER|DOCKER_FPR|GITLEAKS_VER|GITLEAKS_ARCHIVO|GITLEAKS_SHA256|GITLEAKS_CONFIG_SHA256|OSV_VER|OSV_ARCHIVO|OSV_SHA256|SEMGREP_VER|SEMGREP_PAQUETES)
        printf -v "PIN_$k" '%s' "$v" ;;
      IMAGEN) IMAGENES+=("$v") ;;
      *) err "pines: clave inesperada «$k»" ;;
    esac
  done <<< "$salida"
}

# ---------------------------------------------------------------------------------------------------------------
FALLAS=0
informe(){ printf '%-6s %s\n' "$1" "$2"; if [ "$1" = FALLA ]; then FALLAS=$((FALLAS + 1)); fi; }
quiere_docker(){ [ "${UAEH_SOLO_ESCANERES:-0}" != 1 ]; }
instala_docker(){ quiere_docker && [ "${UAEH_SKIP_DOCKER:-0}" != 1 ]; }

revisar(){  # comprobaciones previas: mismas en --comprobar y al instalar (allí, cualquier FALLA detiene todo)
  local arq codename pid1
  informe OK "pines de $PINS"
  echo "       docker $PIN_DOCKER_VER · gitleaks $PIN_GITLEAKS_VER · osv-scanner $PIN_OSV_VER · semgrep $PIN_SEMGREP_VER"
  echo "       reglas de semgrep: $PIN_SEMGREP_PAQUETES"
  local spec; for spec in "${IMAGENES[@]}"; do echo "       imagen ${spec//|/ · }"; done
  arq=$(uname -m)
  if [ "$arq" = "$PIN_ARQUITECTURA" ]; then informe OK "arquitectura $arq"
  else informe FALLA "arquitectura $arq: los binarios fijados son para $PIN_ARQUITECTURA"; fi
  codename=$( { . /etc/os-release && printf '%s' "${VERSION_CODENAME-}"; } 2>/dev/null || true)
  if [ "$codename" = "$PIN_UBUNTU" ]; then informe OK "Ubuntu $codename"
  else informe FALLA "se esperaba Ubuntu $PIN_UBUNTU (24.04) y es «${codename:-desconocido}»"; fi
  if instala_docker; then
    pid1=$(ps -p 1 -o comm= 2>/dev/null || true)
    if [ "$pid1" = systemd ]; then informe OK "systemd es el proceso 1"
    else informe FALLA "systemd no es el proceso 1 (en WSL: [boot] systemd=true en /etc/wsl.conf y wsl --shutdown)"; fi
  fi
  U=$(resolver_usuario)
  if ! usuario_valido "$U"; then informe FALLA "UAEH_USER: $MOTIVO (fijar UAEH_USER=<usuario de la distro>)"
  elif ! command -v getent >/dev/null 2>&1; then informe AVISO "usuario $U (sin getent no se pudo comprobar que exista)"
  elif getent passwd "$U" >/dev/null 2>&1; then informe OK "usuario $U"
  else informe FALLA "el usuario $U no existe en este Linux"; fi
  if [ -n "${UAEH_TZ-}" ] && [[ ! "$UAEH_TZ" =~ ^[A-Za-z0-9_+/-]{1,64}$ ]]; then informe FALLA "UAEH_TZ no válido: $UAEH_TZ"; fi
  if quiere_docker; then
    if instala_docker; then informe OK "modo completo (Docker Engine $PIN_DOCKER_VER + escáneres + imágenes)"
    else informe OK "modo UAEH_SKIP_DOCKER=1 (usa el Docker que ya responde + escáneres + imágenes)"; fi
  else informe OK "modo UAEH_SOLO_ESCANERES=1 (sin Docker ni imágenes)"; fi
}

estado_instalado(){  # solo informa (no cuenta como falla): lo que ya hay frente a los pines
  local v
  v=$(/usr/local/bin/gitleaks version 2>/dev/null || true); informe INFO "gitleaks instalado: ${v:-no} (pin $PIN_GITLEAKS_VER)"
  v=$(/usr/local/bin/osv-scanner --version 2>/dev/null | head -1 || true); informe INFO "osv-scanner instalado: ${v:-no} (pin $PIN_OSV_VER)"
  v=$(/usr/local/bin/semgrep --version 2>/dev/null || true); informe INFO "semgrep instalado: ${v:-no} (pin $PIN_SEMGREP_VER)"
  v=$(readlink -e "$OPT/reglas/semgrep/vigente" 2>/dev/null || true); informe INFO "reglas de semgrep vigentes: ${v:-no}"
  if [ -f "$OPT/instalado.json" ]; then informe INFO "$OPT/instalado.json presente"; else informe INFO "$OPT/instalado.json: no (aún no se instaló con este instalador)"; fi
  if [ -f "$OPT/uaeh.conf" ]; then informe INFO "$OPT/uaeh.conf presente"; else informe INFO "$OPT/uaeh.conf: no (falta instalar-bin.sh)"; fi
}

# ---------------------------------------------------------------------------------------------------------------
PASO=0
paso(){ PASO=$((PASO + 1)); printf '\n== %s. %s\n' "$PASO" "$*"; }
descargar(){  # $1 url, $2 destino, $3 sha256 esperado
  curl -fsSL --retry 3 --proto '=https' "$1" -o "$2" || err "no se pudo descargar $1"
  local h; h=$(sha256sum "$2" | cut -c1-64)
  [ "$h" = "$3" ] || err "huella sha256 distinta en $1 (esperada $3, recibida $h)"
}
escribir_json(){  # $1 destino; el resto, pares clave=valor (las claves con «.» anidan); «imagen=clave|ref» se agrupan
  python3 -I - "$@" <<'PY'
import json, sys
destino, pares = sys.argv[1], sys.argv[2:]
raiz, imagenes = {}, {}
for par in pares:
    k, v = par.split("=", 1)
    if k == "imagen":
        clave, ref = v.split("|", 1)
        imagenes[clave] = ref
        continue
    nodo, partes = raiz, k.split(".")
    for parte in partes[:-1]:
        nodo = nodo.setdefault(parte, {})
    nodo[partes[-1]] = v
if imagenes:
    raiz["imagenes"] = imagenes
with open(destino, "w", encoding="utf-8") as f:
    json.dump(raiz, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}
instalar_archivo(){ install -m "$1" -o root -g root "$2" "$3.nuevo" && mv -f "$3.nuevo" "$3"; }  # modo, origen, destino
sello(){ if [ -n "${UAEH_TZ-}" ]; then TZ="$UAEH_TZ" date '+%Y-%m-%dT%H:%M:%S%:z'; else date '+%Y-%m-%dT%H:%M:%S%:z'; fi; }

reglas_sanas(){  # $1 carpeta → 0 si SHA256SUMS verifica y trae todos los paquetes fijados
  local d="$1" p
  [ -n "$d" ] && [ -f "$d/SHA256SUMS" ] || return 1
  (cd "$d" && sha256sum --quiet -c SHA256SUMS >/dev/null 2>&1) || return 1
  for p in $PIN_SEMGREP_PAQUETES; do [ -s "$d/$p.yml" ] || return 1; done
  return 0
}
contar_reglas(){  # $1 paquete bajado del registro de semgrep → número de reglas (el registro entrega YAML o JSON)
  python3 -I - "$1" <<'PY'
import json, re, sys
try:
    texto = open(sys.argv[1], encoding="utf-8").read()
except Exception:
    print(0); sys.exit(0)
if texto.lstrip().startswith("{"):
    try:
        reglas = json.loads(texto).get("rules")
        print(len(reglas) if isinstance(reglas, list) else 0)
    except Exception:
        print(0)
else:
    print(len(re.findall(r"(?m)^rules:", texto)) and len(re.findall(r"(?m)^\s*- id:", texto)))
PY
}

instalar(){
  [ "$(id -u)" = 0 ] || err "correr como root (Windows: wsl -d <distro> -u root …; Linux: sudo …)"
  # Root trabaja con SU casa: con sudo, HOME y las XDG_* pueden seguir siendo las del usuario, y lo que root corre aquí
  # (semgrep --version, pipx, gpg) dejaría en ellas archivos de root que el usuario ya no puede abrir (semgrep muere
  # al leer su settings.yml).
  HOME=$( { getent passwd 0 || true; } | cut -d: -f6); [ -n "$HOME" ] || HOME=/root; export HOME
  unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_RUNTIME_DIR
  if ! command -v python3 >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || err "falta python3 y no hay apt-get (se esperaba Ubuntu 24.04)"
    apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 >/dev/null
  fi
  cargar_pines
  revisar
  [ "$FALLAS" = 0 ] || err "$FALLAS comprobación(es) fallaron; no se instaló nada"

  TMP=$(mktemp -d /root/uaeh-instalar.XXXXXX); trap 'rm -rf "$TMP"' EXIT
  local APTV="" CLIV="" docker_ver="" modo=completo
  if ! quiere_docker; then modo=solo-escaneres; elif ! instala_docker; then modo=docker-existente; fi

  paso "paquetes base"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg pipx python3 >/dev/null

  if instala_docker; then
    paso "repositorio de Docker (huella de la llave verificada)"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL --retry 3 --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o "$TMP/docker.asc"
    local fpr; fpr=$(gpg --show-keys --with-colons "$TMP/docker.asc" 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}' || true)
    [ "$fpr" = "$PIN_DOCKER_FPR" ] || err "huella de la llave de Docker inesperada: ${fpr:-ninguna}"
    install -m 0644 "$TMP/docker.asc" /etc/apt/keyrings/docker.asc
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $PIN_UBUNTU stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq

    paso "Docker Engine $PIN_DOCKER_VER"
    APTV=$(apt-cache madison docker-ce | awk '{print $3}' | grep -E "^5:${PIN_DOCKER_VER//./\\.}-" | head -1 || true)
    CLIV=$(apt-cache madison docker-ce-cli | awk '{print $3}' | grep -E "^5:${PIN_DOCKER_VER//./\\.}-" | head -1 || true)
    if [ -z "$APTV" ] || [ -z "$CLIV" ]; then
      apt-cache madison docker-ce | head -5 >&2 || true
      err "docker-ce $PIN_DOCKER_VER ya no está en el repositorio de Docker: hay que subir el pin en herramientas.json"
    fi
    apt-mark unhold docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || true
    apt-get install -y -qq --no-install-recommends "docker-ce=$APTV" "docker-ce-cli=$CLIV" >/dev/null
    # containerd.io no lleva pin: entra como dependencia de docker-ce (y sube solo si un pin nuevo lo exige). Una
    # reinstalación NUNCA lo sube por su cuenta: subirlo reinicia el demonio de Docker y detiene los contenedores.
    apt-get install -y -qq --no-install-recommends --no-upgrade containerd.io >/dev/null
    apt-mark hold docker-ce docker-ce-cli containerd.io >/dev/null
    systemctl enable --now docker >/dev/null 2>&1
    usermod -aG docker "$U"
  elif quiere_docker; then
    paso "Docker ya presente (UAEH_SKIP_DOCKER=1)"
    docker info >/dev/null 2>&1 || err "UAEH_SKIP_DOCKER=1 pero Docker no responde (docker info)"
    if getent group docker >/dev/null 2>&1 && [[ " $(id -nG "$U") " != *" docker "* ]]; then usermod -aG docker "$U"; fi
  fi
  if quiere_docker; then
    docker_ver=$(docker version --format '{{.Server.Version}}')
    echo "docker server $docker_ver"
  fi

  paso "gitleaks $PIN_GITLEAKS_VER (sha256 fijado)"
  if [ "$(/usr/local/bin/gitleaks version 2>/dev/null || true)" != "$PIN_GITLEAKS_VER" ]; then
    descargar "https://github.com/gitleaks/gitleaks/releases/download/v$PIN_GITLEAKS_VER/$PIN_GITLEAKS_ARCHIVO" "$TMP/$PIN_GITLEAKS_ARCHIVO" "$PIN_GITLEAKS_SHA256"
    tar -xzf "$TMP/$PIN_GITLEAKS_ARCHIVO" -C "$TMP" gitleaks
    install -m 0755 -o root -g root "$TMP/gitleaks" /usr/local/bin/gitleaks
  fi
  echo "gitleaks $(/usr/local/bin/gitleaks version)"

  paso "configuración por defecto de gitleaks (sha256 fijado; un repo auditado no puede apagar reglas)"
  local GD="$OPT/reglas/gitleaks" GT
  GT="$GD/$PIN_GITLEAKS_VER.toml"
  install -d -m 0755 -o root -g root "$OPT" "$OPT/reglas" "$GD"
  if [ ! -f "$GT" ] || [ "$(sha256sum "$GT" | cut -c1-64)" != "$PIN_GITLEAKS_CONFIG_SHA256" ]; then
    descargar "https://raw.githubusercontent.com/gitleaks/gitleaks/v$PIN_GITLEAKS_VER/config/gitleaks.toml" "$TMP/gitleaks.toml" "$PIN_GITLEAKS_CONFIG_SHA256"
    instalar_archivo 0444 "$TMP/gitleaks.toml" "$GT"
  fi
  ln -sfn "$GT" "$GD/vigente.toml"
  if [ ! -f "$GD/ignorar-vacio" ] || [ -s "$GD/ignorar-vacio" ]; then : > "$GD/ignorar-vacio"; fi
  chmod 0444 "$GD/ignorar-vacio"
  echo "reglas de gitleaks: $(grep -c '^\[\[rules\]\]' "$GT") · $GT"

  paso "osv-scanner $PIN_OSV_VER (sha256 fijado)"
  local osv; osv=$(/usr/local/bin/osv-scanner --version 2>/dev/null || true)
  if [[ "$osv" != *"$PIN_OSV_VER"* ]]; then
    descargar "https://github.com/google/osv-scanner/releases/download/v$PIN_OSV_VER/$PIN_OSV_ARCHIVO" "$TMP/$PIN_OSV_ARCHIVO" "$PIN_OSV_SHA256"
    install -m 0755 -o root -g root "$TMP/$PIN_OSV_ARCHIVO" /usr/local/bin/osv-scanner
  fi
  /usr/local/bin/osv-scanner --version | head -1 || true

  paso "semgrep $PIN_SEMGREP_VER (pipx de root en /opt/pipx)"
  export PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin PIPX_MAN_DIR=/usr/local/share/man
  if [ "$(/usr/local/bin/semgrep --version 2>/dev/null || true)" != "$PIN_SEMGREP_VER" ]; then
    pipx install --force "semgrep==$PIN_SEMGREP_VER" >/dev/null
  fi
  echo "semgrep $(/usr/local/bin/semgrep --version)"

  paso "reglas de semgrep (rotuladas con la fecha real de descarga)"
  local RS="$OPT/reglas/semgrep" RD vig p n
  install -d -m 0755 -o root -g root "$RS"
  vig=$(readlink -e "$RS/vigente" 2>/dev/null || true)
  if [ "${UAEH_REGLAS_NUEVAS:-0}" != 1 ] && [ -L "$RS/vigente" ] && reglas_sanas "$vig"; then
    RD=$vig
    echo "se conservan las reglas vigentes y sanas: $RD (UAEH_REGLAS_NUEVAS=1 para bajarlas de nuevo)"
  else
    mkdir "$TMP/reglas"
    for p in $PIN_SEMGREP_PAQUETES; do
      curl -fsSL --retry 3 --proto '=https' "https://semgrep.dev/c/p/$p" -o "$TMP/reglas/$p.yml" || err "no se pudo bajar p/$p"
      n=$(contar_reglas "$TMP/reglas/$p.yml")
      [ "${n:-0}" -gt 0 ] 2>/dev/null || err "p/$p no devolvió reglas (vacío o con otra forma): quitarlo de semgrep.paquetes en herramientas.json"
      echo "p/$p: $n reglas"
    done
    (cd "$TMP/reglas" && sha256sum ./*.yml > SHA256SUMS)
    RD="$RS/$(date +%F)"; n=1
    while [ -e "$RD" ]; do n=$((n + 1)); RD="$RS/$(date +%F)-$n"; done
    install -d -m 0755 -o root -g root "$RD"
    install -m 0444 -o root -g root -t "$RD" "$TMP"/reglas/*
    reglas_sanas "$RD" || err "las reglas copiadas a $RD no verifican"
    ln -sfn "$RD" "$RS/vigente"
    echo "reglas nuevas: $RD"
  fi

  local pares_img=() planos_img=()
  if quiere_docker; then
    paso "imágenes de la caja de arena (por digest)"
    local spec clave etiqueta digest repo ref digs
    for spec in "${IMAGENES[@]}"; do
      IFS='|' read -r clave etiqueta digest <<< "$spec"
      repo=${etiqueta%:*}; ref="$repo@$digest"
      docker pull -q "$ref" >/dev/null || err "no se pudo bajar $ref"
      digs=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref")
      grep -qxF "$ref" <<< "$digs" || err "la imagen bajada no trae el digest fijado: $ref"
      docker tag "$ref" "$etiqueta"
      echo "$clave: $etiqueta → $ref"
      pares_img+=("imagen=$clave|$ref"); planos_img+=("$clave=$ref")
    done
    # Lista blanca de la caja de arena: { "<clave>": "<repo>@sha256:<digest>" } (la lee uaeh-sandbox).
    escribir_json "$TMP/imagenes.json" "${planos_img[@]}"
    instalar_archivo 0644 "$TMP/imagenes.json" "$OPT/imagenes.json"
  fi

  paso "registro de lo instalado ($OPT/instalado.json)"
  local datos=(
    "esquema=1" "instalado=$(sello)" "pines_sha256=$(sha256sum "$PINS" | cut -c1-64)" "usuario=$U" "modo=$modo"
    "gitleaks.version=$(/usr/local/bin/gitleaks version)" "gitleaks.sha256_binario=$(sha256sum /usr/local/bin/gitleaks | cut -c1-64)"
    "gitleaks.config=$GT" "gitleaks.config_sha256=$(sha256sum "$GT" | cut -c1-64)"
    "osv-scanner.version=$PIN_OSV_VER" "osv-scanner.sha256_binario=$(sha256sum /usr/local/bin/osv-scanner | cut -c1-64)"
    "semgrep.version=$(/usr/local/bin/semgrep --version)"
    "semgrep_reglas.dir=$RD" "semgrep_reglas.paquetes=$PIN_SEMGREP_PAQUETES" "semgrep_reglas.manifiesto_sha256=$(sha256sum "$RD/SHA256SUMS" | cut -c1-64)"
  )
  if quiere_docker; then datos+=("docker.version=$docker_ver" "${pares_img[@]}"); fi
  if instala_docker; then datos+=("docker.apt=$APTV" "docker.llave_fpr=$PIN_DOCKER_FPR"); fi
  escribir_json "$TMP/instalado.json" "${datos[@]}"
  instalar_archivo 0644 "$TMP/instalado.json" "$OPT/instalado.json"
  cat "$OPT/instalado.json"
  echo; echo "INSTALAR_OK"
}

comprobar(){
  if ! command -v python3 >/dev/null 2>&1; then informe FALLA "falta python3 (lo necesita la lectura de pines)"; echo "COMPROBAR_FALLA $FALLAS"; exit 1; fi
  cargar_pines
  revisar
  estado_instalado
  if [ "$FALLAS" = 0 ]; then echo "COMPROBAR_OK"; else echo "COMPROBAR_FALLA $FALLAS"; exit 1; fi
}

principal(){
  local MODO=instalar PINS_PROPIO=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --comprobar) MODO=comprobar; shift ;;
      --pins) [ $# -ge 2 ] || err "--pins necesita un archivo"; PINS=$2; PINS_PROPIO=1; shift 2 ;;
      -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
      *) err "argumento desconocido: $1 (uso: instalar.sh [--comprobar [--pins <archivo>]])" ;;
    esac
  done
  if [ "$PINS_PROPIO" = 1 ] && [ "$MODO" != comprobar ]; then err "--pins solo vale con --comprobar (al instalar se usan los pines del plugin)"; fi
  if [ "$MODO" = comprobar ]; then comprobar; else instalar; fi
}

# Cargado con «source» (pruebas del plugin) solo define funciones; ejecutado, corre principal.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then principal "$@"; fi
