// Pruebas de plugins/uaeh-harness/scripts/aplicar-parche-cyber-neo.cjs y de la copia vendorizada de cyber-neo.
//
// · La copia del plugin está íntegra y PARCHEADA (archivo por archivo contra vendor/cyber-neo/UPSTREAM.json).
// · Sobre copias en una carpeta temporal: aplicar, revertir, idempotencia, respaldo .orig, CRLF, la variante vieja
//   (v0.1.0) y una versión desconocida que no se toca.
// · Comportamiento real (requiere Python 3; omitida fuera de CI, fallo con UAEH_CI=1): con el parche, la evidencia de un
//   secreto falso sale como ***REDACTED*** y el secreto no aparece; sin el parche, sí aparece (la prueba detecta el bug).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');

const CLI = path.join(RAIZ_HARNESS, 'scripts', 'aplicar-parche-cyber-neo.cjs');
const P = require(CLI);
const runner = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'runner.cjs'));
const VENDOR = path.join(RAIZ_HARNESS, 'vendor', 'cyber-neo');
const OBJETIVO = path.join('scripts', 'scan_secrets.py');

const E = entornoTemporal('uaeh-parche-cn-');
process.on('exit', () => E.limpiar());
let n = 0;
const tmp = () => { const d = path.join(E.dir, `t${++n}`); fs.mkdirSync(path.join(d, 'scripts'), { recursive: true }); return d; };

const UPSTREAM = P.leerUpstream();
const PARCHE = P.cargarParche(UPSTREAM);
const VENDORIZADO = fs.readFileSync(path.join(VENDOR, OBJETIVO), 'utf8').replace(/\r\n/g, '\n');
// La copia del plugin = original + 0001 + 0002 (PATCHES/0002-…md: literales PEM partidos en dos cadenas contiguas).
// Las cadenas se arman por partes para que este archivo tampoco tenga la forma de una llave.
const B = '-----BEGIN ';
const K = 'PRIVATE ' + 'KEY-----';
function deshacer0002(texto) {
  let t = texto;
  for (const tipo of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', '']) {
    const partido = `r"${B}${tipo}" r"${K}"`;
    assert.equal(t.split(partido).length - 1, 1, `0002: ${tipo || 'sin tipo'} debe aparecer una vez`);
    t = t.replace(partido, `r"${B}${tipo}${K}"`);
  }
  return t;
}
const PARCHADO = deshacer0002(VENDORIZADO); // original + 0001, como lo dejaría --aplicar en una instalación propia
const ORIGINAL = P.transformar(PARCHADO, PARCHE.hunks, true);
// v0.1.0 (e1a5435 … dcac0a8) = 535d0df sin las 3 líneas de autoría que van tras el shebang.
const VIEJO = ORIGINAL.split('\n').filter((_, i) => i < 1 || i > 3).join('\n');

function destinoCon(texto) {
  const d = tmp();
  fs.writeFileSync(path.join(d, OBJETIVO), texto);
  return d;
}
const leer = (d, rel = OBJETIVO) => fs.readFileSync(path.join(d, rel), 'utf8');
const cli = (args) => correr(CLI, args, { env: E.env });

test('copia del plugin · íntegra y PARCHEADA; --verificar sin --destino sale 0', () => {
  const r = P.verificarVendor();
  assert.equal(r.estado, 'PARCHEADO', r.detalle);
  assert.deepEqual(r.alterados, []);
  const c = cli(['--verificar']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^PARCHEADO .*18 archivos íntegros/);
});

test('UPSTREAM.json · cada archivo de la carpeta vendor está declarado (salvo UPSTREAM.json y PATCHES/) y con licencia', () => {
  const todos = [];
  const recorrer = (d, pre = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre + e.name; if (e.isDirectory()) recorrer(path.join(d, e.name), rel + '/'); else todos.push(rel); } };
  recorrer(VENDOR);
  const sueltos = todos.filter((f) => f !== 'UPSTREAM.json' && !f.startsWith('PATCHES/') && !UPSTREAM.archivos[f]);
  assert.deepEqual(sueltos, []);
  assert.equal(UPSTREAM.licencia, 'MIT');
  assert.match(UPSTREAM.commit, /^[0-9a-f]{40}$/);
  for (const f of ['LICENSE', 'NOTICE']) assert.ok(UPSTREAM.archivos[f], `${f} declarado`);
  assert.match(fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Copyright \(c\)/);
  assert.deepEqual(UPSTREAM.archivos['scripts/scan_secrets.py'].parches, [PARCHE.archivo, 'PATCHES/0002-literales-con-forma-de-llave.md']);
  for (const p of UPSTREAM.parches) assert.ok(fs.existsSync(path.join(VENDOR, ...p.archivo.split('/'))), p.archivo);
  for (const [rel, info] of Object.entries(UPSTREAM.archivos)) {
    if (info.parches) assert.match(info.sha256_upstream || '', /^[0-9a-f]{64}$/, `${rel}: con parches debe declarar la huella de upstream`);
  }
});

