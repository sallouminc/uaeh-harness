// Pruebas de plugins/uaeh-kit/scripts/doctor.cjs
//
// Se ejecuta el script real (correr()) en una casa temporal, con el PATH acotado a una carpeta vacía para que
// «claude» no exista salvo que la prueba ponga uno de mentira. Las comprobaciones que dependen de archivos
// que otros escriben en paralelo (hooks, ventana-contexto, listado de skills, barra) se prueban con un
// «plugin falso»: una copia mínima del doctor dentro de la casa temporal, con sus propios fixtures.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, lineaUso, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'doctor.cjs');
const COMUN = require(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'));
const VERSION = COMUN.versionPlugin();
const MARCA = COMUN.MARCA_CONTEXTO;
const IDS = [
  'node', 'claude-code', 'rutas', 'hooks-json', 'duplicados', 'config', 'tope-compactacion', 'transcripciones',
  'inyeccion', 'claude-md-tamano', 'bloque-reglas', 'statusline', 'espejo', 'skills-listado', 'subagente-modelo',
];
const ESTADOS = ['OK', 'AVISO', 'FALLÓ', 'OMITIDA', 'NO_INSTALADA', 'NO_APLICA'];
const DIA = 86400000;

// ── Ayudas ────────────────────────────────────────────────────────────────────────────────

function conCasa(fn) {
  const e = entornoTemporal('uaeh-doc-');
  try { return fn(e); } finally { e.limpiar(); }
}

// PATH reemplazado por completo (en Windows la variable puede llamarse Path: se quitan todas las variantes).
function envConPath(env, valor) {
  const salida = { ...env };
  for (const k of Object.keys(salida)) if (k.toLowerCase() === 'path') delete salida[k];
  salida.PATH = valor;
  return salida;
}

// Entorno de la casa con un PATH que apunta a una carpeta vacía: ningún «claude» a la vista.
function envSinClaude(e) {
  const vacio = path.join(e.dir, 'sin-claude');
  fs.mkdirSync(vacio, { recursive: true });
  return envConPath(e.env, vacio);
}

// «claude» de mentira que imprime `salida` y sale con `codigo`.
function envConClaudeFalso(e, salida, codigo = 0) {
  const bin = path.join(e.dir, 'bin-claude');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\necho ${salida}\r\nexit /b ${codigo}\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "${salida}"\nexit ${codigo}\n`, { mode: 0o755 });
  }
  return envConPath(e.env, bin);
}

// El doctor con la casa y el proyecto de la prueba; lo que pase la prueba va después y gana.
function doctor(e, args = [], { script = SCRIPT, env } = {}) {
  return correr(script, ['--cwd', e.proyecto, '--tope', e.dir, ...args], { env: env || envSinClaude(e), cwd: e.proyecto });
}

// Corre con --json y devuelve { r, j, c } (c = comprobaciones por id).
function ver(e, args = [], opciones = {}) {
  const r = doctor(e, ['--json', ...args], opciones);
  const j = r.json();
  assert.ok(j, `la salida no es JSON:\n${r.stdout}\n${r.stderr}`);
  return { r, j, c: Object.fromEntries(j.comprobaciones.map((x) => [x.id, x])) };
}

const leer = (ruta) => fs.readFileSync(ruta, 'utf8');
const AHORA_MS = new Date('2026-10-30T20:00:00Z').getTime(); // = UAEH_AHORA del entorno de pruebas

function fechado(ruta, ms) {
  const f = new Date(ms);
  fs.utimesSync(ruta, f, f);
  return ruta;
}

// Transcripción en projects/<rel> con la fecha de modificación dada (por defecto, un día antes de «ahora»).
function transcripcion(e, rel, lineas, ms = AHORA_MS - DIA) {
  const ruta = e.escribir(path.join(e.claudeHome, 'projects', ...rel.split('/')), `${lineas.join('\n')}\n`);
  return fechado(ruta, ms);
}

const lineaMarca = () => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [`${MARCA} reglas`] } });

// Todos los archivos bajo `dir` (rutas relativas, ordenadas).
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

// Copia mínima del plugin (doctor + biblioteca común + manifiesto) con los archivos de prueba que se pidan.
function pluginFalso(e, { version = '7.7.7', archivos = {} } = {}) {
  const raiz = path.join(e.dir, 'plugin-falso');
  fs.mkdirSync(path.join(raiz, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(raiz, 'scripts', 'doctor.cjs'));
  fs.copyFileSync(path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs'), path.join(raiz, 'scripts', 'lib', 'comun.cjs'));
  e.escribir(path.join(raiz, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'uaeh-kit', version }));
  for (const [rel, contenido] of Object.entries(archivos)) e.escribir(path.join(raiz, ...rel.split('/')), contenido);
  return { raiz, version, script: path.join(raiz, 'scripts', 'doctor.cjs') };
}

const hooksJson = (comandos) => JSON.stringify({
  hooks: { SessionStart: [{ hooks: comandos.map((command) => ({ type: 'command', command })) }] },
}, null, 2);

// Plugin falso con un hooks.json válido y sus scripts: base para pruebas donde no debe haber ningún FALLÓ.
function pluginSano(e, extra = {}) {
  return pluginFalso(e, {
    archivos: {
      'hooks/hooks.json': hooksJson(['node "${CLAUDE_PLUGIN_ROOT}/hooks/uno.js"']),
      'hooks/uno.js': '// hook de prueba\n',
      ...extra,
    },
  });
}

// ── Estructura y salida ───────────────────────────────────────────────────────────────────

test('casa vacía: las 15 comprobaciones en orden, con el estado que le corresponde a cada una', () => conCasa((e) => {
  const raro = (s) => /\s/.test(s) || /[^\x20-\x7e]/.test(s);
  const { r, j, c } = ver(e);
  assert.deepEqual(j.comprobaciones.map((x) => x.id), IDS);
  assert.ok(j.comprobaciones.every((x) => ESTADOS.includes(x.estado) && typeof x.detalle === 'string' && x.detalle.length > 0));

  assert.equal(c.node.estado, 'OK');
  assert.ok(c.node.detalle.includes(process.versions.node));
  assert.equal(c['claude-code'].estado, 'NO_INSTALADA', 'con el PATH acotado no hay claude');
  assert.equal(c.rutas.estado, raro(e.claudeHome) || raro(e.uaehHome) ? 'AVISO' : 'OK');

  // hooks-json: el estado debe ser coherente con lo que hay en disco (otros lo escriben en paralelo)
  const rutaHooks = path.join(RAIZ_KIT, 'hooks', 'hooks.json');
  let esperado = 'FALLÓ';
  if (fs.existsSync(rutaHooks)) {
    const hooks = JSON.parse(leer(rutaHooks)).hooks;
    const comandos = Object.values(hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
    const scripts = comandos.flatMap((cmd) => [...cmd.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"']+)/g)].map((m) => m[1]));
    esperado = scripts.every((s) => fs.existsSync(path.join(RAIZ_KIT, ...s.split('/')))) ? 'OK' : 'FALLÓ';
  }
  assert.equal(c['hooks-json'].estado, esperado);

  assert.equal(c.duplicados.estado, 'OK');
  assert.equal(c.config.estado, 'AVISO');
  assert.match(c.config.detalle, /sin uaeh\.config\.json: valores por defecto/);
  if (fs.existsSync(path.join(RAIZ_KIT, 'scripts', 'ventana-contexto.cjs'))) {
    assert.ok(['OK', 'AVISO'].includes(c['tope-compactacion'].estado), c['tope-compactacion'].detalle);
  } else {
    assert.equal(c['tope-compactacion'].estado, 'OMITIDA');
  }
  assert.equal(c.transcripciones.estado, 'NO_APLICA');
  assert.equal(c.inyeccion.estado, 'NO_APLICA');
  assert.equal(c['claude-md-tamano'].estado, 'NO_APLICA');
  assert.equal(c['bloque-reglas'].estado, 'AVISO');
  assert.equal(c.statusline.estado, 'AVISO');
  assert.equal(c.espejo.estado, 'NO_APLICA');
  assert.equal(c['skills-listado'].estado, fs.existsSync(path.join(RAIZ_KIT, 'scripts', 'uaeh-listado-skills.cjs')) ? 'NO_APLICA' : 'OMITIDA');
  assert.equal(c['subagente-modelo'].estado, 'AVISO');

  assert.equal(r.status, j.resumen['FALLÓ'] > 0 ? 1 : 0, 'código 0 sin FALLÓ, 1 con FALLÓ');
  assert.equal(j.codigo, r.status);
}));

test('--json devuelve { capa, comprobaciones, resumen, codigo } y el resumen cuenta cada estado', () => conCasa((e) => {
  const { r, j } = ver(e);
  assert.deepEqual(Object.keys(j), ['capa', 'comprobaciones', 'resumen', 'codigo']);
  assert.equal(j.capa, 'kit');
  assert.deepEqual(Object.keys(j.resumen), ESTADOS);
  for (const estado of ESTADOS) assert.equal(j.resumen[estado], j.comprobaciones.filter((x) => x.estado === estado).length, estado);
  assert.equal(Object.values(j.resumen).reduce((a, b) => a + b, 0), IDS.length);
  assert.equal(r.stderr, '');
}));

test('la salida humana trae una línea alineada por comprobación y el resumen final', () => conCasa((e) => {
  const r = doctor(e);
  const filas = r.stdout.split('\n').filter((l) => IDS.some((id) => l.includes(` ${id} `)) && l.includes(' — '));
  assert.equal(filas.length, IDS.length, r.stdout);
  assert.equal(new Set(filas.map((l) => l.indexOf(' — '))).size, 1, 'el separador queda en la misma columna');
  assert.ok(filas.every((l) => ESTADOS.includes(l.slice(0, 12).trim())));
  assert.deepEqual(filas.map((l) => l.slice(14).split(' ')[0]), IDS);
  assert.match(r.stdout, /^Resumen: \d+ OK · \d+ AVISO · \d+ FALLÓ · \d+ OMITIDA · \d+ NO_INSTALADA · \d+ NO_APLICA$/m);
}));

test('argumentos: --capa todo equivale a kit; lo inválido → código 2; --ayuda → 0', () => conCasa((e) => {
  const todo = ver(e, ['--capa', 'todo']);
  assert.equal(todo.j.capa, 'todo');
  assert.deepEqual(todo.j.comprobaciones.map((x) => x.id), IDS);

  for (const args of [['--capa', 'rara'], ['--rara'], ['--cwd'], ['--capa'], ['--cwd', path.join(e.dir, 'no-existe')]]) {
    const r = doctor(e, args);
    assert.equal(r.status, 2, `${args.join(' ')} → ${r.stdout}`);
    assert.match(r.stderr, /Uso: node doctor\.cjs/);
    assert.equal(r.stdout, '');
  }
  const ayuda = doctor(e, ['--ayuda']);
  assert.equal(ayuda.status, 0);
  assert.match(ayuda.stdout, /Uso: node doctor\.cjs/);
}));

test('el doctor solo lee: con duplicados, CLAUDE.md y transcripciones a la vista no escribe nada sin --proponer', () => conCasa((e) => {
  e.escribir(path.join(e.claudeHome, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node C:/x/hooks/inyectar-contexto.js' }] }] },
  }));
  e.escribir(path.join(e.claudeHome, 'CLAUDE.md'), 'x'.repeat(41000));
  transcripcion(e, 'p/a.jsonl', [lineaUso({ entrada: 1 }), lineaMarca()]);
  const env = envSinClaude(e);
  const antes = arbol(e.dir);
  const contenidos = antes.map((f) => leer(path.join(e.dir, f)));
  for (const args of [[], ['--json'], ['--capa', 'todo']]) assert.ok([0, 1].includes(doctor(e, args, { env }).status));
  assert.deepEqual(arbol(e.dir), antes);
  assert.deepEqual(antes.map((f) => leer(path.join(e.dir, f))), contenidos, 'ni un byte distinto');
}));

// ── Comprobaciones, una por una ───────────────────────────────────────────────────────────

test('node: la versión que corre el doctor, con el mínimo de 20 declarado', () => conCasa((e) => {
  const { c } = ver(e);
  assert.equal(c.node.estado, Number(process.versions.node.split('.')[0]) >= 20 ? 'OK' : 'FALLÓ');
  assert.equal(c.node.detalle, `Node ${process.versions.node}`);
}));

test('claude-code: compara la versión numéricamente (2.1.295 es el mínimo) y distingue ausente de ilegible', () => conCasa((e) => {
  const estado = (salida, codigo) => {
    const { r, c } = ver(e, [], { env: envConClaudeFalso(e, salida, codigo) });
    assert.equal(r.stderr, '', 'sin advertencias de Node (DEP0190) en stderr');
    return c['claude-code'];
  };
  assert.equal(estado('2.1.316 (Claude Code)').estado, 'OK');
  assert.match(estado('2.1.316 (Claude Code)').detalle, /2\.1\.316/);
  assert.equal(estado('2.1.295 (Claude Code)').estado, 'OK', 'justo el mínimo');
  assert.equal(estado('2.1.1000 (Claude Code)').estado, 'OK', '1000 > 295: no se compara como texto');
  assert.equal(estado('3.0.0 (Claude Code)').estado, 'OK');
  const vieja = estado('2.1.294 (Claude Code)');
  assert.equal(vieja.estado, 'AVISO');
  assert.match(vieja.detalle, /2\.1\.294.*2\.1\.295/);
  assert.equal(estado('2.0.99 (Claude Code)').estado, 'AVISO');
  assert.equal(estado('hola mundo').estado, 'AVISO');
  assert.match(estado('hola mundo').detalle, /no se pudo leer la versión/);
  assert.equal(estado('2.1.316 (Claude Code)', 3).estado, 'NO_INSTALADA', 'estado distinto de 0');
}));

test('rutas: sin carpeta de Claude Code → FALLÓ; sin carpeta uaeh → AVISO; espacios o no ASCII → AVISO', () => conCasa((e) => {
  fs.rmSync(e.uaehHome, { recursive: true, force: true });
  let { c } = ver(e);
  assert.equal(c.rutas.estado, 'AVISO');
  assert.match(c.rutas.detalle, /no existe; se crea con \/uaeh-kit:setup/);

  const noExiste = path.join(e.dir, 'no-existe');
  let m = ver(e, [], { env: { ...envSinClaude(e), CLAUDE_CONFIG_DIR: noExiste, UAEH_HOME: path.join(noExiste, 'uaeh') } });
  assert.equal(m.c.rutas.estado, 'FALLÓ');
  assert.match(m.c.rutas.detalle, /la carpeta de Claude Code no existe/);
  assert.equal(m.r.status, 1);

  const archivo = e.escribir(path.join(e.dir, 'soy-un-archivo'), 'x');
  m = ver(e, [], { env: { ...envSinClaude(e), CLAUDE_CONFIG_DIR: archivo, UAEH_HOME: path.join(e.dir, 'uaeh-aparte') } });
  assert.equal(m.c.rutas.estado, 'FALLÓ');
  assert.match(m.c.rutas.detalle, /existe pero no es una carpeta/);

  const raro = path.join(e.dir, 'casa', '.claude ñandú');
  fs.mkdirSync(path.join(raro, 'uaeh'), { recursive: true });
  m = ver(e, [], { env: { ...envSinClaude(e), CLAUDE_CONFIG_DIR: raro, UAEH_HOME: path.join(raro, 'uaeh') } });
  assert.equal(m.c.rutas.estado, 'AVISO');
  assert.match(m.c.rutas.detalle, /espacios o caracteres no ASCII/);
  ({ c } = m);
  assert.equal(c.node.estado, 'OK', 'una ruta rara no tumba el resto');
}));

test('hooks-json: ausente, roto, sin eventos, con scripts que faltan, completo y con args como arreglo', () => conCasa((e) => {
  const p = pluginFalso(e);
  const estado = () => ver(e, [], { script: p.script }).c['hooks-json'];
  const escribirHooks = (texto) => e.escribir(path.join(p.raiz, 'hooks', 'hooks.json'), texto);

  assert.equal(estado().estado, 'FALLÓ');
  assert.match(estado().detalle, /falta hooks\/hooks\.json/);

  escribirHooks('{ roto');
  assert.match(estado().detalle, /no parsea/);
  assert.equal(estado().estado, 'FALLÓ');

  escribirHooks(JSON.stringify({ description: 'sin eventos' }));
  assert.equal(estado().estado, 'FALLÓ');
  assert.match(estado().detalle, /clave «hooks»/);

  escribirHooks(hooksJson(['node "${CLAUDE_PLUGIN_ROOT}/hooks/uno.js"', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/dos.js" arg']));
  e.escribir(path.join(p.raiz, 'hooks', 'uno.js'), '// uno\n');
  let r = estado();
  assert.equal(r.estado, 'FALLÓ');
  assert.match(r.detalle, /no existen en el plugin: hooks\/dos\.js$/);
  assert.ok(!r.detalle.includes('hooks/uno.js'), 'solo se nombran los que faltan');

  e.escribir(path.join(p.raiz, 'hooks', 'dos.js'), '// dos\n');
  r = estado();
  assert.equal(r.estado, 'OK');
  assert.equal(r.detalle, '2 hooks, 2 scripts presentes');

  // rutas con barra invertida y scripts dados en args (forma de arreglo)
  escribirHooks(JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}\\hooks\\uno.js' }, { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/tres.js'] }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'no cuenta' }] }],
    },
  }));
  r = estado();
  assert.equal(r.estado, 'FALLÓ');
  assert.match(r.detalle, /hooks\/tres\.js$/);
  assert.ok(r.detalle.startsWith('2 hooks;'), 'solo cuentan los hooks de tipo command');
}));

test('duplicados: avisa con el puntero exacto; --proponer escribe la propuesta y deja el original idéntico', () => conCasa((e) => {
  const original = JSON.stringify({
    env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node C:/x/hooks/vigia-contexto.js prompt' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [
        { type: 'command', command: 'node "C:/x/hooks/inyectar-contexto.js"' },
        { type: 'command', command: 'echo hola' },
      ] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node C:\\x\\hooks\\mi-vigia-contexto.js' }] }], // nombre parecido, otro script
    },
  }, null, 2);
  const settings = e.escribir(path.join(e.claudeHome, 'settings.json'), original);
  const antes = arbol(e.dir);

  let { c } = ver(e);
  assert.equal(c.duplicados.estado, 'AVISO');
  const d = c.duplicados.detalle;
  assert.ok(d.includes('/hooks/UserPromptSubmit/0/hooks/0'), d);
  assert.ok(d.includes('/hooks/SessionStart/0/hooks/0'), d);
  assert.ok(d.includes('node C:/x/hooks/vigia-contexto.js prompt'));
  assert.ok(d.includes(settings));
  assert.ok(!d.includes('echo hola') && !d.includes('mi-vigia'), 'solo los duplicados');
  assert.match(d, /--proponer/);
  assert.deepEqual(arbol(e.dir), antes, 'sin --proponer no se escribe nada');

  ({ c } = ver(e, ['--proponer']));
  const propuesta = path.join(e.claudeHome, 'settings.uaeh-propuesto.json');
  assert.ok(c.duplicados.detalle.includes(propuesta));
  assert.equal(leer(settings), original, 'el original queda idéntico');
  const prop = JSON.parse(leer(propuesta));
  assert.equal(prop.hooks.UserPromptSubmit, undefined, 'el grupo que quedó vacío se elimina');
  assert.deepEqual(prop.hooks.SessionStart, [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hola' }] }]);
  assert.ok(prop.hooks.Stop, 'el hook de nombre parecido no se toca');
  assert.deepEqual(prop.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' });
  assert.ok(!JSON.stringify(prop).includes('vigia-contexto.js prompt'));
  assert.deepEqual(arbol(e.dir).filter((f) => !antes.includes(f)), ['casa/.claude/settings.uaeh-propuesto.json']);
}));

test('duplicados: también en los settings del proyecto (barra invertida incluida), con su propia propuesta; sin duplicados → OK', () => conCasa((e) => {
  const local = e.escribir(path.join(e.proyecto, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node C:\\x\\hooks\\router-context-inject.js' }] }] },
  }));
  e.escribir(path.join(e.proyecto, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] } }));
  const antes = leer(local);

  let { c } = ver(e, ['--proponer']);
  assert.equal(c.duplicados.estado, 'AVISO');
  assert.ok(c.duplicados.detalle.includes(local));
  assert.equal(leer(local), antes);
  const propuesta = path.join(e.proyecto, '.claude', 'settings.local.uaeh-propuesto.json');
  assert.deepEqual(JSON.parse(leer(propuesta)), {}, 'sin hooks queda sin la clave hooks');
  assert.equal(fs.existsSync(path.join(e.proyecto, '.claude', 'settings.uaeh-propuesto.json')), false, 'el archivo sin duplicados no genera propuesta');

  fs.rmSync(local);
  ({ c } = ver(e));
  assert.equal(c.duplicados.estado, 'OK');
  assert.match(c.duplicados.detalle, /sin hooks duplicados \(1 archivo\(s\)/);

  // un settings que no parsea se anota pero no tumba nada
  e.escribir(path.join(e.claudeHome, 'settings.json'), '{ roto');
  ({ c } = ver(e));
  assert.equal(c.duplicados.estado, 'OK');
  assert.match(c.duplicados.detalle, /no se pudieron leer: .*settings\.json/);
}));

test('config: sin archivo → AVISO; válido → OK; roto o con claves raras → AVISO con el motivo', () => conCasa((e) => {
  const cfg = path.join(e.uaehHome, 'uaeh.config.json');
  assert.equal(ver(e).c.config.estado, 'AVISO');
  e.escribir(cfg, JSON.stringify({ idioma: 'en' }));
  assert.equal(ver(e).c.config.estado, 'OK');
  e.escribir(cfg, '{ roto');
  assert.match(ver(e).c.config.detalle, /no parsea/);
  e.escribir(cfg, JSON.stringify({ rara: 1 }));
  const raro = ver(e).c.config;
  assert.equal(raro.estado, 'AVISO');
  assert.match(raro.detalle, /clave desconocida/);
}));

test('tope-compactacion: sin módulo → OMITIDA; sin tope → AVISO con la recomendación; con tope → OK; recibe (undefined, { cwd })', () => conCasa((e) => {
  const ventana = (cuerpo) => ({ 'scripts/ventana-contexto.cjs': `'use strict';\n${cuerpo}\n` });
  let p = pluginFalso(e);
  assert.equal(ver(e, [], { script: p.script }).c['tope-compactacion'].estado, 'OMITIDA');

  p = pluginFalso(e, { archivos: ventana('module.exports = { topeCompactacion: () => 0, COMPACTA_SIN_TOPE: 967000 };') });
  let r = ver(e, [], { script: p.script }).c['tope-compactacion'];
  assert.equal(r.estado, 'AVISO');
  assert.match(r.detalle, /sin tope propio \(se compacta cerca de 967K\); recomendado 700000 vía \/uaeh-kit:setup settings/);

  p = pluginFalso(e, { archivos: ventana('module.exports = { topeCompactacion: () => 700000 };') });
  r = ver(e, [], { script: p.script }).c['tope-compactacion'];
  assert.equal(r.estado, 'OK');
  assert.match(r.detalle, /700000/);

  p = pluginFalso(e, { archivos: ventana(`module.exports = { topeCompactacion: (modelo, o) => (modelo === undefined && o && o.cwd === ${JSON.stringify(e.proyecto)} ? 424242 : 0) };`) });
  assert.match(ver(e, [], { script: p.script }).c['tope-compactacion'].detalle, /424242/, 'el doctor pasa el --cwd');

  p = pluginFalso(e, { archivos: ventana('module.exports = { otraCosa: 1 };') });
  assert.equal(ver(e, [], { script: p.script }).c['tope-compactacion'].estado, 'OMITIDA', 'un módulo sin la función no rompe');
}));

test('una comprobación que lanza queda como FALLÓ con su mensaje y el resto sigue; el código de salida es 1', () => conCasa((e) => {
  const p = pluginSano(e, { 'scripts/ventana-contexto.cjs': "module.exports = { topeCompactacion() { throw new Error('boom\\n  de prueba'); } };\n" });
  const { r, j, c } = ver(e, [], { script: p.script });
  assert.equal(c['tope-compactacion'].estado, 'FALLÓ');
  assert.match(c['tope-compactacion'].detalle, /error inesperado: boom de prueba/, 'los saltos de línea del mensaje se aplanan');
  assert.ok(j.comprobaciones.every((x) => !/[\r\n]/.test(x.detalle)), 'una comprobación = una línea');
  assert.deepEqual(j.comprobaciones.map((x) => x.id), IDS, 'las 15 comprobaciones siguen presentes');
  assert.equal(c.node.estado, 'OK');
  assert.equal(c['hooks-json'].estado, 'OK');
  assert.equal(j.resumen['FALLÓ'], 1);
  assert.equal(r.status, 1);
  assert.equal(j.codigo, 1);
}));

test('sin ningún FALLÓ el código de salida es 0', () => conCasa((e) => {
  const p = pluginSano(e);
  const { r, j } = ver(e, [], { script: p.script });
  assert.equal(j.resumen['FALLÓ'], 0, JSON.stringify(j.comprobaciones.filter((x) => x.estado === 'FALLÓ')));
  assert.equal(r.status, 0);
  assert.equal(j.codigo, 0);
}));

test('transcripciones: reconoce el campo usage en la más reciente y avisa si no lo hay', () => conCasa((e) => {
  assert.equal(ver(e).c.transcripciones.estado, 'NO_APLICA');

  transcripcion(e, 'p/a.jsonl', [lineaUso({ entrada: 5, salida: 2 })]);
  let t = ver(e).c.transcripciones;
  assert.equal(t.estado, 'OK');
  assert.match(t.detalle, /formato reconocido \(a\.jsonl\)/);

  // la más reciente manda: una nueva sin usage pasa a ser la que se mira
  transcripcion(e, 'p/b.jsonl', [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hola' } })], AHORA_MS - 1000);
  t = ver(e).c.transcripciones;
  assert.equal(t.estado, 'AVISO');
  assert.match(t.detalle, /formato no reconocido en b\.jsonl/);

  // las de subagentes no cuentan
  fs.rmSync(path.join(e.claudeHome, 'projects'), { recursive: true });
  transcripcion(e, 'p/sesion/subagents/agent-1.jsonl', [lineaUso({ entrada: 1 })]);
  assert.equal(ver(e).c.transcripciones.estado, 'NO_APLICA');
}));

test('inyeccion: encuentra la marca en transcripciones de la última semana; nunca la imprime', () => conCasa((e) => {
  assert.equal(ver(e).c.inyeccion.estado, 'NO_APLICA');

  const ruta = transcripcion(e, 'p/a.jsonl', [lineaUso({ entrada: 1 }), lineaMarca()], new Date('2026-10-29T12:00:00Z').getTime());
  let { r, c } = ver(e);
  assert.equal(c.inyeccion.estado, 'OK');
  assert.match(c.inyeccion.detalle, /^vista en a\.jsonl \(2026-10-29 12:00 \(UTC\)\)$/);
  assert.ok(!r.stdout.includes(MARCA), 'la salida del doctor acabaría en transcripciones: no puede contener la marca');
  assert.ok(!doctor(e).stdout.includes(MARCA));

  // sin la marca → AVISO con la instrucción
  fs.writeFileSync(ruta, `${lineaUso({ entrada: 1 })}\n`);
  fechado(ruta, AHORA_MS - DIA);
  ({ c } = ver(e));
  assert.equal(c.inyeccion.estado, 'AVISO');
  assert.match(c.inyeccion.detalle, /no vista en transcripciones recientes: abre una sesión nueva con el plugin cargado y vuelve a correr el doctor/);

  // la marca suelta en otra parte de la conversación NO cuenta: solo la línea en la que Claude Code la adjuntó
  // al contexto (hook_additional_context). Ni la respuesta del modelo ni el stdout del hook (hook_success) bastan.
  const lineaRespuesta = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `${MARCA} lo vi` }] } });
  const lineaHookSuccess = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'SessionStart', stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: `${MARCA} reglas` } }) } });
  fs.writeFileSync(ruta, `${lineaRespuesta}\n${lineaHookSuccess}\n${lineaUso({ entrada: 1 })}\n`);
  fechado(ruta, AHORA_MS - DIA);
  ({ c } = ver(e));
  assert.equal(c.inyeccion.estado, 'AVISO', 'la marca fuera de hook_additional_context es un falso positivo');
  // …y una línea muy larga con la marca al final sí se encuentra (lectura por bloques)
  fs.writeFileSync(ruta, `${'x'.repeat(5 * 1024 * 1024)}\n${lineaMarca()}\n`);
  fechado(ruta, AHORA_MS - DIA);
  ({ c } = ver(e));
  assert.equal(c.inyeccion.estado, 'OK');

  // los límites de la ventana: 6 días adentro, 8 afuera (relativo a «ahora»)
  fs.writeFileSync(ruta, `${lineaMarca()}\n`);
  fechado(ruta, AHORA_MS - 6 * DIA);
  assert.equal(ver(e).c.inyeccion.estado, 'OK');
  fechado(ruta, AHORA_MS - 8 * DIA);
  const vieja = ver(e).c.inyeccion;
  assert.equal(vieja.estado, 'NO_APLICA');
  assert.match(vieja.detalle, /últimos 7 días/);

  // la marca solo en una transcripción de subagente no cuenta
  fs.rmSync(path.join(e.claudeHome, 'projects'), { recursive: true });
  transcripcion(e, 'p/sesion/subagents/agent-1.jsonl', [lineaMarca()]);
  assert.equal(ver(e).c.inyeccion.estado, 'NO_APLICA');
}));

const BLOQUE_LECTURA = 4 * 1024 * 1024; // el tamaño de bloque con que el doctor lee las transcripciones

test('inyeccion: encuentra la marca aunque su línea y la marca misma queden partidas entre dos bloques de lectura', () => conCasa((e) => {
  const ruta = path.join(e.claudeHome, 'projects', 'p', 'grande.jsonl');
  // Una sola línea del adjunto hook_additional_context. 5 bytes de la marca caen en el primer bloque y el resto
  // en el segundo; el texto «hook_additional_context» queda entero antes del corte.
  const cabeza = '{"type":"attachment","attachment":{"type":"hook_additional_context","content":["';
  const relleno = 'y'.repeat(BLOQUE_LECTURA - 5 - cabeza.length);
  e.escribir(ruta, `${cabeza}${relleno}${MARCA} reglas"]}}\n`);
  fechado(ruta, AHORA_MS - DIA);
  assert.ok(fs.statSync(ruta).size > BLOQUE_LECTURA, 'la prueba solo vale si el archivo cruza el primer bloque');
  const { c } = ver(e);
  assert.equal(c.inyeccion.estado, 'OK');
  assert.match(c.inyeccion.detalle, /grande\.jsonl/);

  // …y si la marca y la palabra clave están en líneas distintas, aunque cruce el bloque, no cuenta
  e.escribir(ruta, `{"type":"attachment","attachment":{"type":"hook_additional_context","content":["sin marca"]}}\n${relleno}\n${MARCA}\n`);
  fechado(ruta, AHORA_MS - DIA);
  assert.equal(ver(e).c.inyeccion.estado, 'AVISO');
}));

