// Pruebas de plugins/uaeh-harness/skills/uae-security/scripts/pasada-determinista.cjs que NO necesitan los escáneres.
//
// · Utilidades puras: rutas del motor, relativizar, argumentos, paquetes de semgrep, estado global, hora local.
// · El gestor de npm se resuelve y responde con el Node que corre la prueba (Windows y Linux).
// · Corrida completa SIN motor de Linux (Windows: una distro que no existe; Linux sin los escáneres instalados): las
//   herramientas de Linux quedan NO_INSTALADA, el estado global es UNKNOWN (código 3) y lo demás corre de verdad
//   (copia limpia, cyber-neo vendorizado con Python, sin secretos en ninguna salida). Requiere Python 3 (CI lo tiene).
// La corrida con gitleaks, semgrep y osv-scanner reales está en tests/integracion/ (node tools/correr-pruebas.cjs --solo integracion).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal, git } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_HARNESS, 'skills', 'uae-security', 'scripts', 'pasada-determinista.cjs');
const P = require(SCRIPT);
const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
const runner = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'runner.cjs'));

const E = entornoTemporal('uaeh-pasada-');
process.on('exit', () => E.limpiar());

test('rutaMotor · Windows: unidad con letra → /mnt/<letra>/…; rechaza UNC y caracteres de control', () => {
  assert.equal(P.rutaMotor('C:\\a\\b', 'win32'), '/mnt/c/a/b');
  assert.equal(P.rutaMotor('D:\\', 'win32'), '/mnt/d');
  assert.equal(P.rutaMotor('c:/x/y z/', 'win32'), '/mnt/c/x/y z');
  assert.equal(P.rutaMotor('C:\\proyectos\\Mi App\\proyecto-ejemplo', 'win32'), '/mnt/c/proyectos/Mi App/proyecto-ejemplo');
  assert.throws(() => P.rutaMotor('\\\\servidor\\recurso\\x', 'win32'), /solo unidades con letra/);
  assert.throws(() => P.rutaMotor('C:\\a\nb', 'win32'), /control/);
});

test('rutaMotor · Linux: la ruta no cambia (pero tampoco acepta caracteres de control)', () => {
  assert.equal(P.rutaMotor('/home/ana/run-1/fuente', 'linux'), '/home/ana/run-1/fuente');
  assert.throws(() => P.rutaMotor('/tmp/a\0b', 'linux'), /control/);
});

test('relativizar · quita la raíz sin importar mayúsculas ni barras', () => {
  assert.equal(P.relativizar('C:\\Run\\Fuente\\src\\a.js', ['c:/run/fuente']), 'src/a.js');
  assert.equal(P.relativizar('/mnt/c/run/fuente/a.js', ['/mnt/c/run/fuente']), 'a.js');
  assert.equal(P.relativizar('/otra/parte/a.js', ['/mnt/c/run/fuente']), '/otra/parte/a.js');
});

test('parsearArgs · dos posicionales y --base validado', () => {
  assert.equal(P.parsearArgs(['r', 'o', '--base', 'abc123']).base, 'abc123');
  assert.equal(P.parsearArgs(['r', 'o', '--base=main']).base, 'main');
  assert.equal(P.parsearArgs(['r', 'o']).base, null);
  assert.throws(() => P.parsearArgs(['r', 'o', '--base', '--evil']));
  assert.throws(() => P.parsearArgs(['r', 'o', '--base']));
  assert.throws(() => P.parsearArgs(['r']));
  assert.throws(() => P.parsearArgs(['r', 'o', 'x']));
});

