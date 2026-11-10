#!/bin/bash
# instalar-bin.sh — capa 3 de uaeh-harness: instala los programas de la caja de arena en /opt/uaeh (de root,
# solo lectura para los demás) y escribe /opt/uaeh/uaeh.conf, la ÚNICA configuración que leen uaeh-sandbox,
# uaeh-promover y uaeh-validar: la carpeta de corridas (UAEH_BASE) y el usuario (UAEH_USER). Ningún agente
# puede cambiarla: vive fuera de su alcance y la escribe root.
#
# Uso (después de instalar.sh):
#   Windows:  wsl -d <distro> -u root -e env UAEH_BASE=<carpeta de corridas en ruta de Linux> UAEH_USER=<usuario> \
#               bash <carpeta wsl del plugin>/instalar-bin.sh
#   Linux:    sudo env UAEH_BASE=<carpeta de corridas> bash <carpeta wsl del plugin>/instalar-bin.sh
#   Revisar sin instalar (sin root; no escribe nada):  env UAEH_BASE=… UAEH_USER=… bash instalar-bin.sh --comprobar
# La carpeta de corridas en ruta de Linux la da el plugin:
#   node <plugin>/scripts/uaeh-config.cjs ruta-motor "$(node <plugin>/scripts/uaeh-config.cjs runs-dir)"
# Reglas de UAEH_BASE: ruta absoluta con solo A-Z a-z 0-9 . _ - /, sin «.», «..», «//» ni «/» final, 3 niveles o
# más y colgando de /mnt/…, /srv/… o /home/<UAEH_USER>/… (nunca /, /mnt/<x>, /home ni /home/<usuario> a secas).
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

O=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")   # carpeta wsl/ del plugin
PLUGIN=$(dirname "$O")
OPT=/opt/uaeh
VALIDADORES=(validate-findings.cjs validate-coverage-ledger.cjs validate-findings.test.cjs validate-coverage-ledger.test.cjs report-schema.json)

err(){ echo "instalar-bin.sh: ERROR: $*" >&2; exit 1; }

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

copiar(){  # $1 origen, $2 destino, $3 modo — sin CR (por si el plugin vino con fin de línea de Windows), root:root
  tr -d '\r' < "$1" > "$2.nuevo"
  chown root:root "$2.nuevo"; chmod "$3" "$2.nuevo"; mv -f "$2.nuevo" "$2"
}

MODO=instalar
case "${1-}" in
  '') ;;
  --comprobar) MODO=comprobar ;;
  -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) err "argumento desconocido: $1 (uso: instalar-bin.sh [--comprobar])" ;;
esac
[ $# -le 1 ] || err "demasiados argumentos"

U=$(resolver_usuario)
usuario_valido "$U" || err "UAEH_USER: $MOTIVO (fijar UAEH_USER=<usuario de la distro>)"
BASE=${UAEH_BASE-}
[ -n "$BASE" ] || err "falta UAEH_BASE: la carpeta de corridas en ruta de Linux (ver la cabecera de este archivo)"
base_valida "$BASE" "$U" || err "UAEH_BASE: $MOTIVO"
CONF_TXT="# $OPT/uaeh.conf — lo escribe instalar-bin.sh (root). Lo leen uaeh-sandbox, uaeh-promover y uaeh-validar.
# Para cambiarlo se vuelve a correr instalar-bin.sh con otro UAEH_BASE o UAEH_USER; no se edita a mano.
UAEH_BASE=$BASE
UAEH_USER=$U"

ESTADO_BASE="no existe todavía (la crea la puerta de seguridad en su primera corrida)"
if [ -e "$BASE" ] || [ -L "$BASE" ]; then
  REAL=$(realpath -e -- "$BASE" 2>/dev/null || true)
  if [ -L "$BASE" ] || [ ! -d "$BASE" ] || [ "$REAL" != "$BASE" ]; then
    err "UAEH_BASE «$BASE» existe pero no es una carpeta real (enlace o archivo): la caja de arena la rechazaría"
  fi
  ESTADO_BASE="existe (carpeta real)"
fi
VA="$PLUGIN/vendor/security-audit"
if [ -d "$VA" ]; then ESTADO_VAL="desde $VA"; else ESTADO_VAL="AVISO: este plugin no trae vendor/security-audit; uaeh-validar no tendrá validadores"; fi

if [ "$MODO" = comprobar ]; then
  echo "usuario:      $U"
  echo "base:         $BASE — $ESTADO_BASE"
  echo "programas:    $(cd "$O/bin" && echo *) → $OPT/bin"
  echo "contenedor:   $(cd "$O/contenedor" && echo *) → $OPT/contenedor"
  echo "autopruebas:  $(cd "$O/pruebas" && echo *) → $OPT/pruebas"
  echo "validadores:  $ESTADO_VAL"
  echo "--- $OPT/uaeh.conf quedaría así:"
  printf '%s\n' "$CONF_TXT"
  echo "COMPROBAR_OK"
  exit 0
fi

[ "$(id -u)" = 0 ] || err "correr como root (Windows: wsl -d <distro> -u root …; Linux: sudo …)"
getent passwd "$U" >/dev/null 2>&1 || err "el usuario $U no existe en este Linux"

install -d -m 0755 -o root -g root "$OPT" "$OPT/bin" "$OPT/contenedor" "$OPT/pruebas"
for f in "$O"/bin/*; do copiar "$f" "$OPT/bin/$(basename "$f")" 0755; done
for f in "$O"/contenedor/*; do copiar "$f" "$OPT/contenedor/$(basename "$f")" 0644; done
for f in "$O"/pruebas/*; do copiar "$f" "$OPT/pruebas/$(basename "$f")" 0755; done
if [ -d "$VA" ]; then
  install -d -m 0755 -o root -g root "$OPT/validadores"
  for n in "${VALIDADORES[@]}"; do
    if [ -f "$VA/$n" ]; then copiar "$VA/$n" "$OPT/validadores/$n" 0644; else echo "AVISO: falta $VA/$n" >&2; fi
  done
else
  echo "$ESTADO_VAL" >&2
fi

printf '%s\n' "$CONF_TXT" > "$OPT/uaeh.conf.nuevo"
chown root:root "$OPT/uaeh.conf.nuevo"; chmod 0644 "$OPT/uaeh.conf.nuevo"; mv -f "$OPT/uaeh.conf.nuevo" "$OPT/uaeh.conf"
ln -sfn "$OPT/bin/uaeh-sandbox" /usr/local/bin/uaeh-sandbox

echo "base de corridas: $BASE — $ESTADO_BASE"
ls -la "$OPT/bin" "$OPT/contenedor" "$OPT/pruebas" "$OPT/uaeh.conf"
sha256sum "$OPT"/bin/* "$OPT"/contenedor/* "$OPT/uaeh.conf"
echo "INSTALAR_BIN_OK"
