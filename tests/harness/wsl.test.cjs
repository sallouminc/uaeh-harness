// Pruebas de plugins/uaeh-harness/wsl/ (capa 3: motor de Linux de la puerta de seguridad).
//
// Corren en la batería normal, en Windows (Git Bash) y en Linux, sin instalar nada:
//   · herramientas.json: solo pines, con forma válida y la regla «publicado hace 14 días o más».
//   · reglas estáticas de los scripts (LF, shebang fijo, PATH fijo, bloques comunes idénticos, nada de pines repetidos).
//   · comportamiento real de las validaciones: el bloque «validar» y el bloque «conf» se cargan con `source` desde
//     bin/uaeh-sandbox (que solo corre su principal si se ejecuta), y uaeh-promover se importa en Python (solo en
//     POSIX: usa O_NOFOLLOW) para comprobar que las dos implementaciones dan el mismo veredicto caso por caso.
//   · los modos --comprobar de instalar.sh e instalar-bin.sh (sin root, no escriben nada).
// Lo que necesita la capa 3 instalada (Docker, /opt/uaeh) vive en tests/integracion/wsl-autopruebas.test.cjs.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RAIZ_REPO, RAIZ_HARNESS, entornoTemporal, requiereBash, requiereHerramienta } = require('../helpers/entorno.cjs');

const WSL = path.join(RAIZ_HARNESS, 'wsl');
const PINS = path.join(WSL, 'herramientas.json');
const SANDBOX = path.join(WSL, 'bin', 'uaeh-sandbox');
const VALIDAR = path.join(WSL, 'bin', 'uaeh-validar');
const PROMOVER = path.join(WSL, 'bin', 'uaeh-promover');
const INSTALAR = path.join(WSL, 'instalar.sh');
const INSTALAR_BIN = path.join(WSL, 'instalar-bin.sh');
const DESINSTALAR = path.join(WSL, 'desinstalar.sh');
const POSIX = process.platform !== 'win32';

const E = entornoTemporal('uaeh-wsl-');
process.on('exit', () => E.limpiar());

const barra = (p) => p.replace(/\\/g, '/');
function listar(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...listar(p)); else out.push(p);
  }
  return out;
}
const ARCHIVOS = listar(WSL);
const rel = (p) => barra(path.relative(WSL, p));
const SCRIPTS_BASH = ARCHIVOS.filter((p) => /^((des)?instalar(-bin)?\.sh|estado\.sh|bin\/uaeh-(sandbox|validar)|pruebas\/.+\.sh)$/.test(rel(p)));

