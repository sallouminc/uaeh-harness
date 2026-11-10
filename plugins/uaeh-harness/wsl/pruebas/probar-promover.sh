#!/bin/bash
# Pruebas reales de uaeh-promover (capa 3 de uaeh-harness). Corre el uaeh-promover HERMANO de esta carpeta
# (../bin/uaeh-promover: el instalado si se corre desde /opt/uaeh/pruebas, el del plugin si se corre desde wsl/pruebas)
# con python3 -I. Necesita /opt/uaeh/uaeh.conf (lo escribe instalar-bin.sh). Dos juegos de casos con la misma lógica:
#   [base]  run de prueba en <UAEH_BASE>/uaeh-prueba-promover-<pid>/run-1 (la carpeta de corridas real de uaeh.conf)
#   [ext4]  run de prueba en /tmp/uaeh-prueba-<pid>/r/run-1, con UAEH_PROMOVER_BASE_PRUEBA fijada AQUÍ.
#           Esa variable existe SOLO para estas pruebas; en producción no se usa (la base es la de uaeh.conf).
# Uso:  <prefijo del motor> bash /opt/uaeh/pruebas/probar-promover.sh
# Línea por caso: PASS|FAIL|N/A caso.  Al final: RESUMEN pass=X fail=Y na=Z.  Código 0 solo si fail=0;
# 77 (omitida) si falta la capa 3 o python3.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROM="$AQUI/../bin/uaeh-promover"
PY=/usr/bin/python3
CONF=/opt/uaeh/uaeh.conf
omitir(){ echo "SKIP: $*"; exit 77; }
[ -x "$PY" ] || omitir "falta $PY"
[ -f "$PROM" ] || omitir "falta $PROM"
[ -f "$CONF" ] || omitir "falta $CONF (capa 3 sin instalar: wsl/instalar-bin.sh)"
BASE=$(sed -n 's/^UAEH_BASE=//p' "$CONF" | head -1)
[ -n "$BASE" ] || { echo "FAIL $CONF sin UAEH_BASE"; exit 1; }
RAIZ_BASE="$BASE/uaeh-prueba-promover-$$"
RAIZ_EXT=/tmp/uaeh-prueba-$$
FUERA=/tmp/uaeh-prueba-fuera-$$        # "fuera de scratch": archivo objetivo de enlaces
P=0; F=0; N=0

limpiar(){
  case "$RAIZ_BASE" in "$BASE"/uaeh-prueba-promover-*) rm -rf -- "$RAIZ_BASE" ;; esac
  [ -n "$RAIZ_EXT" ] && rm -rf -- "$RAIZ_EXT" "$FUERA"
}
trap limpiar EXIT

rep(){ # estado caso [detalle]
  case "$1" in PASS) P=$((P+1));; FAIL) F=$((F+1));; N/A) N=$((N+1));; esac
  echo "$1 $2${3:+ - $3}"
}
py(){ "$PY" -I -c 'import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))' "$OUT" "$1" 2>/dev/null; }

# promo <agente> <max-archivo> <max-total> <archivos...>  -> OUT (json), RC
promo(){
  local ag="$1" ma="$2" mt="$3"; shift 3
  local args=() a
  for a in "$@"; do args+=(--archivo "$a"); done
  OUT=$("$PY" -I "$PROM" --run "$RUN" --agente "$ag" --max-archivo "$ma" --max-total "$mt" "${args[@]}" 2>/dev/null); RC=$?
}
nuevo(){ SC="$RUN/agents/$1/scratch"; AR="$RUN/agents/$1/artifacts"; rm -rf -- "$RUN/agents/$1"; mkdir -p -- "$SC"; }

# espera: rechazado (rc 3, 0 promovidos, 1 rechazo, nada creado en artifacts para $2 si se pide)
espera_rechazo(){ # caso ruta [fragmento_motivo]
  local c="$1" r="$2" frag="${3:-}"
  if [ "$RC" = 3 ] && [ "$(py 'len(d["promovidos"])')" = 0 ] && [ "$(py 'len(d["rechazados"])')" = 1 ] \
     && { [ -z "$frag" ] || [[ "$(py 'd["rechazados"][0]["motivo"]')" == *"$frag"* ]]; } \
     && { [ -z "$r" ] || [ ! -e "$AR/$r" ]; } ; then
    rep PASS "$c" "$(py 'd["rechazados"][0]["motivo"]')"
  else
    rep FAIL "$c" "rc=$RC out=$OUT"
  fi
}