test('transcripciones: reconoce el campo usage aunque quede partido entre dos bloques de lectura', () => conCasa((e) => {
  const ruta = path.join(e.claudeHome, 'projects', 'p', 'grande.jsonl');
  e.escribir(ruta, `${'x'.repeat(BLOQUE_LECTURA - 3)}"usage"\n`); // 3 bytes del campo en el primer bloque, 4 en el segundo
  fechado(ruta, AHORA_MS - DIA);
  assert.equal(ver(e).c.transcripciones.estado, 'OK');
}));

test('claude-md-tamano: avisa por encima de 40,000 caracteres (global o de proyecto); en el límite exacto está bien', () => conCasa((e) => {
  const global = path.join(e.claudeHome, 'CLAUDE.md');
  const delProyecto = path.join(e.proyecto, 'CLAUDE.md');
  assert.equal(ver(e).c['claude-md-tamano'].estado, 'NO_APLICA');

  e.escribir(global, 'x'.repeat(40000));
  let t = ver(e).c['claude-md-tamano'];
  assert.equal(t.estado, 'OK', 'exactamente 40,000 no excede');
  assert.match(t.detalle, /límite 40,000/);

  e.escribir(global, 'x'.repeat(41000));
  t = ver(e).c['claude-md-tamano'];
  assert.equal(t.estado, 'AVISO');
  assert.ok(t.detalle.includes(global));
  assert.match(t.detalle, /41\.0K caracteres \(41,000\)/);
  assert.match(t.detalle, /\/uaeh-kit:dieta/);

  e.escribir(global, 'corto');
  e.escribir(delProyecto, 'y'.repeat(42500));
  t = ver(e).c['claude-md-tamano'];
  assert.equal(t.estado, 'AVISO');
  assert.ok(t.detalle.includes(delProyecto) && !t.detalle.includes(global));
  assert.match(t.detalle, /42\.5K/);
}));

