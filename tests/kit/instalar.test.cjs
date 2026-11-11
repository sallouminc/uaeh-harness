// Pruebas de plugins/uaeh-kit/scripts/instalar.cjs
//
// Se ejecuta el script real (correr()) en una casa temporal y se comprueba también en disco. Cuando una
// prueba necesita controlar qué archivos trae el plugin (los orígenes de la barra de estado, la versión),
// usa un «plugin falso»: una copia mínima del plugin dentro de la casa temporal. Así no dependen de lo que
// otros hayan escrito o dejado a medias en plugins/uaeh-kit.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'instalar.cjs');
const COMUN = require(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'));
const INST = require(SCRIPT);
const VERSION = COMUN.versionPlugin(); // la que escribe el instalador, sea cual sea el manifiesto del plugin
const VIEJA = VERSION === '0.0.1' ? '0.0.2' : '0.0.1';
const SNIPPET = JSON.parse(fs.readFileSync(path.join(RAIZ_KIT, 'templates', 'settings-snippet.json'), 'utf8'));
const MODELO_SUBAGENTES = SNIPPET.env.CLAUDE_CODE_SUBAGENT_MODEL;
const BOM = String.fromCharCode(0xFEFF); // marca de orden de bytes UTF-8 (U+FEFF)
const ORIGENES_BARRA = ['statusline/statusline.js', 'statusline/claude-status-fetch.js', 'scripts/ventana-contexto.cjs'];

// ── Ayudas ────────────────────────────────────────────────────────────────────────────────

function conCasa(fn) {
  const e = entornoTemporal('uaeh-inst-');
  try { return fn(e); } finally { e.limpiar(); }
}

function instalar(e, args, plugin) {
  return correr(plugin ? plugin.script : SCRIPT, args, { env: e.env, cwd: e.proyecto });
}

const leer = (ruta) => fs.readFileSync(ruta, 'utf8');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bloqueViejo = (v, cuerpo = 'contenido viejo') => `<!-- UAEH:BEGIN v${v} -->\n${cuerpo}\n<!-- UAEH:END -->`;
const contar = (texto, sub) => texto.split(sub).length - 1;

// Líneas de acción de la salida humana (las que empiezan por un TIPO).
function lineasDeAccion(r) {
  return r.stdout.split('\n').filter((l) => /^(HARÍA|HECHO|SIN CAMBIOS|RESPALDO|FALTA|ERROR)/.test(l));
}

// Respaldos de `base` dentro de `dir`, ordenados.
function respaldos(dir, base) {
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.uaeh-respaldo-`)).sort();
}

// Todos los archivos bajo `dir` (rutas relativas, ordenadas): sirve para demostrar que no se escribió nada.
function arbol(dir) {
  const salida = [];
  const recorrer = (d) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) recorrer(p); else salida.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  };
  recorrer(dir);
  return salida.sort();
}

// Bloque que el instalador debe escribir según la plantilla (oráculo independiente del script).
function bloqueEsperado(archivo, version = VERSION) {
  const crudo = fs.readFileSync(path.join(RAIZ_KIT, 'templates', archivo), 'utf8').replace(/\r\n/g, '\n');
  return crudo.split('{{VERSION}}').join(version).trim();
}

// Copia mínima del plugin dentro de la casa temporal, con la versión y los orígenes de barra que se pidan.
function pluginFalso(e, { version = '7.7.7', origenes = [] } = {}) {
  const raiz = path.join(e.dir, 'plugin-falso');
  fs.mkdirSync(path.join(raiz, 'scripts', 'lib'), { recursive: true });
  require('../helpers/entorno.cjs').copiarCarpeta(path.join(RAIZ_KIT, 'templates'), path.join(raiz, 'templates'));
  fs.copyFileSync(SCRIPT, path.join(raiz, 'scripts', 'instalar.cjs'));
  fs.copyFileSync(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'), path.join(raiz, 'scripts', 'lib', 'comun.cjs'));
  e.escribir(path.join(raiz, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'uaeh-kit', version }));
  for (const rel of origenes) e.escribir(path.join(raiz, ...rel.split('/')), `// ${rel} (archivo de prueba v${version})\n`);
  return { raiz, version, script: path.join(raiz, 'scripts', 'instalar.cjs') };
}

// ── claude-md ─────────────────────────────────────────────────────────────────────────────

test('claude-md en seco describe el cambio y no escribe nada', () => conCasa((e) => {
  const antes = arbol(e.dir);
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const r = instalar(e, ['claude-md']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^HARÍA +se añadiría el bloque v/m);
  const lineasPlantilla = bloqueEsperado('bloque-claude-md.md').split('\n').length;
  assert.ok(r.stdout.includes(`el bloque v${VERSION} (${lineasPlantilla} líneas) a ${destino}`), r.stdout);
  assert.match(r.stdout, /En seco: no se escribió nada/);
  assert.deepEqual(arbol(e.dir), antes, 'en seco no se crea ni se toca ningún archivo');

  const j = instalar(e, ['claude-md', '--json']).json();
  assert.deepEqual(Object.keys(j), ['subcomando', 'aplicado', 'acciones', 'codigo']);
  assert.equal(j.subcomando, 'claude-md');
  assert.equal(j.aplicado, false);
  assert.equal(j.codigo, 0);
  assert.equal(j.acciones.length, 1);
  assert.equal(j.acciones[0].tipo, 'HARÍA');
  assert.equal(j.acciones[0].ruta, destino);
  assert.match(j.acciones[0].detalle, /se añadiría el bloque/);
}));

test('claude-md --aplicar crea el CLAUDE.md global con el bloque; la segunda corrida no cambia nada ni respalda', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  let r = instalar(e, ['claude-md', '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^HECHO +bloque v/m);
  const texto = leer(destino);
  assert.equal(texto, `${bloqueEsperado('bloque-claude-md.md')}\n`, 'el archivo nuevo es exactamente el bloque de la plantilla');
  assert.ok(texto.startsWith(`<!-- UAEH:BEGIN v${VERSION} -->`));
  assert.ok(!texto.includes('{{VERSION}}'));
  assert.deepEqual(COMUN.bloqueUaeh(texto), { presente: true, version: VERSION });
  assert.deepEqual(respaldos(e.claudeHome, 'CLAUDE.md'), [], 'un archivo nuevo no tiene qué respaldar');

  r = instalar(e, ['claude-md', '--aplicar']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SIN CAMBIOS +sin cambios/m);
  assert.deepEqual(lineasDeAccion(r).filter((l) => !l.startsWith('SIN CAMBIOS')), []);
  assert.equal(leer(destino), texto);
  assert.deepEqual(respaldos(e.claudeHome, 'CLAUDE.md'), [], 'sin cambios no se crea respaldo');
}));

test('claude-md sobre un archivo con texto propio: añade al final tras una línea en blanco y respalda el original', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const bloque = bloqueEsperado('bloque-claude-md.md');
  const casos = [
    ['# Mis reglas\n\nuna línea mía\n', `# Mis reglas\n\nuna línea mía\n\n${bloque}\n`],  // con un salto final
    ['# Mis reglas\n\nuna línea mía', `# Mis reglas\n\nuna línea mía\n\n${bloque}\n`],    // sin salto final
    ['# Mis reglas\n\nuna línea mía\n\n\n', `# Mis reglas\n\nuna línea mía\n\n\n${bloque}\n`], // ya hay línea en blanco
  ];
  for (const [previo, esperado] of casos) {
    fs.rmSync(destino, { force: true });
    e.escribir(destino, previo);
    const r = instalar(e, ['claude-md', '--aplicar']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(leer(destino), esperado);
    const bak = respaldos(e.claudeHome, 'CLAUDE.md');
    assert.equal(bak.length, 1);
    assert.equal(leer(path.join(e.claudeHome, bak[0])), previo, 'el respaldo es el contenido original');
    fs.rmSync(path.join(e.claudeHome, bak[0]));
  }
}));