test('copia del plugin = original exacto de upstream + 0001 + 0002 (deshacer los dos da la huella del original)', () => {
  assert.equal(P.huella(PARCHADO), PARCHE.variantes[0].sha256_parcheado, 'deshacer 0002 deja exactamente original + 0001');
  assert.equal(P.huella(ORIGINAL), PARCHE.variantes[0].sha256_original, 'deshacer además 0001 deja el original de upstream');
  assert.equal(P.huella(ORIGINAL), UPSTREAM.archivos['scripts/scan_secrets.py'].sha256_upstream);
});

test('copia del plugin · ninguna línea tiene forma de llave para la guarda de commits (por eso existe el 0002)', () => {
  const G = require(path.join(RAIZ_HARNESS, 'hooks', 'guardia-git.js'));
  const hallazgos = [];
  for (const rel of [...Object.keys(UPSTREAM.archivos), ...UPSTREAM.parches.map((p) => p.archivo)]) {
    fs.readFileSync(path.join(VENDOR, ...rel.split('/')), 'utf8').split('\n').forEach((l, i) => {
      const tipos = G.tiposEnTexto(l);
      if (tipos.length) hallazgos.push(`${rel}:${i + 1} ${tipos.join(',')}`);
    });
  }
  assert.deepEqual(hallazgos, []);
});

// Vendor sintético: el parche real, el scan_secrets.py parchado y dos archivos chicos. No se copian las referencias de
// cyber-neo a la carpeta temporal: un antivirus puede bloquearlas ahí (medido en Windows con lang-python.md → EPERM).
function vendorSintetico() {
  const d = path.join(E.dir, `vendor-${++n}`);
  for (const sub of ['scripts', 'PATCHES', 'references']) fs.mkdirSync(path.join(d, sub), { recursive: true });
  fs.copyFileSync(path.join(VENDOR, ...PARCHE.archivo.split('/')), path.join(d, ...PARCHE.archivo.split('/')));
  fs.writeFileSync(path.join(d, OBJETIVO), VENDORIZADO);
  fs.writeFileSync(path.join(d, 'scripts', 'check_lockfiles.py'), 'print("ok")\n');
  fs.writeFileSync(path.join(d, 'references', 'guia.md'), '# Guía\n');
  const archivos = {};
  for (const rel of ['scripts/scan_secrets.py', 'scripts/check_lockfiles.py', 'references/guia.md']) archivos[rel] = { sha256: P.huella(fs.readFileSync(path.join(d, ...rel.split('/')), 'utf8')) };
  fs.writeFileSync(path.join(d, 'UPSTREAM.json'), JSON.stringify({ ...UPSTREAM, archivos }));
  return d;
}

test('copia alterada o incompleta · DESCONOCIDO con el archivo nombrado; la verificación parcial solo mira lo pedido', () => {
  const copia = vendorSintetico();
  assert.equal(P.verificarVendor(copia).estado, 'PARCHEADO');
  fs.appendFileSync(path.join(copia, 'references', 'guia.md'), 'línea añadida\n');
  let r = P.verificarVendor(copia);
  assert.equal(r.estado, 'DESCONOCIDO');
  assert.deepEqual(r.alterados, ['references/guia.md']);
  r = P.verificarVendor(copia, { archivos: ['scripts/check_lockfiles.py'] });
  assert.equal(r.estado, 'PARCHEADO', 'la pasada no depende de las referencias');
  assert.match(r.detalle, /2 archivos íntegros/, 'siempre incluye el archivo parchado');
  assert.deepEqual(P.verificarVendor(copia, { archivos: ['scripts/otro.py'] }).alterados, ['scripts/otro.py (no declarado en UPSTREAM.json)']);
  fs.unlinkSync(path.join(copia, 'scripts', 'check_lockfiles.py'));
  r = P.verificarVendor(copia, { archivos: ['scripts/check_lockfiles.py'] });
  assert.deepEqual(r.alterados, ['scripts/check_lockfiles.py (falta)']);
  fs.writeFileSync(path.join(copia, OBJETIVO), ORIGINAL);
  assert.equal(P.verificarVendor(copia, { archivos: [] }).estado, 'DESCONOCIDO', 'el parchado cambió: su huella ya no es la declarada');
  fs.rmSync(path.join(copia, 'UPSTREAM.json'));
  assert.equal(P.verificarVendor(copia).estado, 'DESCONOCIDO');
});