test('bloque-reglas: al día → OK; versión vieja o sin versión → AVISO; ausente → AVISO; ni bloque ni inyección → FALLÓ', () => conCasa((e) => {
  const global = path.join(e.claudeHome, 'CLAUDE.md');
  const cfg = path.join(e.uaehHome, 'uaeh.config.json');
  const conBloque = (v) => `# Mío\n\n<!-- UAEH:BEGIN${v ? ` v${v}` : ''} -->\nreglas\n<!-- UAEH:END -->\n`;

  e.escribir(global, conBloque(VERSION));
  let b = ver(e).c['bloque-reglas'];
  assert.equal(b.estado, 'OK');
  assert.ok(b.detalle.includes(`v${VERSION}`));

  e.escribir(global, conBloque('9.9.9'));
  b = ver(e).c['bloque-reglas'];
  assert.equal(b.estado, 'AVISO');
  assert.match(b.detalle, /v9\.9\.9/);
  assert.match(b.detalle, /actualizar con \/uaeh-kit:setup claude-md/);

  e.escribir(global, conBloque(null));
  b = ver(e).c['bloque-reglas'];
  assert.equal(b.estado, 'AVISO');
  assert.match(b.detalle, /sin versión/);

  // un bloque al día en el CLAUDE.md del proyecto basta aunque el global no lo traiga
  e.escribir(global, '# sin bloque\n');
  e.escribir(path.join(e.proyecto, 'CLAUDE.md'), conBloque(VERSION));
  assert.equal(ver(e).c['bloque-reglas'].estado, 'OK');
  fs.rmSync(path.join(e.proyecto, 'CLAUDE.md'));

  b = ver(e).c['bloque-reglas'];
  assert.equal(b.estado, 'AVISO');
  assert.match(b.detalle, /sin bloque: las reglas llegan compactas por hook; para el bloque completo: \/uaeh-kit:setup claude-md/);

  // reglas.inyectar=false: sin bloque no llegan reglas por ningún lado
  e.escribir(cfg, JSON.stringify({ reglas: { inyectar: false } }));
  const sin = ver(e);
  assert.equal(sin.c['bloque-reglas'].estado, 'FALLÓ');
  assert.match(sin.c['bloque-reglas'].detalle, /ni bloque ni inyección/);
  assert.equal(sin.r.status, 1);
  e.escribir(global, conBloque(VERSION));
  assert.equal(ver(e).c['bloque-reglas'].estado, 'OK', 'con el bloque presente, desactivar la inyección es legítimo');

  // una configuración con «reglas» nulo o del tipo equivocado no debe tumbar la comprobación
  fs.rmSync(global);
  for (const reglas of [null, 'texto', 5]) {
    e.escribir(cfg, JSON.stringify({ reglas }));
    const b2 = ver(e).c['bloque-reglas'];
    assert.equal(b2.estado, 'AVISO', JSON.stringify(reglas));
    assert.ok(!b2.detalle.includes('error inesperado'));
  }
}));

