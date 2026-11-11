// Pruebas de tools/probar-perfil-limpio.cjs: que la copia de credenciales nunca sobreviva a la corrida.
// Herméticas: casa y carpeta temporal propias (entornoTemporal) y un `claude` falso en el PATH; no llaman al modelo.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { entornoTemporal, RAIZ_REPO } = require('../helpers/entorno.cjs');
const { limpiarRestos, PREFIJO, MARCA_CONSERVAR } = require('../../tools/probar-perfil-limpio.cjs');

const HERRAMIENTA = path.join(RAIZ_REPO, 'tools', 'probar-perfil-limpio.cjs');
const POSIX = process.platform !== 'win32';
const HORA = 60 * 60 * 1000;

function conEntorno(t) {
  const e = entornoTemporal('uaeh-perfil-limpio-test-');
  t.after(() => e.limpiar());
  return e;
}

// Carpeta como la deja una corrida cortada: perfil con copia de credenciales y, si se pide, la marca de --conservar.
function resto(dir, nombre, { edadMs = 2 * HORA, conservar = false } = {}) {
  const p = path.join(dir, nombre);
  fs.mkdirSync(path.join(p, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(p, 'claude', '.credentials.json'), '{"falso":true}');
  if (conservar) fs.writeFileSync(path.join(p, MARCA_CONSERVAR), 'x');
  const t = new Date(Date.now() - edadMs);
  fs.utimesSync(p, t, t);
  return p;
}

const restosCon = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(PREFIJO));
const conCredenciales = (dir) => restosCon(dir).filter((n) => fs.existsSync(path.join(dir, n, 'claude', '.credentials.json')));

// `claude` falso que contesta sin la marca (la corrida da FAIL) o que se queda esperando (para cortarla).
function claudeFalso(e, { esperar = false } = {}) {
  const bin = path.join(e.dir, 'bin-falso');
  fs.mkdirSync(bin, { recursive: true });
  if (POSIX) {
    // Solo `claude -p` espera: el doctor del kit también llama a `claude --version`.
    // Como el real, `claude -p` lee el prompt de su entrada: si terminara sin leerla, la herramienta recibiría a veces
    // EPIPE al escribirla (medido en Linux con la máquina cargada: 89 de 1500 corridas) y la prueba fallaría sin motivo.
    const enP = `cat >/dev/null${esperar ? '; sleep 30' : ''}`;
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = -p ]; then ${enP}; fi\necho '{"result":"SIN MARCA"}'\n`, { mode: 0o755 });
  } else {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nif "%~1"=="-p" findstr "^" >nul\r\necho {"result":"SIN MARCA"}\r\nexit /b 0\r\n');
  }
  const env = { ...e.env };
  const k = Object.keys(env).find((x) => x.toUpperCase() === 'PATH') || 'PATH';
  env[k] = bin + path.delimiter + (env[k] || '');
  fs.writeFileSync(path.join(e.claudeHome, '.credentials.json'), '{"falso":true}');
  return env;
}

test('limpiarRestos: borra lo viejo, a lo conservado solo le quita las credenciales y no toca lo reciente ni lo ajeno', (t) => {
  const e = conEntorno(t);
  const d = path.join(e.dir, 'base');
  fs.mkdirSync(d);
  const viejo = resto(d, `${PREFIJO}viejo`);
  const conservado = resto(d, `${PREFIJO}conservado`, { conservar: true });
  const reciente = resto(d, `${PREFIJO}reciente`, { edadMs: 5 * 60 * 1000 });
  const ajeno = resto(d, 'otra-cosa-vieja');
  fs.writeFileSync(path.join(d, `${PREFIJO}archivo-suelto`), 'no es carpeta');

  const r = limpiarRestos([d, d]);
  assert.deepEqual(r.errores, []);
  assert.equal(fs.existsSync(viejo), false, 'la carpeta vieja se borra entera');
  assert.ok(fs.existsSync(conservado), 'la carpeta de --conservar se queda');
  assert.equal(fs.existsSync(path.join(conservado, 'claude', '.credentials.json')), false, '…pero sin la copia de credenciales');
  assert.ok(fs.existsSync(path.join(reciente, 'claude', '.credentials.json')), 'una corrida reciente (quizá en curso) no se toca');
  assert.ok(fs.existsSync(path.join(ajeno, 'claude', '.credentials.json')), 'lo que no lleva el prefijo no se toca');
  assert.ok(fs.existsSync(path.join(d, `${PREFIJO}archivo-suelto`)), 'un archivo con el prefijo no se toca');
  assert.equal(r.credenciales.length, 2, 'dos copias borradas (la carpeta repetida en la lista se revisa una vez)');
  assert.deepEqual(r.carpetas, [viejo]);
  assert.deepEqual(limpiarRestos([path.join(e.dir, 'no-existe')]), { credenciales: [], carpetas: [], errores: [] });
});

if (POSIX) {
  test('limpiarRestos: un enlace con el prefijo no se sigue (lo de fuera queda intacto)', (t) => {
    const e = conEntorno(t);
    const d = path.join(e.dir, 'base');
    fs.mkdirSync(d);
    const fuera = resto(e.dir, 'fuera');
    fs.symlinkSync(fuera, path.join(d, `${PREFIJO}enlace`));
    const r = limpiarRestos([d], { ahora: Date.now() + 10 * HORA });
    assert.deepEqual(r, { credenciales: [], carpetas: [], errores: [] });
    assert.ok(fs.existsSync(path.join(fuera, 'claude', '.credentials.json')));
  });
}

test('una corrida completa limpia los restos viejos al arrancar y no deja su propia copia de credenciales', (t) => {
  const e = conEntorno(t);
  const env = claudeFalso(e);
  const base = path.join(e.dir, 'base');
  fs.mkdirSync(base);
  const viejo = resto(base, `${PREFIJO}cortada`);
  const r = spawnSync(process.execPath, [HERRAMIENTA, '--base', base], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 1, `el claude falso no inyecta nada: FAIL\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /restos de corridas anteriores: 1 copia\(s\) de credenciales y 1 carpeta\(s\) borradas/);
  assert.match(r.stdout, /^OK +claude -p en perfil limpio/m, r.stdout);
  assert.equal(fs.existsSync(viejo), false);
  assert.deepEqual(restosCon(base), [], 'la corrida borra su carpeta al terminar');
});