test('claude-md con un bloque viejo lo reemplaza: queda UN solo bloque, el texto de alrededor intacto, y un respaldo', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const previo = `# Mis reglas\n\nuna línea mía\n\n${bloqueViejo(VIEJA)}\n\ndespués del bloque\n`;
  e.escribir(destino, previo);

  let r = instalar(e, ['claude-md']);
  assert.match(r.stdout, new RegExp(`se reemplazaría v${escRe(VIEJA)} → v${escRe(VERSION)}`));
  assert.equal(leer(destino), previo, 'en seco no cambia el archivo');

  r = instalar(e, ['claude-md', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  const nuevo = leer(destino);
  assert.equal(contar(nuevo, 'UAEH:BEGIN'), 1);
  assert.equal(contar(nuevo, 'UAEH:END'), 1);
  assert.ok(!nuevo.includes('contenido viejo'));
  assert.equal(nuevo, `# Mis reglas\n\nuna línea mía\n\n${bloqueEsperado('bloque-claude-md.md')}\n\ndespués del bloque\n`);
  assert.deepEqual(COMUN.bloqueUaeh(nuevo), { presente: true, version: VERSION });
  const bak = respaldos(e.claudeHome, 'CLAUDE.md');
  assert.deepEqual(bak, ['CLAUDE.md.uaeh-respaldo-20261030-200000'], 'sello con la hora fija de la prueba (UTC)');
  assert.equal(leer(path.join(e.claudeHome, bak[0])), previo);

  // un bloque sin versión también se reemplaza
  e.escribir(destino, '<!-- UAEH:BEGIN -->\nviejo sin versión\n<!-- UAEH:END -->\n');
  r = instalar(e, ['claude-md']);
  assert.match(r.stdout, new RegExp(`se reemplazaría \\(sin versión\\) → v${escRe(VERSION)}`));
}));

test('dos respaldos en el mismo segundo no se pisan: el segundo lleva sufijo y el primero queda intacto', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const primero = `${bloqueViejo(VIEJA, 'primera versión')}\n`;
  e.escribir(destino, primero);
  instalar(e, ['claude-md', '--aplicar']);
  const segundo = `${bloqueViejo(VIEJA, 'segunda versión')}\n`;
  e.escribir(destino, segundo);
  const r = instalar(e, ['claude-md', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(respaldos(e.claudeHome, 'CLAUDE.md'), [
    'CLAUDE.md.uaeh-respaldo-20261030-200000',
    'CLAUDE.md.uaeh-respaldo-20261030-200000-2',
  ]);
  assert.equal(leer(path.join(e.claudeHome, 'CLAUDE.md.uaeh-respaldo-20261030-200000')), primero);
  assert.equal(leer(path.join(e.claudeHome, 'CLAUDE.md.uaeh-respaldo-20261030-200000-2')), segundo);
}));

test('claude-md --quitar deja el texto original intacto, byte por byte, y quita a lo sumo una línea en blanco', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const original = '# Mi archivo\n\nReglas propias.\n';
  e.escribir(destino, original);
  instalar(e, ['claude-md', '--aplicar']);
  assert.notEqual(leer(destino), original);

  let r = instalar(e, ['claude-md', '--quitar']);
  assert.match(r.stdout, /^HARÍA +se quitaría el bloque v/m);
  assert.ok(leer(destino).includes('UAEH:BEGIN'), 'en seco no quita nada');

  r = instalar(e, ['claude-md', '--quitar', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(leer(destino), original);

  r = instalar(e, ['claude-md', '--quitar', '--aplicar']);
  assert.match(r.stdout, /^SIN CAMBIOS +sin cambios/m, 'sin bloque no hay nada que quitar');
  assert.equal(leer(destino), original);

  // dónde estaba el bloque define qué línea en blanco se va
  const b = bloqueViejo('0.0.9', 'regla');
  const casos = [
    [`A\n\n${b}\n`, 'A\n'],
    [`A\n\n${b}\n\nB\n`, 'A\n\nB\n'],
    [`${b}\n\nB\n`, 'B\n'],
    [`${b}\n`, ''],
    [`A\n${b}\nB\n`, 'A\nB\n'],
    [`A\r\n\r\n${b.replace(/\n/g, '\r\n')}\r\n`, 'A\r\n'],
  ];
  for (const [entrada, salida] of casos) {
    e.escribir(destino, entrada);
    r = instalar(e, ['claude-md', '--quitar', '--aplicar']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(leer(destino), salida, JSON.stringify(entrada));
  }
}));

test('claude-md respeta los fines de línea CRLF y el BOM del archivo', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const crlf = '# Título\r\n\r\nTexto\r\n';
  e.escribir(destino, crlf);
  instalar(e, ['claude-md', '--aplicar']);
  const t = leer(destino);
  assert.ok(t.includes('UAEH:BEGIN'));
  assert.ok(!/(^|[^\r])\n/.test(t), 'ningún salto de línea suelto: todo el archivo sigue en CRLF');
  assert.equal(instalar(e, ['claude-md', '--aplicar']).stdout.includes('SIN CAMBIOS'), true, 'idempotente también en CRLF');
  instalar(e, ['claude-md', '--quitar', '--aplicar']);
  assert.equal(leer(destino), crlf);

  const conBom = `${BOM}# Con BOM\n`;
  e.escribir(destino, conBom);
  instalar(e, ['claude-md', '--aplicar']);
  assert.ok(leer(destino).startsWith(`${BOM}# Con BOM`), 'el BOM se conserva');
  instalar(e, ['claude-md', '--quitar', '--aplicar']);
  assert.equal(leer(destino), conBom);
}));

