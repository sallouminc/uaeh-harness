// Pruebas de plugins/uaeh-harness/scripts/lib/config.cjs: carga, precedencia, validación, lista blanca y derivados.
// Cada caso corre en un proceso hijo con el entorno de la casa temporal (así process.env es el de producción).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { entornoTemporal, RAIZ_HARNESS } = require('../helpers/entorno.cjs');

const LIB = path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs');
const configLib = require(LIB);

function conCasa(fn) {
  const e = entornoTemporal('uaeh-config-');
  try { return fn(e); } finally { e.limpiar(); }
}

// Evalúa `codigo` (con `cfg` ya cargada y `r = cfg.cargarConfig()`) en un hijo con el env de la casa. Devuelve stdout parseado.
function enCasa(e, codigo, extraEnv) {
  const script = `const cfg=require(${JSON.stringify(LIB)});const r=cfg.cargarConfig();process.stdout.write(JSON.stringify((()=>{${codigo}})()));`;
  const p = spawnSync(process.execPath, ['-e', script], { env: { ...e.env, ...(extraEnv || {}) }, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout);
}

function escribirConfig(e, obj) {
  const ruta = path.join(e.uaehHome, 'uaeh.config.json');
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

test('sin archivo: valores por defecto, sin avisos, existe=false', () => conCasa((e) => {
  const r = enCasa(e, 'return { existe: r.existe, avisos: r.avisos, credito: r.config.commits.credito, distro: r.config.wsl.distro, codex: r.config.codex.habilitado, topes: [r.config.codex.timeoutDiffMin, r.config.codex.timeoutCompletaMin] }');
  assert.deepEqual(r, { existe: false, avisos: [], credito: 'permitir', distro: 'Ubuntu-24.04', codex: false, topes: [10, 40] });
}));

test('la ruta del archivo sale del entorno (UAEH_HOME) y se puede derivar sin lanzar un proceso', () => conCasa((e) => {
  assert.equal(configLib.rutaConfigDe(e.env), path.join(e.uaehHome, 'uaeh.config.json'));
  const sinUaeh = { ...e.env }; delete sinUaeh.UAEH_HOME;
  assert.equal(configLib.rutaConfigDe(sinUaeh), path.join(e.claudeHome, 'uaeh', 'uaeh.config.json'));
  const r = configLib.cargarConfig({ env: e.env });
  assert.equal(r.ruta, path.join(e.uaehHome, 'uaeh.config.json'));
}));

test('archivo con valores propios: se fusionan con los defectos y se conservan las claves de otras capas', () => conCasa((e) => {
  escribirConfig(e, { commits: { credito: 'prohibir', firma: 'Authored By: ejemplo.com' }, wsl: { distro: 'Debian', usuario: 'pepe' }, codex: { habilitado: true, modelos: { profundo: { modelo: 'otro' } } }, statusline: { estadoClaude: true } });
  const r = enCasa(e, 'return { existe: r.existe, avisos: r.avisos, commits: r.config.commits, wsl: r.config.wsl, profundo: r.config.codex.modelos.profundo, equilibrado: r.config.codex.modelos.equilibrado, estado: r.config.statusline.estadoClaude, retencion: r.config.datos.retencion.completasDias }');
  assert.equal(r.existe, true);
  assert.deepEqual(r.avisos, []);
  assert.deepEqual(r.commits, { credito: 'prohibir', firma: 'Authored By: ejemplo.com' });
  assert.deepEqual(r.wsl, { distro: 'Debian', usuario: 'pepe' });
  assert.deepEqual(r.profundo, { modelo: 'otro', esfuerzo: 'high' }); // el esfuerzo se hereda del defecto
  assert.deepEqual(r.equilibrado, { modelo: 'gpt-6-sol', esfuerzo: 'medium' });
  assert.equal(r.estado, true);
  assert.equal(r.retencion, 30);
}));

test('valores inválidos: aviso y valor por defecto, nunca una excepción', () => conCasa((e) => {
  escribirConfig(e, { commits: { credito: 'quizas', firma: 5 }, wsl: { distro: 'con espacios', usuario: 'root' }, codex: { habilitado: 'si', timeoutDiffMin: 'diez', timeoutCompletaMin: 0, modelos: { rapido: { modelo: '', esfuerzo: 'high' } } }, arnes: { extra: 'no' }, datos: { runs: 3 }, rara: 1 });
  const r = enCasa(e, 'return { avisos: r.avisos, c: r.config }');
  assert.equal(r.c.commits.credito, 'permitir');
  assert.equal(r.c.commits.firma, '');
  assert.equal(r.c.wsl.distro, 'Ubuntu-24.04');
  assert.equal(r.c.wsl.usuario, '');
  assert.equal(r.c.codex.habilitado, false);
  assert.equal(r.c.codex.timeoutDiffMin, 10);
  assert.equal(r.c.codex.timeoutCompletaMin, 40);
  assert.deepEqual(r.c.codex.modelos.rapido, { modelo: 'gpt-6-luna', esfuerzo: 'medium' });
  assert.deepEqual(r.c.arnes.extra, []);
  assert.equal(r.c.datos.runs, '');
  for (const frag of ['rara', 'commits.credito', 'commits.firma', 'wsl.distro', 'wsl.usuario', 'codex.habilitado', 'codex.timeoutDiffMin', 'codex.timeoutCompletaMin', 'codex.modelos.rapido', 'arnes.extra', 'datos.runs']) {
    assert.ok(r.avisos.some((a) => a.includes(frag)), `falta aviso sobre ${frag}: ${JSON.stringify(r.avisos)}`);
  }
}));

test('arnes.extra: solo carpetas con ruta absoluta; las relativas o con ~ se descartan con aviso y el resto se conserva', () => conCasa((e) => {
  const absoluta = path.join(e.dir, 'vigilada');
  escribirConfig(e, { arnes: { extra: [[absoluta, '\\.js$', true], ['relativa/x', '.'], ['~/otra', '.']] } });
  const r = enCasa(e, 'return { extra: r.config.arnes.extra, avisos: r.avisos }');
  assert.deepEqual(r.extra, [[absoluta, '\\.js$', true]]);
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /^arnes\.extra solo admite carpetas con ruta absoluta.*relativa\/x, ~\/otra/);
}));

test('archivo roto: existe=true, defectos y un aviso que lo dice', () => conCasa((e) => {
  escribirConfig(e, '{ roto');
  const r = enCasa(e, 'return { existe: r.existe, credito: r.config.commits.credito, aviso: r.avisos[0] }');
  assert.equal(r.existe, true);
  assert.equal(r.credito, 'permitir');
  assert.match(r.aviso, /no parsea/);
}));

test('las variables UAEH_* pisan el archivo (y se validan igual)', () => conCasa((e) => {
  escribirConfig(e, { commits: { credito: 'prohibir', firma: 'Authored By: archivo' }, wsl: { distro: 'Debian', usuario: 'ana' } });
  const r = enCasa(e, 'return { commits: r.config.commits, wsl: r.config.wsl, runs: r.config.datos.runs, avisos: r.avisos }',
    { UAEH_COMMIT_CREDITO: 'permitir', UAEH_COMMIT_FIRMA: 'Authored By: entorno', UAEH_WSL_DISTRO: 'Ubuntu', UAEH_WSL_USER: 'root', UAEH_RUNS_DIR: e.tmp });
  assert.deepEqual(r.commits, { credito: 'permitir', firma: 'Authored By: entorno' });
  assert.equal(r.wsl.distro, 'Ubuntu');
  assert.equal(r.wsl.usuario, ''); // root nunca
  assert.equal(path.resolve(r.runs), path.resolve(e.tmp));
  assert.ok(r.avisos.some((a) => a.includes('wsl.usuario')));
  const r2 = enCasa(e, 'return { credito: r.config.commits.credito, avisos: r.avisos }', { UAEH_COMMIT_CREDITO: 'tal-vez' });
  assert.equal(r2.credito, 'prohibir'); // el valor inválido del entorno se ignora y queda el del archivo
  assert.ok(r2.avisos.some((a) => a.includes('UAEH_COMMIT_CREDITO')));
}));

test('politicaCommits: permitir por defecto; prohibir con firma recortada', () => {
  assert.deepEqual(configLib.politicaCommits(configLib.CONFIG_DEFECTO), { credito: 'permitir', prohibir: false, firma: '' });
  assert.deepEqual(configLib.politicaCommits({ commits: { credito: 'prohibir', firma: '  Authored By: x.com  ' } }), { credito: 'prohibir', prohibir: true, firma: 'Authored By: x.com' });
  assert.deepEqual(configLib.politicaCommits({ commits: { credito: 'otro' } }), { credito: 'permitir', prohibir: false, firma: '' });
  assert.deepEqual(configLib.politicaCommits(null), { credito: 'permitir', prohibir: false, firma: '' });
});

test('listaBlanca por defecto: cuatro categorías con nombre legible, exclusiones de fábrica y sin patrones personales', () => {
  const lb = configLib.listaBlanca(configLib.CONFIG_DEFECTO);
  assert.deepEqual(lb.avisos, []);
  assert.deepEqual(lb.categorias.map((c) => c.nombre), ['dinero', 'cuentas', 'base de datos', 'producción']);
  const clasificados = configLib.clasificar([
    'src/auth/login.ts', 'api/pagos/cobro.php', 'db/migrations/001.sql', 'vercel.json', 'docs/auth.md', 'tasks/todo.md',
    'assets/login.png', 'src/app.ts', 'scripts/srv_copia.sh', 'web/pricing.html', '.github/workflows/ci.yml',
  ], lb);
  assert.deepEqual(clasificados, [
    { archivo: 'src/auth/login.ts', categoria: 'cuentas' },
    { archivo: 'api/pagos/cobro.php', categoria: 'dinero' },
    { archivo: 'db/migrations/001.sql', categoria: 'base de datos' },
    { archivo: 'vercel.json', categoria: 'producción' },
    { archivo: 'web/pricing.html', categoria: 'dinero' },
    { archivo: '.github/workflows/ci.yml', categoria: 'producción' },
  ]);
});

test('listaBlanca configurable: agregar suma, categorias reemplaza, exclusiones se suman, patrón inválido avisa', () => {
  const lb = configLib.listaBlanca({ listaBlanca: {
    agregar: { produccion: ['srv_'], secretos: ['llave'] },
    categorias: { dinero: ['solo-esto'] },
    excluirRutas: ['privado'], excluirExtensiones: ['psd'],
  } });
  assert.deepEqual(lb.avisos, []);
  assert.deepEqual(configLib.clasificar(['scripts/srv_copia.sh', 'x/llave.json', 'api/pagos.ts', 'y/solo-esto.ts', 'privado/token.txt', 'auth/foto.psd'], lb), [
    { archivo: 'scripts/srv_copia.sh', categoria: 'producción' },
    { archivo: 'x/llave.json', categoria: 'secretos' },
    { archivo: 'y/solo-esto.ts', categoria: 'dinero' },
  ]);
  const vacia = configLib.listaBlanca({ listaBlanca: { categorias: { dinero: [] } } });
  assert.deepEqual(vacia.categorias.map((c) => c.clave), ['cuentas', 'baseDeDatos', 'produccion']);
  const rota = configLib.listaBlanca({ listaBlanca: { agregar: { dinero: ['(sin cerrar'] }, categorias: 'no' } });
  assert.equal(rota.avisos.length, 2);
  assert.match(rota.avisos.join(' '), /no es una expresión regular válida/);
  assert.equal(configLib.clasificar(['api/pagos.ts'], rota)[0].categoria, 'dinero'); // los patrones válidos siguen
});

test('clasificar normaliza barras, mayúsculas y ./ y respeta rutas y extensiones excluidas', () => {
  const lb = configLib.listaBlanca(configLib.CONFIG_DEFECTO);
  assert.deepEqual(configLib.clasificar(['.\\SRC\\Auth\\Login.TS', 'node_modules/auth/x.js', 'docs/pagos/x.ts', 'README.md', ''], lb), [
    { archivo: '.\\SRC\\Auth\\Login.TS', categoria: 'cuentas' },
  ]);
});

test('espejoHarness y rutaGitHooks: bajo estable/uaeh-harness salvo UAEH_GIT_HOOKS', () => conCasa((e) => {
  const r = enCasa(e, 'return { espejo: cfg.espejoHarness(), hooks: cfg.rutaGitHooks() }');
  assert.equal(r.espejo, path.join(e.uaehHome, 'estable', 'uaeh-harness'));
  assert.equal(r.hooks, path.join(e.uaehHome, 'estable', 'uaeh-harness', 'git-hooks'));
  const otra = path.join(e.dir, 'otra-guarda');
  const r2 = enCasa(e, 'return cfg.rutaGitHooks()', { UAEH_GIT_HOOKS: otra });
  assert.equal(r2, otra);
}));

test('modelosCodex completa lo que falte con los defectos', () => {
  const m = configLib.modelosCodex({ codex: { modelos: { profundo: { modelo: 'p' } } } });
  assert.deepEqual(m.profundo, { modelo: 'p', esfuerzo: 'high' });
  assert.deepEqual(m.rapido, { modelo: 'gpt-6-luna', esfuerzo: 'medium' });
  assert.deepEqual(configLib.modelosCodex(null), configLib.CONFIG_DEFECTO.codex.modelos);
});

test('la plantilla uaeh.config.example.json carga sin avisos y coincide con los defectos en las claves que trae', () => conCasa((e) => {
  const plantilla = fs.readFileSync(path.join(RAIZ_HARNESS, 'templates', 'uaeh.config.example.json'), 'utf8');
  escribirConfig(e, plantilla);
  const r = enCasa(e, 'return { avisos: r.avisos, c: r.config }');
  assert.deepEqual(r.avisos, []);
  const datos = JSON.parse(plantilla);
  assert.equal(datos.commits.credito, r.c.commits.credito);
  assert.equal(datos.wsl.distro, configLib.CONFIG_DEFECTO.wsl.distro);
  assert.deepEqual(datos.codex.modelos, configLib.CONFIG_DEFECTO.codex.modelos);
  for (const k of Object.keys(datos)) assert.ok(k in configLib.CONFIG_DEFECTO, `clave de la plantilla sin defecto: ${k}`);
}));

test('claves retiradas (codex.exigir, visual.viewports, proyectos): se toleran sin aviso y no llegan a la configuración', () => conCasa((e) => {
  escribirConfig(e, { codex: { exigir: 'siempre', timeoutDiffMin: 7 }, visual: { viewports: [320], catalogo: '' }, proyectos: { x: 1 } });
  const r = enCasa(e, 'return { avisos: r.avisos, c: r.config }');
  assert.deepEqual(r.avisos, []);
  assert.equal('exigir' in r.c.codex, false);
  assert.equal('viewports' in r.c.visual, false);
  assert.equal('proyectos' in r.c, false);
  assert.equal(r.c.codex.timeoutDiffMin, 7);
}));

test('topeCodexMin: el de la configuración según el modo; valores inválidos caen al de fábrica', () => {
  const C = require('../../plugins/uaeh-harness/scripts/lib/config.cjs');
  assert.equal(C.topeCodexMin({ codex: { timeoutDiffMin: 6, timeoutCompletaMin: 55 } }, 'diff'), 6);
  assert.equal(C.topeCodexMin({ codex: { timeoutDiffMin: 6, timeoutCompletaMin: 55 } }, 'completa'), 55);
  assert.equal(C.topeCodexMin({ codex: { timeoutDiffMin: -1 } }, 'diff'), 10);
  assert.equal(C.topeCodexMin({}, 'completa'), 40);
  assert.equal(C.topeCodexMin(null, 'diff'), 10);
});
