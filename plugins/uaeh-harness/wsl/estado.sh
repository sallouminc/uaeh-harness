#!/bin/bash
# estado.sh — capa 3 de uaeh-harness: lo que hay instalado en este Linux para la puerta de seguridad, en líneas
# «clave valor» que lee scripts/doctor-puertas.cjs. SOLO LEE: no necesita root, no escribe, no descarga nada.
# Lo corre el usuario de la puerta (el de /opt/uaeh/uaeh.conf), igual que la caja de arena:
#   Windows:  wsl -d <distro> -u <usuario> -e bash <carpeta wsl del plugin>/estado.sh
#   Linux:    bash <carpeta wsl del plugin>/estado.sh
# Compara lo instalado en /opt/uaeh con ESTE plugin (programas sin CR, como los copia instalar-bin.sh). Las versiones
# de los escáneres se informan tal cual: compararlas con los pines de herramientas.json es trabajo del doctor.
# Pruebas: UAEH_OPT=<carpeta> reemplaza /opt/uaeh y UAEH_BIN_ESCANERES=<carpeta> reemplaza /usr/local/bin.
# Nunca falla por un dato ausente: lo informa («no»). La última línea es siempre «ESTADO_FIN».
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

O=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")   # carpeta wsl/ del plugin
PLUGIN=$(dirname "$O")
OPT=${UAEH_OPT:-/opt/uaeh}
BIN=${UAEH_BIN_ESCANERES:-/usr/local/bin}

dato(){ printf '%s %s\n' "$1" "${2:-no}"; }
primera(){ head -n 1 | tr -d '\r' | cut -c1-160; }
huella(){ if [ -f "$1" ]; then tr -d '\r' < "$1" | sha256sum | cut -d' ' -f1; fi; }

# Un archivo del plugin frente a su copia instalada: «archivo <rel> igual|distinto|falta <dueño>:<grupo> <modo>».
comparar(){  # $1 origen en el plugin, $2 destino instalado, $3 etiqueta
  local esperado instalado permisos
  if [ ! -e "$2" ]; then dato archivo "$3 falta"; return; fi
  esperado=$(huella "$1"); instalado=$(sha256sum < "$2" 2>/dev/null | cut -d' ' -f1)
  permisos=$(stat -c '%U:%G %a' "$2" 2>/dev/null || echo '?')
  if [ -n "$esperado" ] && [ "$esperado" = "$instalado" ]; then dato archivo "$3 igual $permisos"
  else dato archivo "$3 distinto $permisos"; fi
}

dato estado_version 1
dato arquitectura "$(uname -m 2>/dev/null)"
dato ubuntu "$( { . /etc/os-release && printf '%s' "${VERSION_CODENAME-}"; } 2>/dev/null )"
dato pid1 "$(ps -p 1 -o comm= 2>/dev/null)"
dato usuario "$(id -un 2>/dev/null)"
if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx docker; then dato grupo_docker si; else dato grupo_docker no; fi
dato python3 "$(python3 --version 2>/dev/null | primera)"

dato gitleaks "$("$BIN/gitleaks" version 2>/dev/null | primera)"
dato osv "$("$BIN/osv-scanner" --version 2>/dev/null | primera)"
dato semgrep "$("$BIN/semgrep" --version 2>/dev/null | primera)"
dato reglas_semgrep "$(readlink -e "$OPT/reglas/semgrep/vigente" 2>/dev/null)"

if command -v docker >/dev/null 2>&1; then
  if v=$(timeout 25 docker info --format '{{.ServerVersion}}' 2>&1); then dato docker "$(printf '%s' "$v" | primera)"
  else dato docker "no: $(printf '%s' "$v" | primera)"; fi
  timeout 25 docker image ls --digests --format '{{.Repository}}@{{.Digest}}' 2>/dev/null | while read -r img; do
    case "$img" in *@sha256:*) dato imagen "$img" ;; esac
  done
else
  dato docker "no: falta el programa docker"
fi

if [ -f "$OPT/uaeh.conf" ]; then
  dato conf si
  dato conf_base "$(sed -n 's/^UAEH_BASE=//p' "$OPT/uaeh.conf" | primera)"
  dato conf_usuario "$(sed -n 's/^UAEH_USER=//p' "$OPT/uaeh.conf" | primera)"
else
  dato conf no
fi
if [ -f "$OPT/instalado.json" ]; then dato instalado si; else dato instalado no; fi
if [ -L /usr/local/bin/uaeh-sandbox ] && [ "$(readlink -f /usr/local/bin/uaeh-sandbox)" = "$(readlink -f "$OPT/bin/uaeh-sandbox" 2>/dev/null)" ]; then
  dato enlace_sandbox si
else
  dato enlace_sandbox no
fi

for d in bin contenedor pruebas; do
  for f in "$O/$d"/*; do [ -f "$f" ] && comparar "$f" "$OPT/$d/$(basename "$f")" "$d/$(basename "$f")"; done
done
# La lista de validadores sale de instalar-bin.sh (una sola fuente).
VA="$PLUGIN/vendor/security-audit"
for n in $(sed -n 's/^VALIDADORES=(\(.*\))$/\1/p' "$O/instalar-bin.sh"); do
  if [ -f "$VA/$n" ]; then comparar "$VA/$n" "$OPT/validadores/$n" "validadores/$n"; else dato archivo "validadores/$n sin-origen"; fi
done
echo ESTADO_FIN