test('un archivo que no es UTF-8 válido no se toca (se perderían sus bytes); el UTF-8 válido sobrevive intacto', () => conCasa((e) => {
  const claudeMd = path.join(e.claudeHome, 'CLAUDE.md');
  const latin1 = Buffer.from('# Título con acento: caf\xe9\n', 'latin1'); // 0xE9 suelto: no es UTF-8
  fs.writeFileSync(claudeMd, latin1);
  for (const args of [['claude-md', '--aplicar'], ['claude-md', '--quitar', '--aplicar']]) {
    const r = instalar(e, args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^ERROR +no se pudo leer \(no es UTF-8 válido\); no se tocó el archivo/m);
  }
  assert.ok(fs.readFileSync(claudeMd).equals(latin1), 'los bytes originales quedan como estaban');
  assert.deepEqual(respaldos(e.claudeHome, 'CLAUDE.md'), []);

  const settings = path.join(e.claudeHome, 'settings.json');
  const sucio = Buffer.concat([Buffer.from('{"nota":"caf'), Buffer.from([0xe9]), Buffer.from('"}')]);
  fs.writeFileSync(settings, sucio);
  const r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /no es UTF-8 válido/);
  assert.ok(fs.readFileSync(settings).equals(sucio));

  const unicode = '# Título ñ — 日本語 🚀\n\nTexto con «comillas» y acentos áéíóú.\n';
  fs.writeFileSync(claudeMd, unicode, 'utf8');
  instalar(e, ['claude-md', '--aplicar']);
  assert.ok(leer(claudeMd).startsWith(unicode), 'lo que ya estaba queda igual, byte por byte');
  instalar(e, ['claude-md', '--quitar', '--aplicar']);
  assert.equal(leer(claudeMd), unicode);
}));

test('claude-md con marcadores dañados: ERROR, código 1 y el archivo queda como estaba', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'CLAUDE.md');
  const dañados = [
    '# X\n<!-- UAEH:BEGIN v1 -->\nsin fin\n',
    '# X\n<!-- UAEH:END -->\ncosa\n<!-- UAEH:BEGIN v1 -->\n',
    `# X\n${bloqueViejo('1')}\n${bloqueViejo('2')}\n`,
  ];
  for (const texto of dañados) {
    e.escribir(destino, texto);
    for (const args of [['claude-md', '--aplicar'], ['claude-md', '--quitar', '--aplicar']]) {
      const r = instalar(e, args);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /^ERROR +bloque UAEH dañado/m);
      assert.equal(leer(destino), texto);
    }
    assert.deepEqual(respaldos(e.claudeHome, 'CLAUDE.md'), []);
  }
}));

test('claude-md --proyecto escribe en <dir>/CLAUDE.md y no toca el global; --idioma en usa la plantilla inglesa', () => conCasa((e) => {
  const r = instalar(e, ['claude-md', '--proyecto', e.proyecto, '--idioma', 'en', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  const delProyecto = path.join(e.proyecto, 'CLAUDE.md');
  assert.equal(leer(delProyecto), `${bloqueEsperado('bloque-claude-md.en.md')}\n`);
  assert.match(leer(delProyecto), /UAEH method/);
  assert.equal(fs.existsSync(path.join(e.claudeHome, 'CLAUDE.md')), false, 'el CLAUDE.md global no se crea');

  // sin --idioma manda la configuración del usuario; con --idioma, el flag
  e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ idioma: 'en' }));
  instalar(e, ['claude-md', '--aplicar']);
  assert.match(leer(path.join(e.claudeHome, 'CLAUDE.md')), /UAEH method/);
  const r2 = instalar(e, ['claude-md', '--idioma', 'es', '--aplicar']);
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(leer(path.join(e.claudeHome, 'CLAUDE.md')), /Método UAEH/);
  assert.equal(respaldos(e.claudeHome, 'CLAUDE.md').length, 1);

  // por defecto, español
  fs.rmSync(path.join(e.uaehHome, 'uaeh.config.json'));
  fs.rmSync(path.join(e.claudeHome, 'CLAUDE.md'));
  instalar(e, ['claude-md', '--aplicar']);
  assert.match(leer(path.join(e.claudeHome, 'CLAUDE.md')), /Método UAEH/);
}));

test('claude-md rechaza opciones inválidas con código 2', () => conCasa((e) => {
  for (const args of [
    ['claude-md', '--idioma', 'fr'],
    ['claude-md', '--global', '--proyecto', e.proyecto],
    ['claude-md', '--proyecto'],
    ['claude-md', 'sobra'],
    ['claude-md', '--rara'],
  ]) {
    const r = instalar(e, args);
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.stdout}`);
    assert.match(r.stderr, /Uso: node instalar\.cjs/);
  }
  assert.equal(instalar(e, ['claude-md', '--global']).status, 0, '--global es el destino por defecto, dicho explícitamente');
}));

// ── settings ──────────────────────────────────────────────────────────────────────────────

test('settings sin archivo: en seco no crea nada; --aplicar lo crea con las dos claves; la segunda corrida no cambia', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  let r = instalar(e, ['settings']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^HARÍA +env\\.CLAUDE_CODE_SUBAGENT_MODEL: agregado \\("${escRe(MODELO_SUBAGENTES)}"\\)`, 'm'));
  assert.match(r.stdout, new RegExp(`^HARÍA +autoCompactWindow: agregado \\(${SNIPPET.autoCompactWindow}\\)`, 'm'));
  assert.equal(fs.existsSync(destino), false);

  r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  const texto = leer(destino);
  assert.deepEqual(JSON.parse(texto), SNIPPET);
  assert.ok(texto.endsWith('}\n'), 'salto de línea final');
  assert.ok(texto.includes('\n  "env": {'), 'sangría de 2 espacios');
  assert.deepEqual(respaldos(e.claudeHome, 'settings.json'), []);

  r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 0);
  assert.equal(lineasDeAccion(r).length, 2);
  assert.ok(lineasDeAccion(r).every((l) => l.startsWith('SIN CAMBIOS')));
  assert.match(r.stdout, /autoCompactWindow: ya definido \(\d+\)/);
  assert.equal(leer(destino), texto);
  assert.deepEqual(respaldos(e.claudeHome, 'settings.json'), []);
}));

test('settings con env ya definido: dice «ya definido», no lo pisa, conserva las demás claves y respalda', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  const previo = JSON.stringify({
    model: 'opus',
    env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', OTRA: '1' },
    permissions: { allow: ['Bash(ls:*)'] },
  }, null, 2);
  e.escribir(destino, previo);
  const r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^SIN CAMBIOS +env\.CLAUDE_CODE_SUBAGENT_MODEL: ya definido \("opus"\)/m);
  assert.match(r.stdout, /^HECHO +autoCompactWindow: agregado/m);
  const s = JSON.parse(leer(destino));
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, 'opus', 'el valor del usuario no se pisa');
  assert.equal(s.env.OTRA, '1');
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(s.autoCompactWindow, SNIPPET.autoCompactWindow);
  const bak = respaldos(e.claudeHome, 'settings.json');
  assert.equal(bak.length, 1);
  assert.equal(leer(path.join(e.claudeHome, bak[0])), previo);
}));

test('settings con modelSettings.*.autoCompactWindow no añade autoCompactWindow', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  e.escribir(destino, JSON.stringify({ modelSettings: { 'claude-x': { autoCompactWindow: 500000 } } }));
  const r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /autoCompactWindow: ya definido \(modelSettings\.claude-x\.autoCompactWindow = 500000\)/);
  const s = JSON.parse(leer(destino));
  assert.equal(s.autoCompactWindow, undefined);
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, MODELO_SUBAGENTES, 'lo que sí falta se agrega');
  assert.equal(s.modelSettings['claude-x'].autoCompactWindow, 500000);
}));