test('--conservar deja el perfil con su marca y sin la copia de credenciales', (t) => {
  const e = conEntorno(t);
  const env = claudeFalso(e);
  const base = path.join(e.dir, 'base');
  fs.mkdirSync(base);
  const r = spawnSync(process.execPath, [HERRAMIENTA, '--base', base, '--conservar'], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const quedan = restosCon(base);
  assert.equal(quedan.length, 1, 'el perfil se conserva');
  assert.ok(fs.existsSync(path.join(base, quedan[0], MARCA_CONSERVAR)));
  assert.deepEqual(conCredenciales(base), []);
});

if (POSIX) for (const senal of ['SIGINT', 'SIGTERM']) {
  test(`corte a media corrida (${senal} al grupo, como Ctrl+C o kill): no queda la copia de credenciales`, { timeout: 90000 }, async (t) => {
    const e = conEntorno(t);
    const env = claudeFalso(e, { esperar: true });
    const base = path.join(e.dir, 'base');
    fs.mkdirSync(base);
    const hijo = spawn(process.execPath, [HERRAMIENTA, '--base', base], { env, detached: true, stdio: 'ignore' });
    const fin = new Promise((resolve) => hijo.on('exit', (code, signal) => resolve({ code, signal })));
    const limite = Date.now() + 20000;
    while (!conCredenciales(base).length && Date.now() < limite) await new Promise((r) => setTimeout(r, 100));
    assert.equal(conCredenciales(base).length, 1, 'la corrida llegó a copiar las credenciales');
    await new Promise((r) => setTimeout(r, 300)); // ya dentro de la espera a `claude`
    process.kill(-hijo.pid, senal);
    const { code, signal } = await fin;
    assert.equal(signal, null, 'Node no muere por la señal: la atiende y limpia');
    assert.notEqual(code, 0);
    assert.deepEqual(conCredenciales(base), [], 'sin copia de credenciales tras el corte');
    assert.deepEqual(restosCon(base), [], 'ni la carpeta temporal');
  });
}