suite(){ # $1 etiqueta ; RUN ya definido
  local E="[$1]" t
  mkdir -p -- "$RUN"

  # 1 archivo normal (en subdirectorio) -> promovido, bytes y sha256 coinciden, contenido identico
  nuevo n1; mkdir -p "$SC/a/b"; printf 'hola promover\nlinea 2\n' > "$SC/a/b/f.txt"
  promo n1 1000 10000 a/b/f.txt
  esperado=$(sha256sum "$SC/a/b/f.txt" | cut -d' ' -f1)
  if [ "$RC" = 0 ] && [ "$(py 'd["promovidos"][0]["bytes"]')" = 22 ] && [ "$(py 'd["promovidos"][0]["sha256"]')" = "$esperado" ] \
     && [ "$(py 'd["promovidos"][0]["ruta"]')" = a/b/f.txt ] && cmp -s "$SC/a/b/f.txt" "$AR/a/b/f.txt"; then
    rep PASS "$E archivo normal promovido (bytes+sha256+contenido)"
  else rep FAIL "$E archivo normal promovido" "rc=$RC out=$OUT"; fi

  # 1b artifacts/ no existe -> la crea (n1 no la tenia)
  [ -d "$AR" ] && rep PASS "$E artifacts/ creada si faltaba" || rep FAIL "$E artifacts/ creada si faltaba"

  # 2 symlink a archivo dentro de scratch
  nuevo n2; echo dentro > "$SC/real.txt"
  if ln -s real.txt "$SC/enlace.txt" 2>/dev/null && [ -L "$SC/enlace.txt" ]; then
    promo n2 1000 10000 enlace.txt; espera_rechazo "$E symlink a archivo dentro de scratch" enlace.txt
  else rep N/A "$E symlink a archivo dentro de scratch" "no se pudo crear symlink en este sistema de archivos"; fi

  # 3 symlink a archivo fuera de scratch
  nuevo n3; mkdir -p "$FUERA"; echo secreto-fuera > "$FUERA/obj.txt"
  if ln -s "$FUERA/obj.txt" "$SC/fuera.txt" 2>/dev/null && [ -L "$SC/fuera.txt" ]; then
    promo n3 1000 10000 fuera.txt; espera_rechazo "$E symlink a archivo fuera de scratch" fuera.txt
  else rep N/A "$E symlink a archivo fuera de scratch" "no se pudo crear symlink en este sistema de archivos"; fi

  # 4 enlace duro
  nuevo n4; echo duro > "$SC/orig.txt"
  if ln "$SC/orig.txt" "$SC/duro.txt" 2>/dev/null; then
    nl=$(stat -c %h "$SC/duro.txt")
    if [ "$nl" -gt 1 ]; then promo n4 1000 10000 duro.txt; espera_rechazo "$E enlace duro (nlink=$nl)" duro.txt
    else rep N/A "$E enlace duro" "el sistema de archivos reporta nlink=$nl tras ln (no distingue enlaces duros)"; fi
  else rep N/A "$E enlace duro" "ln (enlace duro) no permitido en este sistema de archivos"; fi

  # 5 FIFO
  nuevo n5
  if mkfifo "$SC/tuberia" 2>/dev/null && [ -p "$SC/tuberia" ]; then
    promo n5 1000 10000 tuberia; espera_rechazo "$E FIFO" tuberia "no es archivo regular"
  else rep N/A "$E FIFO" "mkfifo no permitido en este sistema de archivos"; fi

  # 6 directorio
  nuevo n6; mkdir -p "$SC/dir"
  promo n6 1000 10000 dir; espera_rechazo "$E directorio" dir "no es archivo regular"

  # 7 excede max-archivo
  nuevo n7; head -c 50 /dev/zero | tr '\0' x > "$SC/grande.bin"
  promo n7 49 10000 grande.bin; espera_rechazo "$E excede max-archivo" grande.bin "limite por archivo"
  nuevo n7b; head -c 49 /dev/zero | tr '\0' x > "$SC/justo.bin"
  promo n7b 49 10000 justo.bin
  [ "$RC" = 0 ] && [ -f "$AR/justo.bin" ] && rep PASS "$E tamano igual a max-archivo se acepta" || rep FAIL "$E tamano igual a max-archivo se acepta" "rc=$RC out=$OUT"

  # 8 excede max-total acumulado: 3 x 40 bytes, tope 100 -> el 3.o se rechaza
  nuevo n8; for i in 1 2 3; do head -c 40 /dev/zero | tr '\0' y > "$SC/t$i.bin"; done
  promo n8 100 100 t1.bin t2.bin t3.bin
  if [ "$RC" = 3 ] && [ "$(py 'len(d["promovidos"])')" = 2 ] && [ "$(py 'd["rechazados"][0]["ruta"]')" = t3.bin ] \
     && [ -f "$AR/t1.bin" ] && [ -f "$AR/t2.bin" ] && [ ! -e "$AR/t3.bin" ]; then
    rep PASS "$E excede max-total: el que rebasa se rechaza" "$(py 'd["rechazados"][0]["motivo"]')"
  else rep FAIL "$E excede max-total" "rc=$RC out=$OUT"; fi

  # 9-11 rutas invalidas
  nuevo n9; echo x > "$SC/ok.txt"; echo y > "$RUN/agents/n9/afuera.txt"
  promo n9 1000 10000 ../afuera.txt; espera_rechazo "$E ruta con .." ok.txt
  promo n9 1000 10000 a/../ok.txt;   espera_rechazo "$E ruta con .. en medio" ok.txt
  promo n9 1000 10000 "$RUN/agents/n9/scratch/ok.txt"; espera_rechazo "$E ruta absoluta" "ok.txt"
  promo n9 1000 10000 "";            espera_rechazo "$E ruta vacia" ""
  promo n9 1000 10000 .;             espera_rechazo "$E ruta '.'" ""

  # 12 componente intermedio que es enlace (a directorio dentro de scratch y a directorio fuera)
  nuevo n12; mkdir -p "$SC/real"; echo contenido > "$SC/real/f.txt"
  if ln -s real "$SC/lnk" 2>/dev/null && [ -L "$SC/lnk" ]; then
    promo n12 1000 10000 lnk/f.txt; espera_rechazo "$E componente intermedio es enlace (a dir de scratch)" lnk/f.txt
  else rep N/A "$E componente intermedio es enlace" "no se pudo crear symlink en este sistema de archivos"; fi
  nuevo n12b
  if ln -s "$FUERA" "$SC/lnk2" 2>/dev/null && [ -L "$SC/lnk2" ]; then
    promo n12b 1000 10000 lnk2/obj.txt; espera_rechazo "$E componente intermedio es enlace (a dir fuera)" lnk2/obj.txt
  else rep N/A "$E componente intermedio es enlace (a dir fuera)" "no se pudo crear symlink en este sistema de archivos"; fi

  # 13 destino ya existente -> rechazado (O_EXCL) y su contenido no cambia
  nuevo n13; echo nuevo > "$SC/f.txt"; mkdir -p "$AR"; echo viejo > "$AR/f.txt"
  promo n13 1000 10000 f.txt
  if [ "$RC" = 3 ] && [ "$(cat "$AR/f.txt")" = viejo ] && [ "$(py 'len(d["promovidos"])')" = 0 ]; then
    rep PASS "$E destino ya existente rechazado (O_EXCL)" "$(py 'd["rechazados"][0]["motivo"]')"
  else rep FAIL "$E destino ya existente" "rc=$RC out=$OUT"; fi

  # 14 destino: componente intermedio de artifacts es un enlace hacia fuera -> rechazado y nada escrito fuera
  nuevo n14; mkdir -p "$SC/d" "$AR"; echo z > "$SC/d/f.txt"; rm -rf -- "$FUERA/d14"; mkdir -p "$FUERA/d14"
  if ln -s "$FUERA/d14" "$AR/d" 2>/dev/null && [ -L "$AR/d" ]; then
    promo n14 1000 10000 d/f.txt
    if [ "$RC" = 3 ] && [ ! -e "$FUERA/d14/f.txt" ]; then rep PASS "$E destino: directorio de artifacts es enlace -> rechazado, nada escrito fuera"
    else rep FAIL "$E destino con directorio enlace" "rc=$RC out=$OUT"; fi
  else rep N/A "$E destino con directorio enlace" "no se pudo crear symlink en este sistema de archivos"; fi

  # 15 destino: artifacts/ misma es un enlace -> no se sigue
  nuevo n15; echo q > "$SC/f.txt"; rm -rf -- "$FUERA/a15"; mkdir -p "$FUERA/a15"
  if ln -s "$FUERA/a15" "$RUN/agents/n15/artifacts" 2>/dev/null && [ -L "$RUN/agents/n15/artifacts" ]; then
    promo n15 1000 10000 f.txt
    if [ "$RC" = 3 ] && [ ! -e "$FUERA/a15/f.txt" ]; then rep PASS "$E artifacts/ es enlace -> rechazado, nada escrito fuera"
    else rep FAIL "$E artifacts/ es enlace" "rc=$RC out=$OUT"; fi
  else rep N/A "$E artifacts/ es enlace" "no se pudo crear symlink en este sistema de archivos"; fi

  # 16 argumentos invalidos -> 64
  "$PY" -I "$PROM" --run "$RUN" --agente "CON" --max-archivo 1 --max-total 1 >/dev/null 2>&1; r1=$?
  # base con sufijo: <base>x/otro/run-1 empieza igual que la base pero está fuera (comparación literal, no prefijo suelto)
  "$PY" -I "$PROM" --run "${UAEH_PROMOVER_BASE_PRUEBA:-$BASE}x/otro/run-1" --agente n1 --max-archivo 1 --max-total 1 >/dev/null 2>&1; r2=$?
  "$PY" -I "$PROM" --run "$RUN" --agente nul --max-archivo 1 --max-total 1 >/dev/null 2>&1; r3=$?
  "$PY" -I "$PROM" --run "$RUN" --agente n1 --max-archivo abc --max-total 1 >/dev/null 2>&1; r4=$?
  "$PY" -I "$PROM" --agente n1 >/dev/null 2>&1; r5=$?
  [ "$r1$r2$r3$r4$r5" = 6464646464 ] && rep PASS "$E argumentos invalidos -> codigo 64" || rep FAIL "$E argumentos invalidos -> 64" "$r1 $r2 $r3 $r4 $r5"
}

