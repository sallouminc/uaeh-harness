// Pruebas de plugins/uaeh-kit/scripts/verificar-dieta-claudemd.cjs. Las que usan git crean un repositorio
// temporal con el entorno hermético (GIT_CONFIG_GLOBAL propio, sin ganchos ni configuración del usuario).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, git, requiereHerramienta, RAIZ_KIT } = require('../helpers/entorno.cjs');
const { LIMITE_CLAUDE_MD } = require(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'));

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'verificar-dieta-claudemd.cjs');
const dieta = require(SCRIPT);

const LINEA_REGLA = 'Regla uno: medir antes de optimizar.';
const LINEA_BITACORA = 'El historial detallado vive en tasks/bitacora.md';
const ORIGINAL = ['# Reglas del proyecto', LINEA_REGLA, LINEA_BITACORA].join('\n') + '\n';
const SIN_LA_REGLA = ['# Reglas del proyecto', LINEA_BITACORA].join('\n') + '\n';

// Repositorio temporal con CLAUDE.md (ORIGINAL) ya confirmado en HEAD.
function repoConClaudeMd(e) {
  const repo = path.join(e.dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q'], e.env);
  e.escribir(path.join(repo, 'CLAUDE.md'), ORIGINAL);
  git(repo, ['add', 'CLAUDE.md'], e.env);
  git(repo, ['commit', '-q', '-m', 'inicial'], e.env);
  return repo;
}

// Entorno en el que `git` no se encuentra: PATH apunta a una carpeta vacía (se borra cualquier variante de «path»).
function envSinGit(e) {
  const vacia = path.join(e.dir, 'sin-herramientas');
  fs.mkdirSync(vacia, { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(e.env)) if (!/^path$/i.test(k)) env[k] = v;
  env.PATH = vacia;
  return env;
}

test('git: mover una línea a la bitácora sin perderla → PASS', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = entornoTemporal();
  try {
    const repo = repoConClaudeMd(e);
    e.escribir(path.join(repo, 'CLAUDE.md'), SIN_LA_REGLA);
    e.escribir(path.join(repo, 'tasks', 'bitacora.md'), `# Bitácora\n${LINEA_REGLA}\n`);
    const r = correr(SCRIPT, [], { env: e.env, cwd: repo });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^Original \d+K car · CLAUDE\.md nuevo \d+K car \(≈\d+K tokens\) · bitácora \d+K car$/m);
    assert.match(r.stdout, /^OK: ninguna línea del original se perdió\.$/m);
    assert.match(r.stdout, new RegExp(`^OK: CLAUDE\\.md dentro del límite \\(${SIN_LA_REGLA.length} ≤ ${LIMITE_CLAUDE_MD}\\)\\.$`, 'm'));
    assert.match(r.stdout, /^OK: CLAUDE\.md apunta a la bitácora\.$/m);
    assert.match(r.stdout, /^RESULTADO: PASS$/m);
    assert.doesNotMatch(r.stdout, /FAIL/);
  } finally { e.limpiar(); }
});