function bash(t, script, args = [], { env = {}, input = '' } = {}) {
  const b = requiereBash(t);
  if (!b) return null;
  const base = { ...E.env };
  delete base.SUDO_USER; // si la batería corre con sudo, no debe decidir el usuario por las pruebas
  const entorno = { ...base, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete entorno[k];
  const r = spawnSync(b, ['-c', script, 'prueba', ...args], { encoding: 'utf8', env: entorno, input, timeout: 60000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── herramientas.json ───────────────────────────────────────────────────────────────────────────────────────
test('herramientas.json · solo pines con forma válida (versiones, sha256, digests, huella de la llave)', () => {
  const p = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  const VER = /^\d+\.\d+\.\d+$/;
  const SHA = /^[0-9a-f]{64}$/;
  assert.equal(p.esquema, 1);
  assert.deepEqual(p.plataforma, { ubuntu: 'noble', arquitectura: 'x86_64' });
  assert.match(p.docker.version, VER);
  assert.match(p.docker.llave_fpr, /^[0-9A-F]{40}$/);
  assert.match(p.gitleaks.version, VER);
  assert.equal(p.gitleaks.archivo, `gitleaks_${p.gitleaks.version}_linux_x64.tar.gz`);
  assert.match(p.gitleaks.sha256, SHA);
  assert.match(p.gitleaks.config_sha256, SHA);
  assert.match(p['osv-scanner'].version, VER);
  assert.equal(p['osv-scanner'].archivo, 'osv-scanner_linux_amd64');
  assert.match(p['osv-scanner'].sha256, SHA);
  assert.match(p.semgrep.version, VER);
  assert.ok(Array.isArray(p.semgrep.paquetes) && p.semgrep.paquetes.length > 0);
  assert.equal(new Set(p.semgrep.paquetes).size, p.semgrep.paquetes.length, 'paquetes de semgrep repetidos');
  for (const x of p.semgrep.paquetes) assert.match(x, /^[a-z0-9-]{1,40}$/);
  assert.ok(p.imagenes.node && p.imagenes.postgres, 'la caja de arena necesita node y postgres');
  for (const [clave, img] of Object.entries(p.imagenes)) {
    assert.match(clave, /^[a-z0-9-]{1,32}$/);
    assert.match(img.etiqueta, /^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/);
    assert.match(img.digest, /^sha256:[0-9a-f]{64}$/);
  }
  for (const v of Object.values(p.visual)) assert.match(v, VER);
  // Sin datos de una instalación concreta: eso va a /opt/uaeh/instalado.json.
  for (const k of ['instalado', 'pipx_home', 'sha256_binario', 'copia']) assert.ok(!JSON.stringify(p).includes(`"${k}"`), `clave de instalación en los pines: ${k}`);
});

test('herramientas.json · regla de versión: todo lo fijado se publicó 14 días o más antes de fijarlo', () => {
  const p = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  const fijado = Date.parse(`${p.fijado}T00:00:00Z`);
  assert.ok(Number.isFinite(fijado), 'fijado debe ser AAAA-MM-DD');
  const fechas = [['docker', p.docker], ['gitleaks', p.gitleaks], ['osv-scanner', p['osv-scanner']], ['semgrep', p.semgrep],
    ...Object.entries(p.imagenes).map(([k, v]) => [`imagen ${k}`, v])];
  for (const [nombre, x] of fechas) {
    const pub = Date.parse(`${x.publicado}T00:00:00Z`);
    assert.ok(Number.isFinite(pub), `${nombre}: falta «publicado» (AAAA-MM-DD)`);
    assert.ok((fijado - pub) / 86400000 >= 14, `${nombre}: publicado ${x.publicado}, menos de 14 días antes de ${p.fijado}`);
  }
});

// ── reglas estáticas ────────────────────────────────────────────────────────────────────────────────────────
test('wsl/ · LF, UTF-8 sin BOM y shebang fijo (nunca /usr/bin/env: el PATH de quien llama no elige el intérprete)', () => {
  for (const f of ARCHIVOS) {
    const buf = fs.readFileSync(f);
    assert.ok(!buf.includes(0x0d), `${rel(f)} tiene CR`);
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${rel(f)} tiene BOM`);
  }
  for (const f of SCRIPTS_BASH) assert.ok(fs.readFileSync(f, 'utf8').startsWith('#!/bin/bash\n'), `${rel(f)}: shebang`);
  assert.ok(fs.readFileSync(PROMOVER, 'utf8').startsWith('#!/usr/bin/python3 -I\n'), 'uaeh-promover: shebang');
  assert.ok(fs.readFileSync(path.join(WSL, 'contenedor', 'armar.sh'), 'utf8').startsWith('#!/bin/sh\n'), 'armar.sh: shebang');
});

test('wsl/ · cada script de bash fija su PATH y su modo estricto antes de hacer nada', () => {
  for (const f of SCRIPTS_BASH) {
    const cabeza = fs.readFileSync(f, 'utf8').split('\n').slice(0, 30).join('\n');
    assert.match(cabeza, /^set -[eu]*u[eo]* ?(-o )?pipefail$|^set -u$/m, `${rel(f)}: falta set -u…`);
    assert.match(cabeza, /^export PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/m, `${rel(f)}: PATH no fijado`);
  }
});

// «x | grep -q» con pipefail: grep sale al primer acierto, x muere por SIGPIPE si aún escribía y la tubería entera «falla»
// aunque el texto estaba (5-nov: «osv-scanner --version», 4 líneas, dio «≠ pin» una vez en el contenedor de CI).
// Se captura antes («v=$(x); grep -q … <<<"$v"») o se compara con [[ ]].
test('bash con pipefail · ningún script de wsl/ ni de tools/ hace «… | grep -q»', () => {
  const deTools = listar(path.join(RAIZ_REPO, 'tools')).filter((p) => p.endsWith('.sh'));
  const malos = [];
  for (const f of [...SCRIPTS_BASH, ...deTools]) {
    const t = fs.readFileSync(f, 'utf8');
    if (!/\bpipefail\b/.test(t)) continue;
    t.split('\n').forEach((l, i) => {
      // una tubería, no el «||» de bash
      if (!/^\s*#/.test(l) && /(^|[^|])\|\s*grep\s+-[A-Za-z]*q/.test(l)) malos.push(`${barra(path.relative(RAIZ_REPO, f))}:${i + 1}`);
    });
  }
  assert.ok(deTools.length >= 2, 'no encontré los scripts de tools/');
  assert.deepEqual(malos, []);
});

function bloque(texto, nombre) {
  const ini = texto.indexOf(`# >>> bloque común «${nombre}»`);
  const fin = texto.indexOf(`# <<< bloque común «${nombre}»`);
  return ini >= 0 && fin > ini ? texto.slice(ini, fin) : null;
}
test('wsl/ · los bloques comunes «validar» y «conf» son idénticos byte a byte en cada script que los lleva', () => {
  const validar = [INSTALAR, INSTALAR_BIN, DESINSTALAR, SANDBOX, VALIDAR].map((f) => [rel(f), bloque(fs.readFileSync(f, 'utf8'), 'validar')]);
  for (const [n, b] of validar) assert.ok(b, `${n}: falta el bloque «validar»`);
  for (const [n, b] of validar.slice(1)) assert.equal(b, validar[0][1], `${n}: el bloque «validar» difiere del de ${validar[0][0]}`);
  const conf = [SANDBOX, VALIDAR].map((f) => [rel(f), bloque(fs.readFileSync(f, 'utf8'), 'conf')]);
  for (const [n, b] of conf) assert.ok(b, `${n}: falta el bloque «conf»`);
  assert.equal(conf[1][1], conf[0][1], 'el bloque «conf» difiere entre uaeh-sandbox y uaeh-validar');
});

test('wsl/ · los pines viven SOLO en herramientas.json (ningún script repite una versión, huella o digest)', () => {
  const p = JSON.parse(fs.readFileSync(PINS, 'utf8'));
  const valores = [p.docker.version, p.docker.llave_fpr, p.gitleaks.version, p.gitleaks.sha256, p.gitleaks.config_sha256,
    p['osv-scanner'].version, p['osv-scanner'].sha256, p.semgrep.version,
    ...Object.values(p.imagenes).flatMap((i) => [i.etiqueta, i.digest.slice(7)])];
  for (const f of ARCHIVOS.filter((x) => !/(\.json|\.md)$/.test(x))) {
    const texto = fs.readFileSync(f, 'utf8');
    for (const v of valores) assert.ok(!texto.includes(v), `${rel(f)} repite el pin ${v}`);
  }
});

test('uaeh-sandbox · las CPU que pide a Docker se topan a las de la máquina (un número fijo mayor falla)', () => {
  // Docker rechaza --cpus por encima de las CPU del equipo; un runner de CI de repo privado tiene 2 y preparar-deps pedía 4.
  const s = fs.readFileSync(SANDBOX, 'utf8');
  assert.doesNotMatch(s, /--cpus [2-9]/, 'uaeh-sandbox pide un número fijo de CPU mayor que 1');
  assert.match(s, /NCPU=\$\(nproc /, 'el tope sale de nproc');
});

test('instalar.sh · instala con la casa de root: fija HOME y quita las XDG_* del usuario antes de correr nada', () => {
  // Con sudo, HOME/XDG_CONFIG_HOME pueden ser las del usuario: semgrep --version de root dejaba ahí un settings.yml de root
  // y después el usuario no podía correr semgrep (lo encontró linux-integracion). El comportamiento real lo comprueba
  // tools/contenedor/verificar-instaladores.sh (paso 2); aquí, que el arreglo esté antes del primer comando.
  const cuerpo = fs.readFileSync(INSTALAR, 'utf8').split(/\ninstalar\(\)\{\n/)[1];
  assert.ok(cuerpo, 'no se encontró instalar()');
  const lineas = cuerpo.split('\n');
  const iHome = lineas.findIndex((l) => /export HOME/.test(l));
  const iXdg = lineas.findIndex((l) => /unset XDG_CONFIG_HOME/.test(l));
  const iPrimero = lineas.findIndex((l) => !/^\s*#/.test(l) && /apt-get|cargar_pines|semgrep|pipx/.test(l));
  assert.ok(iHome >= 0 && iXdg >= 0, 'instalar() no fija HOME ni quita XDG_*');
  assert.ok(iHome < iPrimero && iXdg < iPrimero, 'HOME y XDG_* se arreglan antes del primer comando que escribe');
  assert.match(fs.readFileSync(path.join(RAIZ_REPO, 'tools', 'contenedor', 'verificar-instaladores.sh'), 'utf8'), /archivos de root en la casa del usuario/);
});

test('instalar.sh · un semgrep que no instaló UAEH se revisa antes de instalar nada y solo se reemplaza con UAEH_SEMGREP_REEMPLAZAR=1', () => {
  // pipx install --force pisaba cualquier /usr/local/bin/semgrep de otra versión. revisar() corre antes del primer paso
  // (una FALLA ahí detiene todo) y también en --comprobar. El comportamiento real: tools/contenedor/verificar-instaladores.sh.
  const s = fs.readFileSync(INSTALAR, 'utf8');
  const revisar = (s.split(/\nrevisar\(\)\{/)[1] || '').split(/\n\}\n/)[0];
  assert.ok(revisar, 'no se encontró revisar()');
  assert.match(revisar, /if ! semgrep_propio; then/);
  assert.match(revisar, /informe FALLA "[^"\n]*no se pisa/);
  assert.match(revisar, /"\$\{UAEH_SEMGREP_REEMPLAZAR:-0\}" = 1/);
  assert.match(s, /^#   UAEH_SEMGREP_REEMPLAZAR=1 /m, 'la variable está en la cabecera');
  assert.match(fs.readFileSync(path.join(RAIZ_REPO, 'tools', 'contenedor', 'verificar-instaladores.sh'), 'utf8'), /un semgrep que no instaló UAEH no se pisa/);
});

test('instalar.sh · reinstalar no sube paquetes sin pin: containerd.io va aparte y con --no-upgrade', () => {
  // Subir containerd.io reinicia el demonio de Docker y detiene los contenedores del usuario: una segunda corrida
  // del instalador (p. ej. tras subir el pin de semgrep) no puede hacerlo por su cuenta.
  const lineas = fs.readFileSync(INSTALAR, 'utf8').split('\n').filter((l) => /^\s*apt-get install /.test(l));
  const conPin = lineas.filter((l) => /docker-ce=/.test(l));
  assert.equal(conPin.length, 1, 'se esperaba UNA línea de apt-get install con docker-ce fijado');
  assert.doesNotMatch(conPin[0], /containerd\.io/, 'containerd.io no puede ir en la línea que instala docker-ce fijado');
  const containerd = lineas.filter((l) => /containerd\.io/.test(l));
  assert.equal(containerd.length, 1, 'se esperaba UNA línea de apt-get install para containerd.io');
  assert.match(containerd[0], /--no-upgrade/, 'containerd.io se instala con --no-upgrade');
});

test('wsl/ · nombres que otras piezas dan por hechos: autopruebas del candado, validadores, ejecutables en git', () => {
  // solo-lectura.js deja pasar SOLO estas autopruebas por su nombre exacto.
  const candado = fs.readFileSync(path.join(RAIZ_HARNESS, 'hooks', 'solo-lectura.js'), 'utf8');
  const m = /pruebas\\\/\(\?:([a-z|-]+)\)\\\.sh/.exec(candado);
  assert.ok(m, 'no se encontró la lista de autopruebas en solo-lectura.js');
  const pruebas = fs.readdirSync(path.join(WSL, 'pruebas')).map((n) => n.replace(/\.sh$/, '')).sort();
  assert.deepEqual(m[1].split('|').sort(), pruebas);
  for (const n of pruebas) assert.match(fs.readFileSync(path.join(WSL, 'pruebas', `${n}.sh`), 'utf8'), /exit 77/, `${n}: sin salida 77 (omitida)`);
  // Lo que uaeh-validar monta de /opt/uaeh/validadores lo copia instalar-bin.sh.
  const copiados = /^VALIDADORES=\(([^)]*)\)/m.exec(fs.readFileSync(INSTALAR_BIN, 'utf8'))[1].split(/\s+/);
  const usados = [...fs.readFileSync(VALIDAR, 'utf8').matchAll(/\/skill\/([A-Za-z0-9._-]+)/g)].map((x) => x[1]).filter((x) => x !== '$1');
  for (const u of usados) assert.ok(copiados.includes(u), `uaeh-validar usa ${u} y instalar-bin.sh no lo copia`);
  // …y todo lo que copia existe en vendor/security-audit del plugin (si no, instalar-bin.sh solo avisa).
  for (const n of copiados) assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, 'vendor', 'security-audit', n)), `instalar-bin.sh copia ${n} y vendor/security-audit no lo trae`);
  // Ejecutables en el índice de git (los que ya están rastreados).
  const r = spawnSync('git', ['ls-files', '-s', '--', 'plugins/uaeh-harness/wsl'], { cwd: RAIZ_REPO, encoding: 'utf8' });
  if (r.status === 0) {
    for (const linea of r.stdout.split('\n').filter(Boolean)) {
      const [modo, , , ruta] = linea.split(/\s+/);
      if (/\/wsl\/(bin\/|pruebas\/|(des)?instalar(-bin)?\.sh$)/.test(ruta)) assert.equal(modo, '100755', `${ruta} no es ejecutable en git`);
    }
  }
});

test('wsl/ · sintaxis de bash (bash -n) de cada script', (t) => {
  for (const f of [...SCRIPTS_BASH, path.join(WSL, 'contenedor', 'armar.sh')]) {
    const r = bash(t, 'bash -n "$1"', [barra(f)]);
    if (!r) return;
    assert.equal(r.status, 0, `${rel(f)}: ${r.stderr}`);
  }
});

// ── validaciones (bloque «validar») ─────────────────────────────────────────────────────────────────────────
const CASOS_BASE = [
  ['/home/ana/runs', 'ana', true], ['/home/ana/.claude/uaeh/runs', 'ana', true], ['/mnt/c/x/runs', 'ana', true],
  ['/mnt/d/r', 'ana', true], ['/srv/uaeh/runs', 'ana', true], ['/mnt/c/datos/x.y/runs', 'ana', true],
  ['', 'ana', false], ['home/ana/runs', 'ana', false], ['/', 'ana', false], ['/mnt/c', 'ana', false],
  ['/home/ana', 'ana', false], ['/home', 'ana', false], ['/home/otro/runs', 'ana', false], ['/home/ana/runs', '', false],
  ['/tmp/a/b', 'ana', false], ['/etc/uaeh/runs', 'ana', false], ['/opt/uaeh/runs', 'ana', false], ['/root/a/b', 'ana', false],
  ['/mnt/c/x/', 'ana', false], ['/mnt//c/x', 'ana', false], ['/mnt/c/../x', 'ana', false], ['/mnt/c/./x', 'ana', false],
  ['/mnt/c/x/..', 'ana', false], ['/mnt/c/x y', 'ana', false], ['/mnt/c/acentó/x', 'ana', false], ['/mnt/c/x\n', 'ana', false],
  ['/mnt/c/$x/y', 'ana', false], ['/mnt/c/*/y', 'ana', false], ['/mnt/c/x\\y/z', 'ana', false],
];
const CASOS_USUARIO = [['ana', true], ['a_b-1', true], ['_x', true], ['root', false], ['Ana', false], ['1ana', false],
  ['', false], ['a b', false], ['a'.repeat(33), false], ['ana\n', false]];

test('bloque «validar» (bash) · base_valida: solo /mnt, /srv o /home/<usuario>, 3 niveles o más, sin . .. // ni / final', (t) => {
  // Una línea por caso: «OK» o «NO <largo del motivo>» (el motivo cita la ruta, que puede traer un salto de línea).
  const r = bash(t, '. "$1"; while IFS= read -r -d "" b && IFS= read -r -d "" u; do if base_valida "$b" "$u"; then echo OK; else echo "NO ${#MOTIVO}"; fi; done',
    [barra(SANDBOX)], { input: CASOS_BASE.map(([b, u]) => `${b}\0${u}\0`).join('') });
  if (!r) return;
  assert.equal(r.status, 0, r.stderr);
  const lineas = r.stdout.trim().split('\n');
  assert.equal(lineas.length, CASOS_BASE.length, r.stdout);
  CASOS_BASE.forEach(([b, u, ok], i) => assert.equal(lineas[i].startsWith('OK'), ok, `base_valida(${JSON.stringify(b)}, ${u}) → ${lineas[i]}`));
  assert.ok(lineas.every((l) => l === 'OK' || /^NO [1-9]\d*$/.test(l)), 'todo rechazo trae su motivo');
});

test('bloque «validar» (bash) · usuario_valido: minúsculas, nunca root', (t) => {
  const r = bash(t, '. "$1"; while IFS= read -r -d "" u; do if usuario_valido "$u"; then echo OK; else echo NO; fi; done',
    [barra(SANDBOX)], { input: CASOS_USUARIO.map(([u]) => `${u}\0`).join('') });
  if (!r) return;
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), CASOS_USUARIO.map(([, ok]) => (ok ? 'OK' : 'NO')));
});

// ── configuración y rutas (bloque «conf») ───────────────────────────────────────────────────────────────────
function conf(nombre, contenido) { return barra(E.escribir(path.join('conf', nombre), contenido)); }

test('bloque «conf» (bash) · leer_conf: solo UAEH_BASE y UAEH_USER, revalidados; cualquier otra cosa es error 64', (t) => {
  const casos = [
    ['valida', '# comentario\n\nUAEH_BASE=/home/ana/runs\nUAEH_USER=ana\n', 0, '/home/ana/runs|ana'],
    ['sin-salto-final', 'UAEH_USER=ana\nUAEH_BASE=/mnt/c/x/runs', 0, '/mnt/c/x/runs|ana'],
    ['clave-desconocida', 'UAEH_BASE=/home/ana/runs\nUAEH_USER=ana\nUAEH_EXTRA=1\n', 64, 'línea desconocida'],
    ['base-mala', 'UAEH_BASE=/home/otro/runs\nUAEH_USER=ana\n', 64, 'UAEH_BASE'],
    ['base-amplia', 'UAEH_BASE=/mnt/c\nUAEH_USER=ana\n', 64, 'UAEH_BASE'],
    ['usuario-root', 'UAEH_BASE=/srv/a/b\nUAEH_USER=root\n', 64, 'UAEH_USER'],
    ['sin-usuario', 'UAEH_BASE=/srv/a/b\n', 64, 'UAEH_USER'],
    ['crlf', 'UAEH_BASE=/home/ana/runs\r\nUAEH_USER=ana\r\n', 64, 'UAEH_'],
    ['con-espacio', ' UAEH_BASE=/home/ana/runs\nUAEH_USER=ana\n', 64, 'línea desconocida'],
  ];
  for (const [nombre, contenido, codigo, esperado] of casos) {
    const r = bash(t, '. "$1"; leer_conf "$2"; printf "%s|%s\\n" "$BASE" "$USUARIO"', [barra(SANDBOX), conf(`${nombre}.conf`, contenido)]);
    if (!r) return;
    assert.equal(r.status, codigo, `${nombre}: ${r.stdout}${r.stderr}`);
    assert.ok((codigo === 0 ? r.stdout : r.stderr).includes(esperado), `${nombre}: ${r.stdout}${r.stderr}`);
  }
  const falta = bash(t, '. "$1"; leer_conf "$2"', [barra(SANDBOX), barra(path.join(E.dir, 'no-existe.conf'))]);
  assert.equal(falta.status, 64);
});

test('bloque «conf» (bash) · conf_segura: un uaeh.conf que no es de root, es escribible por otros o falta → error 64', (t) => {
  const f = conf('abierta.conf', 'UAEH_BASE=/home/ana/runs\nUAEH_USER=ana\n');
  try { fs.chmodSync(f, 0o666); } catch { /* en Windows el modo no aplica: igual no es de root */ }
  const r = bash(t, '. "$1"; conf_segura "$2"; echo PASO', [barra(SANDBOX), f]);
  if (!r) return;
  assert.equal(r.status, 64, r.stdout + r.stderr);
  assert.match(r.stderr, /debe ser de root|escribible/);
  const falta = bash(t, '. "$1"; conf_segura "$2"', [barra(SANDBOX), barra(path.join(E.dir, 'no-existe.conf'))]);
  assert.equal(falta.status, 64);
  assert.match(falta.stderr, /instalar-bin\.sh/);
  if (POSIX) {
    fs.symlinkSync(f, path.join(E.dir, 'conf', 'enlace.conf'));
    const enlace = bash(t, '. "$1"; conf_segura "$2"', [barra(SANDBOX), barra(path.join(E.dir, 'conf', 'enlace.conf'))]);
    assert.equal(enlace.status, 64, 'un uaeh.conf que es enlace se rechaza');
  }
});

test('bloque «conf» (bash) · ids_usuario: uid/gid reales del usuario de uaeh.conf; root o un usuario que no existe → error 64', (t) => {
  // Los contenedores corrían con uid 1000 fijo: en un Linux donde el usuario tiene otro uid, /scratch no se dejaba escribir.
  const yo = bash(t, 'U=$(id -un); printf "%s:%s\\n" "$(id -u)" "$(id -g)"; . "$1"; USUARIO=$U; ids_usuario; printf "%s:%s\\n" "$UID_U" "$GID_U"', [barra(SANDBOX)]);
  if (!yo) return;
  const [esperado, obtenido] = yo.stdout.trim().split('\n');
  if (/^0:|:0$/.test(esperado)) {
    assert.equal(yo.status, 64, 'quien corre la batería es root: ids_usuario tiene que negarse');
  } else {
    assert.equal(yo.status, 0, yo.stderr);
    assert.equal(obtenido, esperado, 'UID_U:GID_U son los del usuario, no un número fijo');
  }
  for (const u of ['root', 'no-existe-uaeh']) {
    const r = bash(t, '. "$1"; USUARIO="$2"; ids_usuario; echo PASO', [barra(SANDBOX), u]);
    assert.equal(r.status, 64, `${u}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /nunca corren como root|no existe/, u);
    assert.doesNotMatch(r.stdout, /PASO/, u);
  }
  // Ningún programa de la capa 3 vuelve a fijar el uid de los contenedores del agente.
  assert.doesNotMatch(fs.readFileSync(SANDBOX, 'utf8'), /--user 1000|uid=1000/, 'uaeh-sandbox con uid fijo');
  assert.match(fs.readFileSync(VALIDAR, 'utf8'), /COMUNES\+=\(--user "\$UID_U:\$GID_U"\)/, 'uaeh-validar valida el run con la identidad de uaeh.conf');
});

test('bloque «conf» (bash) · normaliza_run compara la base LITERAL: un «.» de la base no acepta otra letra', (t) => {
  const raiz = path.join(E.dir, 'runs');
  for (const d of ['a.b/repo/run-1', 'aXb/repo/run-1', 'a.bx/repo/run-1', 'a.b/repo/run-x']) fs.mkdirSync(path.join(raiz, d), { recursive: true });
  const casos = [
    ['a.b/repo/run-1', 0], ['a.b/repo/run-1/', 0],
    ['aXb/repo/run-1', 64], // con la base como regex, «a.b» aceptaba «aXb»
    ['a.bx/repo/run-1', 64], ['a.b/../a.b/repo/run-1', 64], ['a.b/../run-1', 64], ['a.b/repo/run-x', 64],
    ['a.b/repo/run-2', 64], ['a.b/repo/sub/run-1', 64], ['a.b/run-1', 64],
  ];
  if (POSIX) {
    fs.symlinkSync(path.join(raiz, 'a.b', 'repo'), path.join(raiz, 'a.b', 'enlace'));
    casos.push(['a.b/enlace/run-1', 64]);
  }
  for (const [sufijo, codigo] of casos) {
    const r = bash(t, '. "$1"; T=$(cd "$2" && pwd -P); BASE="$T/a.b"; normaliza_run "$T/$3"', [barra(SANDBOX), barra(raiz), sufijo]);
    if (!r) return;
    assert.equal(r.status, codigo, `${sufijo}: ${r.stdout}${r.stderr}`);
    if (codigo === 0) assert.match(r.stdout, /\/a\.b\/repo\/run-1$/);
  }
  const win = bash(t, '. "$1"; BASE=/mnt/c/x/runs; normaliza_run "C:/otra/repo/run-1"', [barra(SANDBOX)]);
  assert.equal(win.status, 64, 'una ruta de Windows fuera de la base se rechaza (con o sin wslpath)');
});

// ── uaeh-promover (Python; solo POSIX: usa O_NOFOLLOW) ──────────────────────────────────────────────────────
const PY_DRIVER = `
import importlib.machinery, importlib.util, json, os, sys
sys.dont_write_bytecode = True
cargador = importlib.machinery.SourceFileLoader("uaeh_promover", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("uaeh_promover", cargador))
cargador.exec_module(m)
c = json.load(sys.stdin)
def intenta(f, *a):
    try:
        return {"ok": f(*a)}
    except m.Invalido as e:
        return {"invalido": str(e)}
out = {"base": [m.base_valida(b, u) for b, u in c["base"]], "usuario": [m.usuario_valido(u) for u in c["usuario"]],
       "run": [intenta(m.normaliza_run, v, b) for v, b in c["run"]],
       "conf": [intenta(m.leer_conf, r, False) for r in c["conf"]], "conf_root": [intenta(m.leer_conf, r, True) for r in c["conf_root"]]}
prueba = []
for valor, usuario in c["prueba"]:
    os.environ["UAEH_PROMOVER_BASE_PRUEBA"] = valor
    prueba.append(intenta(m.base_permitida, {"base": "/srv/uaeh/runs", "usuario": usuario}))
os.environ.pop("UAEH_PROMOVER_BASE_PRUEBA", None)
prueba.append(intenta(m.base_permitida, {"base": "/srv/uaeh/runs", "usuario": "ana"}))
out["prueba"] = prueba
print(json.dumps(out))
`;

if (POSIX) {
  test('uaeh-promover (Python) · mismas reglas que bash para base y usuario; base literal; conf de root; base de prueba acotada', (t) => {
    if (!requiereHerramienta(t, 'python3')) return;
    const valida = conf('promover-valida.conf', 'UAEH_BASE=/home/ana/runs\nUAEH_USER=ana\n');
    const casos = {
      base: CASOS_BASE.map(([b, u]) => [b, u]),
      usuario: CASOS_USUARIO.map(([u]) => u),
      run: [['/srv/a.b/repo/run-1', '/srv/a.b'], ['/srv/aXb/repo/run-1', '/srv/a.b'], ['/srv/a.bx/repo/run-1', '/srv/a.b'],
        ['/srv/a.b/repo/run-1\n', '/srv/a.b'], ['/srv/a.b/../repo/run-1', '/srv/a.b'], ['/srv/a.b/repo/run-1/', '/srv/a.b'],
        ['C:/otra/repo/run-1', '/srv/a.b']],
      conf: [valida, conf('promover-extra.conf', 'UAEH_BASE=/home/ana/runs\nUAEH_USER=ana\nOTRA=1\n'),
        conf('promover-root.conf', 'UAEH_BASE=/srv/a/b\nUAEH_USER=root\n'), path.join(E.dir, 'no-existe.conf')],
      conf_root: [valida],
      prueba: [['/tmp/uaeh-prueba-123', 'ana'], ['/home/ana/uaeh-prueba-x', 'ana'], ['/home/otro/uaeh-prueba-x', 'ana'],
        ['/tmp/uaeh-prueba-x/..', 'ana'], ['/tmp/uaeh-prueba-x\n', 'ana'], ['/tmp/otra', 'ana']],
    };
    const r = spawnSync('python3', ['-B', '-I', '-c', PY_DRIVER, PROMOVER], { encoding: 'utf8', input: JSON.stringify(casos), env: E.env, timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.base, CASOS_BASE.map(([, , ok]) => ok), 'base_valida de Python ≠ veredictos esperados (los mismos que bash)');
    assert.deepEqual(o.usuario, CASOS_USUARIO.map(([, ok]) => ok));
    assert.deepEqual(o.run.map((x) => 'ok' in x), [true, false, false, false, false, true, false], JSON.stringify(o.run));
    assert.deepEqual(o.conf[0], { ok: { base: '/home/ana/runs', usuario: 'ana' } });
    assert.ok(o.conf.slice(1).every((x) => 'invalido' in x), JSON.stringify(o.conf));
    if (process.getuid() !== 0) assert.ok('invalido' in o.conf_root[0], 'un uaeh.conf que no es de root se rechaza');
    assert.deepEqual(o.prueba.map((x) => x.ok || 'NO'), ['/tmp/uaeh-prueba-123', '/home/ana/uaeh-prueba-x', 'NO', 'NO', 'NO', 'NO', '/srv/uaeh/runs']);
  });
}

// ── instalar-bin.sh --comprobar ─────────────────────────────────────────────────────────────────────────────
test('instalar-bin.sh --comprobar · valida UAEH_BASE y UAEH_USER y muestra el uaeh.conf que escribiría (sin root, sin escribir)', (t) => {
  const correr = (env, args = ['--comprobar']) => bash(t, 'bash "$@"', [barra(INSTALAR_BIN), ...args], { env: { UAEH_USER: undefined, UAEH_BASE: undefined, ...env } });
  const ok = correr({ UAEH_BASE: '/home/ana/runs', UAEH_USER: 'ana' });
  if (!ok) return;
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^UAEH_BASE=\/home\/ana\/runs$/m);
  assert.match(ok.stdout, /^UAEH_USER=ana$/m);
  assert.match(ok.stdout, /COMPROBAR_OK\s*$/);
  assert.match(ok.stdout, /uaeh-sandbox/);
  const sudo = correr({ UAEH_BASE: '/home/beto/r', SUDO_USER: 'beto' });
  assert.equal(sudo.status, 0, sudo.stderr);
  assert.match(sudo.stdout, /^UAEH_USER=beto$/m, 'sin UAEH_USER, el usuario sale de SUDO_USER');
  for (const [env, motivo] of [
    [{ UAEH_BASE: '/home/otro/runs', UAEH_USER: 'ana' }, /propio usuario/],
    [{ UAEH_BASE: '/mnt/c', UAEH_USER: 'ana' }, /demasiado amplia/],
    [{ UAEH_BASE: '/tmp/x/y', UAEH_USER: 'ana' }, /\/mnt, \/home/],
    [{ UAEH_BASE: '/mnt/c/x/../y', UAEH_USER: 'ana' }, /«\.»/],
    [{ UAEH_BASE: '/mnt/c/x/runs', UAEH_USER: 'root' }, /root/],
    [{ UAEH_USER: 'ana' }, /falta UAEH_BASE/],
  ]) {
    const r = correr(env);
    assert.equal(r.status, 1, `${JSON.stringify(env)}: ${r.stdout}`);
    assert.match(r.stderr, motivo);
    assert.doesNotMatch(r.stdout, /COMPROBAR_OK/);
  }
  assert.equal(correr({ UAEH_BASE: '/home/ana/runs', UAEH_USER: 'ana' }, ['--otra']).status, 1);
  assert.equal(correr({}, ['--help']).status, 0);
  if (!POSIX || process.getuid() !== 0) {
    const sinRoot = correr({ UAEH_BASE: '/home/ana/runs', UAEH_USER: 'ana' }, []);
    assert.equal(sinRoot.status, 1);
    assert.match(sinRoot.stderr, /correr como root/);
  }
});

// ── instalar.sh --comprobar (lee los pines con Python: solo POSIX) ──────────────────────────────────────────
if (POSIX) {
  test('instalar.sh --comprobar · lee los pines de herramientas.json y rechaza pines mal formados sin instalar nada', (t) => {
    if (!requiereHerramienta(t, 'python3')) return;
    const p = JSON.parse(fs.readFileSync(PINS, 'utf8'));
    const correr = (args, env = {}) => bash(t, 'bash "$@"', [barra(INSTALAR), ...args], { env: { UAEH_USER: 'ana', ...env } });
    const r = correr(['--comprobar']);
    if (!r) return;
    assert.match(r.stdout, /^OK {5}pines de /m, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`docker ${p.docker.version} · gitleaks ${p.gitleaks.version} · osv-scanner ${p['osv-scanner'].version} · semgrep ${p.semgrep.version}`), r.stdout);
    assert.ok(r.stdout.includes(`reglas de semgrep: ${p.semgrep.paquetes.join(' ')}`));
    for (const [k, img] of Object.entries(p.imagenes)) assert.ok(r.stdout.includes(`imagen ${k} · ${img.etiqueta} · ${img.digest}`), k);
    assert.match(r.stdout, /COMPROBAR_(OK|FALLA \d+)\s*$/);

    const malos = {
      'sha-corta': (x) => { x.gitleaks.sha256 = 'abc'; },
      'archivo-de-otra-version': (x) => { x.gitleaks.archivo = 'gitleaks_1.0.0_linux_x64.tar.gz'; },
      'sin-postgres': (x) => { delete x.imagenes.postgres; },
      'digest-con-etiqueta': (x) => { x.imagenes.node.digest = 'latest'; },
      'esquema-2': (x) => { x.esquema = 2; },
      'paquete-raro': (x) => { x.semgrep.paquetes.push('../x'); },
      'arquitectura-arm': (x) => { x.plataforma.arquitectura = 'aarch64'; },
    };
    for (const [nombre, romper] of Object.entries(malos)) {
      const x = JSON.parse(JSON.stringify(p)); romper(x);
      const archivo = E.escribir(`pines-${nombre}.json`, JSON.stringify(x));
      const m = correr(['--comprobar', '--pins', barra(archivo)]);
      assert.equal(m.status, 1, `${nombre}: ${m.stdout}`);
      assert.match(m.stderr, /pines:/, `${nombre}: ${m.stderr}`);
      assert.doesNotMatch(m.stdout, /pines de/, nombre);
    }
    const roto = correr(['--comprobar', '--pins', barra(E.escribir('pines-roto.json', '{ no es json'))]);
    assert.equal(roto.status, 1);
    const root = correr(['--comprobar'], { UAEH_USER: 'root' });
    assert.equal(root.status, 1);
    assert.match(root.stdout, /^FALLA +UAEH_USER: el usuario no puede ser root/m);
    // --pins nunca se acepta al instalar (se usan los pines del plugin): falla ANTES de tocar nada.
    const instalarConPins = correr(['--pins', barra(PINS)]);
    assert.equal(instalarConPins.status, 1);
    assert.match(instalarConPins.stderr, /--pins solo vale con --comprobar/);
    assert.equal(correr(['--otra']).status, 1);
  });

  test('instalar.sh · contar_reglas acepta los dos formatos del registro de semgrep (YAML y JSON) y rechaza paquetes vacíos', (t) => {
    if (!requiereHerramienta(t, 'python3')) return;
    // Medido el 3-nov-2026: p/react llegó en JSON y p/nextjs como «rules: []»; la comprobación vieja (^rules:) fallaba con
    // el primero y aceptaba el segundo.
    const casos = [
      ['yaml', 'rules:\n- id: a.b\n  pattern: x\n- id: c.d\n  pattern: y\n', 2],
      ['json', '{"rules":[{"id":".audit.x","pattern":"y"}]}', 1],
      ['yaml-vacio', 'rules: []\n', 0],
      ['json-vacio', '{"rules": []}', 0],
      ['html', '<html><body>Not found</body></html>', 0],
      ['vacio', '', 0],
      ['json-roto', '{"rules": [', 0],
    ];
    for (const [nombre, contenido, n] of casos) {
      const f = barra(E.escribir(path.join('reglas', `${nombre}.yml`), contenido));
      const r = bash(t, '. "$1"; contar_reglas "$2"', [barra(INSTALAR), f]);
      if (!r) return;
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), String(n), nombre);
    }
  });

  test('instalar.sh · semgrep_propio: solo es de UAEH lo que falta o el enlace hacia /opt/pipx/venvs/semgrep/', (t) => {
    // Lo demás (un binario suelto, un enlace a otro sitio) es de otra instalación y pipx --force lo pisaría sin avisar.
    const d = path.join(E.dir, 'semgrep-propio');
    fs.mkdirSync(d, { recursive: true });
    const casos = [
      ['falta', null, 0],
      ['enlace-uaeh', '/opt/pipx/venvs/semgrep/bin/semgrep', 0],
      ['enlace-otro', '/usr/bin/semgrep', 1],
      ['enlace-prefijo-parecido', '/opt/pipx/venvs/semgrep-otro/bin/semgrep', 1],
      ['enlace-relativo', '../venvs/semgrep/bin/semgrep', 1],
      ['archivo', 'ARCHIVO', 1],
    ];
    for (const [nombre, destino] of casos) {
      const f = path.join(d, nombre);
      if (destino === 'ARCHIVO') fs.writeFileSync(f, '#!/bin/sh\necho 0.0.1\n', { mode: 0o755 });
      else if (destino) fs.symlinkSync(destino, f);
    }
    const script = '. "$1"; shift; for f in "$@"; do if semgrep_propio "$f"; then echo "0 ${f##*/}"; else echo "1 ${f##*/}"; fi; done';
    const r = bash(t, script, [barra(INSTALAR), ...casos.map(([n]) => barra(path.join(d, n)))]);
    if (!r) return;
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), casos.map(([n, , c]) => `${c} ${n}`));
  });
}

// ── desinstalar.sh ──────────────────────────────────────────────────────────────────────────────────────────
test('desinstalar.sh · cargado con source solo define funciones: no imprime ni quita nada', (t) => {
  const r = bash(t, '. "$1"; declare -F principal ruta_permitida quitar >/dev/null && echo FUNCIONES_OK', [barra(DESINSTALAR)]);
  if (!r) return;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'FUNCIONES_OK');
});

test('desinstalar.sh · ruta_permitida: lista cerrada (nunca vacía, raíz, /opt a secas, «..» ni binarios ajenos)', (t) => {
  const buenas = ['/opt/uaeh', '/opt/pipx', '/opt/pipx/venvs/semgrep', '/usr/local/bin/gitleaks', '/usr/local/bin/uaeh-sandbox',
    '/usr/local/share/man/man1/semgrep.1'];
  const malas = ['/', '/opt', '/opt/', '/opt/uaeh/', '/opt/uaeh/bin', '/opt/otro', '/usr/local/bin', '/usr/local/bin/..', '/usr/local/bin/a/b',
    '/usr/local/bin/../../etc', '/usr/local/share/man/../x', '/etc/passwd', '/home/ana', 'opt/uaeh', '/usr/local/bin/a b'];
  const script = '. "$1"; shift; for r in "$@"; do if ruta_permitida "$r"; then echo "SI $r"; else echo "NO $r"; fi; done; if ruta_permitida ""; then echo "SI vacia"; else echo "NO vacia"; fi';
  const r = bash(t, script, [barra(DESINSTALAR), ...buenas, ...malas]);
  if (!r) return;
  assert.equal(r.status, 0, r.stderr);
  const lineas = r.stdout.split('\n').filter(Boolean);
  assert.deepEqual(lineas, [...buenas.map((x) => 'SI ' + x), ...malas.map((x) => 'NO ' + x), 'NO vacia']);
});

test('desinstalar.sh · quitar no pasa de la lista: una ruta no permitida no se toca y cuenta como falla', (t) => {
  const r = bash(t, '. "$1"; APLICAR=1; quitar "/etc" prueba dir; echo "FALLAS=$FALLAS QUITAR=$QUITAR"; quitar "" prueba dir; echo "FALLAS=$FALLAS"', [barra(DESINSTALAR)]);
  if (!r) return;
  assert.match(r.stdout, /FALLA {2}ruta no permitida «\/etc»/);
  assert.match(r.stdout, /FALLAS=1 QUITAR=0/);
  assert.match(r.stdout, /FALLAS=2\s*$/);
});

test('desinstalar.sh · por defecto es en seco, sin root y sin escribir; opciones desconocidas fallan; --aplicar exige root', (t) => {
  const correr = (...args) => bash(t, 'bash "$@"', [barra(DESINSTALAR), ...args]);
  const lista = () => (fs.existsSync('/opt/uaeh') ? fs.readdirSync('/opt/uaeh').join(',') : null);
  const antes = POSIX ? lista() : null;
  const seco = correr('--con-escaneres', '--con-imagenes');
  if (!seco) return;
  assert.equal(seco.status, 0, seco.stderr);
  assert.match(seco.stdout, /^MODO: EN SECO/m);
  assert.doesNotMatch(seco.stdout, /^QUITO /m);
  assert.match(seco.stdout, /^(NADA_QUE_QUITAR|EN_SECO: \d+ cosa)/m);
  if (POSIX) assert.equal(lista(), antes, 'en seco no cambia /opt/uaeh');
  for (const mala of [['--otra'], ['--aplicar', '--forzar'], ['aplicar'], ['']]) {
    const r = correr(...mala);
    assert.equal(r.status, 1, JSON.stringify(mala));
    assert.match(r.stderr, /argumento desconocido/);
  }
  assert.equal(correr('--help').status, 0);
  if (!POSIX || process.getuid() !== 0) {
    const sinRoot = correr('--aplicar');
    assert.equal(sinRoot.status, 1);
    assert.match(sinRoot.stderr, /necesita root/);
    assert.doesNotMatch(sinRoot.stdout, /QUITO/);
  }
});

test('desinstalar.sh · se niega si /opt/uaeh es un enlace simbólico y solo quitar() borra, con la ruta ya validada', (t) => {
  const texto = fs.readFileSync(DESINSTALAR, 'utf8');
  const rm = texto.split('\n').filter((l) => /\brm -/.test(l) && !/^\s*(#|informe )/.test(l));
  assert.ok(rm.length > 0);
  for (const l of rm) assert.match(l, /rm -rf --one-file-system -- "\$r"|rm -f -- "\$r"/, 'rm fuera de quitar(): ' + l.trim());
  if (!POSIX) return;
  const script = 'dir=$(mktemp -d); mkdir "$dir/real"; ln -s "$dir/real" "$dir/enlace"; . "$1"; OPT="$dir/enlace"; rc=0; (verificar_opt) 2>&1 || rc=$?; echo "rc=$rc"; rm -rf "$dir"';
  const r = bash(t, script, [barra(DESINSTALAR)]);
  if (!r) return;
  assert.match(r.stdout, /enlace simbólico/);
  assert.match(r.stdout, /rc=1/);
});
