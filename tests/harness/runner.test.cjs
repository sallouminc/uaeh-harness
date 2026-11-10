// Pruebas de plugins/uaeh-harness/scripts/lib/runner.cjs: plataforma, rutas /mnt, argv para Linux/WSL y ejecución con tope.
// Nada aquí requiere WSL ni Docker: lo que depende del motor solo se prueba en su forma (argv) y en su contrato de retorno.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, RAIZ_HARNESS } = require('../helpers/entorno.cjs');

const runner = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'runner.cjs'));
const CFG = { wsl: { distro: 'Ubuntu-24.04', usuario: 'ana' } };

test('plataforma: win32 → wsl, linux → linux, lo demás no soportado', () => {
  assert.deepEqual(runner.plataforma('win32'), { so: 'win32', modo: 'wsl' });
  assert.deepEqual(runner.plataforma('linux'), { so: 'linux', modo: 'linux' });
  assert.deepEqual(runner.plataforma('darwin'), { so: 'darwin', modo: 'no-soportado' });
  assert.ok(['wsl', 'linux', 'no-soportado'].includes(runner.plataforma().modo));
});

test('aRutaMotor: unidad de Windows a /mnt/<letra>; POSIX identidad', () => {
  assert.equal(runner.aRutaMotor('C:\\proyectos\\ana\\repo', 'win32'), '/mnt/c/proyectos/ana/repo');
  assert.equal(runner.aRutaMotor('d:/datos/x/', 'win32'), '/mnt/d/datos/x');
  assert.equal(runner.aRutaMotor('E:\\', 'win32'), '/mnt/e');
  assert.equal(runner.aRutaMotor('/home/ana/repo', 'linux'), '/home/ana/repo');
});

test('deRutaMotor: /mnt/<letra> a unidad de Windows; otras rutas tal cual', () => {
  assert.equal(runner.deRutaMotor('/mnt/c/proyectos/ana', 'win32'), 'C:\\proyectos\\ana');
  assert.equal(runner.deRutaMotor('/mnt/d', 'win32'), 'D:\\');
  assert.equal(runner.deRutaMotor('/opt/uaeh', 'win32'), '/opt/uaeh');
  assert.equal(runner.deRutaMotor('/mnt/c/x', 'linux'), '/mnt/c/x');
});

test('prefijoMotor y prefijoCaja: wsl.exe con distro y usuario (nunca root) en Windows; nada en Linux', () => {
  assert.deepEqual(runner.prefijoMotor(CFG, 'win32'), ['wsl.exe', '-d', 'Ubuntu-24.04', '-u', 'ana', '-e']);
  assert.deepEqual(runner.prefijoMotor({ wsl: { distro: 'Debian', usuario: 'root' } }, 'win32'), ['wsl.exe', '-d', 'Debian', '-e']);
  assert.deepEqual(runner.prefijoMotor({ wsl: { distro: 'Debian', usuario: '' } }, 'win32'), ['wsl.exe', '-d', 'Debian', '-e']);
  assert.deepEqual(runner.prefijoMotor(CFG, 'linux'), []);
  assert.deepEqual(runner.prefijoCaja(CFG, 'linux'), ['/opt/uaeh/bin/uaeh-sandbox', 'ejecutar']);
  assert.deepEqual(runner.prefijoCaja(CFG, 'win32'), ['wsl.exe', '-d', 'Ubuntu-24.04', '-u', 'ana', '-e', '/opt/uaeh/bin/uaeh-sandbox', 'ejecutar']);
});