test('settings con todo definido: sin cambios, sin respaldo y el archivo queda idéntico byte por byte', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  const previo = '{ "env": {"CLAUDE_CODE_SUBAGENT_MODEL":"haiku"}, "autoCompactWindow": 300000 }';
  e.escribir(destino, previo);
  const r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 0);
  assert.ok(lineasDeAccion(r).every((l) => l.startsWith('SIN CAMBIOS')), r.stdout);
  assert.equal(leer(destino), previo, 'ni se reformatea');
  assert.deepEqual(respaldos(e.claudeHome, 'settings.json'), []);
}));

test('settings roto: código 1, imprime el bloque completo para pegar a mano y no toca el archivo', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  const roto = '{ "env": { esto no es json';
  e.escribir(destino, roto);
  let r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^ERROR +/m);
  assert.match(r.stdout, /Pega a mano/);
  assert.ok(r.stdout.includes(destino));
  assert.ok(r.stdout.includes(`"CLAUDE_CODE_SUBAGENT_MODEL": "${MODELO_SUBAGENTES}"`), 'el bloque completo en stdout');
  assert.ok(r.stdout.includes(`"autoCompactWindow": ${SNIPPET.autoCompactWindow}`));
  assert.equal(leer(destino), roto);
  assert.deepEqual(respaldos(e.claudeHome, 'settings.json'), []);

  const j = instalar(e, ['settings', '--json']).json();
  assert.equal(j.codigo, 1);
  assert.equal(j.acciones[0].tipo, 'ERROR');
  assert.deepEqual(JSON.parse(j.acciones[0].snippet), SNIPPET);

  // raíz que no es un objeto, o env que no lo es: tampoco se toca
  for (const texto of ['[1, 2]', '{ "env": "texto" }']) {
    e.escribir(destino, texto);
    r = instalar(e, ['settings', '--aplicar']);
    assert.equal(r.status, 1, texto);
    assert.equal(leer(destino), texto);
  }
}));

test('settings con el archivo vacío lo trata como {} (con respaldo)', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  e.escribir(destino, '  \n');
  const r = instalar(e, ['settings', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(JSON.parse(leer(destino)), SNIPPET);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, 1);
}));

// ── statusline ────────────────────────────────────────────────────────────────────────────

test('statusline copia los 4 archivos al espejo, escribe VERSION y registra la barra con la ruta del espejo', () => conCasa((e) => {
  const p = pluginFalso(e, { version: '7.7.7', origenes: ORIGENES_BARRA });
  const estable = path.join(e.uaehHome, 'estable');
  const settings = path.join(e.claudeHome, 'settings.json');
  let r = instalar(e, ['statusline'], p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^HARÍA +copiar statusline\/statusline\.js/m);
  assert.match(r.stdout, /^HARÍA +copiar package\.json/m);
  assert.equal(fs.existsSync(estable), false, 'en seco no se crea el espejo');
  assert.equal(fs.existsSync(settings), false);

  r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const rel of [...ORIGENES_BARRA, 'scripts/lib/comun.cjs']) {
    const destino = path.join(estable, ...rel.split('/'));
    assert.ok(fs.existsSync(destino), `falta ${rel} en el espejo`);
    assert.equal(leer(destino), leer(path.join(p.raiz, ...rel.split('/'))), rel);
  }
  assert.equal(leer(path.join(estable, 'VERSION')).trim(), '7.7.7');
  assert.match(r.stdout, /^HECHO +package\.json: copiado/m);
  assert.equal(leer(path.join(estable, 'package.json')), '{"type":"commonjs"}\n', 'package.json del espejo: una línea y salto final');
  const comando = `node "${estable.replace(/\\/g, '/')}/statusline/statusline.js"`;
  assert.deepEqual(JSON.parse(leer(settings)).statusLine, { type: 'command', command: comando });
  assert.ok(!JSON.parse(leer(settings)).statusLine.command.includes('\\'), 'la ruta del comando va con /');

  // segunda corrida: todo igual, ningún respaldo
  r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 0);
  assert.ok(lineasDeAccion(r).every((l) => l.startsWith('SIN CAMBIOS')), r.stdout);
  assert.match(r.stdout, /statusLine: ya configurada/);
  assert.deepEqual(respaldos(e.claudeHome, 'settings.json'), []);

  // un archivo del espejo editado a mano se actualiza, pero antes se respalda
  const editado = path.join(estable, 'statusline', 'statusline.js');
  fs.writeFileSync(editado, '// editado a mano\n');
  r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^RESPALDO /m);
  assert.match(r.stdout, /^HECHO +statusline\/statusline\.js: actualizado/m);
  const bak = respaldos(path.join(estable, 'statusline'), 'statusline.js');
  assert.equal(bak.length, 1);
  assert.equal(leer(path.join(estable, 'statusline', bak[0])), '// editado a mano\n');
  assert.equal(leer(editado), leer(path.join(p.raiz, 'statusline', 'statusline.js')));

  // el package.json del espejo también se restaura (con respaldo) si alguien lo cambia
  const pkg = path.join(estable, 'package.json');
  fs.writeFileSync(pkg, '{"type":"module"}\n');
  r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^HECHO +package\.json: actualizado/m);
  assert.equal(leer(pkg), '{"type":"commonjs"}\n');
  const bakPkg = respaldos(estable, 'package.json');
  assert.equal(bakPkg.length, 1);
  assert.equal(leer(path.join(estable, bakPkg[0])), '{"type":"module"}\n');
}));

test('el package.json del espejo hace que la barra cargue aunque una carpeta ancestro declare "type":"module"', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  const barra = "const fs = require('fs');\nconsole.log(`barra cargada ${typeof fs.readFileSync}`);\n"; // CommonJS de verdad
  e.escribir(path.join(p.raiz, 'statusline', 'statusline.js'), barra);
  e.escribir(path.join(e.dir, 'package.json'), '{ "type": "module" }\n'); // ancestro del espejo: la casa temporal cuelga de e.dir
  const estable = path.join(e.uaehHome, 'estable');
  const corrida = () => correr(path.join(estable, 'statusline', 'statusline.js'), [], { env: e.env, cwd: e.proyecto });

  // sin el package.json del espejo el ancestro rompe la carga: así se reproduce el fallo que se quiere evitar
  e.escribir(path.join(estable, 'statusline', 'statusline.js'), barra);
  let r = corrida();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /require is not defined/);

  fs.rmSync(estable, { recursive: true, force: true });
  const inst = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(inst.status, 0, inst.stdout);
  r = corrida();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'barra cargada function');
}));