test('--destino · original → SIN_PARCHE (3); --aplicar → PARCHEADO con respaldo .orig; repetir no cambia nada', () => {
  const d = destinoCon(ORIGINAL);
  assert.equal(cli(['--verificar', '--destino', d]).status, 3);
  const a = cli(['--aplicar', '--destino', d]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^PARCHEADO .*parchado \(respaldo: scan_secrets\.py\.orig\)/);
  assert.equal(P.huella(leer(d)), PARCHE.variantes[0].sha256_parcheado);
  assert.equal(leer(d, OBJETIVO + '.orig'), ORIGINAL);
  const mtime = fs.statSync(path.join(d, OBJETIVO)).mtimeMs;
  const otra = cli(['--aplicar', '--destino', d]);
  assert.equal(otra.status, 0);
  assert.match(otra.stdout, /ya estaba así/);
  assert.equal(fs.statSync(path.join(d, OBJETIVO)).mtimeMs, mtime, 'idempotente: no reescribe');
  assert.equal(cli(['--verificar', '--destino', d]).status, 0);
});

test('--revertir · vuelve al original exacto, quita el .orig idéntico y es idempotente', () => {
  const d = destinoCon(ORIGINAL);
  assert.equal(cli(['--aplicar', '--destino', d]).status, 0);
  const r = cli(['--revertir', '--destino', d]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SIN_PARCHE .*revertido/);
  assert.equal(leer(d), ORIGINAL);
  assert.equal(fs.existsSync(path.join(d, OBJETIVO + '.orig')), false);
  const otra = cli(['--revertir', '--destino', d]);
  assert.equal(otra.status, 0);
  assert.match(otra.stdout, /ya estaba así/);
});

test('--aplicar · respeta CRLF y la huella sigue siendo la de la variante parchada', () => {
  const d = destinoCon(ORIGINAL.replace(/\n/g, '\r\n'));
  assert.equal(cli(['--aplicar', '--destino', d]).status, 0);
  const texto = leer(d);
  assert.ok(texto.includes('***REDACTED***\")\r\n'), 'el bloque nuevo también va en CRLF');
  assert.ok(!/[^\r]\n/.test(texto), 'ningún LF suelto');
  assert.equal(P.huella(texto), PARCHE.variantes[0].sha256_parcheado);
});

test('--aplicar · la variante vieja (v0.1.0) también se reconoce y se parcha', () => {
  const d = destinoCon(VIEJO);
  const v = cli(['--verificar', '--destino', d]);
  assert.equal(v.status, 3, v.stdout + v.stderr);
  assert.equal(cli(['--aplicar', '--destino', d]).status, 0);
  assert.equal(P.huella(leer(d)), PARCHE.variantes[1].sha256_parcheado);
});

test('versión desconocida · --aplicar y --revertir salen 4 y no tocan el archivo ni dejan respaldo', () => {
  const raro = ORIGINAL + '# cambio local\n';
  const d = destinoCon(raro);
  for (const modo of ['--verificar', '--aplicar', '--revertir']) {
    const r = cli([modo, '--destino', d]);
    assert.equal(r.status, 4, modo);
    assert.match(r.stdout, /^DESCONOCIDO /);
  }
  assert.equal(leer(d), raro);
  assert.equal(fs.existsSync(path.join(d, OBJETIVO + '.orig')), false);
});

test('uso incorrecto o archivo ausente · código 2, nada en stdout', () => {
  const vacio = tmp();
  for (const args of [[], ['--aplicar'], ['--revertir'], ['--verificar', '--aplicar'], ['--destino'], ['--verificar', '--destino', '--json'], ['--raro'],
    ['--verificar', '--destino', vacio], ['--aplicar', '--destino', path.join(E.dir, 'no-existe')]]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.ok(r.stderr.trim(), args.join(' '));
  }
});

test('--json · una línea JSON con estado, ruta y variante', () => {
  const d = destinoCon(VIEJO);
  const r = cli(['--verificar', '--destino', d, '--json']);
  const j = JSON.parse(r.stdout);
  assert.equal(j.estado, 'SIN_PARCHE');
  assert.equal(j.variante, 'dcac0a8');
  assert.equal(j.ruta, path.join(path.resolve(d), OBJETIVO));
});

test('parsearParche y transformar · rechazan rutas inseguras, varios archivos y anclas ausentes o repetidas', () => {
  const bloque = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n';
  assert.deepEqual(P.parsearParche(`texto libre\n--- a/x.py\n+++ b/x.py\n${bloque}`).hunks, [{ antes: 'a\nb', despues: 'a\nc' }]);
  assert.throws(() => P.parsearParche(`--- a/../x\n+++ b/../x\n${bloque}`), /inseguro/);
  assert.throws(() => P.parsearParche(`--- a/x\n+++ b/x\n${bloque}--- a/y\n+++ b/y\n${bloque}`), /más de un archivo/);
  assert.throws(() => P.parsearParche('sin cabecera\n'), /cabecera/);
  const hunks = [{ antes: 'a\nb', despues: 'a\nc' }];
  assert.equal(P.transformar('0\na\nb\n1', hunks), '0\na\nc\n1');
  assert.throws(() => P.transformar('nada', hunks), /aparece 0/);
  assert.throws(() => P.transformar('a\nb\na\nb', hunks), /aparece 2/);
  assert.equal(P.huella('x\r\ny'), P.huella('x\ny'), 'la huella ignora CRLF');
});

