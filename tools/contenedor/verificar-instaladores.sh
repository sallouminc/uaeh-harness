#!/usr/bin/env bash
# tools/contenedor/verificar-instaladores.sh — corre DENTRO de un contenedor ubuntu:24.04 desechable, como root, con el
# plugin uaeh-harness montado en /plugin (solo lectura). Lo lanza tools/probar-instaladores-contenedor.sh; no se corre
# a mano en una máquina real (instala en /opt/uaeh).
# Comprueba de verdad la capa 3 sin Docker dentro (UAEH_SOLO_ESCANERES=1): instalar.sh (pines, descargas verificadas,
# reglas, instalado.json, idempotencia), instalar-bin.sh (uaeh.conf, permisos, validadores de vendor/security-audit,
# rechazo de bases peligrosas), la
# validación de rutas de uaeh-sandbox, uaeh.conf manipulado, salida 77 de las autopruebas sin Docker y el
# probar-promover.sh completo y, al final, desinstalar.sh. Salida: PASS/FAIL por control y PROBAR_INSTALADORES_OK | PROBAR_INSTALADORES_FALLA <n>.
set -uo pipefail
P=/plugin
W=$P/wsl
U=ubuntu   # el usuario con uid 1000 de la imagen ubuntu:24.04
PASS=0; FAIL=0
ok(){ echo "PASS  $*"; PASS=$((PASS + 1)); }
no(){ echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
paso(){ printf '\n== %s\n' "$*"; }
# corre «$@», guarda la salida en /tmp/v.out y el código en RC
corre(){ "$@" >/tmp/v.out 2>&1; RC=$?; }
espera(){  # descripción, código esperado, texto que debe aparecer (o vacío)
  if [ "$RC" = "$2" ] && { [ -z "$3" ] || grep -qF -- "$3" /tmp/v.out; }; then ok "$1"
  else no "$1 (código $RC, se esperaba $2${3:+ y «$3»})"; tail -6 /tmp/v.out | sed 's/^/      /'; fi
}
pin(){ python3 -I -c 'import functools,json,sys; print(functools.reduce(lambda a, k: a[k], sys.argv[2].split("/"), json.load(open(sys.argv[1]))))' "$W/herramientas.json" "$1"; }
como(){ su "$U" -c "$1"; }

paso "1. instalar.sh --comprobar sin python3"
corre bash "$W/instalar.sh" --comprobar; espera "sin python3 → COMPROBAR_FALLA" 1 "falta python3"

paso "2. instalar.sh (UAEH_SOLO_ESCANERES=1), con la casa del usuario en el entorno (como deja sudo en algunos Linux)"
CASA=$(getent passwd "$U" | cut -d: -f6)
corre env UAEH_SOLO_ESCANERES=1 UAEH_TZ=UTC HOME="$CASA" XDG_CONFIG_HOME="$CASA/.config" XDG_CACHE_HOME="$CASA/.cache" bash "$W/instalar.sh"
espera "instalación completa" 0 "INSTALAR_OK"
grep -E "^p/[a-z-]+: [0-9]+ reglas" /tmp/v.out | sed 's/^/      /'
de_root=$(find "$CASA" -user root 2>/dev/null | head -5)
[ -z "$de_root" ] && ok "instalar.sh no deja archivos de root en la casa del usuario" || no "archivos de root en $CASA: $de_root"
como "/usr/local/bin/semgrep --version" >/tmp/v.sg 2>&1 && ok "el usuario corre semgrep ($(tail -n 1 /tmp/v.sg))" || no "el usuario no corre semgrep: $(tail -n 1 /tmp/v.sg)"

paso "3. segunda corrida (idempotente)"
corre env UAEH_SOLO_ESCANERES=1 bash "$W/instalar.sh"; espera "segunda corrida" 0 "se conservan las reglas vigentes"
if grep -qE "^p/[a-z-]+: [0-9]+ reglas" /tmp/v.out; then no "la segunda corrida volvió a bajar reglas"; else ok "la segunda corrida no volvió a bajar reglas"; fi

paso "4. escáneres, reglas y configuración de gitleaks contra los pines"
[ "$(gitleaks version)" = "$(pin gitleaks/version)" ] && ok "gitleaks $(gitleaks version)" || no "gitleaks $(gitleaks version) ≠ pin"
# Salida capturada antes de buscar: con pipefail, «osv-scanner --version | grep -q» falla al azar (grep -q sale al primer
# acierto y osv-scanner muere por SIGPIPE si aún escribía).
v=$(osv-scanner --version 2>&1)
grep -qF "$(pin osv-scanner/version)" <<<"$v" && ok "osv-scanner = pin" || no "osv-scanner ≠ pin: $(head -1 <<<"$v")"
[ "$(semgrep --version)" = "$(pin semgrep/version)" ] && ok "semgrep $(semgrep --version)" || no "semgrep ≠ pin"
(cd /opt/uaeh/reglas/semgrep/vigente && sha256sum --quiet -c SHA256SUMS) && ok "SHA256SUMS de las reglas verifica" || no "SHA256SUMS de las reglas"
[ "$(sha256sum /opt/uaeh/reglas/gitleaks/vigente.toml | cut -c1-64)" = "$(pin gitleaks/config_sha256)" ] && ok "configuración de gitleaks = pin" || no "configuración de gitleaks ≠ pin"
[ -f /opt/uaeh/reglas/gitleaks/ignorar-vacio ] && [ ! -s /opt/uaeh/reglas/gitleaks/ignorar-vacio ] && ok "ignorar-vacio vacío" || no "ignorar-vacio"
mkdir -p /tmp/s && printf 'export default function A({h}){return <div dangerouslySetInnerHTML={{__html: h}} />}\n' > /tmp/s/a.jsx
args=(); for f in /opt/uaeh/reglas/semgrep/vigente/*.yml; do args+=(--config "$f"); done
semgrep scan --metrics=off --disable-version-check --json "${args[@]}" /tmp/s > /tmp/s.json 2>/tmp/s.err
r=$(python3 -I -c 'import json; d=json.load(open("/tmp/s.json")); print(len(d["results"]), len(d["errors"]))')
[[ "$r" =~ ^[1-9][0-9]*\ 0$ ]] && ok "semgrep carga todos los paquetes (YAML y JSON) y detecta el caso de react ($r)" || no "semgrep con las reglas vigentes: hallazgos/errores = $r"

paso "5. instalado.json"
python3 -I - "$W/herramientas.json" "$U" <<'PY' && ok "instalado.json coherente con los pines" || no "instalado.json"
import hashlib, json, os, stat, sys
r = "/opt/uaeh/instalado.json"
st = os.stat(r)
assert st.st_uid == 0 and stat.S_IMODE(st.st_mode) == 0o644, "permisos"
d = json.load(open(r)); p = json.load(open(sys.argv[1]))
assert d["esquema"] == "1" and d["modo"] == "solo-escaneres" and d["usuario"] == sys.argv[2], d
assert d["pines_sha256"] == hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()
assert d["gitleaks"]["version"] == p["gitleaks"]["version"] and d["semgrep"]["version"] == p["semgrep"]["version"]
assert d["gitleaks"]["config_sha256"] == p["gitleaks"]["config_sha256"]
assert "imagenes" not in d and "docker" not in d
PY

paso "6. instalar-bin.sh"
corre env UAEH_BASE=/home/$U/runs bash "$W/instalar-bin.sh"; espera "instalar-bin.sh" 0 "INSTALAR_BIN_OK"
[ "$(stat -c '%U %a' /opt/uaeh/uaeh.conf)" = "root 644" ] && ok "uaeh.conf de root 0644" || no "uaeh.conf: $(stat -c '%U %a' /opt/uaeh/uaeh.conf)"
[ "$(grep -v '^#' /opt/uaeh/uaeh.conf)" = "$(printf 'UAEH_BASE=/home/%s/runs\nUAEH_USER=%s' "$U" "$U")" ] && ok "uaeh.conf con la base y el usuario (uid 1000)" || no "contenido de uaeh.conf"
for f in "$W"/bin/* "$W"/pruebas/*; do
  dest=/opt/uaeh/$(basename "$(dirname "$f")")/$(basename "$f")
  if [ "$(stat -c '%U %a' "$dest")" = "root 755" ] && cmp -s <(tr -d '\r' < "$f") "$dest"; then ok "$dest root 0755 = plugin"; else no "$dest"; fi
done
[ "$(stat -c '%U %a' /opt/uaeh/contenedor/armar.sh)" = "root 644" ] && ok "armar.sh root 0644" || no "armar.sh"
[ "$(readlink /usr/local/bin/uaeh-sandbox)" = /opt/uaeh/bin/uaeh-sandbox ] && ok "enlace /usr/local/bin/uaeh-sandbox" || no "enlace uaeh-sandbox"
# Validadores: la lista sale del propio instalar-bin.sh (una sola fuente) y cada uno es copia exacta del vendor, de root 0644.
eval "$(grep -m1 '^VALIDADORES=(' "$W/instalar-bin.sh")"
[ "${#VALIDADORES[@]}" -ge 5 ] && ok "lista de validadores (${#VALIDADORES[@]})" || no "lista de validadores de instalar-bin.sh"
for n in "${VALIDADORES[@]}"; do
  dest=/opt/uaeh/validadores/$n
  if [ "$(stat -c '%U %a' "$dest" 2>/dev/null)" = "root 644" ] && cmp -s <(tr -d '\r' < "$P/vendor/security-audit/$n") "$dest"; then ok "$dest root 0644 = vendor"; else no "$dest"; fi
done

paso "7. instalar-bin.sh rechaza bases peligrosas aun como root y no toca uaeh.conf"
antes=$(sha256sum /opt/uaeh/uaeh.conf)
for b in / /mnt/c /home/$U /home/otro/runs /tmp/x/y /opt/uaeh/runs /home/$U/runs/ /home/$U/../$U/runs; do
  corre env UAEH_BASE="$b" bash "$W/instalar-bin.sh"; espera "rechaza UAEH_BASE=$b" 1 "UAEH_BASE"
done
corre env UAEH_BASE=/home/$U/runs UAEH_USER=root bash "$W/instalar-bin.sh"; espera "rechaza UAEH_USER=root" 1 "root"
[ "$(sha256sum /opt/uaeh/uaeh.conf)" = "$antes" ] && ok "uaeh.conf intacto tras los rechazos" || no "uaeh.conf cambió"

paso "8. uaeh-sandbox como el usuario: validación de rutas"
como "mkdir -p /home/$U/runs/repo/run-1/fuente /home/$U/runsX/repo/run-1/fuente && ln -s /home/$U/runs/repo /home/$U/runs/enlace"
SB=/opt/uaeh/bin/uaeh-sandbox
corre como "$SB ejecutar --run /home/$U/runs/repo/run-1 --agente a1 -- true"; espera "ruta válida pasa la validación (luego falta imagenes.json)" 64 "falta /opt/uaeh/imagenes.json"
corre como "$SB ejecutar --run /home/$U/runsX/repo/run-1 --agente a1 -- true"; espera "base con sufijo" 64 "run fuera"
corre como "$SB ejecutar --run /home/$U/runs/../runs/repo/run-1 --agente a1 -- true"; espera "ruta con .." 64 "run fuera"
corre como "$SB ejecutar --run /home/$U/runs/enlace/run-1 --agente a1 -- true"; espera "ruta por enlace" 64 "enlace"
corre como "$SB ejecutar --run /tmp/repo/run-1 --agente a1 -- true"; espera "fuera de la base" 64 "run fuera"
corre como "$SB borrar --run /home/$U/runs/repo/run-1"; espera "modo desconocido" 64 "modo desconocido"

paso "9. uaeh.conf manipulado"
cp -p /opt/uaeh/uaeh.conf /tmp/conf.bak
chmod 0666 /opt/uaeh/uaeh.conf
corre como "$SB ejecutar --run /home/$U/runs/repo/run-1 --agente a1 -- true"; espera "escribible por otros" 64 "escribible"
chmod 0644 /opt/uaeh/uaeh.conf; chown "$U" /opt/uaeh/uaeh.conf
corre como "$SB ejecutar --run /home/$U/runs/repo/run-1 --agente a1 -- true"; espera "de otro dueño" 64 "debe ser de root"
chown root /opt/uaeh/uaeh.conf
printf 'UAEH_BASE=/\nUAEH_USER=%s\n' "$U" > /opt/uaeh/uaeh.conf
corre como "$SB ejecutar --run /home/$U/runs/repo/run-1 --agente a1 -- true"; espera "base / en el archivo" 64 "UAEH_BASE"
printf 'UAEH_BASE=/home/%s/runs\nUAEH_USER=%s\nOTRA=1\n' "$U" "$U" > /opt/uaeh/uaeh.conf
corre como "$SB ejecutar --run /home/$U/runs/repo/run-1 --agente a1 -- true"; espera "clave desconocida" 64 "línea desconocida"
cp -p /tmp/conf.bak /opt/uaeh/uaeh.conf
corre como "/usr/bin/python3 -I /opt/uaeh/bin/uaeh-promover --run /home/$U/runsX/repo/run-1 --agente a1 --max-archivo 1 --max-total 1"; espera "uaeh-promover: base con sufijo" 64 "run fuera"
corre como "/opt/uaeh/bin/uaeh-validar /home/$U/runs/repo/run-1"; espera "uaeh-validar encuentra los validadores (luego falta imagenes.json)" 64 "falta /opt/uaeh/imagenes.json"

paso "10. autopruebas sin Docker → 77 (omitida)"
corre como "bash /opt/uaeh/pruebas/probar-sandbox.sh"; espera "probar-sandbox.sh sin Docker" 77 "SKIP:"
corre como "bash /opt/uaeh/pruebas/probar-pnpmfile.sh"; espera "probar-pnpmfile.sh sin Docker" 77 "SKIP:"

paso "11. probar-promover.sh completo (base de uaeh.conf + ext4)"
corre como "bash /opt/uaeh/pruebas/probar-promover.sh"; espera "probar-promover.sh" 0 "fail=0"
grep -E "^RESUMEN" /tmp/v.out | sed 's/^/      /'

paso "12. instalar.sh --comprobar después"
corre env UAEH_SOLO_ESCANERES=1 bash "$W/instalar.sh" --comprobar; espera "comprobar tras instalar" 0 "COMPROBAR_OK"

paso "13. desinstalar.sh (al final: usa lo instalado por los pasos anteriores)"
DS=$W/desinstalar.sh
instantanea(){ find /opt/uaeh /opt/pipx /usr/local/bin -xdev -printf '%p %y %s %m %l\n' 2>/dev/null | sort | sha256sum | cut -c1-64; }
antes=$(instantanea)
corre bash "$DS" --con-escaneres; espera "en seco: lista y no quita nada" 0 "EN_SECO:"
[ "$(instantanea)" = "$antes" ] && ok "en seco no cambió ni un archivo" || no "el modo en seco cambió archivos"
[ -d /opt/uaeh ] && [ -L /usr/local/bin/uaeh-sandbox ] && [ -x /usr/local/bin/gitleaks ] && ok "tras el seco sigue todo instalado" || no "tras el seco falta algo"
corre bash "$DS" --aplicar --otra; espera "opción desconocida falla" 1 "argumento desconocido"
corre su "$U" -c "bash $DS --aplicar"; espera "--aplicar sin root falla" 1 "necesita root"
corre bash "$DS" --aplicar
espera "--aplicar (nivel base) quita lo propio" 0 "DESINSTALAR_OK"
[ ! -e /opt/uaeh ] && [ ! -L /opt/uaeh ] && ok "/opt/uaeh ya no existe" || no "/opt/uaeh sigue"
[ ! -e /usr/local/bin/uaeh-sandbox ] && [ ! -L /usr/local/bin/uaeh-sandbox ] && ok "enlace uaeh-sandbox fuera" || no "enlace uaeh-sandbox sigue"
[ -x /usr/local/bin/gitleaks ] && [ -x /usr/local/bin/osv-scanner ] && [ -x /usr/local/bin/semgrep ] && ok "el nivel base deja los escáneres" || no "el nivel base quitó escáneres"
corre bash "$DS" --aplicar; espera "segunda corrida: nada que quitar" 0 "NADA_QUE_QUITAR"
corre bash "$DS" --aplicar --con-escaneres; espera "sin instalado.json los escáneres se dejan" 0 "NADA_QUE_QUITAR"
[ -x /usr/local/bin/gitleaks ] && [ -x /usr/local/bin/osv-scanner ] && [ -x /usr/local/bin/semgrep ] && ok "sin huella anotada no se quitó ningún escáner" || no "se quitó un escáner sin huella"
# Se vuelve a instalar (rápido: los binarios ya son los fijados) para tener el registro con las huellas.
corre env UAEH_SOLO_ESCANERES=1 UAEH_TZ=UTC bash "$W/instalar.sh"; espera "reinstalación para probar --con-escaneres" 0 "INSTALAR_OK"
cp -p /usr/local/bin/gitleaks /tmp/gitleaks.bak
printf '\n' >> /usr/local/bin/gitleaks
corre bash "$DS" --con-escaneres; espera "gitleaks modificado: se deja" 0 "gitleaks: se deja, su huella no coincide"
v=$(cat /tmp/v.out)
grep -qF "QUITA  osv-scanner" <<<"$v" && grep -qF "QUITA  enlace de semgrep" <<<"$v" && ok "en seco: osv-scanner y semgrep sí, gitleaks no" || no "plan de escáneres con gitleaks modificado"
cp -p /tmp/gitleaks.bak /usr/local/bin/gitleaks
corre bash "$DS" --aplicar --con-escaneres; espera "--con-escaneres quita lo propio y los escáneres" 0 "DESINSTALAR_OK"
if [ ! -e /usr/local/bin/gitleaks ] && [ ! -e /usr/local/bin/osv-scanner ] && [ ! -e /usr/local/bin/semgrep ] && [ ! -L /usr/local/bin/semgrep ] && [ ! -e /opt/pipx ] && [ ! -e /opt/uaeh ]; then
  ok "gitleaks, osv-scanner, semgrep, /opt/pipx y /opt/uaeh fuera"; else no "quedó algún escáner o carpeta"; fi
corre bash "$DS" --aplicar --con-escaneres --con-imagenes; espera "tercera corrida: nada que quitar (Docker no responde aquí, se dice)" 0 "NADA_QUE_QUITAR"

echo; echo "RESUMEN pass=$PASS fail=$FAIL"
if [ "$FAIL" = 0 ]; then echo PROBAR_INSTALADORES_OK; else echo "PROBAR_INSTALADORES_FALLA $FAIL"; exit 1; fi