test('statusline con orígenes que faltan: los reporta como FALTA, sigue, y VERSION sí se escribe', () => conCasa((e) => {
  const p = pluginFalso(e, { version: '7.7.7', origenes: ['statusline/statusline.js'] });
  const estable = path.join(e.uaehHome, 'estable');
  const r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^FALTA +statusline\/claude-status-fetch\.js: no existe en el plugin/m);
  assert.match(r.stdout, /^FALTA +scripts\/ventana-contexto\.cjs: no existe en el plugin/m);
  assert.ok(fs.existsSync(path.join(estable, 'statusline', 'statusline.js')));
  assert.ok(fs.existsSync(path.join(estable, 'scripts', 'lib', 'comun.cjs')));
  assert.equal(fs.existsSync(path.join(estable, 'statusline', 'claude-status-fetch.js')), false);
  assert.equal(fs.existsSync(path.join(estable, 'scripts', 'ventana-contexto.cjs')), false);
  assert.equal(leer(path.join(estable, 'VERSION')).trim(), '7.7.7');
  assert.equal(leer(path.join(estable, 'package.json')), '{"type":"commonjs"}\n', 'también se escribe aunque falten orígenes');
  assert.ok(JSON.parse(leer(path.join(e.claudeHome, 'settings.json'))).statusLine, 'la barra se registra igual: así lo pide el diseño');
  const j = instalar(e, ['statusline', '--json'], p).json();
  assert.equal(j.acciones.filter((a) => a.tipo === 'FALTA').length, 2);
}));

test('statusline con una barra propia en settings: no se toca, se imprime el bloque alternativo y no hay respaldo', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  const destino = path.join(e.claudeHome, 'settings.json');
  const propia = { theme: 'dark', statusLine: { type: 'command', command: 'node /otra/barra.js' } };
  const previo = JSON.stringify(propia, null, 2);
  e.escribir(destino, previo);
  const r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^SIN CAMBIOS +statusLine: barra propia; no se toca/m);
  assert.ok(r.stdout.includes('"statusLine"') && r.stdout.includes('/estable/statusline/statusline.js'), 'imprime el bloque para que el usuario decida');
  assert.equal(leer(destino), previo);
  assert.deepEqual(respaldos(e.claudeHome, 'settings.json'), []);
  assert.ok(fs.existsSync(path.join(e.uaehHome, 'estable', 'statusline', 'statusline.js')), 'el espejo sí se copia');
}));

test('statusline con la barra ya apuntando al espejo: «ya configurada» y settings.json intacto', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  const destino = path.join(e.claudeHome, 'settings.json');
  const estable = path.join(e.uaehHome, 'estable');
  const previo = JSON.stringify({ statusLine: { type: 'command', command: `node "${estable}\\statusline\\statusline.js"` } }, null, 2);
  e.escribir(destino, previo);
  const r = instalar(e, ['statusline', '--aplicar'], p);
  assert.match(r.stdout, /statusLine: ya configurada/);
  assert.equal(leer(destino), previo);
}));

test('statusline con settings.json roto: código 1 con el bloque a pegar, pero el espejo igual se copia', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  const destino = path.join(e.claudeHome, 'settings.json');
  e.escribir(destino, '{ roto');
  const r = instalar(e, ['statusline', '--aplicar'], p);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^ERROR +/m);
  assert.ok(r.stdout.includes('"statusLine"') && r.stdout.includes('statusline.js'));
  assert.equal(leer(destino), '{ roto');
  assert.ok(fs.existsSync(path.join(e.uaehHome, 'estable', 'VERSION')));
}));

test('statusline con el plugin real: copia lo que existe, reporta FALTA lo demás y registra la barra', () => conCasa((e) => {
  const estable = path.join(e.uaehHome, 'estable');
  const r = instalar(e, ['statusline', '--aplicar']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const rel of [...ORIGENES_BARRA, 'scripts/lib/comun.cjs']) {
    const origen = path.join(RAIZ_KIT, ...rel.split('/'));
    const destino = path.join(estable, ...rel.split('/'));
    if (fs.existsSync(origen)) {
      assert.ok(fs.readFileSync(destino).equals(fs.readFileSync(origen)), `${rel} debe ser idéntico al del plugin`);
    } else {
      assert.equal(fs.existsSync(destino), false, rel);
      assert.match(r.stdout, new RegExp(`^FALTA +${escRe(rel)}`, 'm'));
    }
  }
  assert.equal(leer(path.join(estable, 'VERSION')).trim(), VERSION);
  assert.equal(leer(path.join(estable, 'package.json')), '{"type":"commonjs"}\n');
  const comando = JSON.parse(leer(path.join(e.claudeHome, 'settings.json'))).statusLine.command;
  assert.equal(comando, `node "${estable.replace(/\\/g, '/')}/statusline/statusline.js"`);
}));

// ── proyecto ──────────────────────────────────────────────────────────────────────────────