# ---- juego 1: la carpeta de corridas real (UAEH_BASE de uaeh.conf) ----
RUN="$RAIZ_BASE/run-1"
unset UAEH_PROMOVER_BASE_PRUEBA
suite base

# ruta estilo Windows X:/... (solo en WSL con la base bajo /mnt/<unidad>)
nuevo w1; echo win > "$SC/w.txt"
if [ -x /usr/bin/wslpath ] && [[ "$RUN" == /mnt/[a-z]/* ]]; then
  WIN=$(/usr/bin/wslpath -m "$RUN")
  OUT=$("$PY" -I "$PROM" --run "$WIN" --agente w1 --max-archivo 100 --max-total 100 --archivo w.txt 2>/dev/null); RC=$?
  [ "$RC" = 0 ] && [ -f "$AR/w.txt" ] && rep PASS "[base] --run con ruta $WIN se convierte con wslpath" || rep FAIL "[base] --run con ruta de Windows" "rc=$RC out=$OUT"
else rep N/A "[base] --run con ruta de Windows" "no es WSL o la base no está bajo /mnt/<unidad>"; fi

# ---- juego 2: ext4 (base de prueba SOLO fijada aqui) ----
mkdir -p -- "$RAIZ_EXT/r"
RUN="$RAIZ_EXT/r/run-1"
export UAEH_PROMOVER_BASE_PRUEBA="$RAIZ_EXT/r/.."   # valor invalido a proposito: debe rechazarse (64)
"$PY" -I "$PROM" --run "$RUN" --agente x --max-archivo 1 --max-total 1 >/dev/null 2>&1; rv=$?
[ "$rv" = 64 ] && rep PASS "[ext4] UAEH_PROMOVER_BASE_PRUEBA fuera del patron permitido -> 64" || rep FAIL "[ext4] base de prueba invalida -> 64" "rc=$rv"
export UAEH_PROMOVER_BASE_PRUEBA="$RAIZ_EXT"
# la base de prueba es "$RAIZ_EXT" y la regla exige <base>/<repo>/run-N
suite ext4
unset UAEH_PROMOVER_BASE_PRUEBA

echo "RESUMEN pass=$P fail=$F na=$N"
[ "$F" = 0 ]