// ── Comportamiento real con Python ─────────────────────────────────────────────────────────────────────────

function python(t) {
  const py = runner.comandoPython();
  if (py) return { cmd: py, pre: py === 'py' ? ['-3', '-I'] : ['-I'] };
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error('prueba omitida en modo estricto: falta Python 3');
  t.skip('falta Python 3 (python3, python o py)');
  return null;
}

function escanear(py, carpetaSkill, objetivo) {
  const r = spawnSync(py.cmd, [...py.pre, path.join(carpetaSkill, OBJETIVO), objetivo, '--json'], {
    encoding: 'utf8', env: { ...E.env, PYTHONIOENCODING: 'utf-8' }, timeout: 120000, windowsHide: true,
  });
  assert.ok([0, 1].includes(r.status), `scan_secrets salió con ${r.status}: ${r.stderr}`);
  return r.stdout;
}

test('comportamiento · con el parche el secreto sale ***REDACTED***; sin el parche se filtra (la prueba ve el bug)', (t) => {
  const py = python(t);
  if (!py) return;
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const token = 'gh' + 'p_' + Array.from(crypto.randomBytes(36), (b) => abc[b % abc.length]).join('');
  const proyecto = path.join(E.dir, 'proyecto-escaneado');
  fs.mkdirSync(proyecto, { recursive: true });
  fs.writeFileSync(path.join(proyecto, 'config.js'), `module.exports = { githubToken: '${token}' };\n`);

  const conParche = escanear(py, VENDOR, proyecto);
  const j = JSON.parse(conParche);
  const hallazgo = j.findings.find((f) => f.file && f.file.endsWith('config.js') && /GitHub/.test(f.type || ''));
  assert.ok(hallazgo, 'scan_secrets no detectó el token de juguete');
  assert.match(hallazgo.evidence, /\*\*\*REDACTED\*\*\*/);
  assert.ok(!conParche.includes(token), 'el secreto aparece en la salida parchada');

  const sinParche = destinoCon(ORIGINAL);
  assert.ok(escanear(py, sinParche, proyecto).includes(token), 'sin el parche el secreto debería filtrarse: si no, esta prueba ya no ve el bug');
});

test('comportamiento · el 0002 no cambia los patrones: PATTERNS y SKIP_DIRS compilados son idénticos a los de original + 0001', (t) => {
  const py = python(t);
  if (!py) return;
  const volcar = (archivo) => {
    const codigo = 'import importlib.util,json,sys\ns=importlib.util.spec_from_file_location("s",sys.argv[1])\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\nprint(json.dumps([m.PATTERNS,sorted(m.SKIP_DIRS)]))';
    // -B y PYTHONDONTWRITEBYTECODE: importar el módulo no deja __pycache__ dentro de la carpeta del vendor.
    const r = spawnSync(py.cmd, [...py.pre, '-B', '-c', codigo, archivo], { encoding: 'utf8', env: { ...E.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 60000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const conSolo0001 = destinoCon(PARCHADO);
  const a = volcar(path.join(VENDOR, OBJETIVO));
  const b = volcar(path.join(conSolo0001, OBJETIVO));
  assert.ok(a[0].length >= 50, `se esperaban los patrones de cyber-neo, hay ${a[0].length}`);
  assert.deepEqual(a, b);
  assert.equal(fs.existsSync(path.join(VENDOR, 'scripts', '__pycache__')), false, 'la prueba no debe ensuciar la carpeta del vendor');
});

// ── Parche 0003: el ejemplo que hacía que un antivirus bloqueara lang-python.md ───────
test('0003 · lang-python.md lleva el ejemplo de exec en su forma parcheada (una vez) y nunca en la original', () => {
  const guia = fs.readFileSync(path.join(RAIZ_HARNESS, 'vendor', 'cyber-neo', 'references', 'lang-python.md'), 'utf8');
  const cola = '(request.data.decode())';
  assert.equal(guia.split('exec ' + cola).length - 1, 1, 'forma parcheada, una vez');
  assert.equal(guia.split('exec' + cola).length - 1, 0, 'la forma original no debe volver (una actualización del vendor la traería)');
  assert.ok(UPSTREAM.archivos['references/lang-python.md'].parches.includes('PATCHES/0003-ejemplo-que-dispara-antivirus.md'));
  assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, 'vendor', 'cyber-neo', 'PATCHES', '0003-ejemplo-que-dispara-antivirus.md')));
});