test('proyecto crea los 4 archivos con el nombre sustituido y la segunda corrida no pisa nada', () => conCasa((e) => {
  const dir = path.join(e.dir, 'mi-proyecto'); // todavía no existe
  const archivos = ['CLAUDE.md', 'tasks/context-map.md', 'tasks/todo.md', 'tasks/lessons.md'];
  let r = instalar(e, ['proyecto', dir, '--nombre', 'Mi App']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lineasDeAccion(r).filter((l) => l.startsWith('HARÍA')).length, 4);
  assert.equal(fs.existsSync(dir), false, 'en seco no se crea ni la carpeta');

  r = instalar(e, ['proyecto', dir, '--nombre', 'Mi App', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  for (const f of archivos) {
    const t = leer(path.join(dir, ...f.split('/')));
    assert.ok(t.includes('Mi App'), f);
    assert.ok(!t.includes('{NOMBRE DEL PROYECTO}'), `${f} no debe conservar el marcador`);
  }
  assert.match(leer(path.join(dir, 'CLAUDE.md')), /^# Mi App\n/);
  assert.match(leer(path.join(dir, 'tasks', 'todo.md')), /^# Pendientes — Mi App\n/);

  const mio = path.join(dir, 'tasks', 'todo.md');
  fs.writeFileSync(mio, 'MI CONTENIDO\n');
  r = instalar(e, ['proyecto', dir, '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(leer(mio), 'MI CONTENIDO\n', 'un archivo existente no se pisa');
  assert.equal(contar(r.stdout, 'existe (no se toca)'), 4);
  assert.deepEqual(arbol(dir), [...archivos].sort());

  const j = instalar(e, ['proyecto', dir, '--json']).json();
  assert.equal(j.subcomando, 'proyecto');
  assert.ok(j.acciones.every((a) => a.tipo === 'SIN CAMBIOS' && a.detalle === 'existe (no se toca)'));
}));

test('proyecto sin --nombre usa el nombre de la carpeta; el nombre se inserta literal (sin patrones de reemplazo)', () => conCasa((e) => {
  const dir = path.join(e.dir, 'otra-carpeta');
  instalar(e, ['proyecto', dir, '--aplicar']);
  assert.match(leer(path.join(dir, 'CLAUDE.md')), /^# otra-carpeta\n/);

  const raro = path.join(e.dir, 'raro');
  instalar(e, ['proyecto', raro, '--nombre', 'A$&B$1', '--aplicar']);
  assert.match(leer(path.join(raro, 'CLAUDE.md')), /^# A\$&B\$1\n/);
}));

test('proyecto sin carpeta, o sobre un archivo, falla con el código que corresponde', () => conCasa((e) => {
  assert.equal(instalar(e, ['proyecto']).status, 2);
  assert.equal(instalar(e, ['proyecto', 'a', 'b']).status, 2);
  const archivo = e.escribir(path.join(e.dir, 'soy-un-archivo'), 'x');
  const r = instalar(e, ['proyecto', archivo, '--aplicar']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^ERROR +la ruta existe y no es una carpeta/m);
}));

// ── todo ──────────────────────────────────────────────────────────────────────────────────

test('todo en seco: código 0, los tres pasos en orden y ni un archivo escrito', () => conCasa((e) => {
  const antes = arbol(e.dir);
  const r = instalar(e, ['todo']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([...r.stdout.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]), ['claude-md', 'settings', 'statusline']);
  assert.match(r.stdout, /En seco: no se escribió nada/);
  assert.deepEqual(arbol(e.dir), antes);

  const j = instalar(e, ['todo', '--json']).json();
  assert.equal(j.subcomando, 'todo');
  assert.equal(j.aplicado, false);
  assert.equal(j.codigo, 0);
  assert.deepEqual([...new Set(j.acciones.map((a) => a.paso))], ['claude-md', 'settings', 'statusline']);
  assert.ok(j.acciones.every((a) => typeof a.tipo === 'string' && 'ruta' in a && typeof a.detalle === 'string'));
  assert.deepEqual(arbol(e.dir), antes);
}));

test('todo --aplicar instala las tres partes con UN respaldo por archivo; la segunda corrida no cambia nada', () => conCasa((e) => {
  const p = pluginFalso(e, { version: '7.7.7', origenes: ORIGENES_BARRA });
  const claudeMd = path.join(e.claudeHome, 'CLAUDE.md');
  const settings = path.join(e.claudeHome, 'settings.json');
  e.escribir(claudeMd, '# Mío\n');
  e.escribir(settings, JSON.stringify({ theme: 'dark' }, null, 2));

  const r = instalar(e, ['todo', '--aplicar', '--idioma', 'en'], p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(leer(claudeMd).startsWith('# Mío\n\n<!-- UAEH:BEGIN v7.7.7 -->'));
  assert.match(leer(claudeMd), /UAEH method/);
  const s = JSON.parse(leer(settings));
  assert.equal(s.theme, 'dark');
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, MODELO_SUBAGENTES);
  assert.equal(s.autoCompactWindow, SNIPPET.autoCompactWindow);
  assert.ok(s.statusLine.command.endsWith('/estable/statusline/statusline.js"'));
  assert.equal(leer(path.join(e.uaehHome, 'estable', 'VERSION')).trim(), '7.7.7');
  assert.equal(leer(path.join(e.uaehHome, 'estable', 'package.json')), '{"type":"commonjs"}\n');

  assert.equal(respaldos(e.claudeHome, 'CLAUDE.md').length, 1);
  const bakSettings = respaldos(e.claudeHome, 'settings.json');
  assert.equal(bakSettings.length, 1, 'settings.json se reescribe en dos pasos pero solo se respalda el estado original');
  assert.deepEqual(JSON.parse(leer(path.join(e.claudeHome, bakSettings[0]))), { theme: 'dark' });

  const r2 = instalar(e, ['todo', '--aplicar', '--idioma', 'en'], p);
  assert.equal(r2.status, 0, r2.stdout);
  assert.deepEqual(lineasDeAccion(r2).filter((l) => !l.startsWith('SIN CAMBIOS')), [], r2.stdout);
  assert.equal(respaldos(e.claudeHome, 'CLAUDE.md').length, 1);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, 1);
}));

test('todo con settings.json roto: sigue con los demás pasos y termina con código 1', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  e.escribir(path.join(e.claudeHome, 'settings.json'), '{ roto');
  const r = instalar(e, ['todo', '--aplicar'], p);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(fs.existsSync(path.join(e.claudeHome, 'CLAUDE.md')), 'claude-md sí se aplicó');
  assert.ok(fs.existsSync(path.join(e.uaehHome, 'estable', 'VERSION')), 'el espejo sí se copió');
  assert.equal(leer(path.join(e.claudeHome, 'settings.json')), '{ roto');
  assert.equal(contar(r.stdout, '\nERROR '), 2, 'un error en settings y otro al registrar la barra');
}));

// ── Uso ───────────────────────────────────────────────────────────────────────────────────

test('uso incorrecto → código 2 con el uso en stderr; --ayuda → código 0', () => conCasa((e) => {
  for (const args of [[], ['rara'], ['settings', '--rara'], ['settings', 'sobra'], ['statusline', '--idioma', 'es'], ['proyecto', 'carpeta', '--quitar']]) {
    const r = instalar(e, args);
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.stdout}`);
    assert.match(r.stderr, /Uso: node instalar\.cjs/);
    assert.equal(r.stdout, '');
  }
  const ayuda = instalar(e, ['--ayuda']);
  assert.equal(ayuda.status, 0);
  assert.match(ayuda.stdout, /Uso: node instalar\.cjs/);
}));

// ── Funciones puras exportadas ────────────────────────────────────────────────────────────

test('localizarBloque distingue ausente, presente (con versión) y dañado', () => {
  assert.deepEqual(INST.localizarBloque('nada'), { estado: 'ausente' });
  const t = `a\n${bloqueViejo('1.2.3', 'x')}\nb`;
  const loc = INST.localizarBloque(t);
  assert.equal(loc.estado, 'presente');
  assert.equal(loc.version, '1.2.3');
  assert.equal(t.slice(loc.inicio, loc.fin), bloqueViejo('1.2.3', 'x'));
  assert.equal(INST.localizarBloque('<!-- UAEH:BEGIN v1 -->\nsin fin').estado, 'danado');
  assert.equal(INST.localizarBloque('<!-- UAEH:END -->\n<!-- UAEH:BEGIN v1 -->').estado, 'danado');
  assert.equal(INST.localizarBloque(`${t}\n${t}`).estado, 'danado');
});

test('mezclarSettings solo agrega lo que falta y no muta la entrada', () => {
  const entrada = { env: { OTRA: '1' }, modelSettings: { m: { autoCompactWindow: 1 } } };
  const copia = JSON.parse(JSON.stringify(entrada));
  const { salida, cambios } = INST.mezclarSettings(entrada, SNIPPET);
  assert.deepEqual(entrada, copia, 'la entrada no se modifica');
  assert.equal(salida.env.CLAUDE_CODE_SUBAGENT_MODEL, MODELO_SUBAGENTES);
  assert.equal(salida.env.OTRA, '1');
  assert.equal(salida.autoCompactWindow, undefined);
  assert.deepEqual(cambios.map((c) => [c.clave, c.estado]), [
    ['env.CLAUDE_CODE_SUBAGENT_MODEL', 'agregado'],
    ['autoCompactWindow', 'ya definido'],
  ]);
  assert.equal(INST.mezclarSettings({ env: 5 }, SNIPPET).error, '"env" existe pero no es un objeto');
  assert.equal(INST.mezclarSettings({ env: null }, SNIPPET).salida.env.CLAUDE_CODE_SUBAGENT_MODEL, MODELO_SUBAGENTES, 'env null cuenta como ausente');
});

test('anadirBloque y quitarBloque son inversas salvo la línea en blanco que la regla permite comer', () => {
  const b = bloqueViejo('0.0.9', 'r');
  // [archivo original, lo que queda tras añadir y quitar]
  const casos = [
    ['', ''],
    ['A\n', 'A\n'],
    ['# T\n\ncuerpo\n', '# T\n\ncuerpo\n'],
    ['A', 'A\n'],     // sin salto final: al añadir se le pone uno
    ['A\n\n', 'A\n'], // ya terminaba en línea en blanco: el bloque queda pegado a ella y «a lo sumo una» se la lleva
  ];
  for (const [original, esperado] of casos) {
    const conBloque = INST.anadirBloque(original, b, '\n');
    assert.deepEqual(INST.localizarBloque(conBloque).estado, 'presente');
    assert.equal(INST.quitarBloque(conBloque, INST.localizarBloque(conBloque)), esperado, JSON.stringify(original));
  }
});

// ── reversas: settings --quitar, statusline --quitar, todo --quitar ───────────────────────

// Formato que escribe el instalador (JSON con sangría de 2 y salto final): con él la ida y vuelta es exacta byte a byte.
const aJson = (obj) => JSON.stringify(obj, null, 2) + '\n';
const sinRespaldos = (e) => fs.readdirSync(e.claudeHome).filter((f) => f.includes('.uaeh-respaldo-'));

test('settings --quitar: ida y vuelta deja el archivo byte a byte como estaba (con y sin "env" propio)', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  const casos = [
    aJson({ theme: 'dark' }), // el instalador crea "env" y lo vacía al quitar
    aJson({ theme: 'dark', env: { OTRA: '1' }, permissions: { allow: ['Bash(ls:*)'] } }), // "env" propio: se conserva con OTRA
  ];
  for (const original of casos) {
    fs.writeFileSync(destino, original);
    let r = instalar(e, ['settings', '--aplicar']);
    assert.equal(r.status, 0, r.stdout);
    assert.notEqual(leer(destino), original);
    r = instalar(e, ['settings', '--quitar', '--aplicar']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(leer(destino), original, 'idéntico byte a byte');
    for (const f of sinRespaldos(e)) fs.unlinkSync(path.join(e.claudeHome, f));
  }
}));

test('settings --quitar: el detalle clave por clave, un respaldo del estado previo y segunda corrida «nada que hacer»', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  fs.writeFileSync(destino, aJson({ theme: 'dark', ...SNIPPET }));
  const antes = leer(destino);

  let r = instalar(e, ['settings', '--quitar', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, new RegExp(`^HECHO +env\\.CLAUDE_CODE_SUBAGENT_MODEL: quitado \\("${escRe(MODELO_SUBAGENTES)}"\\)`, 'm'));
  assert.match(r.stdout, /^HECHO +env: objeto vacío tras la retirada, quitado/m);
  assert.match(r.stdout, new RegExp(`^HECHO +autoCompactWindow: quitado \\(${SNIPPET.autoCompactWindow}\\)`, 'm'));
  assert.deepEqual(JSON.parse(leer(destino)), { theme: 'dark' });
  const bak = respaldos(e.claudeHome, 'settings.json');
  assert.equal(bak.length, 1);
  assert.equal(leer(path.join(e.claudeHome, bak[0])), antes);

  const despues = leer(destino);
  r = instalar(e, ['settings', '--quitar', '--aplicar']);
  assert.equal(r.status, 0);
  assert.ok(lineasDeAccion(r).every((l) => l.startsWith('SIN CAMBIOS')), r.stdout);
  assert.match(r.stdout, /nada que hacer/);
  assert.equal(leer(destino), despues);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, 1, 'la segunda corrida no respalda');
}));

test('settings --quitar con un valor cambiado por el usuario: se conserva, NOTA y ningún respaldo', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  const previo = aJson({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }, autoCompactWindow: SNIPPET.autoCompactWindow + 1 });
  fs.writeFileSync(destino, previo);
  const r = instalar(e, ['settings', '--quitar', '--aplicar']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^NOTA +env\.CLAUDE_CODE_SUBAGENT_MODEL: el valor actual \("opus"\)/m);
  assert.match(r.stdout, /^NOTA +autoCompactWindow: el valor actual/m);
  assert.equal(leer(destino), previo);
  assert.deepEqual(sinRespaldos(e), []);

  // Mezcla: una clave igual (se quita) y otra distinta (se conserva); "env" no queda vacío, así que se queda.
  fs.writeFileSync(destino, aJson({ env: { CLAUDE_CODE_SUBAGENT_MODEL: MODELO_SUBAGENTES, OTRA: '1' }, autoCompactWindow: 123 }));
  const r2 = instalar(e, ['settings', '--quitar', '--aplicar']);
  assert.equal(r2.status, 0, r2.stdout);
  assert.deepEqual(JSON.parse(leer(destino)), { env: { OTRA: '1' }, autoCompactWindow: 123 });
  assert.doesNotMatch(r2.stdout, /objeto vacío/);
}));

test('settings --quitar en seco no escribe; settings ausente o roto no se toca y se dice', () => conCasa((e) => {
  const destino = path.join(e.claudeHome, 'settings.json');
  let r = instalar(e, ['settings', '--quitar']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SIN CAMBIOS +no existe .*settings\.json: nada que hacer/m);
  assert.equal(fs.existsSync(destino), false);

  fs.writeFileSync(destino, aJson({ theme: 'dark', ...SNIPPET }));
  const antes = arbol(e.dir);
  const contenido = leer(destino);
  r = instalar(e, ['settings', '--quitar']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^HARÍA +env\.CLAUDE_CODE_SUBAGENT_MODEL: quitado/m);
  assert.match(r.stdout, /^HARÍA +autoCompactWindow: quitado/m);
  assert.match(r.stdout, /En seco: no se escribió nada/);
  assert.equal(leer(destino), contenido);
  assert.deepEqual(arbol(e.dir), antes);

  const roto = '{ "env": { ';
  fs.writeFileSync(destino, roto);
  r = instalar(e, ['settings', '--quitar', '--aplicar']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ERROR +.*no se tocó\. Quita a mano.*env\.CLAUDE_CODE_SUBAGENT_MODEL, autoCompactWindow/m);
  assert.equal(leer(destino), roto);
  assert.deepEqual(sinRespaldos(e), []);
}));

test('statusline --quitar: ida y vuelta borra solo lo que copió, respeta estable/uaeh-harness y deja settings.json como estaba', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  const destino = path.join(e.claudeHome, 'settings.json');
  const original = aJson({ theme: 'dark' });
  fs.writeFileSync(destino, original);
  const estable = path.join(e.uaehHome, 'estable');
  e.escribir(path.join(estable, 'uaeh-harness', 'VERSION'), '9.9.9\n'); // lo del otro plugin
  instalar(e, ['statusline', '--aplicar'], p);
  assert.ok(fs.existsSync(path.join(estable, 'statusline', 'statusline.js')));
  assert.ok(JSON.parse(leer(destino)).statusLine);
  const bakInstalar = respaldos(e.claudeHome, 'settings.json').length;

  const antes = arbol(e.dir);
  let r = instalar(e, ['statusline', '--quitar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^HARÍA +statusLine: se quitaría/m);
  assert.match(r.stdout, /^HARÍA .*borrar statusline\/statusline\.js del espejo/m);
  assert.deepEqual(arbol(e.dir), antes, 'en seco no cambia nada');

  r = instalar(e, ['statusline', '--quitar', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(leer(destino), original, 'settings.json idéntico al original, byte a byte');
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, bakInstalar + 1);
  assert.deepEqual(arbol(estable), ['uaeh-harness/VERSION'], 'solo queda lo del otro plugin');
  assert.equal(leer(path.join(estable, 'uaeh-harness', 'VERSION')), '9.9.9\n');

  r = instalar(e, ['statusline', '--quitar', '--aplicar'], p);
  assert.equal(r.status, 0);
  assert.ok(lineasDeAccion(r).every((l) => l.startsWith('SIN CAMBIOS')), r.stdout);
  assert.match(r.stdout, /nada que hacer/);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, bakInstalar + 1);
}));

test('statusline --quitar sin otro plugin: borra también las carpetas vacías, hasta estable/', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  instalar(e, ['statusline', '--aplicar'], p);
  const estable = path.join(e.uaehHome, 'estable');
  assert.ok(fs.existsSync(estable));
  const r = instalar(e, ['statusline', '--quitar', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.existsSync(estable), false);
  assert.equal(JSON.parse(leer(path.join(e.claudeHome, 'settings.json'))).statusLine, undefined);
}));

test('statusline --quitar con una barra ajena en settings: no se toca (aunque se limpie el espejo)', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  const destino = path.join(e.claudeHome, 'settings.json');
  instalar(e, ['statusline', '--aplicar'], p);
  const ajena = aJson({ theme: 'dark', statusLine: { type: 'command', command: 'node /otra/barra.js' } });
  fs.writeFileSync(destino, ajena);
  const bak = respaldos(e.claudeHome, 'settings.json').length;
  const r = instalar(e, ['statusline', '--quitar', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^SIN CAMBIOS +statusLine: barra propia/m);
  assert.equal(leer(destino), ajena);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, bak, 'no se respalda lo que no se toca');
  assert.equal(fs.existsSync(path.join(e.uaehHome, 'estable', 'statusline')), false, 'el espejo sí se limpia');
}));

test('statusline --quitar con settings.json roto: ERROR código 1 y no toca nada (ni settings ni el espejo)', () => conCasa((e) => {
  const p = pluginFalso(e, { origenes: ORIGENES_BARRA });
  instalar(e, ['statusline', '--aplicar'], p);
  const destino = path.join(e.claudeHome, 'settings.json');
  const estable = path.join(e.uaehHome, 'estable');
  fs.writeFileSync(destino, '{ roto');
  const antes = arbol(estable);
  assert.ok(antes.includes('VERSION') && antes.length > 1, 'el espejo de la barra existe antes de quitar');
  for (const args of [['statusline', '--quitar'], ['statusline', '--quitar', '--aplicar']]) {
    const r = instalar(e, args, p);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^ERROR +.*no se tocó, y el espejo tampoco/m);
    assert.doesNotMatch(r.stdout, /^(HECHO|HARÍA) /m, 'ni hace ni anuncia borrados');
    assert.equal(leer(destino), '{ roto');
    assert.deepEqual(arbol(estable), antes, `${args.join(' ')}: el espejo queda igual (la barra sigue apuntando a algo que existe)`);
  }
}));

test('todo --quitar: deshace en orden inverso, un respaldo por archivo, ida y vuelta exacta e idempotente', () => conCasa((e) => {
  const p = pluginFalso(e, { version: '7.7.7', origenes: ORIGENES_BARRA });
  const claudeMd = path.join(e.claudeHome, 'CLAUDE.md');
  const settings = path.join(e.claudeHome, 'settings.json');
  const mdOriginal = '# Mío\n';
  const stOriginal = aJson({ theme: 'dark' });
  fs.writeFileSync(claudeMd, mdOriginal);
  fs.writeFileSync(settings, stOriginal);
  assert.equal(instalar(e, ['todo', '--aplicar', '--idioma', 'en'], p).status, 0);
  const bakMd = respaldos(e.claudeHome, 'CLAUDE.md').length;
  const bakSt = respaldos(e.claudeHome, 'settings.json').length;

  const antes = arbol(e.dir);
  let r = instalar(e, ['todo', '--quitar'], p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([...r.stdout.matchAll(/^\[(.+)\]$/gm)].map((m) => m[1]), ['statusline', 'settings', 'claude-md']);
  assert.match(r.stdout, /En seco: no se escribió nada/);
  assert.deepEqual(arbol(e.dir), antes);

  r = instalar(e, ['todo', '--quitar', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(leer(claudeMd), mdOriginal);
  assert.equal(leer(settings), stOriginal);
  assert.equal(fs.existsSync(path.join(e.uaehHome, 'estable')), false);
  assert.equal(respaldos(e.claudeHome, 'CLAUDE.md').length, bakMd + 1);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, bakSt + 1, 'settings.json se reescribe en dos pasos pero se respalda una vez');

  r = instalar(e, ['todo', '--quitar', '--aplicar'], p);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(lineasDeAccion(r).every((l) => l.startsWith('SIN CAMBIOS')), r.stdout);
  assert.equal(respaldos(e.claudeHome, 'CLAUDE.md').length, bakMd + 1);
  assert.equal(respaldos(e.claudeHome, 'settings.json').length, bakSt + 1);
}));

test('--quitar se acepta en settings, statusline y todo; proyecto sigue sin admitirlo', () => conCasa((e) => {
  for (const sub of ['settings', 'statusline', 'todo']) {
    assert.deepEqual(INST.parsearArgumentos([sub, '--quitar']).opciones, { quitar: true }, sub);
  }
  assert.match(INST.parsearArgumentos(['proyecto', 'x', '--quitar']).error, /opción desconocida/);
  const u = INST.uso();
  assert.match(u, /settings +\[--quitar\]/);
  assert.match(u, /statusline +\[--quitar\]/);
  assert.match(u, /todo .*\[--quitar\]/);
}));

// ── Aviso de revisiones en curso (sello de integridad del harness) ───────────────────────────
test('aviso de sello: con una foto reciente, lo que toca settings/CLAUDE.md global/estable lleva una NOTA; un proyecto, no; una foto vieja, tampoco', () => conCasa((e) => {
  const dir = path.join(e.uaehHome, 'integridad');
  fs.mkdirSync(dir, { recursive: true });
  const foto = path.join(dir, 'agente-x.foto.json');
  fs.writeFileSync(foto, '{}');
  const aviso = /^NOTA +hay 1 foto\(s\) del sello de integridad/m;
  for (const args of [['settings'], ['statusline'], ['todo'], ['claude-md', '--global'], ['settings', '--quitar']]) {
    const r = instalar(e, args);
    assert.match(r.stdout, aviso, args.join(' '));
    assert.equal(r.status, 0, 'solo avisa: no se niega');
  }
  assert.doesNotMatch(instalar(e, ['claude-md', '--proyecto', e.proyecto]).stdout, aviso, 'el CLAUDE.md de un proyecto no lo mide el sello');
  const vieja = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(foto, vieja, vieja);
  assert.doesNotMatch(instalar(e, ['settings']).stdout, aviso, 'una foto de hace 3 h ya no cuenta');
}));