test('git: borrar una línea sin dejarla en la bitácora → FAIL y se lista la línea perdida', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = entornoTemporal();
  try {
    const repo = repoConClaudeMd(e);
    e.escribir(path.join(repo, 'CLAUDE.md'), SIN_LA_REGLA); // y no existe tasks/bitacora.md
    const r = correr(SCRIPT, [], { env: e.env, cwd: repo });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL: 1 línea\(s\) del original no aparecen en ninguno de los dos archivos:$/m);
    assert.match(r.stdout, new RegExp(`^  - ${LINEA_REGLA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(r.stdout, /^RESULTADO: FAIL$/m);
    assert.doesNotMatch(r.stdout, /RESULTADO: PASS/);
  } finally { e.limpiar(); }
});

test('git: se compara contra HEAD, no contra el árbol de trabajo, y las rutas pueden darse como argumentos', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = entornoTemporal();
  try {
    const repo = repoConClaudeMd(e);
    // CLAUDE.md está modificado pero sin confirmar: el original sigue siendo el de HEAD.
    e.escribir(path.join(repo, 'CLAUDE.md'), `# Otro título\n${LINEA_BITACORA}\n`);
    e.escribir(path.join(repo, 'detalle', 'historia.md'), `${LINEA_REGLA}\n# Reglas del proyecto\n`);
    const r = correr(SCRIPT, ['CLAUDE.md', path.join('detalle', 'historia.md')], { env: e.env, cwd: repo });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RESULTADO: PASS/);
    // Con la bitácora por defecto (que no existe) las dos líneas movidas se pierden.
    const sinBitacora = correr(SCRIPT, [], { env: e.env, cwd: repo });
    assert.equal(sinBitacora.status, 1);
    assert.match(sinBitacora.stdout, /FAIL: 2 línea\(s\)/);
  } finally { e.limpiar(); }
});

test('CLAUDE.md de más de 40,000 caracteres → FAIL aunque no se pierda ninguna línea; justo en el límite pasa', () => {
  const e = entornoTemporal();
  try {
    assert.equal(LIMITE_CLAUDE_MD, 40000);
    const original = e.escribir('original.md', ORIGINAL);
    const enElLimite = ORIGINAL + 'x'.repeat(LIMITE_CLAUDE_MD - ORIGINAL.length);
    assert.equal(enElLimite.length, LIMITE_CLAUDE_MD);

    const justo = e.escribir('justo/CLAUDE.md', enElLimite);
    const rJusto = correr(SCRIPT, [justo, path.join(e.dir, 'no-hay-bitacora.md'), '--original', original], { env: e.env });
    assert.equal(rJusto.status, 0, rJusto.stdout + rJusto.stderr);
    assert.match(rJusto.stdout, /^OK: CLAUDE\.md dentro del límite \(40000 ≤ 40000\)\.$/m);

    const pasado = e.escribir('pasado/CLAUDE.md', enElLimite + 'x');
    const rPasado = correr(SCRIPT, [pasado, path.join(e.dir, 'no-hay-bitacora.md'), '--original', original], { env: e.env });
    assert.equal(rPasado.status, 1, rPasado.stdout + rPasado.stderr);
    assert.match(rPasado.stdout, /^FAIL: CLAUDE\.md pesa 40001 caracteres \(límite 40000\)\.$/m);
    assert.match(rPasado.stdout, /^OK: ninguna línea del original se perdió\.$/m, 'es el único motivo del fallo');
    assert.match(rPasado.stdout, /^RESULTADO: FAIL$/m);
  } finally { e.limpiar(); }
});

test('CLAUDE.md que no menciona la bitácora → FAIL', () => {
  const e = entornoTemporal();
  try {
    const original = e.escribir('original.md', '# Reglas\nuna regla\n');
    const nuevo = e.escribir('nuevo/CLAUDE.md', '# Reglas\nuna regla\n');
    const r = correr(SCRIPT, [nuevo, path.join(e.dir, 'x.md'), '--original', original], { env: e.env });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^FAIL: el CLAUDE\.md nuevo no menciona la bitácora\.$/m);
    assert.match(r.stdout, /^OK: ninguna línea del original se perdió\.$/m);
  } finally { e.limpiar(); }
});