test('statusline y espejo: barra del kit al día → OK; desactualizada o a medias → AVISO; barra propia → NO_APLICA', () => conCasa((e) => {
  const p = pluginFalso(e, { version: '7.7.7', archivos: { 'statusline/statusline.js': '// barra\n', 'statusline/claude-status-fetch.js': '// fetch\n' } });
  const estable = path.join(e.uaehHome, 'estable');
  const settings = path.join(e.claudeHome, 'settings.json');
  const opciones = { script: p.script };
  const estados = () => { const { c } = ver(e, [], opciones); return { barra: c.statusline, espejo: c.espejo }; };
  const ponerBarra = (command) => e.escribir(settings, JSON.stringify({ statusLine: { type: 'command', command } }));
  const comando = `node "${estable.replace(/\\/g, '/')}/statusline/statusline.js"`;

  let x = estados();
  assert.equal(x.barra.estado, 'AVISO');
  assert.match(x.barra.detalle, /opcional: \/uaeh-kit:setup statusline/);
  assert.equal(x.espejo.estado, 'NO_APLICA');

  ponerBarra('node /otra/barra.js');
  x = estados();
  assert.equal(x.barra.estado, 'NO_APLICA');
  assert.match(x.barra.detalle, /barra propia/);

  ponerBarra(comando);
  e.escribir(path.join(estable, 'statusline', 'statusline.js'), '// barra\n');
  e.escribir(path.join(estable, 'statusline', 'claude-status-fetch.js'), '// fetch\n');
  assert.equal(estados().barra.estado, 'OK');

  ponerBarra(`node "${estable}\\statusline\\statusline.js"`);
  assert.equal(estados().barra.estado, 'OK', 'también reconoce la ruta escrita con barras invertidas');

  ponerBarra(comando);
  e.escribir(path.join(estable, 'statusline', 'statusline.js'), '// versión vieja\n');
  x = estados();
  assert.equal(x.barra.estado, 'AVISO');
  assert.match(x.barra.detalle, /desactualizado: statusline\/statusline\.js \(distinto del plugin\)/);
  assert.match(x.barra.detalle, /vuelve a correr \/uaeh-kit:setup statusline/);

  e.escribir(path.join(estable, 'statusline', 'statusline.js'), '// barra\n');
  fs.rmSync(path.join(estable, 'statusline', 'claude-status-fetch.js'));
  x = estados();
  assert.equal(x.barra.estado, 'AVISO');
  assert.match(x.barra.detalle, /claude-status-fetch\.js \(falta en el espejo\)/);

  // VERSION del espejo contra la del plugin
  e.escribir(path.join(estable, 'VERSION'), '7.7.7\n');
  assert.equal(estados().espejo.estado, 'OK');
  e.escribir(path.join(estable, 'VERSION'), '7.7.6\n');
  const viejo = estados().espejo;
  assert.equal(viejo.estado, 'AVISO');
  assert.match(viejo.detalle, /7\.7\.6.*7\.7\.7/);
}));

