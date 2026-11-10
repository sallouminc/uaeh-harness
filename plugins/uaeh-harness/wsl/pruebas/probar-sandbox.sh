#!/bin/bash
# Autoprueba de la caja de arena de uaeh-harness (capa 3). Cada control del contrato de ejecución de
# security-audit se comprueba con un intento real contra el programa INSTALADO (/opt/uaeh/bin/uaeh-sandbox).
# Uso (como el usuario de UAEH_USER, del grupo docker):
#   Windows:  wsl -d <distro> -e bash /opt/uaeh/pruebas/probar-sandbox.sh
#   Linux:    bash /opt/uaeh/pruebas/probar-sandbox.sh
# PROBAR_DISCO=1 incluye la prueba del vigía de disco (escribe ~1.3 GB temporales en la carpeta de corridas).
# Salida: una línea PASS/FAIL por control y «RESUMEN pass=X fail=Y»; código 0 si no hubo FAIL, 1 si hubo, y
# 77 (omitida) si la capa 3 no está instalada o Docker no responde.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SB=/opt/uaeh/bin/uaeh-sandbox
CONF=/opt/uaeh/uaeh.conf
omitir(){ echo "SKIP: $*"; exit 77; }
[ -x "$SB" ] || omitir "falta $SB (capa 3 sin instalar: wsl/instalar.sh y wsl/instalar-bin.sh)"
[ -f "$CONF" ] || omitir "falta $CONF (correr wsl/instalar-bin.sh)"
docker info >/dev/null 2>&1 || omitir "Docker no responde para $(id -un) (¿grupo docker? ¿systemd?)"
BASE=$(sed -n 's/^UAEH_BASE=//p' "$CONF" | head -1)
[ -n "$BASE" ] || { echo "FAIL  $CONF sin UAEH_BASE"; exit 1; }

B="$BASE/uaeh-prueba-sandbox-$$"
RUN=$B/run-1
PASS=0; FAIL=0
ok(){ echo "PASS  $*"; PASS=$((PASS+1)); }
no(){ echo "FAIL  $*"; FAIL=$((FAIL+1)); }
sb(){ "$SB" ejecutar --run "$RUN" --agente t01 "$@" 2>/tmp/uaeh-sb-err; }
rechaza(){ local d="$1"; shift; "$SB" "$@" >/dev/null 2>&1; [ $? -eq 64 ] && ok "rechaza: $d" || no "rechaza: $d"; }
limpiar(){ case "$B" in "$BASE"/uaeh-prueba-sandbox-*) rm -rf -- "$B" ;; esac; }
trap limpiar EXIT

mkdir -p "$RUN/fuente" || { echo "FAIL  no se pudo crear $RUN/fuente"; exit 1; }
cat > "$RUN/fuente/app.js" <<'EOF'
require('http').createServer((q, r) => r.end('hola')).listen(3000, '127.0.0.1');
EOF
printf '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x","version":"1.0.0"}}}' > "$RUN/fuente/package-lock.json"
printf '{"name":"x","version":"1.0.0"}' > "$RUN/fuente/package.json"

echo "== red y entorno"
o=$(sb -- node -e "require('https').get('https://example.com',()=>console.log('RED')).on('error',e=>console.log('SIN_RED',e.code))")
[[ "$o" == SIN_RED* ]] && ok "sin internet por nombre ($o)" || no "sin internet por nombre ($o)"
o=$(sb -- node -e "fetch('http://1.1.1.1').then(()=>console.log('RED')).catch(e=>console.log('SIN_RED',e.cause&&e.cause.code))")
[[ "$o" == SIN_RED* ]] && ok "sin internet por IP ($o)" || no "sin internet por IP ($o)"
sb -- getent hosts example.com >/dev/null && no "DNS resuelve" || ok "DNS no resuelve"
o=$(sb -- sh -c 'env | cut -d= -f1 | sort | tr "\n" " "')
extra=$(echo "$o" | tr ' ' '\n' | grep -vxE 'PATH|HOSTNAME|HOME|TMPDIR|npm_config_cache|CI|NODE_VERSION|YARN_VERSION|PWD|SHLVL|_|' || true)
[ -z "$extra" ] && ok "entorno solo lista blanca" || no "entorno con variables de más: $extra"
if o=$(sb -- sh -c 'echo "$PATH"') && [ -n "$o" ]; then
  [[ "$o" == *"/mnt"* ]] && no "PATH del anfitrión dentro ($o)" || ok "PATH sin rutas del anfitrión"