test('--original funciona sin git instalado', (t) => {
  if (!requiereHerramienta(t, 'git')) return; // el repositorio de apoyo se arma con git; la ejecución real va sin él
  const e = entornoTemporal();
  try {
    const repo = repoConClaudeMd(e);
    e.escribir(path.join(repo, 'CLAUDE.md'), SIN_LA_REGLA);
    e.escribir(path.join(repo, 'tasks', 'bitacora.md'), `${LINEA_REGLA}\n`);
    const copia = e.escribir('copia-original.md', ORIGINAL);
    const sinGit = envSinGit(e);

    // Sin --original, el mismo archivo versionado no se puede comparar porque git no está.
    const sinCopia = correr(SCRIPT, [], { env: sinGit, cwd: repo });
    assert.equal(sinCopia.status, 1, sinCopia.stdout + sinCopia.stderr);

    const r = correr(SCRIPT, ['--original', copia], { env: sinGit, cwd: repo });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RESULTADO: PASS/);
    // --original puede ir en cualquier posición.
    const alReves = correr(SCRIPT, ['--original', copia, 'CLAUDE.md', path.join('tasks', 'bitacora.md')], { env: sinGit, cwd: repo });
    assert.equal(alReves.status, 0, alReves.stdout + alReves.stderr);
  } finally { e.limpiar(); }
});

test('sin git ni --original → código 1 con un mensaje que explica qué hacer', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = entornoTemporal();
  try {
    // 1) Archivo versionado pero git no está en el PATH.
    const repo = repoConClaudeMd(e);
    const sinGit = correr(SCRIPT, [], { env: envSinGit(e), cwd: repo });
    assert.equal(sinGit.status, 1, sinGit.stdout + sinGit.stderr);
    assert.match(sinGit.stderr, /^FAIL: CLAUDE\.md no está en git; pasa la copia original con --original <ruta>\.$/m);
    assert.equal(sinGit.stdout, '');

    // 2) Hay git, pero el archivo no está en ningún repositorio.
    const suelto = path.join(e.dir, 'suelto');
    e.escribir(path.join(suelto, 'CLAUDE.md'), SIN_LA_REGLA);
    const fueraDeRepo = correr(SCRIPT, [], { env: { ...e.env, GIT_CEILING_DIRECTORIES: e.dir }, cwd: suelto });
    assert.equal(fueraDeRepo.status, 1, fueraDeRepo.stdout + fueraDeRepo.stderr);
    assert.match(fueraDeRepo.stderr, /no está en git; pasa la copia original con --original <ruta>/);
  } finally { e.limpiar(); }
});

test('git: archivo en el índice pero repositorio sin commits → código 1 y lo explica', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = entornoTemporal();
  try {
    const repo = path.join(e.dir, 'repo-nuevo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q'], e.env);
    e.escribir(path.join(repo, 'CLAUDE.md'), ORIGINAL);
    git(repo, ['add', 'CLAUDE.md'], e.env);
    const r = correr(SCRIPT, [], { env: e.env, cwd: repo });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no se pudo leer HEAD:CLAUDE\.md \(¿el repositorio tiene al menos un commit\?\)/);
  } finally { e.limpiar(); }
});

test('uso incorrecto: argumentos desconocidos, --original sin ruta, de más, o archivos que no se pueden leer → código 1', () => {
  const e = entornoTemporal();
  try {
    const original = e.escribir('original.md', ORIGINAL);
    const nuevo = e.escribir('n/CLAUDE.md', ORIGINAL);
    const casos = [
      [['--nada'], /argumento desconocido: --nada/],
      [['--original'], /--original necesita una ruta/],
      [['--original', '--otro'], /--original necesita una ruta/],
      [['a.md', 'b.md', 'c.md', '--original', original], /argumento de más: c\.md/],
    ];
    for (const [args, patron] of casos) {
      const r = correr(SCRIPT, args, { env: e.env });
      assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, patron);
      assert.match(r.stderr, /Uso: node verificar-dieta-claudemd\.cjs/);
      assert.equal(r.stdout, '');
    }
    const sinCopia = correr(SCRIPT, [nuevo, 'b.md', '--original', path.join(e.dir, 'no-existe.md')], { env: e.env });
    assert.equal(sinCopia.status, 1);
    assert.match(sinCopia.stderr, /FAIL: no se pudo leer la copia original/);
    const sinNuevo = correr(SCRIPT, [path.join(e.dir, 'no-hay', 'CLAUDE.md'), 'b.md', '--original', original], { env: e.env });
    assert.equal(sinNuevo.status, 1);
    assert.match(sinNuevo.stderr, /FAIL: no se pudo leer .*CLAUDE\.md/);
  } finally { e.limpiar(); }
});