test('subagente-modelo: lo toma de settings.env y respeta la prioridad del proyecto sobre el usuario', () => conCasa((e) => {
  assert.equal(ver(e).c['subagente-modelo'].estado, 'AVISO');
  assert.match(ver(e).c['subagente-modelo'].detalle, /recomendado: \/uaeh-kit:setup settings/);

  e.escribir(path.join(e.claudeHome, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }));
  let s = ver(e).c['subagente-modelo'];
  assert.equal(s.estado, 'OK');
  assert.equal(s.detalle, 'sonnet (pisa el model: de los agentes)');

  e.escribir(path.join(e.proyecto, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }));
  s = ver(e).c['subagente-modelo'];
  assert.match(s.detalle, /^haiku /, 'manda el settings local del proyecto');

  // sin --cwd explícito, el proyecto es la carpeta desde la que se corre
  const sinFlag = correr(SCRIPT, ['--json', '--tope', e.dir], { env: envSinClaude(e), cwd: e.proyecto }).json();
  assert.match(sinFlag.comprobaciones.find((x) => x.id === 'subagente-modelo').detalle, /^haiku /);
}));

test('skills-listado: usa buscarListado y analizar del módulo; sin módulo → OMITIDA; sin listado → NO_APLICA', () => conCasa((e) => {
  const modulo = [
    "'use strict';",
    "const fs = require('fs');",
    'module.exports = {',
    '  buscarListado(archivo) {',
    "    return fs.readFileSync(archivo, 'utf8').includes('skill_listing') ? { type: 'skill_listing', content: '- a: uno', skillCount: 2 } : null;",
    '  },',
    '  analizar(at, nombresExtra) {',
    "    if (!Array.isArray(nombresExtra)) throw new Error('analizar exige nombresExtra');",
    "    return { caracteres: 123, skillCount: 2, conDescripcion: 2, sinDescripcion: 0, masLargas: [{ nombre: 'b', caracteres: 9 }, { nombre: 'a', caracteres: 6 }] };",
    '  },',
    '};',
    '',
  ].join('\n');
  const sin = pluginFalso(e);
  assert.equal(ver(e, [], { script: sin.script }).c['skills-listado'].estado, 'OMITIDA');

  const p = pluginFalso(e, { archivos: { 'scripts/uaeh-listado-skills.cjs': modulo } });
  assert.equal(ver(e, [], { script: p.script }).c['skills-listado'].estado, 'NO_APLICA', 'sin transcripciones');

  transcripcion(e, 'p/vieja.jsonl', [JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: '- a: uno', skillCount: 2 } })], AHORA_MS - 2 * DIA);
  transcripcion(e, 'p/nueva-sin-listado.jsonl', [lineaUso({ entrada: 1 })], AHORA_MS - 1000);
  const r = ver(e, [], { script: p.script }).c['skills-listado'];
  assert.equal(r.estado, 'OK', 'busca hacia atrás hasta dar con una transcripción que traiga el listado');
  assert.equal(r.detalle, '2 skills, 123 caracteres; más largas: b (9), a (6)');

  fs.rmSync(path.join(e.claudeHome, 'projects', 'p', 'vieja.jsonl'));
  assert.equal(ver(e, [], { script: p.script }).c['skills-listado'].estado, 'NO_APLICA');
}));