test('elegirPaquetes · reglas de semgrep según la tecnología', () => {
  const dir = path.join(E.dir, 'paquetes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  assert.deepEqual(P.elegirPaquetes(dir, ['package.json', 'src/a.tsx']), ['default', 'owasp-top-ten', 'secrets', 'javascript', 'nodejsscan', 'typescript', 'react']);
  assert.deepEqual(P.elegirPaquetes(dir, ['index.php', 'app/requirements.txt']), ['default', 'owasp-top-ten', 'secrets', 'php', 'python']);
  assert.deepEqual(P.elegirPaquetes(dir, ['README.md']), ['default', 'owasp-top-ten', 'secrets']);
});

test('estadoGlobal · FALLÓ o NO_INSTALADA → UNKNOWN; OMITIDA (no aplica) no lo baja', () => {
  assert.equal(P.estadoGlobal([{ estado: 'OK' }, { estado: 'OMITIDA' }]), 'OK');
  assert.equal(P.estadoGlobal([{ estado: 'OK' }, { estado: 'NO_INSTALADA' }]), 'UNKNOWN');
  assert.equal(P.estadoGlobal([{ estado: 'FALLÓ' }]), 'UNKNOWN');
  assert.equal(P.estadoGlobal([]), 'OK');
});

test('ahoraLocal · fecha ISO con desfase de la zona configurada', () => {
  const config = configLib.cargarConfig({ env: E.env }).config;
  const conZona = (tz) => {
    const antes = process.env.UAEH_TZ;
    process.env.UAEH_TZ = tz; // UAEH_TZ manda sobre la configuración (comun.zonaHoraria)
    try { return P.ahoraLocal({ config }); } finally { if (antes === undefined) delete process.env.UAEH_TZ; else process.env.UAEH_TZ = antes; }
  };
  assert.match(conZona('UTC'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]00:00)$/);
  assert.match(conZona('America/Bogota'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-05:00$/); // −05:00 todo el año
});

test('resolverNpm · encuentra el npm del Node actual y responde --version', () => {
  const g = P.resolverNpm();
  const r = P.correrGestor(g, ['--version'], E.dir, 60000);
  assert.equal(r.codigo, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('resolverNpm y resolverPnpm · en POSIX nunca usan cmd.exe', () => {
  const g = P.resolverNpm(path.join(E.dir, 'bin', 'node'), 'linux');
  assert.notEqual(g.cmd, 'cmd.exe');
  assert.equal(P.resolverPnpm(path.join(E.dir, 'sin-pnpm'), 'linux'), null);
  const bin = path.join(E.dir, 'bin-pnpm');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\n');
  assert.deepEqual(P.resolverPnpm(bin, 'linux'), { cmd: path.join(bin, 'pnpm'), pre: [], verbatim: false });
});

test('uso o entorno inválido · código 2 sin tocar nada', () => {
  const repo = path.join(E.dir, 'repo-uso');
  fs.mkdirSync(repo, { recursive: true });
  const correr = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: E.env, timeout: 60000 });
  let r = correr([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Uso: node pasada-determinista\.cjs/);
  r = correr([repo, path.join(E.dir, 'run-x')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No es un repo git/);
  git(repo, ['init', '-q'], E.env);
  r = correr([repo, path.join(repo, 'run-dentro')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no puede estar dentro del repo/);
  assert.equal(fs.existsSync(path.join(repo, 'run-dentro')), false);
});

function hayPython(t) {
  if (runner.comandoPython()) return true;
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error('prueba omitida en modo estricto: falta Python 3');
  t.skip('falta Python 3');
  return false;
}

test('sin motor de Linux · herramientas de Linux NO_INSTALADA → UNKNOWN (3); copia limpia y cyber-neo sí corren, sin filtrar secretos', (t) => {
  if (!hayPython(t)) return;
  const repo = path.join(E.dir, 'repo-juguete');
  fs.mkdirSync(repo, { recursive: true });
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const token = 'gh' + 'p_' + Array.from(crypto.randomBytes(36), (b) => abc[b % abc.length]).join('');
  fs.writeFileSync(path.join(repo, 'config.js'), `module.exports = { githubToken: '${token}' };\n`);
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log("hola");\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'CLAVE=ejemplo\n');
  fs.writeFileSync(path.join(repo, '.semgrepignore'), 'config.js\n');
  git(repo, ['init', '-q'], E.env);
  git(repo, ['add', '-A'], E.env);
  git(repo, ['commit', '-q', '-m', 'inicial'], E.env);
  fs.writeFileSync(path.join(repo, '.env'), 'CLAVE=privada-no-sale\n');

  // Windows: una distro que no existe deja el motor sin responder. Linux: sin los escáneres en /usr/local/bin quedan
  // NO_INSTALADA igual; si algún día están instalados, corren y la prueba sigue valiendo (exige solo invariantes).
  const env = { ...E.env, UAEH_WSL_DISTRO: 'uaeh-distro-inexistente', UAEH_TZ: 'UTC' };
  const run = path.join(E.dir, 'corridas', 'run-1');
  const r = spawnSync(process.execPath, [SCRIPT, repo, run], { encoding: 'utf8', env, timeout: 20 * 60 * 1000 });
  const salida = r.stdout + r.stderr;
  assert.ok([0, 3].includes(r.status), `código ${r.status}: ${salida}`);
  const j = JSON.parse(fs.readFileSync(path.join(run, 'deterministico.json'), 'utf8'));
  const herr = (n) => j.herramientas.find((h) => h.nombre === n);

  const sinInstalar = j.herramientas.filter((h) => h.estado === 'NO_INSTALADA');
  if (process.platform === 'win32') {
    assert.equal(j.motor.listo, false);
    for (const n of ['gitleaks-historial', 'gitleaks-dir', 'semgrep', 'osv-scanner']) {
      assert.equal(herr(n).estado, 'NO_INSTALADA', n);
      assert.match(herr(n).motivo, /motor de Linux no disponible/);
    }
  }
  if (sinInstalar.length) {
    assert.equal(j.estado_global, 'UNKNOWN', 'NO_INSTALADA nunca deja el estado en OK');
    assert.equal(r.status, 3);
    assert.match(salida, /ESTADO_GLOBAL UNKNOWN/);
  }
  assert.equal(j.historial_clon_borrado, true);
  assert.equal(fs.existsSync(path.join(run, 'historial.git')), false);
  assert.match(j.generado, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]00:00)$/);

  const f = path.join(run, 'fuente');
  assert.ok(fs.existsSync(path.join(f, 'config.js')) && fs.existsSync(path.join(f, '.env.example')));
  assert.ok(!fs.existsSync(path.join(f, '.env')), '.env no sale del repo');
  assert.ok(!fs.existsSync(path.join(f, '.semgrepignore')), 'la config de escáner del repo no se copia');
  assert.match(salida, /AVISO configs de escáner del repo ignoradas: 1/);

  const cn = herr('cyber-neo-secretos');
  assert.equal(cn.estado, 'OK', cn.motivo);
  assert.ok(cn.hallazgos.some((x) => x.archivo === 'config.js'), 'cyber-neo no halló el token en config.js');
  assert.equal(herr('npm audit').estado, 'OMITIDA');
  for (const archivo of fs.readdirSync(path.join(run, 'deterministico'))) {
    assert.ok(!fs.readFileSync(path.join(run, 'deterministico', archivo), 'utf8').includes(token), `${archivo} contiene el token`);
  }
  assert.ok(!fs.readFileSync(path.join(run, 'deterministico.json'), 'utf8').includes(token));
  assert.ok(!salida.includes(token) && !salida.includes('privada-no-sale'));
});

test('cyber-neo · si no revisa ningún archivo (ruta del run con una carpeta que salta) queda FALLÓ, no «sin hallazgos»', (t) => {
  if (!hayPython(t)) return;
  const repo = path.join(E.dir, 'repo-build');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.js'), 'console.log(1);\n');
  git(repo, ['init', '-q'], E.env);
  git(repo, ['add', '-A'], E.env);
  git(repo, ['commit', '-q', '-m', 'inicial'], E.env);
  const run = path.join(E.dir, 'build', 'run-1'); // «build» está en la lista de carpetas que cyber-neo salta
  const r = spawnSync(process.execPath, [SCRIPT, repo, run], { encoding: 'utf8', env: { ...E.env, UAEH_WSL_DISTRO: 'uaeh-distro-inexistente' }, timeout: 20 * 60 * 1000 });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const j = JSON.parse(fs.readFileSync(path.join(run, 'deterministico.json'), 'utf8'));
  const cn = j.herramientas.find((h) => h.nombre === 'cyber-neo-secretos');
  assert.equal(cn.estado, 'FALLÓ');
  assert.match(cn.motivo, /no revisó ningún archivo/);
  assert.equal(j.estado_global, 'UNKNOWN');
});