else no "no se pudo leer el PATH dentro de la caja"; fi
sb -- sh -c 'test -e /var/run/docker.sock || test -e /run/docker.sock' && no "docker.sock visible" || ok "sin docker.sock"
sb -- sh -c 'test -e /mnt/c' && no "/mnt/c visible" || ok "sin /mnt/c"
UC=$(sed -n 's/^UAEH_USER=//p' "$CONF" | head -1); IDC=$(id -u -- "$UC" 2>/dev/null || echo "?")
o=$(sb -- id -u)
[ "$IDC" != 0 ] && [ "$o" = "$IDC" ] && ok "usuario de uaeh.conf ($UC, uid $IDC; no root)" || no "el contenedor corre con uid '$o' y $UC es '$IDC'"
o=$(sb -- sh -c 'grep CapEff /proc/self/status | tr -d "\t "')
[ "$o" = "CapEff:0000000000000000" ] && ok "capacidades vacías" || no "capacidades: $o"
sb -- sh -c 'grep -q NoNewPrivs:.*1 /proc/self/status' && ok "no-new-privileges" || no "no-new-privileges"

echo "== escritura"
sb -- sh -c 'echo x > /src/intruso' 2>/dev/null; [ -e "$RUN/fuente/intruso" ] && no "/src escribible" || ok "/src solo lectura"
sb -- sh -c 'touch /etc/x || touch /usr/x || touch /x' >/dev/null 2>&1 && no "raíz escribible" || ok "raíz del contenedor solo lectura"
sb -- sh -c 'echo dato > /scratch/salida.txt' && [ "$(cat "$RUN/agents/t01/scratch/salida.txt" 2>/dev/null)" = dato ] && ok "/scratch escribible y persiste" || no "/scratch: $(tail -n 1 /tmp/uaeh-sb-err)"
sb -- sh -c 'sh /uaeh/armar.sh >/dev/null && test -f /work/app/app.js' && ok "armar.sh arma /work/app" || no "armar.sh"
sb -- sh -c 'echo x > /uaeh/x' >/dev/null 2>&1 && no "/uaeh escribible" || ok "/uaeh solo lectura"
sb -- sh -c 'head -c 300M /dev/zero > /scratch/grande' >/dev/null 2>&1
t=$(stat -c %s "$RUN/agents/t01/scratch/grande" 2>/dev/null || echo 0); rm -f "$RUN/agents/t01/scratch/grande"
# 0 bytes no demuestra el tope (puede ser que /scratch no se deje escribir): tiene que haber escrito y haberse cortado.
[ "$t" -gt 0 ] && [ "$t" -le 268435456 ] && ok "tope por archivo 256 MB (quedó $t bytes)" || no "tope por archivo ($t bytes)"

echo "== límites"
o=$(sb -- node -e "const {spawn}=require('child_process');let n=0;for(let i=0;i<400;i++){try{const p=spawn('sleep',['15']);p.on('error',()=>{});if(p.pid)n++}catch(e){}}console.log(n);process.exit(0)")
[ -n "$o" ] && [ "$o" -lt 300 ] && ok "tope de procesos (lanzó $o de 400)" || no "tope de procesos (lanzó '$o')"
sb -- node -e "const a=[];for(let i=0;i<40;i++)a.push(Buffer.alloc(100*1024*1024,1));console.log('NO_OOM')" >/tmp/uaeh-oom 2>&1; rc=$?
grep -q NO_OOM /tmp/uaeh-oom && no "memoria sin tope (4 GB)" || ok "tope de memoria (código $rc)"
t0=$(date +%s); sb --segundos 3 -- sleep 60; rc=$?; dt=$(( $(date +%s) - t0 ))
[ "$rc" = 124 ] && [ "$dt" -lt 20 ] && ok "límite de tiempo (código $rc, ${dt}s)" || no "límite de tiempo (código $rc, ${dt}s)"