test('argumentosLinux arma el argv con timeout -k, env y cwd (Windows: --cd con ruta /mnt)', () => {
  const w = runner.argumentosLinux(['gitleaks', 'detect', '--no-git'], { segundos: 90, env: { UAEH_RUN: 'r1', VACIA: null }, cwd: 'C:\\repo\\x' }, CFG, 'win32');
  assert.equal(w.programa, 'wsl.exe');
  assert.deepEqual(w.args, ['-d', 'Ubuntu-24.04', '-u', 'ana', '--cd', '/mnt/c/repo/x', '-e', '/usr/bin/timeout', '-k', '10', '90', '/usr/bin/env', 'UAEH_RUN=r1', 'VACIA=', 'gitleaks', 'detect', '--no-git']);
  const l = runner.argumentosLinux(['ls'], {}, CFG, 'linux');
  assert.equal(l.programa, '/usr/bin/timeout');
  assert.deepEqual(l.args, ['-k', '10', '60', 'ls']);
  const sinUsuario = runner.argumentosLinux(['ls'], { segundos: 2.2 }, { wsl: { distro: 'Debian', usuario: '' } }, 'win32');
  assert.deepEqual(sinUsuario.args, ['-d', 'Debian', '-e', '/usr/bin/timeout', '-k', '10', '3', 'ls']);
  assert.throws(() => runner.argumentosLinux([], {}, CFG, 'linux'), /lista no vacía/);
  assert.throws(() => runner.argumentosLinux(['ls'], { env: { 'MAL NOMBRE': '1' } }, CFG, 'linux'), /variable inválido/);
});

test('ejecutar: sin shell, con stdin, código de salida y tope de tiempo (agotado)', () => {
  const ok = runner.ejecutar(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write("eco:" + d)); process.stdin.on("end", () => process.exit(3))'], { segundos: 10, input: 'hola "con comillas" $HOME' });
  assert.equal(ok.codigo, 3);
  assert.equal(ok.stdout, 'eco:hola "con comillas" $HOME');
  assert.equal(ok.agotado, false);
  assert.equal(ok.error, null);
  const lento = runner.ejecutar(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { segundos: 1, margenSegundos: 0 });
  assert.equal(lento.agotado, true);
  assert.notEqual(lento.codigo, 0);
  const inexistente = runner.ejecutar('programa-que-no-existe-uaeh', [], { segundos: 5 });
  assert.equal(inexistente.codigo, -1);
  assert.ok(inexistente.error);
});

test('ejecutarEnLinux no lanza en una plataforma no soportada y mantiene la forma de retorno', () => {
  const r = runner.ejecutarEnLinux(['true'], { segundos: 1 });
  for (const k of ['codigo', 'stdout', 'stderr', 'agotado', 'error']) assert.ok(k in r, `falta ${k}`);
  if (runner.plataforma().modo === 'no-soportado') assert.equal(r.error, 'no-soportado');
});

test('motorListo devuelve { listo, detalle } sin lanzar', () => {
  const r = runner.motorListo({ wsl: { distro: 'distro-inexistente-uaeh', usuario: '' } });
  assert.equal(typeof r.listo, 'boolean');
  assert.equal(typeof r.detalle, 'string');
  if (process.platform === 'win32') assert.equal(r.listo, false); // esa distro no existe
});

test('resolverGestor por archivo de bloqueo', () => {
  const e = entornoTemporal('uaeh-runner-');
  try {
    assert.equal(runner.resolverGestor(e.proyecto), 'npm');
    fs.writeFileSync(path.join(e.proyecto, 'yarn.lock'), '');
    assert.equal(runner.resolverGestor(e.proyecto), 'yarn');
    fs.writeFileSync(path.join(e.proyecto, 'pnpm-lock.yaml'), '');
    assert.equal(runner.resolverGestor(e.proyecto), 'pnpm');
    fs.unlinkSync(path.join(e.proyecto, 'pnpm-lock.yaml')); fs.unlinkSync(path.join(e.proyecto, 'yarn.lock'));
    fs.writeFileSync(path.join(e.proyecto, 'bun.lock'), '');
    assert.equal(runner.resolverGestor(e.proyecto), 'bun');
  } finally { e.limpiar(); }
});

test('comandoPython devuelve un nombre de programa o null, sin lanzar', () => {
  const p = runner.comandoPython();
  assert.ok(p === null || ['python3', 'python', 'py'].includes(p));
});

test('matarArbol rechaza pids inválidos y mata un hijo real', () => {
  assert.equal(runner.matarArbol(0), false);
  assert.equal(runner.matarArbol('x'), false);
  const { spawn } = require('child_process');
  const hijo = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  const vivo = () => { try { process.kill(hijo.pid, 0); return true; } catch { return false; } };
  assert.equal(vivo(), true);
  assert.equal(runner.matarArbol(hijo.pid), true);
  return new Promise((resolver) => hijo.on('exit', () => resolver()));
});
