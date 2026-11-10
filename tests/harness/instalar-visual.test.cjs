// tests/harness/instalar-visual.test.cjs — puerta visual en la instalación y la configuración (capa 3).
//
// Qué protege:
//   · `instalar.cjs visual --proyecto`: en seco no escribe; con --aplicar copia las plantillas byte a byte y el DESIGN.md
//     si falta, NUNCA pisa un archivo del proyecto, agrega las exclusiones de evidencia con la misma lista que
//     uaeh-ignorar.cjs (--local: al archivo privado del clon) y es idempotente.
//   · `instalar.cjs visual --registrar-skills`: el borrador del catálogo propio propone un rol por skill, respeta el
//     silenciado de settings.json y la marca «manual», no pisa uno existente (salvo --reemplazar, con respaldo) y lo que
//     escribe pasa el comprobador del catálogo (los dos hablan el mismo formato).
//   · `uaeh-config.cjs catalogo-visual` y la validación de visual.catalogo (solo ruta absoluta).
// Hermético: casa temporal de tests/helpers/entorno.cjs; git con configuración global temporal.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr, escribir, git } = require('../helpers/entorno.cjs');

const INSTALAR = path.join(RAIZ_HARNESS, 'scripts', 'instalar.cjs');
const CONFIG = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs');
const COMPROBAR = path.join(RAIZ_HARNESS, 'skills', 'uae-visual', 'scripts', 'comprobar-catalogo.cjs');
const SKILL = path.join(RAIZ_HARNESS, 'skills', 'uae-visual');
const GENERICO = path.join(SKILL, 'referencias', 'catalogo.md');
const { LINEAS } = require(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-ignorar.cjs'));
const { parsearArgumentos, PLANTILLAS_VISUAL, rolVisual } = require(INSTALAR);

const instalar = (e, args) => {
  const r = correr(INSTALAR, [...args, '--json'], { env: e.env, cwd: e.proyecto });
  const informe = r.json();
  assert.ok(informe, `salida no JSON: ${r.stdout}\n${r.stderr}`);
  return { status: r.status, informe, tipos: informe.acciones.map((a) => a.tipo), acciones: informe.acciones };
};
const repo = (e) => { git(e.proyecto, ['init', '-q'], e.env); return e.proyecto; };

// ── Argumentos ─────────────────────────────────────────────────────────────────────────

test('visual: argumentos válidos e inválidos', () => {
  assert.equal(parsearArgumentos(['visual', '--proyecto', 'x']).proyecto, 'x');
  assert.equal(parsearArgumentos(['visual', '--registrar-skills', '--reemplazar']).reemplazar, true);
  assert.equal(parsearArgumentos(['visual', '--proyecto', 'x', '--local', '--aplicar']).local, true);
  const errores = [
    [['visual'], /--proyecto <carpeta> o --registrar-skills/],
    [['visual', '--proyecto'], /falta la carpeta de --proyecto/],
    [['visual', '--proyecto', '--aplicar'], /falta la carpeta de --proyecto/],
    [['visual', '--registrar-skills', '--local'], /--local solo aplica junto con --proyecto/],
    [['visual', '--proyecto', 'x', '--reemplazar'], /--reemplazar solo aplica a --registrar-skills/],
    [['codex', '--proyecto', 'x'], /solo aplican a visual/],
    [['git-guard', '--registrar-skills'], /solo aplican a visual/],
  ];
  for (const [argv, re] of errores) assert.throws(() => parsearArgumentos(argv), re, argv.join(' '));
});

test('visual sin opciones: sale 2 con el uso', () => {
  const e = entornoTemporal();
  try {
    const r = correr(INSTALAR, ['visual'], { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /visual \[--proyecto <carpeta> \[--local\]\] \[--registrar-skills \[--reemplazar\]\]/);
  } finally { e.limpiar(); }
});

// ── --proyecto ─────────────────────────────────────────────────────────────────────────

test('visual --proyecto: en seco no escribe nada y dice qué haría', () => {
  const e = entornoTemporal();
  try {
    repo(e);
    const r = instalar(e, ['visual', '--proyecto', e.proyecto]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.tipos, ['HARÍA', 'HARÍA', 'HARÍA', 'HARÍA', 'NOTA']);
    assert.deepEqual(fs.readdirSync(e.proyecto).filter((n) => n !== '.git'), []);
    assert.match(r.acciones[4].detalle, /npm i -D @playwright\/test@1\.63\.0 @axe-core\/playwright@4\.13\.0/);
  } finally { e.limpiar(); }
});

test('visual --proyecto --aplicar: plantillas idénticas, DESIGN.md, exclusiones de uaeh-ignorar e idempotente', () => {
  const e = entornoTemporal();
  try {
    repo(e);
    const r = instalar(e, ['visual', '--proyecto', e.proyecto, '--aplicar']);
    assert.equal(r.status, 0, JSON.stringify(r.acciones));
    assert.deepEqual(r.tipos, ['HECHO', 'HECHO', 'HECHO', 'HECHO', 'NOTA']);
    for (const [origen, destino] of PLANTILLAS_VISUAL) {
      assert.ok(fs.readFileSync(path.join(SKILL, origen)).equals(fs.readFileSync(path.join(e.proyecto, ...destino.split('/')))), `${destino} no es idéntica a ${origen}`);
    }
    const ignorados = fs.readFileSync(path.join(e.proyecto, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const l of LINEAS) assert.ok(ignorados.includes(l), `.gitignore sin ${l}`);
    assert.match(r.acciones[3].detalle, /OK: git ignora los \d+ tipos de evidencia/);
    const otra = instalar(e, ['visual', '--proyecto', e.proyecto, '--aplicar']);
    assert.deepEqual(otra.tipos, ['SIN CAMBIOS', 'SIN CAMBIOS', 'SIN CAMBIOS', 'SIN CAMBIOS', 'NOTA']);
  } finally { e.limpiar(); }
});

test('visual --proyecto --aplicar: NUNCA pisa un archivo del proyecto (config distinta, DESIGN.md propio)', () => {
  const e = entornoTemporal();
  try {
    repo(e);
    escribir(path.join(e.proyecto, 'playwright.visual.config.ts'), '// mi config\n');
    escribir(path.join(e.proyecto, 'DESIGN.md'), '# Mi diseño\n');
    const r = instalar(e, ['visual', '--proyecto', e.proyecto, '--aplicar']);
    assert.equal(r.status, 0);
    assert.equal(r.tipos[0], 'NOTA');
    assert.match(r.acciones[0].detalle, /ya existe y difiere de la plantilla del plugin: no se toca/);
    assert.equal(r.tipos[2], 'NOTA');
    assert.match(r.acciones[2].detalle, /DESIGN\.md ya existe/);
    assert.equal(fs.readFileSync(path.join(e.proyecto, 'playwright.visual.config.ts'), 'utf8'), '// mi config\n');
    assert.equal(fs.readFileSync(path.join(e.proyecto, 'DESIGN.md'), 'utf8'), '# Mi diseño\n');
    assert.deepEqual(fs.readdirSync(e.proyecto).filter((n) => n.includes('uaeh-respaldo')), [], 'ni siquiera deja respaldos: no toca');
  } finally { e.limpiar(); }
});

test('visual --proyecto --local: las exclusiones van al archivo privado del clon, no al .gitignore', () => {
  const e = entornoTemporal();
  try {
    repo(e);
    const r = instalar(e, ['visual', '--proyecto', e.proyecto, '--local', '--aplicar']);
    assert.equal(r.status, 0, JSON.stringify(r.acciones));
    assert.ok(!fs.existsSync(path.join(e.proyecto, '.gitignore')));
    const exclude = fs.readFileSync(path.join(e.proyecto, '.git', 'info', 'exclude'), 'utf8');
    for (const l of LINEAS) assert.ok(exclude.includes(l), `.git/info/exclude sin ${l}`);
  } finally { e.limpiar(); }
});

test('visual --proyecto: carpeta inexistente es ERROR (1); carpeta sin git es solo una NOTA', () => {
  const e = entornoTemporal();
  try {
    const falta = instalar(e, ['visual', '--proyecto', path.join(e.dir, 'no-existe')]);
    assert.equal(falta.status, 1);
    assert.equal(falta.tipos[0], 'ERROR');
    const sinGit = instalar(e, ['visual', '--proyecto', e.proyecto, '--aplicar']);
    assert.equal(sinGit.status, 0, JSON.stringify(sinGit.acciones));
    assert.ok(sinGit.acciones.some((a) => a.tipo === 'NOTA' && /no es un repositorio git/.test(a.detalle)));
  } finally { e.limpiar(); }
});

// ── --registrar-skills ─────────────────────────────────────────────────────────────────

function skillsDePrueba(e) {
  const skill = (nombre, descripcion, extra = '') => escribir(path.join(e.claudeHome, 'skills', nombre, 'SKILL.md'), `---\nname: ${nombre}\ndescription: ${descripcion}\n${extra}---\ncuerpo\n`);
  skill('anima-ui', 'Animaciones y transiciones de interfaz con propósito');
  skill('escena-3d', 'Escenas con three.js y WebGL');
  skill('montaje', 'Edición de video por composición', 'disable-model-invocation: true\n');
  skill('preset-sobrio', 'Dirección visual minimalista para frontend');
  skill('carteles', 'Pósters y piezas estáticas en PNG o PDF');
  skill('apagada', 'Diseño de landing que el usuario apagó');
  skill('hojas-de-calculo', 'Lee y escribe archivos xlsx');
  escribir(path.join(e.claudeHome, 'settings.json'), JSON.stringify({ skillOverrides: { 'preset-sobrio': 'name-only', apagada: 'off' } }));
}

test('rolVisual: propone el rol por nombre y descripción; lo que no es visual queda fuera', () => {
  assert.equal(rolVisual('hyperframes', 'videos HTML'), 'video');
  assert.equal(rolVisual('threejs-builder', ''), '3D');
  assert.equal(rolVisual('gsap-core', ''), 'movimiento');
  assert.equal(rolVisual('canvas-design', 'Create visual art in .png'), 'imagen');
  assert.equal(rolVisual('minimalist-ui', ''), 'estilo');
  assert.equal(rolVisual('xlsx', 'Spreadsheets'), null);
  assert.equal(rolVisual('pdf', 'Read and create PDF files'), null);
});

test('visual --registrar-skills: en seco propone el borrador sin escribir; respeta silenciado, manual y apagadas', () => {
  const e = entornoTemporal();
  try {
    skillsDePrueba(e);
    const r = instalar(e, ['visual', '--registrar-skills']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.tipos, ['HARÍA']);
    assert.match(r.acciones[0].detalle, /5 skill\(s\): video 1 · 3D 1 · movimiento 1 · imagen 1 · estilo 1/);
    assert.ok(!fs.existsSync(path.join(e.uaehHome, 'catalogo-visual.md')));
    const indice = r.acciones[0].contenido;
    for (const linea of ['uaeh-harness:uae-visual | plugin | on', 'anima-ui | local | on', 'escena-3d | local | on', 'montaje | local | manual', 'preset-sobrio | local | name-only', 'carteles | local | on']) {
      assert.ok(indice.includes(linea), `el borrador no trae «${linea}»`);
    }
    assert.ok(!indice.includes('apagada') && !indice.includes('hojas-de-calculo'));
  } finally { e.limpiar(); }
});

test('visual --registrar-skills --aplicar: lo que escribe pasa el comprobador; no pisa sin --reemplazar; --reemplazar respalda', () => {
  const e = entornoTemporal();
  try {
    skillsDePrueba(e);
    const destino = path.join(e.uaehHome, 'catalogo-visual.md');
    const r = instalar(e, ['visual', '--registrar-skills', '--aplicar']);
    assert.equal(r.status, 0, JSON.stringify(r.acciones));
    assert.deepEqual(r.tipos, ['HECHO']);
    assert.ok(fs.existsSync(destino));
    const vigente = correr(CONFIG, ['catalogo-visual'], { env: e.env, cwd: e.proyecto });
    assert.equal(path.resolve(vigente.stdout.trim()), path.resolve(destino), 'el catálogo vigente pasa a ser el propio');
    const comprobado = correr(COMPROBAR, [], { env: e.env, cwd: e.proyecto });
    assert.equal(comprobado.status, 0, comprobado.stdout);
    assert.match(comprobado.stdout, /^OK: 6 skills en el índice, 1 silenciadas/);

    fs.appendFileSync(destino, '\nmis notas\n');
    const otra = instalar(e, ['visual', '--registrar-skills', '--aplicar']);
    assert.deepEqual(otra.tipos, ['SIN CAMBIOS']);
    assert.match(fs.readFileSync(destino, 'utf8'), /mis notas/);
    const reemplazo = instalar(e, ['visual', '--registrar-skills', '--reemplazar', '--aplicar']);
    assert.deepEqual(reemplazo.tipos, ['RESPALDO', 'HECHO']);
    assert.match(fs.readFileSync(reemplazo.acciones[0].ruta, 'utf8'), /mis notas/, 'el respaldo conserva lo editado');
    assert.doesNotMatch(fs.readFileSync(destino, 'utf8'), /mis notas/);
  } finally { e.limpiar(); }
});

test('visual --registrar-skills sin skills locales: borrador solo con la puerta del plugin y una NOTA', () => {
  const e = entornoTemporal();
  try {
    const r = instalar(e, ['visual', '--registrar-skills']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.tipos, ['NOTA', 'HARÍA']);
    assert.match(r.acciones[1].contenido, /uaeh-harness:uae-visual \| plugin \| on/);
  } finally { e.limpiar(); }
});

// ── catalogo-visual y visual.catalogo ──────────────────────────────────────────────────

test('uaeh-config catalogo-visual: genérico → propio de la carpeta de estado → visual.catalogo (absoluta) de la configuración', () => {
  const e = entornoTemporal();
  try {
    const vigente = () => {
      const r = correr(CONFIG, ['catalogo-visual'], { env: e.env, cwd: e.proyecto });
      assert.equal(r.status, 0, r.stderr);
      return path.resolve(r.stdout.trim());
    };
    assert.equal(vigente(), path.resolve(GENERICO));
    escribir(path.join(e.uaehHome, 'catalogo-visual.md'), '# mío\n');
    assert.equal(vigente(), path.resolve(e.uaehHome, 'catalogo-visual.md'));
    const fijado = path.join(e.dir, 'otro sitio', 'catálogo.md');
    escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ visual: { catalogo: fijado } }));
    assert.equal(vigente(), path.resolve(fijado), 'si el usuario lo fijó, se respeta aunque aún no exista');
    assert.equal(correr(CONFIG, ['catalogo-visual', 'sobra'], { env: e.env, cwd: e.proyecto }).status, 64);
  } finally { e.limpiar(); }
});

test('visual.catalogo relativo o con ~ se ignora con aviso (como arnes.extra)', () => {
  const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
  for (const malo of ['catalogo.md', '~/catalogo.md', 42]) {
    const e = entornoTemporal();
    try {
      escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ visual: { catalogo: malo } }));
      const r = correr(CONFIG, ['catalogo-visual'], { env: e.env, cwd: e.proyecto });
      assert.equal(path.resolve(r.stdout.trim()), path.resolve(GENERICO), `con ${JSON.stringify(malo)}`);
    } finally { e.limpiar(); }
  }
  assert.equal(typeof configLib.cargarConfig, 'function');
});