test('lineasFaltantes: multiconjunto, textual, sin contar vacías ni distinguir fin de línea o BOM', () => {
  // Una línea repetida 3 veces tiene que aparecer 3 veces entre CLAUDE.md y la bitácora.
  assert.deepEqual(dieta.lineasFaltantes('r\nr\nr\n', 'r\n', 'r\n'), ['r']);
  assert.deepEqual(dieta.lineasFaltantes('r\nr\nr\n', 'r\nr\n', 'r\n'), []);
  // Basta con que esté en uno de los dos.
  assert.deepEqual(dieta.lineasFaltantes('a\nb\n', 'a\n', 'b\n'), []);
  assert.deepEqual(dieta.lineasFaltantes('a\nb\n', 'a\n', ''), ['b']);
  // Las líneas en blanco del original no cuentan, aunque solo tengan espacios.
  assert.deepEqual(dieta.lineasFaltantes('\n   \n\t\na\n', 'a\n', ''), []);
  // Textual: un espacio de más al final ya es otra línea.
  assert.deepEqual(dieta.lineasFaltantes('a\n', 'a \n', ''), ['a']);
  // Fin de línea de Windows y BOM al inicio no cuentan como diferencia.
  assert.deepEqual(dieta.lineasFaltantes('a\nb\n', '\uFEFFa\r\nb\r\n', ''), []);
  assert.deepEqual(dieta.lineasFaltantes('\uFEFFa\r\nb\r\n', 'a\nb\n', ''), []);
  // El orden y el lugar no importan, solo la presencia.
  assert.deepEqual(dieta.lineasFaltantes('1\n2\n3\n', '3\n', '2\n1\n'), []);
});

test('evaluar y informe: cada criterio por separado y el resumen final', () => {
  const bien = dieta.evaluar('a\n', 'a\nbitácora\n', '');
  assert.equal(bien.ok, true);
  assert.equal(bien.mencionaBitacora, true);
  assert.equal(bien.dentroDelLimite, true);
  assert.deepEqual(bien.faltan, []);
  assert.equal(dieta.informe(bien).at(-1), 'RESULTADO: PASS');

  for (const mencion of ['tasks/bitacora.md', 'la Bitácora', 'BITACORA.MD']) {
    assert.equal(dieta.evaluar('a\n', `a\n${mencion}\n`, '').mencionaBitacora, true, mencion);
  }
  assert.equal(dieta.evaluar('a\n', 'a\nla bitacora\n', '').mencionaBitacora, false, 'sin acento y sin «.md» no cuenta');

  const mal = dieta.evaluar('a\nb\n', 'a\n', '');
  assert.equal(mal.ok, false);
  assert.deepEqual(mal.faltan, ['b']);
  assert.equal(dieta.informe(mal).at(-1), 'RESULTADO: FAIL');

  // Más de 40 líneas perdidas: se listan 40, cada una recortada a 160 caracteres, y se dice cuántas más hay.
  const muchas = Array.from({ length: 45 }, (_, i) => `perdida ${i} ${'z'.repeat(200)}`).join('\n');
  const lineas = dieta.informe(dieta.evaluar(muchas, 'bitacora.md\n', ''));
  const listadas = lineas.filter((l) => l.startsWith('  - '));
  assert.equal(listadas.length, 40);
  assert.ok(listadas.every((l) => l.length === 4 + 160));
  assert.ok(lineas.includes('  … y 5 más'));
  assert.ok(lineas.includes('FAIL: 45 línea(s) del original no aparecen en ninguno de los dos archivos:'));
});