echo "== base de datos desechable (loopback aislado)"
o=$(sb --bd -- node -e "const s=require('net').connect(5432,'127.0.0.1',()=>{console.log('BD_OK');s.end()});s.on('error',e=>console.log('BD_NO',e.code))")
[ "$o" = BD_OK ] && ok "postgres por 127.0.0.1:5432" || no "postgres ($o) $(tail -2 /tmp/uaeh-sb-err)"
o=$(sb --bd -- node -e "require('https').get('https://example.com',()=>console.log('RED')).on('error',e=>console.log('SIN_RED'))")
[ "$o" = SIN_RED ] && ok "modo --bd sin internet" || no "modo --bd con red ($o)"
o=$(sb --bd -- sh -c 'echo "$DATABASE_URL"')
[[ "$o" == postgresql://uaeh:uaeh-ficticia@127.0.0.1:5432/uaeh ]] && ok "DATABASE_URL ficticia" || no "DATABASE_URL ($o)"
[ -z "$(docker ps -q --filter name=uaeh-bd-)" ] && ok "la base se destruye al terminar" || no "quedó una base corriendo"

echo "== dependencias preparadas (solo lectura)"
VOL=$("$SB" preparar-deps --run "$RUN" --gestor npm 2>"$B/preparar-deps.err" | tail -1)
if [[ "$VOL" == uaeh-deps-* ]]; then
  ok "preparar-deps creó $VOL"
  sb --deps "$VOL" -- sh -c 'test -f /deps/app/package.json' && ok "deps montadas en /deps" || no "deps no montadas"
  sb --deps "$VOL" -- sh -c 'echo x > /deps/x' >/dev/null 2>&1 && no "/deps escribible" || ok "/deps solo lectura"
  sb --deps "$VOL" -- sh -c 'sh /uaeh/armar.sh >/dev/null && test -f /work/app/package-lock.json' && ok "armar.sh con deps" || no "armar.sh con deps"
  docker volume rm "$VOL" >/dev/null
else no "preparar-deps ($VOL): $(tail -n 2 "$B/preparar-deps.err" | tr '\n' ' ')"; fi

echo "== validación de argumentos"
rechaza "run con .."           ejecutar --run "$B/run-1/../run-1" --agente t01 -- true
rechaza "run fuera de la base" ejecutar --run /tmp --agente t01 -- true
rechaza "base con sufijo (comparación literal)" ejecutar --run "${BASE}x/uaeh-prueba/run-1" --agente t01 -- true
ln -sfn "$RUN" "$B/run-2" 2>/dev/null && rechaza "run por enlace" ejecutar --run "$B/run-2" --agente t01 -- true
rechaza "imagen no listada"    ejecutar --run "$RUN" --agente t01 --imagen alpine -- true
rechaza "agente con ../"       ejecutar --run "$RUN" --agente ../x -- true
rechaza "agente dispositivo"   ejecutar --run "$RUN" --agente nul -- true
rechaza "segundos de más"      ejecutar --run "$RUN" --agente t01 --segundos 5000 -- true
rechaza "--env HOME"           ejecutar --run "$RUN" --agente t01 --env HOME=/ -- true
rechaza "--env LD_PRELOAD"     ejecutar --run "$RUN" --agente t01 --env LD_PRELOAD=/x.so -- true
rechaza "deps inexistente"     ejecutar --run "$RUN" --agente t01 --deps uaeh-deps-no-existe -- true
rechaza "deps con nombre raro" ejecutar --run "$RUN" --agente t01 --deps /var/lib/docker -- true
rechaza "bandera desconocida"  ejecutar --run "$RUN" --agente t01 --privileged -- true
mkdir -p "$RUN/agents/t02"; ln -sfn /tmp "$RUN/agents/t02/scratch" 2>/dev/null && rechaza "scratch por enlace" ejecutar --run "$RUN" --agente t02 -- true
rechaza "modo desconocido"     borrar --run "$RUN"

if [ "${PROBAR_DISCO:-0}" = 1 ]; then
  echo "== vigía de disco (1 GB)"
  sb --segundos 120 -- sh -c 'for i in 1 2 3 4 5 6; do head -c 250M /dev/zero > /scratch/d$i || true; done; echo TERMINO' > /tmp/uaeh-disco 2>&1
  t=$(du -sm "$RUN/agents/t01/scratch" | cut -f1); rm -f "$RUN"/agents/t01/scratch/d*
  # Sin nada escrito no hay nada que vigilar: «detuvo» exige que haya escrito algo y no haya terminado.
  { ! grep -q TERMINO /tmp/uaeh-disco && [ "${t:-0}" -gt 0 ]; } && ok "vigía de disco detuvo (${t} MB al parar)" || no "vigía de disco (${t} MB; $(tail -n 1 /tmp/uaeh-disco))"
fi

echo "RESUMEN pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
