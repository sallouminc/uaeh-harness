// Pruebas de plugins/uaeh-harness/scripts/uaeh-config.cjs — valores de la configuración para las skills (sin rutas fijas).
// Corren el CLI de verdad en una casa temporal; nunca leen la configuración real.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');

const CLI = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs');
const { nombreRepo, lineaPrefijo } = require(CLI);
const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));

function conCasa(fn) {
  const e = entornoTemporal('uaeh-config-cli-');
  try { return fn(e); } finally { e.limpiar(); }
}
const linea = (r) => r.stdout.trim();

test('runs-dir · sin configuración: <UAEH_HOME>/runs, y no crea la carpeta', () => conCasa((e) => {
  const r = correr(CLI, ['runs-dir'], { env: e.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(linea(r), path.join(e.uaehHome, 'runs'));
  assert.equal(fs.existsSync(path.join(e.uaehHome, 'runs')), false, 'solo informa: no crea nada');
}));

test('runs-dir --repo · subcarpeta con el nombre del repo saneado', () => conCasa((e) => {
  const repo = path.join(e.dir, 'Mi Repo (Ñ)');
  const r = correr(CLI, ['runs-dir', '--repo', repo], { env: e.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(linea(r), path.join(e.uaehHome, 'runs', 'Mi-Repo'));
}));

test('runs-dir · datos.runs de uaeh.config.json manda; UAEH_RUNS_DIR la pisa', () => conCasa((e) => {
  const propia = path.join(e.dir, 'corridas-propias');
  e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ datos: { runs: propia } }));
  assert.equal(linea(correr(CLI, ['runs-dir', '--repo', path.join(e.dir, 'app')], { env: e.env })), path.join(propia, 'app'));
  const deEntorno = path.join(e.dir, 'desde-entorno');
  assert.equal(linea(correr(CLI, ['runs-dir'], { env: { ...e.env, UAEH_RUNS_DIR: deEntorno } })), deEntorno);
}));

test('jurisdiccion · vacía sin configurar; la de preflight.jurisdiccion en UNA línea; con argumentos, 64', () => conCasa((e) => {
  const sin = correr(CLI, ['jurisdiccion'], { env: e.env });
  assert.equal(sin.status, 0, sin.stderr);
  assert.equal(sin.stdout, '\n', 'sin configurar: una línea vacía');
  e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ preflight: { jurisdiccion: '  México\n(usuarios en la UE)  ' } }));
  const con = correr(CLI, ['jurisdiccion'], { env: e.env });
  assert.equal(con.status, 0, con.stderr);
  assert.equal(con.stdout, 'México (usuarios en la UE)\n');
  e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ preflight: { jurisdiccion: 7 } }));
  assert.equal(correr(CLI, ['jurisdiccion'], { env: e.env }).stdout, '\n', 'un valor que no es texto cuenta como sin configurar');
  const mal = correr(CLI, ['jurisdiccion', 'extra'], { env: e.env });
  assert.equal(mal.status, 64);
  assert.equal(mal.stdout, '');
}));

test('nombreRepo · solo [A-Za-z0-9._-], hasta 80 caracteres, nunca vacío ni «.»/«..»', () => {
  assert.equal(nombreRepo(path.join('x', 'Mi Repo (Ñ)')), 'Mi-Repo');
  assert.equal(nombreRepo(path.join('x', 'app.web_v2-final')), 'app.web_v2-final');
  assert.equal(nombreRepo(path.join('x', 'a'.repeat(100))).length, 80);
  assert.equal(nombreRepo(path.join('x', 'ñññ')), 'repo');
  for (const raro of ['x/..', 'x/.']) assert.match(nombreRepo(raro), /^[A-Za-z0-9._-]{1,80}$/);
  assert.notEqual(nombreRepo(path.join('x', '...')), '...');
});

test('ahora-local · hora en la zona de la configuración (UAEH_TZ la pisa)', () => conCasa((e) => {
  const env = { ...e.env };
  delete env.UAEH_TZ;
  e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'America/Bogota' }));
  const r = correr(CLI, ['ahora-local'], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(linea(r), '2026-10-30T15:00:00-05:00'); // UAEH_AHORA = 2026-10-30T20:00:00Z
  assert.match(linea(correr(CLI, ['ahora-local'], { env: { ...env, UAEH_TZ: 'UTC' } })), /^2026-10-30T20:00:00(Z|[+-]00:00)$/);
}));

test('prefijo-motor y prefijo-caja · Windows entra por WSL con la distro y el usuario de la configuración; Linux va directo', () => {
  const config = configLib.cargarConfig({ env: { UAEH_HOME: path.join(__dirname, 'no-existe') } }).config;
  const conUsuario = { ...config, wsl: { distro: 'Distro-1', usuario: 'ana' } };
  const sinUsuario = { ...config, wsl: { distro: 'Distro-1', usuario: '' } };
  assert.equal(lineaPrefijo('motor', { config: conUsuario, so: 'win32' }), 'wsl.exe -d Distro-1 -u ana -e');
  assert.equal(lineaPrefijo('motor', { config: sinUsuario, so: 'win32' }), 'wsl.exe -d Distro-1 -e');
  assert.equal(lineaPrefijo('caja', { config: conUsuario, so: 'win32' }), 'wsl.exe -d Distro-1 -u ana -e /opt/uaeh/bin/uaeh-sandbox ejecutar');
  assert.equal(lineaPrefijo('motor', { config: conUsuario, so: 'linux' }), '');
  assert.equal(lineaPrefijo('caja', { config: conUsuario, so: 'linux' }), '/opt/uaeh/bin/uaeh-sandbox ejecutar');
});

test('prefijo-motor, prefijo-caja y ruta-motor · el CLI imprime UNA línea (vacía en Linux para el prefijo) y sale 0', () => conCasa((e) => {
  const env = { ...e.env, UAEH_WSL_DISTRO: 'Distro-2', UAEH_WSL_USER: 'beto' };
  const motor = correr(CLI, ['prefijo-motor'], { env });
  const caja = correr(CLI, ['prefijo-caja'], { env });
  const carpeta = path.join(e.dir, 'Con espacio', 'repo');
  const ruta = correr(CLI, ['ruta-motor', carpeta], { env });
  for (const r of [motor, caja, ruta]) { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.split('\n').length, 2, 'una línea con su salto'); }
  if (process.platform === 'win32') {
    assert.equal(linea(motor), 'wsl.exe -d Distro-2 -u beto -e');
    assert.equal(linea(caja), 'wsl.exe -d Distro-2 -u beto -e /opt/uaeh/bin/uaeh-sandbox ejecutar');
    assert.match(linea(ruta), /^\/mnt\/[a-z]\/.*\/Con espacio\/repo$/);
  } else {
    assert.equal(motor.stdout, '\n');
    assert.equal(linea(caja), '/opt/uaeh/bin/uaeh-sandbox ejecutar');
    assert.equal(linea(ruta), carpeta);
  }
}));

test('uso incorrecto · código 64 y el uso en stderr, sin salida', () => conCasa((e) => {
  for (const args of [[], ['otra'], ['runs-dir', '--repo'], ['runs-dir', '--raro'], ['runs-dir', '--repo', '--raro'], ['ahora-local', 'x'],
    ['prefijo-motor', 'x'], ['prefijo-caja', '--raro'], ['ruta-motor'], ['ruta-motor', 'a', 'b'], ['ruta-motor', '--raro']]) {
    const r = correr(CLI, args, { env: e.env });
    assert.equal(r.status, 64, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, /uso: uaeh-config\.cjs/, args.join(' '));
  }
}));