// ── Instalador y doctor, juntos ───────────────────────────────────────────────────────────

const INSTALAR = path.join(RAIZ_KIT, 'scripts', 'instalar.cjs');

// Plugin falso con instalador, doctor, plantillas y los archivos que la instalación completa necesita.
function pluginCompleto(e, version = '7.7.7') {
  const p = pluginFalso(e, {
    version,
    archivos: {
      'hooks/hooks.json': hooksJson(['node "${CLAUDE_PLUGIN_ROOT}/hooks/uno.js"']),
      'hooks/uno.js': '// hook de prueba\n',
      'statusline/statusline.js': '// barra de prueba\n',
      'statusline/claude-status-fetch.js': '// consulta de prueba\n',
      'scripts/ventana-contexto.cjs': '// módulo de prueba: el instalador solo lo copia al espejo\n',
    },
  });
  fs.copyFileSync(INSTALAR, path.join(p.raiz, 'scripts', 'instalar.cjs'));
  require('../helpers/entorno.cjs').copiarCarpeta(path.join(RAIZ_KIT, 'templates'), path.join(p.raiz, 'templates'));
  return { ...p, instalar: path.join(p.raiz, 'scripts', 'instalar.cjs') };
}

test('instalador y doctor hablan el mismo idioma: tras «todo --aplicar» todo está al día; si el plugin se actualiza, el doctor lo nota y el instalador lo arregla', () => conCasa((e) => {
  const p = pluginCompleto(e);
  const env = envSinClaude(e);
  const instalar = () => correr(p.instalar, ['todo', '--aplicar'], { env, cwd: e.proyecto });
  const doctorDe = () => ver(e, [], { script: p.script });

  const inicial = doctorDe();
  assert.equal(inicial.c['bloque-reglas'].estado, 'AVISO');
  assert.equal(inicial.c.statusline.estado, 'AVISO');
  assert.equal(inicial.c['subagente-modelo'].estado, 'AVISO');

  const r1 = instalar();
  assert.equal(r1.status, 0, r1.stdout);
  let { r, j, c } = doctorDe();
  assert.equal(c['bloque-reglas'].estado, 'OK');
  assert.ok(c['bloque-reglas'].detalle.includes('v7.7.7'));
  assert.equal(c['subagente-modelo'].estado, 'OK');
  assert.equal(c.statusline.estado, 'OK');
  assert.equal(c.espejo.estado, 'OK');
  assert.equal(c['hooks-json'].estado, 'OK');
  assert.equal(c.duplicados.estado, 'OK');
  assert.equal(j.resumen['FALLÓ'], 0);
  assert.equal(r.status, 0);

  // el plugin se actualiza: otra versión y otro archivo de la barra
  fs.writeFileSync(path.join(p.raiz, 'statusline', 'statusline.js'), '// barra de prueba, versión nueva\n');
  e.escribir(path.join(p.raiz, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'uaeh-kit', version: '7.8.0' }));
  ({ c } = doctorDe());
  assert.equal(c['bloque-reglas'].estado, 'AVISO');
  assert.match(c['bloque-reglas'].detalle, /v7\.7\.7.*v7\.8\.0/);
  assert.equal(c.statusline.estado, 'AVISO');
  assert.equal(c.espejo.estado, 'AVISO');
  assert.match(c.espejo.detalle, /7\.7\.7.*7\.8\.0/);

  // volver a correr el instalador lo deja otra vez al día
  const r2 = instalar();
  assert.equal(r2.status, 0, r2.stdout);
  ({ r, c } = doctorDe());
  assert.equal(c['bloque-reglas'].estado, 'OK');
  assert.ok(c['bloque-reglas'].detalle.includes('v7.8.0'));
  assert.equal(c.statusline.estado, 'OK');
  assert.equal(c.espejo.estado, 'OK');
  assert.equal(r.status, 0);
}));
