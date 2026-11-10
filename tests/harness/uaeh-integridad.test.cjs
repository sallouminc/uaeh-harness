// Pruebas del sello de integridad UAEH (plugins/uaeh-harness/scripts/uaeh-integridad.cjs).
//
// Correr:  node --test tests/harness/uaeh-integridad.test.cjs
// UAEH_SCRIPT=<ruta> corre la misma suite contra otro script (p. ej. una copia con una mutación): sirve para demostrar
// que las regresiones FALLAN con el script viejo o roto y PASAN con el bueno. La carpeta lib/ debe estar junto a él.
//
// Hermética: todo ocurre en una casa temporal (tests/helpers/entorno.cjs: HOME, CLAUDE_CONFIG_DIR, UAEH_HOME, TEMP y la
// configuración global de git apuntan dentro de ella). Cada prueba trabaja en SU carpeta (un «mundo»: repo, fotos, arnés,
// claudeHome y codexHome propios), así que corren en paralelo; las ejecuciones del sello (cada una lanza decenas de
// procesos git) pasan por un semáforo del tamaño de los núcleos (como mucho 8: más no da más rendimiento, solo más espera).
//
// «Casa falsa»: el propio sello se niega a medir (DESCONOCIDO) si su entorno trae un HOME distinto del real o cualquier
// GIT_CONFIG_* / GIT_DIR / … (F3-P1: así un revisor no puede rodearlo cambiando variables), de modo que las pruebas no
// pueden aislarlo metiendo esas variables. Se le pasa una precarga (`node -r`) que, DENTRO de su proceso, hace que
// os.userInfo().homedir sea la casa temporal y que las llamadas a `git` lleven la configuración global de prueba, sin
// tocar el entorno que el sello inspecciona. Las pruebas de F3-P1 comprueban además, sin precarga o con variables
// metidas a propósito, que la regla sigue en pie.
'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('../helpers/entorno.cjs');

const SCRIPT = process.env.UAEH_SCRIPT ? path.resolve(process.env.UAEH_SCRIPT) : path.join(H.RAIZ_HARNESS, 'scripts', 'uaeh-integridad.cjs');
const MOD = require(SCRIPT); // funciones puras del sello (entornoAlterado, comparar, textoTomlNormalizado…): sin git ni entorno
const RE_ID = /^\d{8}-\d{6}-[0-9a-f]{6}-[0-9a-f]{16}$/;
const ESTRICTO = process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1';

// ---------------------------------------------------------------------------------------------------- casa temporal

const E = H.entornoTemporal('uaeh-integridad-');
H.gitConfigGlobal(E); // identidad de prueba, sin firma y SIN la guarda de git del usuario
after(() => E.limpiar());

// Variables que el sello considera «entorno alterado» (más XDG_CONFIG_HOME, que mueve la configuración de git) y perillas.
const VARS_QUE_ALTERAN = /^(GIT_CONFIG_.*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|XDG_CONFIG_HOME)$/i;
const PERILLAS = /^UAEH_(ARNES|PRESUPUESTO_MS|TOPE_SENSIBLES|INTEGRIDAD_DIR|SCRIPT)$/;

// Entorno de los procesos del sello: el hermético de la casa, sin nada que el sello llame «alterado» ni perillas.
function entornoBase() {
  const env = { ...E.env, CODEX_HOME: path.join(E.home, '.codex') };
  for (const k of Object.keys(env)) if (VARS_QUE_ALTERAN.test(k) || PERILLAS.test(k)) delete env[k];
  return env;
}

let nPrecargas = 0;
// Precarga de la casa falsa (ver arriba). `casa` = lo que el sello cree que es el home real; `gitGlobal` = el archivo que
// sus llamadas a git leen como configuración global.
function crearPrecarga({ casa = E.home, gitGlobal = E.env.GIT_CONFIG_GLOBAL } = {}) {
  const f = path.join(E.dir, `precarga-${++nPrecargas}.cjs`);
  fs.writeFileSync(f, [
    "'use strict';",
    "const os = require('os');",
    'const userInfoReal = os.userInfo;',
    `const casa = ${JSON.stringify(casa)};`,
    'os.userInfo = function (...a) { return { ...userInfoReal.apply(this, a), homedir: casa }; };',
    "const cp = require('child_process');",
    'const execFileSyncReal = cp.execFileSync;',
    'cp.execFileSync = function (file, args, opts) {',
    "  if (file === 'git') {",
    '    const env = { ...((opts && opts.env) || process.env) };',
    `    env.GIT_CONFIG_GLOBAL = ${JSON.stringify(gitGlobal)};`,
    "    env.GIT_CONFIG_NOSYSTEM = '1';",
    '    opts = { ...(opts || {}), env };',
    '  }',
    '  return execFileSyncReal.call(this, file, args, opts);',
    '};',
  ].join('\n') + '\n');
  return f;
}
const PRECARGA_BASE = crearPrecarga();

// Imprime el resultado de compararFoto(id) como JSON COMPLETO (la salida del CLI recorta la lista a 20 cambios).
const COMPARAR_JSON = path.join(E.dir, 'comparar-json.cjs');
fs.writeFileSync(COMPARAR_JSON, [
  "'use strict';",
  'const [, , sello, id] = process.argv;',
  'const r = require(sello).compararFoto(id);',
  'process.stdout.write(JSON.stringify({ estado: r.estado, cambios: r.cambios, avisos: r.avisos || [], motivo: r.motivo || null }));',
].join('\n') + '\n');

// ------------------------------------------------------------------------------------------ procesos y paralelismo

const LIMITE = Math.max(2, Math.min(os.availableParallelism(), 8));
let activos = 0;
const espera = [];
function entrar() { return new Promise((resolver) => { if (activos < LIMITE) { activos++; resolver(); } else espera.push(resolver); }); }
function salir() { const siguiente = espera.shift(); if (siguiente) siguiente(); else activos--; }

let nEjecuciones = 0;
after(() => console.log(`# ejecuciones del sello en esta suite: ${nEjecuciones} (hasta ${LIMITE} a la vez)`));

// Lanza `node` con precargas opcionales (`-r`). → Promise<{ code, out, err }> (out y err recortados). Un semáforo limita
// cuántos corren a la vez.
async function correrNode(argv, { entrada, env, precarga, cwd } = {}) {
  await entrar();
  nEjecuciones++;
  try {
    return await new Promise((resolver, rechazar) => {
      const pre = [].concat(precarga || []).flatMap((p) => ['-r', p]);
      const hijo = spawn(process.execPath, [...pre, ...argv], { env: env || entornoBase(), cwd: cwd || E.dir, windowsHide: true, timeout: 300000 });
      let out = '';
      let err = '';
      hijo.stdout.setEncoding('utf8');
      hijo.stderr.setEncoding('utf8');
      hijo.stdout.on('data', (d) => { out += d; });
      hijo.stderr.on('data', (d) => { err += d; });
      hijo.stdin.on('error', () => { /* el hijo pudo terminar antes de leer */ });
      hijo.on('error', rechazar);
      hijo.on('close', (code) => resolver({ code, out: out.trim(), err: err.trim() }));
      hijo.stdin.end(entrada === undefined ? '' : entrada);
    });
  } finally { salir(); }
}

// Corre casos INDEPENDIENTES en paralelo (cada uno con su mundo) y falla UNA vez, con la lista de todos los que fallaron.
async function todos(casos) {
  const resultados = await Promise.allSettled(casos.map((c) => Promise.resolve().then(c)));
  const fallos = resultados.filter((r) => r.status === 'rejected').map((r) => String((r.reason && r.reason.message) || r.reason));
  assert.equal(fallos.length, 0, `${fallos.length} caso(s) fallaron:\n${fallos.join('\n---\n')}`);
}

// Equivalente de ok(cond, nombre, extra) del origen: una sub-aserción con nombre.
function ok(cond, nombre, extra) { assert.ok(cond, extra === undefined ? nombre : `${nombre}\n       -> ${extra}`); }

function escribirArchivo(ruta, txt) { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, txt); return ruta; }
function json(texto) { try { return JSON.parse(texto || '{}'); } catch { return {}; } }

// Copia mínima del plugin bajo `destino/plugin`: el script bajo prueba y su lib/. La «raíz de este plugin» que mide el sello
// pasa a ser esa copia (estable y privada de la prueba), nunca el árbol real del repo, que otros procesos pueden estar editando.
function copiaDelPlugin(destino) {
  const raiz = path.join(destino, 'plugin');
  const scripts = path.join(raiz, 'scripts');
  const origen = path.dirname(SCRIPT);
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scripts, path.basename(SCRIPT)));
  for (const n of fs.readdirSync(path.join(origen, 'lib'))) fs.copyFileSync(path.join(origen, 'lib', n), path.join(scripts, 'lib', n));
  return { raiz, script: path.join(scripts, path.basename(SCRIPT)) };
}

// ------------------------------------------------------------------------------------------------------- el mundo

let nMundos = 0;
class Mundo {
  constructor() {
    this.n = ++nMundos;
    this.dir = path.join(E.dir, 'm' + this.n);
    this.claude = path.join(this.dir, 'claude'); // CLAUDE_CONFIG_DIR de este mundo
    this.codex = path.join(this.dir, 'codex'); // CODEX_HOME
    this.uaeh = path.join(this.claude, 'uaeh'); // UAEH_HOME
    this.fotos = path.join(this.dir, 'fotos');
    this.arnes = path.join(this.dir, 'arnes');
    this.sinGit = path.join(this.dir, 'sin-git');
    for (const d of [this.claude, this.codex, this.fotos, this.arnes, this.sinGit]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(this.arnes, 'settings.json'), '{"a":1}');
    this.script = SCRIPT;
    this.precarga = PRECARGA_BASE;
    this.env = {
      ...entornoBase(), CLAUDE_CONFIG_DIR: this.claude, CODEX_HOME: this.codex, UAEH_HOME: this.uaeh, UAEH_INTEGRIDAD_DIR: this.fotos,
      UAEH_ARNES: JSON.stringify([[this.arnes, '\\.(js|json)$']]),
    };
    this.repo = null;
    this.nRepos = 0;
  }

  // Arnés por defecto (sin UAEH_ARNES) sobre ESTE mundo y una copia privada del plugin.
  porDefecto() {
    delete this.env.UAEH_ARNES;
    const c = copiaDelPlugin(this.dir);
    this.script = c.script;
    this.plugin = c.raiz;
    return this;
  }

  // Env de este mundo con cambios (un valor `undefined` quita la variable).
  conEnv(extra) {
    const env = { ...this.env, ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env;
  }

  git(args, cwd = this.repo) { return H.git(cwd, args, E.env).stdout; }
  escribir(rel, txt) { return escribirArchivo(path.join(this.repo, rel), txt); }
  escribirEn(base, rel, txt) { return escribirArchivo(path.join(base, rel), txt); }

  // Repo temporal nuevo (queda como el actual) con un commit inicial.
  nuevoRepo(archivos, gitignore, nombre) {
    this.repo = path.join(this.dir, nombre || 'r' + (++this.nRepos));
    fs.mkdirSync(this.repo, { recursive: true });
    this.git(['init', '-q']);
    if (gitignore !== undefined) this.escribir('.gitignore', gitignore);
    for (const [k, v] of Object.entries(archivos || { 'a.txt': 'a\n' })) this.escribir(k, v);
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', 'inicial']);
    return this.repo;
  }

  // Corre el sello. → Promise<{ code, out, err }>
  run(args, { entrada, env, precarga } = {}) {
    return correrNode([this.script, ...args], { entrada, env: env || this.env, precarga: precarga === undefined ? this.precarga : precarga });
  }
  // Corre un fragmento de JavaScript con las mismas precargas y entorno.
  nodo(js, { env, precarga } = {}) {
    return correrNode(['-e', js], { env: env || this.env, precarga: precarga === undefined ? this.precarga : precarga });
  }
  // Un hook de verdad tiene 20 s de presupuesto interno; con decenas de procesos git compitiendo por la máquina de pruebas eso
  // es una fuente de falsos fallos, así que aquí se le da más (la prueba comprueba la lógica, no la velocidad).
  hook(op, entrada, opciones = {}) {
    const base = opciones.env || this.env;
    const env = { ...base, UAEH_PRESUPUESTO_MS: base.UAEH_PRESUPUESTO_MS || '120000' };
    return this.run([op], { entrada: JSON.stringify(entrada), ...opciones, env });
  }

  async foto(env) {
    const r = await this.run(['foto', this.repo, '--etiqueta', 'prueba'], { env });
    assert.equal(r.code, 0, 'foto falló: ' + r.out + ' ' + r.err);
    return r.out;
  }
  // Toma foto, aplica el cambio y compara. Si la foto falla devuelve SU resultado (así la aserción dice qué pasó).
  async caso(cambio, env) {
    const f = await this.run(['foto', this.repo, '--etiqueta', 'prueba'], { env });
    if (f.code !== 0) return f;
    await cambio();
    return this.run(['comparar', f.out], { env });
  }
  async rota(nombre, cambio, contiene, env) {
    const r = await this.caso(cambio, env);
    ok(r.code === 3 && r.out.startsWith('ROTA') && (!contiene || r.out.includes(contiene)), nombre, r.code + ' ' + r.out + ' ' + r.err);
    return r;
  }
  async intacto(nombre, cambio, env) {
    const r = await this.caso(cambio, env);
    ok(r.code === 0 && r.out.startsWith('INTACTO'), nombre, r.code + ' ' + r.out + ' ' + r.err);
    return r;
  }
  async desconocido(nombre, cambio, env) {
    const r = await this.caso(cambio, env);
    ok(r.code === 4 && r.out.startsWith('DESCONOCIDO'), nombre, r.code + ' ' + r.out + ' ' + r.err);
    return r;
  }

  // Varios cambios INDEPENDIENTES (rutas distintas) entre UNA foto y UNA comparación; la lista COMPLETA de cambios sale por
  // JSON (el CLI la recorta a 20) y cada caso se juzga por la suya. Un caso es { nombre, cambio, ruta, rota } (o `texto` en
  // vez de `ruta` para cambios que no son un archivo, p. ej. «.git: config»): `rota` exige que figure en la lista y
  // `!rota` que NO figure. → { estado, cambios, … }
  async tanda(casos, env) {
    const id = await this.foto(env);
    for (const c of casos) await c.cambio();
    const r = await correrNode([COMPARAR_JSON, this.script, id], { env: env || this.env, precarga: this.precarga });
    const res = json(r.out);
    ok(res.estado === 'ROTA' || res.estado === 'INTACTO', 'la tanda se pudo medir (ni DESCONOCIDO ni error)', r.out + ' ' + r.err);
    const cambios = res.cambios || [];
    const fallos = [];
    for (const c of casos) {
      const figura = cambios.some((x) => (c.texto ? x.includes(c.texto) : x.includes(': ' + c.ruta + ' (')));
      if (figura !== !!c.rota) fallos.push(`${c.nombre} → ${c.rota ? 'debía figurar en los cambios y no figura' : 'NO debía figurar en los cambios y figura'}`);
    }
    assert.equal(fallos.length, 0, `${fallos.length} caso(s) de la tanda fallaron:\n${fallos.join('\n')}\n(cambios: ${cambios.join(' | ')})`);
    return res;
  }

  // Cambios que NO deben anular nada: todos juntos y se espera INTACTO (si uno solo anulara, el conjunto también, y la lista
  // de cambios del CLI dice cuál). Cada caso es [nombre, cambio].
  async intactoTodos(casos, env) {
    const id = await this.foto(env);
    for (const [, cambio] of casos) await cambio();
    const r = await this.run(['comparar', id], { env });
    ok(r.code === 0 && r.out.startsWith('INTACTO'), 'deben dejar INTACTO: ' + casos.map(([n]) => n).join('; '), r.code + ' ' + r.out + ' ' + r.err);
    return r;
  }
}

// Casos de tanda: R = el cambio debe figurar (ROTA); I = no debe figurar (INTACTO). `ruta` es la del archivo en la lista.
const R = (nombre, cambio, ruta, texto) => ({ nombre, cambio, ruta, texto, rota: true });
const I = (nombre, cambio, ruta, texto) => ({ nombre, cambio, ruta, texto, rota: false });

// El repo «con espacios» del origen: el de los bloques principales (.gitignore con salidas, un fuente y su prueba).
function repoPrincipal(m) {
  return m.nuevoRepo({ 'src/app.js': 'module.exports = 1;\n', 'src/app.test.js': 'test\n' }, 'dist/\n.env.local\n.claude/\ncoverage/\n', 'repo con espacios');
}

// Tanda de casos de config.toml en UNA foto y UNA comparación. Cada caso vive en su subcarpeta (t01/config.toml, …) dentro
// de un arnés recursivo; la comparación devuelve la lista COMPLETA de cambios y cada caso se juzga por su archivo. Un caso es
// [nombre, antes, despues, esperaRota]: el cambio debe (o no) contar como cambio del arnés.
async function tandaToml(casos) {
  const m = new Mundo();
  m.nuevoRepo();
  const subcarpeta = (i) => 't' + String(i + 1).padStart(2, '0');
  casos.forEach(([, antes], i) => m.escribirEn(m.arnes, `${subcarpeta(i)}/config.toml`, antes));
  const env = m.conEnv({ UAEH_ARNES: JSON.stringify([[m.arnes, '^config\\.toml$', true]]) });
  const id = await m.foto(env);
  casos.forEach(([, , despues], i) => m.escribirEn(m.arnes, `${subcarpeta(i)}/config.toml`, despues));
  const r = await correrNode([COMPARAR_JSON, m.script, id], { env, precarga: m.precarga });
  const c = json(r.out);
  ok(c.estado === 'ROTA' || c.estado === 'INTACTO', 'la tanda de config.toml se pudo medir (no DESCONOCIDO)', r.out + ' ' + r.err);
  const fallos = [];
  casos.forEach(([nombre, , , esperaRota], i) => {
    const cambio = (c.cambios || []).some((x) => x.includes(`/${subcarpeta(i)}/config.toml`));
    if (cambio !== esperaRota) fallos.push(`${nombre} → esperaba ${esperaRota ? 'ROTA' : 'INTACTO'} y fue ${cambio ? 'ROTA' : 'INTACTO'}`);
  });
  assert.equal(fallos.length, 0, `${fallos.length} caso(s) de config.toml fallaron:\n${fallos.join('\n')}`);
}

// ====================================================================================================== las pruebas

describe('sello de integridad UAEH (uaeh-integridad.cjs)', { concurrency: true }, () => {
  // -------------------------------------------------------------------------------------------------------- F3-P1
  test('F3-P1 — entorno alterado: la función reconoce las formas equivalentes de HOME y las variables que rodean a git', () => {
    const homeReal = os.userInfo().homedir;
    const nombres = (env) => MOD.entornoAlterado(env).join(',');
    const win = process.platform === 'win32';
    const formas = win
      ? [homeReal, homeReal.replace(/\\/g, '/'), '/' + homeReal[0].toLowerCase() + homeReal.slice(2).replace(/\\/g, '/'), homeReal[0].toLowerCase() + homeReal.slice(1) + '\\']
      : [homeReal, homeReal + '/'];
    formas.forEach((h, i) => ok(nombres({ HOME: h }) === '', 'F3-P1: HOME en forma equivalente #' + (i + 1) + ' → no alterado'));
    ok(nombres({ HOME: path.join(E.dir, 'otra-casa') }) === 'HOME', 'F3-P1: HOME distinta → alterado (solo el nombre)');
    ok(nombres({ XDG_CONFIG_HOME: path.join(E.dir, 'x') }) === 'XDG_CONFIG_HOME', 'F3-P1: XDG_CONFIG_HOME distinta → alterado');
    ok(nombres({ XDG_CONFIG_HOME: '' }) === 'XDG_CONFIG_HOME', 'F3-P1: XDG_CONFIG_HOME vacía pero definida → alterado');
    ok(nombres({ XDG_CONFIG_HOME: path.join(homeReal, '.config') }) === '', 'F3-P1: XDG_CONFIG_HOME = <home>/.config → no alterado');
    for (const v of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_3',
      'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      ok(nombres({ [v]: '' }) === v, 'F3-P1: ' + v + ' definida (aunque vacía) → alterado');
    }
    ok(nombres({ GIT_ASKPASS: 'x', GIT_EDITOR: 'y', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PATH: 'p' }) === '', 'F3-P1: GIT_ASKPASS/GIT_EDITOR/GIT_TERMINAL_PROMPT/GIT_PAGER → no alterado');
  });

  test('F3-P1 — entorno alterado: foto, comparar y hook-fin dan DESCONOCIDO (sin imprimir el valor) y la foto lo recuerda', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    // La casa falsa: dentro del proceso del sello ninguna variable de HOME, XDG o git cuenta como alterada.
    const limpio = await m.nodo(`process.stdout.write(JSON.stringify(require(${JSON.stringify(m.script)}).entornoAlterado()))`);
    ok(limpio.out === '[]', 'casa falsa: el entorno del sello es el real (HOME, XDG_CONFIG_HOME, GIT_* sin alterar)', limpio.out + ' ' + limpio.err);
    const r0 = await m.run(['foto', m.repo]);
    ok(r0.code === 0, 'F3-P1: foto con entorno limpio', r0.out + ' ' + r0.err);
    const c0 = await m.run(['comparar', r0.out]);
    ok(c0.code === 0 && c0.out.startsWith('INTACTO'), 'F3-P1: comparar con entorno limpio → INTACTO', c0.out);
    const sucios = { XDG_CONFIG_HOME: path.join(m.dir, 'x'), HOME: path.join(m.dir, 'otra-casa'), GIT_CONFIG_GLOBAL: path.join(m.dir, 'g'), GIT_DIR: path.join(m.dir, 'd') };
    for (const [v, val] of Object.entries(sucios)) {
      const c = await m.run(['comparar', r0.out], { env: m.conEnv({ [v]: val }) });
      ok(c.code === 4 && /^DESCONOCIDO: entorno alterado: /.test(c.out) && c.out.includes(v) && !c.out.includes(val),
        'F3-P1: comparar con ' + v + ' alterada → DESCONOCIDO con el motivo (sin el valor)', c.code + ' ' + c.out);
    }
    const fs1 = await m.run(['foto', m.repo], { env: m.conEnv({ GIT_CONFIG_NOSYSTEM: '1' }) });
    ok(fs1.code === 0 && /entorno alterado: GIT_CONFIG_NOSYSTEM/.test(fs1.err), 'F3-P1: foto con entorno alterado avisa por stderr', fs1.code + ' ' + fs1.err);
    const cs1 = await m.run(['comparar', fs1.out]);
    ok(cs1.code === 4 && /^DESCONOCIDO: la foto se tomó con entorno alterado: GIT_CONFIG_NOSYSTEM/.test(cs1.out), 'F3-P1: foto con entorno alterado + comparar con entorno limpio → DESCONOCIDO', cs1.code + ' ' + cs1.out);
    const ent = { agent_type: 'uae-verifier', agent_id: 'f3p1', cwd: m.repo };
    const hk = await m.hook('hook-inicio', ent, { env: m.conEnv({ XDG_CONFIG_HOME: path.join(m.dir, 'x') }) });
    const hf = await m.hook('hook-fin', ent);
    ok(/UNKNOWN/.test(hf.out) && /entorno alterado/.test(hf.out), 'F3-P1: el hook-fin hereda la regla (foto del hook con entorno alterado → pide UNKNOWN)', hk.out.slice(0, 80) + ' | ' + hf.out.slice(0, 200));
  });

  test('F3-P1 — config.toml: el catálogo de la app de Codex avisa pero no anula; lo demás sí', async () => {
    const baseToml = 'model = "a"\nsandbox_mode = "workspace-write"\n\n[profiles.p]\nmodel = "m"\n\n[plugins."chrome@openai-bundled"]\nenabled = true\n\n[marketplaces.openai-bundled]\nlast_updated = "t1"\n';
    await todos([
      // Solo cambia el catálogo (plugins*, marketplaces*): INTACTO, con un AVISO por cada archivo que cambió (tres archivos, una comparación).
      async () => {
        const casos = [
          ['F3-P1: plugin nuevo agregado → INTACTO + AVISO', baseToml + '\n[plugins."pdf@openai-primary-runtime"]\nenabled = true\n', 'plugins.pdf@openai-primary-runtime'],
          ['F3-P1: plugin existente cambia enabled → INTACTO + AVISO', baseToml.replace('enabled = true', 'enabled = false'), 'plugins.chrome@openai-bundled'],
          ['F3-P1: marketplace cambia last_updated → INTACTO + AVISO', baseToml.replace('t1', 't2'), 'marketplaces.openai-bundled'],
        ];
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        const env = m.conEnv({ UAEH_ARNES: JSON.stringify([[m.arnes, '^config\\.toml$', true]]) });
        casos.forEach((c, i) => m.escribirEn(m.arnes, `c${i}/config.toml`, baseToml));
        const f = await m.run(['foto', m.repo], { env });
        casos.forEach(([, nuevo], i) => m.escribirEn(m.arnes, `c${i}/config.toml`, nuevo));
        const c = await m.run(['comparar', f.out], { env });
        ok(c.code === 0 && c.out.startsWith('INTACTO'), 'F3-P1: solo catálogo → INTACTO', c.code + ' ' + c.out);
        for (const [nombre, , aviso] of casos) {
          ok(c.out.includes('AVISO: config.toml: cambió solo ' + aviso) && c.out.includes('(catálogo de la app de Codex)'), nombre, c.out);
        }
      },
      // Todo lo demás (o el catálogo junto con otra cosa) anula.
      () => tandaToml([
        ['F3-P1: sandbox_mode cambia → ROTA', baseToml, baseToml.replace('workspace-write', 'danger-full-access'), true],
        ['F3-P1: perfil cambia → ROTA', baseToml, baseToml.replace('model = "m"', 'model = "n"'), true],
        ['F3-P1: servidor MCP nuevo → ROTA', baseToml, baseToml + '\n[mcp_servers.x]\ncommand = "y"\n', true],
        ['F3-P1: catálogo + sandbox a la vez → ROTA', baseToml, baseToml.replace('t1', 't2').replace('workspace-write', 'read-only'), true],
      ]),
    ]);
  });

  // ---------------------------------------------------------------------------------------- bloques principales
  test('Sin cambios y salidas ignoradas (pruebas que escriben cachés y builds), en un repo con espacios en la ruta', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    ok(m.repo.includes(' '), 'el repo principal tiene un espacio en la ruta', m.repo);
    await m.intacto('foto y comparar sin tocar nada → INTACTO', () => {});
    await m.intactoTodos([
      ['leer archivos y git status no cambian nada', () => { fs.readFileSync(path.join(m.repo, 'src/app.js')); m.git(['status']); m.git(['log', '--oneline']); }],
      ['escribir en dist/ (ignorado)', () => m.escribir('dist/bundle.js', 'x')],
      ['escribir en coverage/ (ignorado)', () => m.escribir('coverage/lcov.info', 'x')],
      ['refs/remotes (fetch automático)', () => m.git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])],
      ['evidencia del browser-verifier sin ignorar (reports/visual-audit, test-results)', () => {
        m.escribir('reports/visual-audit/20261015-1200/home-360.png', 'png');
        m.escribir('test-results/visual/resultado.json', '{}');
      }],
    ]);
    await m.rota('pero un archivo en reports/ fuera de visual-audit sí cuenta', () => m.escribir('reports/otro.md', 'x'), 'reports/otro.md');
  });

  test('Cambios que anulan el veredicto: archivos, ignorados de entrada y arnés', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    await m.rota('modificar un archivo rastreado', () => m.escribir('src/app.js', 'module.exports = 2;\n'), 'src/app.js');
    m.git(['checkout', '--', 'src/app.js']);
    // Todos los demás, juntos (rutas distintas): cada uno debe figurar en la lista de cambios.
    m.escribir('src/borrar.js', 'borrame\n');
    m.git(['add', 'src/borrar.js']);
    m.git(['commit', '-q', '-m', 'archivo para borrar']);
    await m.tanda([
      R('modificar una prueba (un archivo rastreado que cambia se reporta como «modificado»)', () => m.escribir('src/app.test.js', 'test.skip\n'), null, 'src/app.test.js (modificado)'),
      R('archivo nuevo no ignorado se reporta como «archivo nuevo»', () => m.escribir('src/nuevo.js', 'x'), null, 'src/nuevo.js (archivo nuevo)'),
      R('borrar un archivo rastreado se reporta como «borrado»', () => fs.unlinkSync(path.join(m.repo, 'src/borrar.js')), null, 'src/borrar.js (borrado)'),
      R('.env.local ignorado cambia el comportamiento', () => m.escribir('.env.local', 'MODO=2\n'), '.env.local'),
      // Un `{}` vale lo mismo que un archivo ausente (ciclo 3, A4); el contenido de la prueba es un hook.
      R('.claude/ ignorado (permisos del proyecto)', () => m.escribir('.claude/settings.local.json', '{"hooks":{}}'), '.claude/settings.local.json'),
      R('arnés: settings', () => fs.writeFileSync(path.join(m.arnes, 'settings.json'), '{"a":2}'), m.arnes.split(path.sep).join('/') + '/settings.json'),
      R('arnés: hook nuevo', () => fs.writeFileSync(path.join(m.arnes, 'nuevo.js'), 'x'), m.arnes.split(path.sep).join('/') + '/nuevo.js'),
    ]);
  });

  test('Cambios que anulan el veredicto: índice, commits, ramas, configuración y ganchos de git', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    // Los que tocan archivos distintos de .git, juntos: índice, config, hooks e info/exclude anulan; etiquetas y ramas nuevas no.
    const exclude = path.join(m.repo, '.git', 'info', 'exclude');
    await m.tanda([
      R('git add (índice)', () => { m.escribir('src/app.js', 'module.exports = 3;\n'); m.git(['add', 'src/app.js']); }, null, 'índice'),
      R('.git/config', () => m.git(['config', 'core.hooksPath', 'x']), null, '.git: config'),
      R('.git/hooks nuevo', () => fs.writeFileSync(path.join(m.repo, '.git', 'hooks', 'pre-commit'), 'exit 0'), null, '.git: hooks/pre-commit'),
      R('.git/info/exclude (ocultar archivos)', () => fs.appendFileSync(exclude, '\nsrc/\n'), null, '.git: info/exclude'),
      // Ramas y etiquetas nuevas ya no anulan (ciclo 2, D11): las mueven otros worktrees sin tocar el código.
      I('etiqueta nueva → no figura (refs ya no se miden)', () => m.git(['tag', 'v-prueba']), null, 'v-prueba'),
      I('rama nueva (sin cambiar de rama) → no figura', () => m.git(['branch', 'rama-nueva']), null, 'rama-nueva'),
    ]);
    // Cada uno de los que mueven HEAD, la rama o el árbol de trabajo, a solas y desde un repo limpio.
    const limpio = new Mundo();
    repoPrincipal(limpio);
    await limpio.rota('commit nuevo (HEAD)', () => { limpio.escribir('src/otro.js', 'x'); limpio.git(['add', 'src/otro.js']); limpio.git(['commit', '-q', '-m', 'x']); }, 'HEAD');
    // El stash ya no se mide como referencia (ciclo 2, D11): con cambios en curso, `git stash` devuelve el archivo a HEAD y se
    // detecta POR ARCHIVO.
    limpio.escribir('src/app.js', 'en progreso\n');
    await limpio.rota('stash con cambios en curso → ROTA por archivo', () => limpio.git(['stash', '-q']), 'src/app.js');
    limpio.git(['stash', 'drop', '-q']);
    await limpio.rota('cambiar de rama', () => limpio.git(['checkout', '-q', '-b', 'otra']), 'rama');
  });

  test('Archivos ya modificados al tomar la foto', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    m.escribir('src/app.js', 'en progreso\n');
    await m.intacto('modificado antes y sin tocar → INTACTO', () => {});
    await m.rota('modificado antes y vuelto a cambiar → ROTA', () => m.escribir('src/app.js', 'otra cosa\n'), 'src/app.js');
    // Ahora el archivo rastreado se hashea siempre (ciclo 2, D1): revertirlo se reporta como «modificado».
    await m.rota('modificado antes y revertido → ROTA', () => m.git(['checkout', '--', 'src/app.js']), 'src/app.js (modificado)');
  });

  test('Foto sustituida (la huella vive en el id que guarda el orquestador)', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    const idA = await m.foto();
    ok(RE_ID.test(idA), 'el id lleva la huella de la medición', idA);
    m.escribir('src/app.js', 'cambio del revisor\n');
    const idB = await m.foto(); // foto tomada DESPUÉS del cambio
    fs.copyFileSync(path.join(m.fotos, idB + '.foto.json'), path.join(m.fotos, idA + '.foto.json'));
    const rs = await m.run(['comparar', idA]);
    ok(rs.code === 3 && /sustituido o alterado/.test(rs.out), 'foto reemplazada por una posterior → ROTA (no INTACTO)', rs.out);
    const idC = await m.foto();
    const f = JSON.parse(fs.readFileSync(path.join(m.fotos, idC + '.foto.json'), 'utf8'));
    f.medicion.archivos = {};
    fs.writeFileSync(path.join(m.fotos, idC + '.foto.json'), JSON.stringify(f));
    const re = await m.run(['comparar', idC]);
    ok(re.code === 3 && /sustituido o alterado/.test(re.out), 'foto editada a mano → ROTA', re.out);
  });

  test('Errores = DESCONOCIDO, nunca INTACTO', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    let r = await m.run(['foto', m.sinGit]);
    ok(r.code === 4 && r.out.startsWith('DESCONOCIDO'), 'foto fuera de un repo git → DESCONOCIDO', r.out);
    r = await m.run(['comparar', 'no-existe-123']);
    ok(r.code === 4, 'comparar una foto inexistente → DESCONOCIDO', r.out);
    r = await m.run(['comparar', '../../etc/passwd']);
    ok(r.code === 4 && r.out.includes('id inválido'), 'id con ruta → DESCONOCIDO (id inválido)', r.out);
    const idCorrupta = await m.foto();
    fs.writeFileSync(path.join(m.fotos, idCorrupta + '.foto.json'), '{corrupta');
    r = await m.run(['comparar', idCorrupta]);
    ok(r.code === 4, 'foto corrupta → DESCONOCIDO', r.out);
    r = await m.run(['foto']);
    ok(r.code === 4, 'foto sin ruta → DESCONOCIDO', r.out);
    r = await m.run(['nada']);
    ok(r.code === 2, 'operación desconocida → uso (2)', r.out);
  });

  test('Hooks de subagente: foto al iniciar, bloqueo al terminar con cambios, nunca bucle', async () => {
    const m = new Mundo();
    repoPrincipal(m);
    const base = { session_id: 's', cwd: m.repo, agent_id: 'abc123', agent_type: 'uae-verifier' };
    let r = await m.hook('hook-inicio', { ...base, hook_event_name: 'SubagentStart' });
    let j = json(r.out);
    ok(r.code === 0 && j.hookSpecificOutput && /activo sobre/.test(j.hookSpecificOutput.additionalContext), 'inicio de un revisor → foto + aviso', r.out);
    ok(fs.existsSync(path.join(m.fotos, 'agente-abc123.foto.json')), 'inicio guarda la foto del agente');
    ok(/"id":"agente-abc123"[^\n]*"resultado":"FOTO_OK"/.test(fs.readFileSync(path.join(m.fotos, 'registro.jsonl'), 'utf8')), 'D6: el inicio registra FOTO_OK');
    r = await m.hook('hook-fin', { ...base, hook_event_name: 'SubagentStop', stop_hook_active: false });
    ok(r.code === 0 && r.out === '', 'fin sin cambios → deja terminar', r.out);

    await m.hook('hook-inicio', { ...base, agent_id: 'def456' });
    m.escribir('src/app.js', 'trampa\n');
    r = await m.hook('hook-fin', { ...base, agent_id: 'def456', stop_hook_active: false });
    j = json(r.out);
    ok(j.decision === 'block' && /ANULADO/.test(j.reason) && /src\/app\.js/.test(j.reason) && /BLOCKED/.test(j.reason), 'fin con cambios → obliga a reportar BLOCKED con la lista', r.out);
    r = await m.hook('hook-fin', { ...base, agent_id: 'def456', stop_hook_active: true });
    ok(r.code === 0 && r.out === '', 'fin repetido (stop_hook_active) → no hace bucle', r.out);
    const registro = fs.readFileSync(path.join(m.fotos, 'registro.jsonl'), 'utf8');
    ok(/"id":"agente-def456"[^\n]*"resultado":"ROTA"/.test(registro), 'el registro guarda el ROTA del agente');
    // El inicio registra también FOTO_OK (D6), así que se cuenta solo el resultado del fin.
    ok((registro.match(/"id":"agente-def456"[^\n]*"resultado":"ROTA"/g) || []).length === 1, 'la segunda parada no duplica el registro');
    ok(/src\/app\.js \(modificado\)/.test(registro), 'un archivo rastreado que cambia se reporta como «modificado»', registro);
    m.git(['checkout', '--', 'src/app.js']);

    r = await m.hook('hook-inicio', { ...base, agent_id: 'x1', agent_type: 'Explore' });
    ok(r.code === 0 && r.out === '' && !fs.existsSync(path.join(m.fotos, 'agente-x1.foto.json')), 'agente que no es revisor → nada');
    r = await m.hook('hook-inicio', { ...base, agent_id: 'x2', agent_type: 'plugin:uae-security' });
    ok(fs.existsSync(path.join(m.fotos, 'agente-x2.foto.json')), 'tipo con prefijo «plugin:uae-security» → se reconoce');
    r = await m.hook('hook-inicio', { ...base, agent_id: 'x3', cwd: m.sinGit });
    j = json(r.out);
    ok(j.hookSpecificOutput && /no es un repo git/.test(j.hookSpecificOutput.additionalContext), 'cwd sin git → avisa que el orquestador toma la foto', r.out);
    // El fin lleva el mismo cwd sin git que el inicio (con cwd = repo la foto sí era esperada).
    r = await m.hook('hook-fin', { ...base, agent_id: 'x3', cwd: m.sinGit });
    ok(r.code === 0 && r.out === '', 'fin sin foto automática → deja terminar');
    // D6: con cwd = repo, la foto ERA esperada; si falta o está corrupta, el fin bloquea pidiendo UNKNOWN.
    await m.hook('hook-inicio', { ...base, agent_id: 'borrada1' });
    fs.unlinkSync(path.join(m.fotos, 'agente-borrada1.foto.json'));
    r = await m.hook('hook-fin', { ...base, agent_id: 'borrada1', stop_hook_active: false });
    j = json(r.out);
    ok(j.decision === 'block' && /UNKNOWN/.test(j.reason), 'D6: foto de agente BORRADA con cwd = repo → bloquea pidiendo UNKNOWN', r.out);
    await m.hook('hook-inicio', { ...base, agent_id: 'corrupta1' });
    fs.writeFileSync(path.join(m.fotos, 'agente-corrupta1.foto.json'), '{corrupta');
    r = await m.hook('hook-fin', { ...base, agent_id: 'corrupta1', stop_hook_active: false });
    j = json(r.out);
    ok(j.decision === 'block' && /UNKNOWN/.test(j.reason), 'D6: foto de agente CORRUPTA con cwd = repo → bloquea pidiendo UNKNOWN', r.out);
    r = await m.hook('hook-fin', { ...base, agent_id: 'corrupta1', stop_hook_active: true });
    ok(r.code === 0 && r.out === '', 'D6: y la segunda parada (stop_hook_active) no hace bucle', r.out);
    r = await m.hook('hook-inicio', { ...base, agent_id: '../../malo' });
    ok(r.code === 0 && r.out === '', 'agent_id con ruta → ignorado');
    r = await m.run(['hook-inicio'], { entrada: 'no es json' });
    ok(r.code === 0 && r.out === '', 'entrada ilegible → no rompe');
  });

  // ================================================================================== Ciclo 2 — una regresión por decisión
  test('D1 — archivos rastreados que git da por limpios (assume-unchanged, skip-worktree, filtro clean)', async () => {
    await todos([
      async () => {
        const m = new Mundo();
        m.nuevoRepo();
        m.git(['update-index', '--assume-unchanged', 'a.txt']);
        await m.rota('assume-unchanged + modificar → ROTA', () => m.escribir('a.txt', 'cambiado\n'), 'a.txt');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo();
        m.git(['update-index', '--skip-worktree', 'a.txt']);
        await m.rota('skip-worktree + modificar → ROTA', () => m.escribir('a.txt', 'cambiado\n'), 'a.txt');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        await m.rota('solo poner la bandera assume-unchanged → ROTA', () => m.git(['update-index', '--assume-unchanged', 'a.txt']), 'banderas');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'z.keep': 'z\n' });
        m.git(['config', 'filter.x.clean', 'echo constante']);
        m.escribir('.gitattributes', '*.txt filter=x\n');
        m.escribir('f.txt', 'original\n');
        m.git(['add', '-A']);
        m.git(['commit', '-q', '-m', 'con filtro']);
        ok(m.git(['status', '--porcelain']).trim() === '', 'filtro clean: git status arranca limpio');
        await m.rota('filtro clean que normaliza + modificar → ROTA', () => m.escribir('f.txt', 'distinto\n'), 'f.txt');
        ok(m.git(['status', '--porcelain']).trim() === '', 'filtro clean: git status sigue «limpio» (el caso que el ciclo 1 no veía)');
      },
    ]);
  });

  test('D2 / D12 — no rastreados y excepción de evidencias (solo NO rastreados, a cualquier profundidad y que no sean pruebas)', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    // La guarda de git del usuario puede rechazar COMMITEAR evidencias: aquí el archivo queda rastreado solo en el índice.
    m.escribir('test-results/fix.json', '{}\n');
    m.git(['add', '-f', 'test-results/fix.json']);
    await m.tanda([
      R('rastreado bajo test-results/ modificado → ROTA', () => m.escribir('test-results/fix.json', '{"x":1}\n'), 'test-results/fix.json'),
      R('test-results/x.test.js nuevo (prueba, no evidencia) → ROTA', () => m.escribir('test-results/x.test.js', 'x\n'), 'test-results/x.test.js'),
      I('test-results/captura.png nuevo → INTACTO', () => m.escribir('test-results/captura.png', 'png'), 'test-results/captura.png'),
      I('sub/test-results/captura.png nuevo (cualquier profundidad) → INTACTO', () => m.escribir('sub/test-results/captura.png', 'png'), 'sub/test-results/captura.png'),
      R('test-results/__tests__/x.js nuevo → ROTA', () => m.escribir('test-results/__tests__/x.js', 'x'), 'test-results/__tests__/x.js'),
    ]);
  });

  test('D3 — sin tope de tamaño (archivo de 33 MiB cambiado conservando tamaño y fecha) y presupuesto de tiempo', async () => {
    const m = new Mundo();
    m.nuevoRepo();
    const grande = path.join(m.repo, 'grande.bin');
    const MIB33 = 33 * 1024 * 1024;
    const fijarFecha = () => fs.utimesSync(grande, 1700000000, 1700000000);
    fs.writeFileSync(grande, Buffer.alloc(MIB33, 1));
    fijarFecha();
    await m.rota('archivo > 32 MiB cambiado conservando tamaño y mtime → ROTA', () => {
      const b = Buffer.alloc(MIB33, 1);
      b[MIB33 - 1] = 2;
      fs.writeFileSync(grande, b);
      fijarFecha();
    }, 'grande.bin');
    fs.unlinkSync(grande);
    const p = new Mundo();
    p.nuevoRepo();
    let rp = await p.run(['foto', p.repo], { env: p.conEnv({ UAEH_PRESUPUESTO_MS: '1' }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'presupuesto agotado al tomar la foto → DESCONOCIDO (4)', rp.code + ' ' + rp.out);
    const id = await p.foto();
    rp = await p.run(['comparar', id], { env: p.conEnv({ UAEH_PRESUPUESTO_MS: '1' }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'presupuesto agotado al comparar → DESCONOCIDO (4), nunca INTACTO', rp.code + ' ' + rp.out);
  });

  test('D4 — errores de medición = DESCONOCIDO (UAEH_ARNES inválido); los estados legítimos NO son error', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    let rp = await m.run(['foto', m.repo], { env: m.conEnv({ UAEH_ARNES: 'esto no es json' }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'UAEH_ARNES inválido → DESCONOCIDO (antes: sin arnés)', rp.code + ' ' + rp.out);
    rp = await m.run(['foto', m.repo], { env: m.conEnv({ UAEH_ARNES: '[["solo-una-cosa"]]' }) });
    ok(rp.code === 4, 'UAEH_ARNES con forma inválida → DESCONOCIDO', rp.code + ' ' + rp.out);
    // Estados legítimos que NO son error.
    const sc = new Mundo();
    sc.repo = path.join(sc.dir, 'sin-commits');
    fs.mkdirSync(sc.repo, { recursive: true });
    sc.git(['init', '-q']);
    sc.escribir('x.txt', 'x\n');
    await sc.intacto('repo sin commits (estado legítimo) → INTACTO', () => {});
    await sc.rota('repo sin commits: archivo nuevo → ROTA', () => sc.escribir('y.txt', 'y\n'), 'y.txt');
    const d = new Mundo();
    d.nuevoRepo();
    d.git(['checkout', '-q', '--detach']);
    await d.intacto('HEAD desacoplado (estado legítimo) → INTACTO', () => {});
  });

  if (process.platform === 'win32') {
    test('D4 — archivo ilegible (icacls /deny lectura) → DESCONOCIDO, no INTACTO (Windows)', async () => {
      const m = new Mundo();
      m.nuevoRepo({ 'a.txt': 'a\n' });
      const bloq = path.join(m.repo, 'bloq.txt');
      fs.writeFileSync(bloq, 'secreto\n');
      const usuario = os.userInfo().username;
      const negar = () => assert.equal(spawnSync('icacls', [bloq, '/deny', usuario + ':(R)'], { encoding: 'utf8' }).status, 0, 'icacls /deny falló');
      const liberar = () => spawnSync('icacls', [bloq, '/remove:d', usuario], { encoding: 'utf8' });
      let rp;
      negar();
      try { rp = await m.run(['foto', m.repo]); } finally { liberar(); }
      ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'archivo ilegible al tomar la foto (icacls /deny lectura) → DESCONOCIDO', rp.code + ' ' + rp.out);
      const id = await m.foto();
      negar();
      try { rp = await m.run(['comparar', id]); } finally { liberar(); }
      ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'archivo que se vuelve ilegible → DESCONOCIDO, no INTACTO', rp.code + ' ' + rp.out);
    });
  } else if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    test('D4 — archivo ilegible (chmod 000) → DESCONOCIDO, no INTACTO (POSIX, sin ser root)', async () => {
      const m = new Mundo();
      m.nuevoRepo({ 'a.txt': 'a\n' });
      const bloq = path.join(m.repo, 'bloq.txt');
      fs.writeFileSync(bloq, 'secreto\n');
      let rp;
      fs.chmodSync(bloq, 0o000);
      try { rp = await m.run(['foto', m.repo]); } finally { fs.chmodSync(bloq, 0o600); }
      ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'archivo ilegible al tomar la foto (chmod 000) → DESCONOCIDO', rp.code + ' ' + rp.out);
      const id = await m.foto();
      fs.chmodSync(bloq, 0o000);
      try { rp = await m.run(['comparar', id]); } finally { fs.chmodSync(bloq, 0o600); }
      ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'archivo que se vuelve ilegible → DESCONOCIDO, no INTACTO', rp.code + ' ' + rp.out);
    });
  }

  test('D5 — la huella cubre {version, repo, medicion}: señuelo, otro repo, repo medido y foto de versión vieja', async () => {
    const m = new Mundo();
    const repoA = m.nuevoRepo({ 'a.txt': 'a\n' });
    const decoy = path.join(m.dir, 'decoy');
    H.copiarCarpeta(repoA, decoy);
    const id = await m.foto();
    m.escribir('a.txt', 'cambiado por el revisor\n');
    const f = JSON.parse(fs.readFileSync(path.join(m.fotos, id + '.foto.json'), 'utf8'));
    f.repo = decoy;
    fs.writeFileSync(path.join(m.fotos, id + '.foto.json'), JSON.stringify(f));
    let rp = await m.run(['comparar', id]);
    ok(rp.code === 3 && /sustituido o alterado/.test(rp.out), 'foto.repo apuntado a una copia señuelo → ROTA (huella)', rp.code + ' ' + rp.out);
    fs.rmSync(decoy, { recursive: true, force: true });
    m.git(['checkout', '--', 'a.txt']);

    const otro = m.nuevoRepo({ 'b.txt': 'b\n' });
    const idB = await m.foto();
    rp = await m.run(['comparar', idB, repoA]);
    ok(rp.code === 4 && /otro repo/.test(rp.out), 'comparar <id> <otro-repo> → DESCONOCIDO («la foto es de otro repo»)', rp.code + ' ' + rp.out);
    rp = await m.run(['comparar', idB, otro]);
    ok(rp.code === 0 && rp.out.startsWith('INTACTO'), 'comparar <id> <mismo-repo> → INTACTO', rp.code + ' ' + rp.out);
    rp = await m.run(['comparar', idB]);
    ok(rp.out.includes('repo medido') && rp.out.toLowerCase().includes(path.basename(otro).toLowerCase()), 'comparar imprime el repo medido', rp.out);

    const idV = await m.foto();
    const fv = JSON.parse(fs.readFileSync(path.join(m.fotos, idV + '.foto.json'), 'utf8'));
    fv.version = 1;
    fs.writeFileSync(path.join(m.fotos, idV + '.foto.json'), JSON.stringify(fv));
    rp = await m.run(['comparar', idV]);
    ok(rp.code === 4 && /versi/.test(rp.out), 'foto v1 (versión vieja) → DESCONOCIDO', rp.code + ' ' + rp.out);
  });

  if (process.platform === 'win32') {
    test('D5 — en Windows la ruta del repo se compara sin distinguir mayúsculas', async () => {
      const m = new Mundo();
      const repo = m.nuevoRepo({ 'a.txt': 'a\n' });
      const id = await m.foto();
      const rp = await m.run(['comparar', id, repo.toUpperCase()]);
      ok(rp.code === 0 && rp.out.startsWith('INTACTO'), 'en Windows la ruta del repo se compara sin distinguir mayúsculas', rp.code + ' ' + rp.out);
    });
  }

  test('D7 — ignorados sensibles a cualquier profundidad (y lo que no cuenta: node_modules, worktrees de Claude)', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, 'config/\n.claude/\nnode_modules/\n');
    await m.tanda([
      R('config/.env.local dentro de una carpeta ignorada → ROTA', () => m.escribir('config/.env.local', 'X=1\n'), 'config/.env.local'),
      I('.env dentro de node_modules → INTACTO (no se mide)', () => m.escribir('node_modules/pkg/.env', 'X=1\n'), 'node_modules/pkg/.env'),
      I('cambio en .claude/worktrees/agent-x/… → INTACTO', () => m.escribir('.claude/worktrees/agent-x/f.txt', 'x\n'), '.claude/worktrees/agent-x/f.txt'),
      R('sub/.npmrc ignorado a profundidad → ROTA', () => m.escribir('config/hondo/.npmrc', 'x=1\n'), 'config/hondo/.npmrc'),
    ]);
    for (let i = 0; i < 25; i++) m.escribir('.claude/muchos/f' + i + '.txt', 'x\n');
    const rp = await m.run(['foto', m.repo], { env: m.conEnv({ UAEH_TOPE_SENSIBLES: '20' }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'más archivos sensibles que el tope → DESCONOCIDO (sin truncar en silencio)', rp.code + ' ' + rp.out);
    // .claude/ NO ignorado: un worktree de agente es un repo anidado.
    const n = new Mundo();
    n.nuevoRepo({ 'a.txt': 'a\n' });
    const wt = path.join(n.repo, '.claude', 'worktrees', 'agent-y');
    fs.mkdirSync(wt, { recursive: true });
    H.git(wt, ['init', '-q'], E.env);
    fs.writeFileSync(path.join(wt, 'k.txt'), 'k\n');
    await n.intacto('repo anidado en .claude/worktrees/ (no ignorado) cambia → INTACTO', () => fs.writeFileSync(path.join(wt, 'k.txt'), 'otro\n'));
  });

  test('D8 — normalización anti-fricción: en settings.local.json solo los permisos aprobados no anulan', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, '.claude/\n');
    m.escribir('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: [] }, env: { A: '1' } }));
    await m.intacto('permissions.allow agregado en .claude/settings.local.json → INTACTO', () => m.escribir('.claude/settings.local.json', JSON.stringify({ env: { A: '1' }, permissions: { deny: [], allow: ['Bash(ls:*)', 'Bash(rm:*)'] } })));
    await m.rota('hooks agregado en .claude/settings.local.json → ROTA', () => m.escribir('.claude/settings.local.json', JSON.stringify({ hooks: { Stop: [] }, env: { A: '1' }, permissions: { deny: [], allow: [] } })), 'settings.local.json');
    await m.rota('permissions.deny cambiado en .claude/settings.local.json → ROTA', () => m.escribir('.claude/settings.local.json', JSON.stringify({ env: { A: '1' }, permissions: { deny: ['x'], allow: [] } })), 'settings.local.json');
  });

  test('D9 — configuración de git: config.worktree, configuración global, core.excludesFile y core.hooksPath externo', async () => {
    await todos([
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        m.git(['config', 'extensions.worktreeConfig', 'true']);
        await m.rota('config.worktree cambiado → ROTA', () => m.git(['config', '--worktree', 'alias.zz', 'status']), 'config');
      },
      async () => {
        const m = new Mundo();
        const global = path.join(m.dir, 'gitconfig-global');
        fs.writeFileSync(global, '[user]\n\tname = t\n');
        m.nuevoRepo({ 'a.txt': 'a\n' });
        m.precarga = crearPrecarga({ gitGlobal: global });
        const r = await m.caso(() => fs.appendFileSync(global, '[alias]\n\tzz = status\n'));
        ok(r.code === 3 && /configuración efectiva de git/.test(r.out), 'config global (la que lee git como global) cambiada → ROTA', r.code + ' ' + r.out);
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        const exc = path.join(m.dir, 'ignora-global');
        fs.writeFileSync(exc, '*.log\n');
        m.git(['config', 'core.excludesFile', exc]);
        await m.rota('contenido de core.excludesFile cambiado → ROTA', () => fs.appendFileSync(exc, 'a.txt\n'), 'excludesFile');
        const hooks = path.join(m.dir, 'hooks-externos');
        fs.mkdirSync(hooks, { recursive: true });
        fs.writeFileSync(path.join(hooks, 'pre-commit'), 'exit 0\n');
        m.git(['config', 'core.hooksPath', hooks]);
        await m.rota('core.hooksPath externo con un hook cambiado → ROTA', () => fs.writeFileSync(path.join(hooks, 'pre-commit'), 'exit 1\n'), 'hooksPath/pre-commit');
      },
    ]);
  });

  test('D10 — submódulos y repos anidados (recursivos, hasta profundidad 3)', async () => {
    await todos([
      async () => {
        const m = new Mundo();
        const origen = path.join(m.dir, 'origen-sub');
        fs.mkdirSync(origen, { recursive: true });
        H.git(origen, ['init', '-q'], E.env);
        fs.writeFileSync(path.join(origen, 's.txt'), 's\n');
        H.git(origen, ['add', '-A'], E.env);
        H.git(origen, ['commit', '-q', '-m', 's'], E.env);
        m.nuevoRepo({ 'a.txt': 'a\n' });
        m.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origen, 'sub']);
        m.git(['commit', '-q', '-m', 'submódulo']);
        m.escribir('sub/s.txt', 'ya modificado\n'); // el submódulo ya aparece « M sub» al tomar la foto
        await m.rota('submódulo ya modificado y vuelto a modificar dentro → ROTA', () => m.escribir('sub/s.txt', 'otra vez\n'), 'sub/');
        await m.intacto('submódulo modificado y sin tocar → INTACTO', () => {});
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        const inner = path.join(m.repo, 'inner');
        fs.mkdirSync(inner, { recursive: true });
        H.git(inner, ['init', '-q'], E.env);
        fs.writeFileSync(path.join(inner, 'i.txt'), 'i\n');
        H.git(inner, ['add', '-A'], E.env);
        H.git(inner, ['commit', '-q', '-m', 'i'], E.env);
        await m.rota('repo anidado no rastreado, archivo modificado dentro → ROTA', () => fs.writeFileSync(path.join(inner, 'i.txt'), 'cambiado\n'), 'inner/');
        await m.rota('repo anidado no rastreado, archivo nuevo dentro → ROTA', () => fs.writeFileSync(path.join(inner, 'nuevo.txt'), 'x\n'), 'inner/');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        const sha = m.git(['rev-parse', 'HEAD']).trim();
        m.git(['update-index', '--add', '--cacheinfo', '160000,' + sha + ',vacio']);
        fs.mkdirSync(path.join(m.repo, 'vacio'), { recursive: true });
        await m.intacto('submódulo no inicializado (carpeta vacía) → INTACTO', () => {});
        fs.writeFileSync(path.join(m.repo, 'vacio', 'f.txt'), 'x\n');
        const rp = await m.run(['foto', m.repo]);
        ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'gitlink con contenido pero sin .git → DESCONOCIDO', rp.code + ' ' + rp.out);
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        let d = m.repo;
        for (let i = 1; i <= 4; i++) { d = path.join(d, 'n' + i); fs.mkdirSync(d, { recursive: true }); H.git(d, ['init', '-q'], E.env); }
        const rp = await m.run(['foto', m.repo]);
        ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'repos anidados más allá de la profundidad 3 → DESCONOCIDO', rp.code + ' ' + rp.out);
      },
    ]);
  });

  test('D13 — enlaces simbólicos: se mide el destino', async (t) => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const destino = path.join(m.dir, 'destino-externo.txt');
    fs.writeFileSync(destino, 'uno\n');
    try { fs.symlinkSync(destino, path.join(m.repo, 'enlace.txt'), 'file'); } catch {
      const motivo = 'el sistema no dejó crear el enlace simbólico (Windows sin privilegio)';
      if (ESTRICTO) throw new Error('prueba omitida en modo estricto: ' + motivo);
      t.skip(motivo);
      return;
    }
    await m.rota('enlace simbólico cuyo destino cambia de contenido → ROTA', () => fs.writeFileSync(destino, 'dos\n'), 'enlace.txt');
    fs.unlinkSync(path.join(m.repo, 'enlace.txt'));
    fs.symlinkSync(path.join(m.dir, 'no-existe.txt'), path.join(m.repo, 'roto.txt'), 'file');
    await m.intacto('enlace roto estable → INTACTO (valor enlace-roto)', () => {});
  });

  test('D14 / D15 — archivo llamado __proto__ y ids que intentan salir de la carpeta de fotos', async () => {
    // El literal {'__proto__': …} NO crea una propiedad propia; con la clave computada sí (ciclo 3, A6).
    const archivosProto = { ['__proto__']: 'p\n', 'a.txt': 'a\n' };
    ok(Object.keys(archivosProto).includes('__proto__'), 'A6: el fixture tiene de verdad la clave propia __proto__');
    const m = new Mundo();
    m.nuevoRepo(archivosProto);
    ok(fs.existsSync(path.join(m.repo, '__proto__')) && m.git(['ls-files']).includes('__proto__'), 'A6: el archivo __proto__ existe en disco y está rastreado ANTES de la foto');
    await m.rota('archivo __proto__ modificado → ROTA', () => m.escribir('__proto__', 'p2\n'), '__proto__');
    const r = await m.nodo(`let lanzo = false; try { require(${JSON.stringify(m.script)}).tomarFoto(${JSON.stringify(m.repo)}, '../escape'); } catch { lanzo = true; } process.stdout.write(String(lanzo));`);
    const escape = path.join(m.dir, 'escape.foto.json');
    ok(r.out === 'true' && !fs.existsSync(escape), "tomarFoto(repo, '../escape') lanza y no escribe fuera de la carpeta de fotos", 'lanzó=' + r.out + ' existe=' + fs.existsSync(escape) + ' ' + r.err);
  });

  // ================================================================================== Ciclo 3 — una regresión por punto A1-A11
  test('A1 — filtro TOML con estado (cadenas multilínea, corchetes entre comillas, segmento exacto)', async () => {
    const codex = "developer_instructions = '''\n[notice]\nREGLA\n'''\nmodel = 'x'\n";
    const ini = 'model = "a"\n';
    await tandaToml([
      ["A1: escenario de Codex — '''…[notice]…''' y se cambia el texto de la regla → ROTA", codex, codex.replace('REGLA', 'OTRA REGLA'), true],
      ['A1: escenario de Codex — se cambia model después de la cadena multilínea → ROTA', codex, codex.replace("'x'", "'y'"), true],
      ['A1: ídem con """ (cadena básica multilínea) y [tui] dentro → ROTA', 'a = """\n[tui]\nREGLA\n"""\nmodel = "x"\n', 'a = """\n[tui]\nREGLA\n"""\nmodel = "y"\n', true],
      ["A1: [projects.'C:\\work[1]'] con trust_level agregado → INTACTO", ini, ini + "\n[projects.'C:\\work[1]']\ntrust_level = \"trusted\"\n", false],
      ["A1: el real [projects.'C:\\Windows\\System32'] agregado → INTACTO", ini, ini + "\n[projects.'C:\\Windows\\System32']\ntrust_level = \"trusted\"\n", false],
      ['A1: [tuiextra] agregado (no es la tabla tui) → ROTA', ini, ini + '\n[tuiextra]\nx = 1\n', true],
      ['A1: [noticeboard] agregado (no es la tabla notice) → ROTA', ini, ini + '\n[noticeboard]\nx = 1\n', true],
      // El [[projects]] ya no se normaliza (toml-crudo, ciclo 6, A28). Sin [[…]] sigue INTACTO.
      ['A1/A28: [[projects]] / [tui] / [notice] agregados → ROTA (el [[…]] fuerza bytes completos)', ini, ini + '\n[tui]\nx = 1\n[notice]\ny = 2\n[[projects]]\nz = 3\n', true],
      ['A1: [tui] / [notice] / [projects.x] agregados (sin [[…]]) → INTACTO', ini, ini + '\n[tui]\nx = 1\n[notice]\ny = 2\n[projects.x]\nz = 3\n', false],
      ['A1: cadena multilínea SIN cerrar (no interpretable) → bytes completos: cualquier cambio → ROTA', "a = '''\n[projects.x]\nfin", "a = '''\n[projects.x]\nfin2", true],
      ['A1: [notice] dentro de un arreglo multilínea no es un encabezado → ROTA al cambiar lo de después', 'x = [\n  ["notice"]\n]\nmodel = "a"\n', 'x = [\n  ["notice"]\n]\nmodel = "b"\n', true],
    ]);
  });

  test('A2 — carpetas de ganchos recursivas (auxiliares en subcarpetas) y nunca terminales', async () => {
    await todos([
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        fs.mkdirSync(path.join(m.repo, '.git', 'hooks', 'helpers'), { recursive: true });
        fs.writeFileSync(path.join(m.repo, '.git', 'hooks', 'helpers', 'check.js'), 'uno\n');
        await m.rota('A2: auxiliar .git/hooks/helpers/check.js cambiado → ROTA', () => fs.writeFileSync(path.join(m.repo, '.git', 'hooks', 'helpers', 'check.js'), 'dos\n'), 'hooks/helpers/check.js');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        fs.mkdirSync(path.join(m.repo, '.git', 'info', 'deep'), { recursive: true });
        fs.writeFileSync(path.join(m.repo, '.git', 'info', 'deep', 'x'), 'uno\n');
        await m.rota('A2: archivo en .git/info/<subcarpeta> cambiado → ROTA', () => fs.writeFileSync(path.join(m.repo, '.git', 'info', 'deep', 'x'), 'dos\n'), 'info/deep/x');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        const ext = path.join(m.dir, 'hooks-externos-rec');
        fs.mkdirSync(path.join(ext, 'helpers'), { recursive: true });
        fs.writeFileSync(path.join(ext, 'pre-commit'), 'exit 0\n');
        fs.writeFileSync(path.join(ext, 'helpers', 'check.js'), 'uno\n');
        m.git(['config', 'core.hooksPath', ext]);
        await m.rota('A2: auxiliar en core.hooksPath externo cambiado → ROTA', () => fs.writeFileSync(path.join(ext, 'helpers', 'check.js'), 'dos\n'), 'hooksPath/helpers/check.js');
      },
      async () => {
        // Un directorio donde se esperaba un archivo es ERROR (antes era el valor «dir» y se daba por medido).
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' });
        fs.mkdirSync(path.join(m.repo, 'carpeta-donde-iba-archivo'), { recursive: true });
        m.git(['update-index', '--add', '--cacheinfo', '100644,' + m.git(['hash-object', 'a.txt']).trim() + ',carpeta-donde-iba-archivo']);
        const rp = await m.run(['foto', m.repo]);
        ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out) && /carpeta/.test(rp.out), 'A2: rastreado que en disco es una carpeta → DESCONOCIDO (no «dir»)', rp.code + ' ' + rp.out);
      },
    ]);
  });

  test('A3 — carpetas ignoradas con .git: se recorren salvo los repos ya medidos', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, 'libs/\ncfg/\ncfg2/\n');
    const lib = path.join(m.repo, 'libs', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    H.git(lib, ['init', '-q'], E.env);
    m.escribir('libs/lib/.env', 'A=1\n');
    m.escribir('libs/lib/.claude/settings.json', '{}');
    fs.mkdirSync(path.join(m.repo, 'cfg', '.git'), { recursive: true });
    m.escribir('cfg/.env.local', 'X=1\n');
    fs.mkdirSync(path.join(m.repo, 'cfg2'), { recursive: true });
    fs.writeFileSync(path.join(m.repo, 'cfg2', '.git'), 'gitdir: ../nada\n');
    m.escribir('cfg2/.npmrc', 'a=1\n');
    await m.tanda([
      R('A3: libs/ ignorado con libs/lib (git init): .env cambiado → ROTA', () => m.escribir('libs/lib/.env', 'A=2\n'), 'libs/lib/.env'),
      R('A3: libs/lib/.claude/settings.json cambiado → ROTA', () => m.escribir('libs/lib/.claude/settings.json', '{"x":1}'), 'libs/lib/.claude/settings.json'),
      R('A3: cfg/ ignorado con cfg/.git VACÍO: cfg/.env.local cambiado → ROTA', () => m.escribir('cfg/.env.local', 'X=2\n'), 'cfg/.env.local'),
      R('A3: carpeta ignorada con .git de ARCHIVO: .npmrc cambiado → ROTA', () => m.escribir('cfg2/.npmrc', 'a=2\n'), 'cfg2/.npmrc'),
    ]);
  });

  test('A4 — la primera aprobación de permisos no rompe el sello', async () => {
    const sl = '.claude/settings.local.json';
    const aprobado = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } });
    const repoA4 = (vacio) => {
      const m = new Mundo();
      m.nuevoRepo({ 'a.txt': 'a\n' }, '.claude/\n');
      if (vacio) m.escribir(sl, '{}');
      return m;
    };
    await todos([
      async () => { const m = repoA4(false); await m.intacto('A4: settings.local.json ausente → aparece con solo permissions.allow → INTACTO', () => m.escribir(sl, aprobado)); },
      async () => { const m = repoA4(true); await m.intacto('A4: {} → {"permissions":{"allow":[…]}} → INTACTO', () => m.escribir(sl, aprobado)); },
      async () => { const m = repoA4(true); await m.intacto('A4: {} → permissions.additionalDirectories (aprobar una carpeta) → INTACTO', () => m.escribir(sl, JSON.stringify({ permissions: { allow: [], additionalDirectories: ['C:\\x'] } }))); },
      async () => { const m = repoA4(true); await m.rota('A4: {} → permissions.deny agregado → ROTA', () => m.escribir(sl, JSON.stringify({ permissions: { allow: [], deny: ['x'] } })), 'settings.local.json'); },
      async () => { const m = repoA4(true); await m.rota('A4: {} → hooks agregado → ROTA', () => m.escribir(sl, JSON.stringify({ hooks: { Stop: [] }, permissions: { allow: ['x'] } })), 'settings.local.json'); },
    ]);
  });

  test('A5 — una sección no medida nunca es un mapa vacío', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, '.claude/\n');
    for (let i = 0; i < 5; i++) m.escribir('.claude/f' + i + '.txt', 'x\n');
    const id = await m.foto();
    let rp = await m.run(['comparar', id], { env: m.conEnv({ UAEH_TOPE_SENSIBLES: '2' }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'A5: tope bajo SOLO en el comparar → DESCONOCIDO (no cientos de «desapareció» ROTA)', rp.code + ' ' + rp.out);
    rp = await m.run(['comparar', id]);
    ok(rp.code === 0 && rp.out.startsWith('INTACTO'), 'A5: y con el tope normal sigue INTACTO', rp.code + ' ' + rp.out);
    // medir() y comparar() directos, en un proceso aparte con la misma casa falsa (la biblioteca cargada aquí leería la casa real).
    const S = JSON.stringify(m.script);
    const R0 = JSON.stringify(m.repo);
    const h = await m.nodo(`const m = require(${S}); const base = m.medir(${R0}); process.env.UAEH_TOPE_SENSIBLES = '2'; const marcada = m.medir(${R0}); delete process.env.UAEH_TOPE_SENSIBLES; process.stdout.write(JSON.stringify({ ig: marcada.ignorados, nm: marcada.noMedidas, base: typeof base.ignorados, dif: m.comparar(base, marcada).length }));`);
    const o = json(h.out);
    ok(o.ig === 'no-medida' && (o.nm || []).length > 0 && o.base === 'object',
      'A5: la sección ignorados queda marcada «no-medida» (no {}) cuando se excede el tope', h.out + ' ' + h.err);
    ok(o.dif === 0, 'A5: comparar() directo no produce «desapareció» con una sección no medida', h.out);
  });

  test('A8 — ignorados que son entradas (código, config, credenciales); salidas y otras extensiones no', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, 'scripts/smoke_*\napp/android/local.properties\napp/android/*.keystore\nbuild/\n*.log\nCLAUDE.md\nnotas/\n');
    m.escribir('scripts/smoke_x.py', 'print(1)\n');
    m.escribir('app/android/local.properties', 'sdk.dir=C:\\x\n');
    m.escribir('app/android/release.keystore', 'k1\n');
    m.escribir('build/x.js', 'a\n');
    m.escribir('app.log', 'l1\n');
    m.escribir('CLAUDE.md', 'reglas\n');
    m.escribir('notas/datos.csv', 'a,b\n');
    await m.tanda([
      R('A8: scripts/smoke_x.py ignorado y modificado → ROTA', () => m.escribir('scripts/smoke_x.py', 'print(2)\n'), 'scripts/smoke_x.py'),
      R('A8: local.properties ignorado y modificado → ROTA', () => m.escribir('app/android/local.properties', 'sdk.dir=C:\\y\n'), 'app/android/local.properties'),
      R('A8: *.keystore ignorado y modificado → ROTA', () => m.escribir('app/android/release.keystore', 'k2\n'), 'app/android/release.keystore'),
      R('A8: CLAUDE.md ignorado y modificado → ROTA', () => m.escribir('CLAUDE.md', 'otras reglas\n'), 'CLAUDE.md'),
      I('A8: build/x.js ignorado (carpeta de salida) → INTACTO', () => m.escribir('build/x.js', 'b\n'), 'build/x.js'),
      I('A8: app.log ignorado (otra extensión) → INTACTO', () => m.escribir('app.log', 'l2\n'), 'app.log'),
      I('A8: notas/datos.csv ignorado (otra extensión) → INTACTO', () => m.escribir('notas/datos.csv', 'c,d\n'), 'notas/datos.csv'),
      // build/ es una carpeta PODADA: un .env dentro es copia o dependencia y no se mide (ciclo 4, A14).
      I('A8/A14: .env dentro de build/ (carpeta podada, documentado) → INTACTO', () => m.escribir('build/.env', 'A=1\n'), 'build/.env'),
      R('A8: .env fuera de carpetas podadas sigue contando (sensible a cualquier profundidad) → ROTA', () => m.escribir('notas/.env', 'A=1\n'), 'notas/.env'),
    ]);
  });

  test('A9 — CLAUDE.md / AGENTS.md de las carpetas ancestro de la raíz del repo', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const padre = path.join(m.dir, 'CLAUDE.md');
    const agentes = path.join(m.dir, 'AGENTS.md');
    fs.writeFileSync(padre, 'reglas del padre\n');
    const clave = (p) => p.split(path.sep).join('/');
    await m.tanda([
      R('A9: CLAUDE.md en una carpeta padre del repo cambiado → ROTA', () => fs.writeFileSync(padre, 'reglas nuevas\n'), clave(padre)),
      R('A9: AGENTS.md que aparece en una carpeta padre → ROTA', () => fs.writeFileSync(agentes, 'x\n'), clave(agentes)),
    ]);
  });

  test('A10 — hooks más robustos (siguen siendo aviso): foto del agente sin cwd, excepciones internas, sin foto', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const b10 = { session_id: 's', cwd: m.repo, agent_id: 'a10fin', agent_type: 'uae-verifier' };
    await m.hook('hook-inicio', b10);
    m.escribir('a.txt', 'trampa\n');
    let r = await m.hook('hook-fin', { ...b10, cwd: path.join(m.dir, 'ya-no-existe'), stop_hook_active: false });
    let j = json(r.out);
    ok(j.decision === 'block' && /ANULADO/.test(j.reason) && /a\.txt/.test(j.reason), 'A10: hook-fin con foto del agente compara aunque el cwd ya no se resuelva → ROTA bloquea', r.code + ' ' + r.out);
    m.git(['checkout', '--', 'a.txt']);
    // Una precarga que hace fallar a todo Set.prototype.has: cualquier excepción interna debe acabar en «pide UNKNOWN», nunca en 4 ni en texto suelto.
    const boom = path.join(m.dir, 'precarga-boom.cjs');
    fs.writeFileSync(boom, "Set.prototype.has = function () { throw new Error('boom'); };\n");
    r = await m.hook('hook-fin', { ...b10, agent_id: 'a10boom' }, { precarga: [PRECARGA_BASE, boom] });
    j = json(r.out);
    ok(r.code === 0 && j.decision === 'block' && /UNKNOWN/.test(j.reason), 'A10: excepción en hook-fin → block pidiendo UNKNOWN y salida 0 (nunca 4 con texto suelto)', r.code + ' ' + r.out);
    r = await m.hook('hook-inicio', { ...b10, agent_id: 'a10boom2' }, { precarga: [PRECARGA_BASE, boom] });
    j = json(r.out);
    ok(r.code === 0 && j.hookSpecificOutput && /UNKNOWN/.test(j.hookSpecificOutput.additionalContext), 'A10: excepción en hook-inicio → aviso UNKNOWN y salida 0', r.code + ' ' + r.out);
    r = await m.hook('hook-fin', { ...b10, agent_id: 'a10sinfoto', cwd: m.sinGit });
    ok(r.code === 0 && r.out === '', 'A10: sin foto y cwd sin git sigue dejando pasar', r.out);
  });

  test('A11 — las perillas de prueba se dicen por stderr y un arnés vacío es un error', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    let rp = await m.run(['foto', m.repo]);
    ok(rp.code === 0 && /perillas de prueba activas/.test(rp.err) && /UAEH_ARNES/.test(rp.err) && /UAEH_INTEGRIDAD_DIR/.test(rp.err), 'A11: foto con perillas activas imprime «perillas de prueba activas: <nombres>»', rp.err);
    ok(!rp.out.includes('perillas') && /^\d{8}-\d{6}-/.test(rp.out), 'A11: y no ensucia el id de stdout', rp.out);
    rp = await m.run(['comparar', rp.out], { env: m.conEnv({ UAEH_PRESUPUESTO_MS: '600000' }) });
    ok(/UAEH_PRESUPUESTO_MS/.test(rp.err), 'A11: comparar también las imprime', rp.err);
    // Sin UAEH_INTEGRIDAD_DIR las fotos van a <UAEH_HOME>/integridad: las únicas perillas activas son UAEH_HOME y UAEH_ARNES.
    const limpio = m.conEnv({ UAEH_INTEGRIDAD_DIR: undefined, UAEH_AHORA: undefined, UAEH_TZ: undefined });
    rp = await m.run(['foto', m.repo], { env: limpio });
    ok(/UAEH_HOME/.test(rp.err) && /UAEH_ARNES/.test(rp.err) && !/UAEH_PRESUPUESTO_MS|UAEH_TOPE|UAEH_INTEGRIDAD_DIR/.test(rp.err), 'A11: solo se nombran las perillas realmente activas', rp.err);
    rp = await m.run(['foto', m.repo], { env: m.conEnv({ UAEH_ARNES: '[]' }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'A11: UAEH_ARNES=[] (arnés vacío) → DESCONOCIDO', rp.code + ' ' + rp.out);
    rp = await m.run(['foto', m.repo], { env: m.conEnv({ UAEH_ARNES: JSON.stringify([[path.join(m.dir, 'no-existe-arnes'), '.']]) }) });
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'A11: arnés que no mide ningún archivo → DESCONOCIDO', rp.code + ' ' + rp.out);
  });

  test('A12 — gramática conservadora en las tablas omitidas del TOML', async () => {
    const ini = 'model = "a"\n';
    // El config.toml de forma típica de Codex se normaliza (no cae a toml-crudo).
    const tipico = 'model = "gpt-6"\nsandbox_mode = "workspace-write"\n[mcp_servers.x]\nurl = "http://x"\n[projects.\'C:\\proyectos\\u\']\ntrust_level = "trusted"\n[tui]\ntheme = "dark"\n[notice]\nhide_full_access_warning = true\n[notice.model_migrations]\n"gpt-5" = "gpt-6"\n';
    ok(typeof MOD.textoTomlNormalizado === 'function' && MOD.textoTomlNormalizado(tipico) !== null, 'A12: un config.toml de forma típica de Codex se normaliza (no cae a toml-crudo)');
    await tandaToml([
      ['A12: hide = true → hide = tru en [notice] (valor inválido) → ROTA', ini + '[notice]\nhide = true\n', ini + '[notice]\nhide = tru\n', true],
      ["A12: trust_level \"trusted\" → \"untrusted\" en [projects.'x'] → INTACTO", ini + "[projects.'C:\\x']\ntrust_level = \"trusted\"\n", ini + "[projects.'C:\\x']\ntrust_level = \"untrusted\"\n", false],
      ['A12: arreglo multilínea en [tui] (no es literal de una línea) → bytes completos: cambio dentro → ROTA', ini + '[tui]\nx = [\n  1,\n  2\n]\n', ini + '[tui]\nx = [\n  1,\n  3\n]\n', true],
      ['A12: tabla en línea en [notice] (no reconocida) → bytes completos: cambio → ROTA', ini + '[notice]\nx = { a = 1 }\n', ini + '[notice]\nx = { a = 2 }\n', true],
      ['A12: cadena con escape inválido ("C:\\x") en [notice] → bytes completos: cambio → ROTA', ini + '[notice]\nx = "C:\\x"\n', ini + '[notice]\nx = "C:\\y"\n', true],
      ['A12: cadena multilínea en [projects.x] → bytes completos: cambio → ROTA', ini + "[projects.x]\nx = '''\nuno\n'''\n", ini + "[projects.x]\nx = '''\ndos\n'''\n", true],
      ['A12: línea sin "=" en [tui] → bytes completos: cambio → ROTA', ini + '[tui]\nbasura\n', ini + '[tui]\nbasura2\n', true],
      ['A12: valores reconocidos (número, decimal, cadenas, arreglo de una línea, comentarios) cambian en tabla omitida → INTACTO',
        ini + "[projects.x]\na = 1\nb = -2.5e3\nc = \"s\\n\\u00e9\"\nd = 'lit'\ne = [ 1, \"x\", 'y', true, ]  # nota\n\"k q\" = false\n# comentario\n",
        ini + "[projects.x]\na = 2\nb = 9\nc = \"t\"\nd = 'otro'\ne = []\n\"k q\" = true\n# otro comentario\n\n", false],
    ]);
  });

  test('A13 — arnés no recursivo: una carpeta donde se esperaba un archivo es error', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const carpetaX = path.join(m.dir, 'arnes-x');
    fs.mkdirSync(carpetaX, { recursive: true });
    const env = m.conEnv({ UAEH_ARNES: JSON.stringify([[m.arnes, '\\.(js|json)$'], [carpetaX, '^config\\.toml$']]) });
    await m.desconocido('A13: aparece una CARPETA config.toml donde se esperaba el archivo → DESCONOCIDO (antes: INTACTO)', () => fs.mkdirSync(path.join(carpetaX, 'config.toml'), { recursive: true }), env);
  });

  // ================================================================================== Ciclo 4 — una regresión por punto A12-A20
  if (process.platform === 'win32') {
    test('A14 — carpeta ilegible dentro de una carpeta podada (.venv/): no se entra, sin error (Windows, icacls)', async () => {
      const m = new Mundo();
      m.nuevoRepo({ 'a.txt': 'a\n' }, '.venv/\n');
      const priv = path.join(m.repo, '.venv', 'lib', 'priv');
      fs.mkdirSync(priv, { recursive: true });
      fs.writeFileSync(path.join(priv, 'a.py'), 'x\n');
      const usuario = os.userInfo().username;
      assert.equal(spawnSync('icacls', [priv, '/deny', usuario + ':(R)'], { encoding: 'utf8' }).status, 0, 'icacls /deny falló');
      let x;
      try { x = await m.run(['foto', m.repo]); } finally { spawnSync('icacls', [priv, '/remove:d', usuario], { encoding: 'utf8' }); }
      ok(x.code === 0, 'A14: carpeta ilegible dentro de .venv/ → sin error (no se entra)', x.code + ' ' + x.out);
    });
  } else if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    test('A14 — carpeta ilegible dentro de una carpeta podada (.venv/): no se entra, sin error (POSIX, sin ser root)', async () => {
      const m = new Mundo();
      m.nuevoRepo({ 'a.txt': 'a\n' }, '.venv/\n');
      const priv = path.join(m.repo, '.venv', 'lib', 'priv');
      fs.mkdirSync(priv, { recursive: true });
      fs.writeFileSync(path.join(priv, 'a.py'), 'x\n');
      fs.chmodSync(priv, 0o000);
      let x;
      try { x = await m.run(['foto', m.repo]); } finally { fs.chmodSync(priv, 0o755); }
      ok(x.code === 0, 'A14: carpeta ilegible dentro de .venv/ → sin error (no se entra)', x.code + ' ' + x.out);
    });
  }

  test('A14 — las carpetas de salida se podan de verdad (también para .env*/.npmrc); lo que cuelga de .claude/ no', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, 'build/\n.venv/\nvendor/\nout/\n.claude/\n');
    m.escribir('build/.env', 'A=1\n');
    m.escribir('vendor/pkg/.npmrc', 'a=1\n');
    await m.tanda([
      I('A14: .env en build/ cambiado → INTACTO (podado, documentado)', () => m.escribir('build/.env', 'A=2\n'), 'build/.env'),
      I('A14: .npmrc en vendor/ cambiado → INTACTO (podado)', () => m.escribir('vendor/pkg/.npmrc', 'a=2\n'), 'vendor/pkg/.npmrc'),
      R('A14: pero .claude/ fuera de las carpetas podadas se sigue midiendo → ROTA', () => m.escribir('.claude/x.txt', 'x\n'), '.claude/x.txt'),
    ]);
  });

  test('A16 — Playwright CLI: .playwright-cli es evidencia (si es nueva y no está rastreada); .playwright no es salida', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, '.playwright/\n.playwright-cli/ignorada/\n');
    // La guarda de git del usuario puede rechazar commitear evidencias: queda rastreado solo en el índice.
    m.escribir('.playwright-cli/page-t.yml', 'uno\n');
    m.git(['add', '-f', '.playwright-cli/page-t.yml']);
    await m.tanda([
      I('A16: .playwright-cli/page-x.yml NUEVO (no ignorado) → INTACTO (evidencia)', () => m.escribir('.playwright-cli/page-x.yml', '- a\n'), '.playwright-cli/page-x.yml'),
      // `.playwright` ya NO es salida (ciclo 5, A21): playwright-cli carga .playwright/cli.config.json.
      R('A16/A21: .playwright/page-y.yml NUEVO e IGNORADO → ROTA (ya no se poda)', () => m.escribir('.playwright/page-y.yml', '- a\n'), '.playwright/page-y.yml'),
      I('A16: .playwright-cli/ignorada/page-z.yml NUEVO e IGNORADO → INTACTO (podado)', () => m.escribir('.playwright-cli/ignorada/page-z.yml', '- a\n'), '.playwright-cli/ignorada/page-z.yml'),
      R('A16: pero un archivo RASTREADO en .playwright-cli/ modificado → ROTA', () => m.escribir('.playwright-cli/page-t.yml', 'dos\n'), '.playwright-cli/page-t.yml'),
    ]);
  });

  test('A17 — más salidas, venvs con cualquier nombre y salidas de sesión por nombre', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, '.env/\n.tox/\n.idea/\njunit*.xml\ncoverage*.xml\ntest-report*.xml\n*storage-state*.json\nauth-state*.json\n');
    m.escribir('.env/pyvenv.cfg', 'home = x\n');
    for (let i = 0; i < 30; i++) m.escribir('.env/lib/m' + i + '.py', 'x\n');
    m.escribir('.tox/py/x.py', 'x\n');
    m.escribir('.idea/workspace.xml', '<a/>');
    const x = await m.caso(() => m.escribir('.env/lib/m0.py', 'cambio\n'), m.conEnv({ UAEH_TOPE_SENSIBLES: '20' }));
    ok(x.code === 0 && x.out.startsWith('INTACTO'), 'A17: venv llamado .env/ (con pyvenv.cfg y 30 .py) → INTACTO sin agotar el tope', x.code + ' ' + x.out);
    m.escribir('junit.xml', '<a/>');
    m.escribir('storage-state.json', '{}');
    await m.tanda([
      I('A17: .tox/ podado → INTACTO', () => m.escribir('.tox/py/x.py', 'y\n'), '.tox/py/x.py'),
      I('A17: .idea/ podado → INTACTO', () => m.escribir('.idea/workspace.xml', '<b/>'), '.idea/workspace.xml'),
      I('A17: junit.xml ignorado reescrito → INTACTO', () => m.escribir('junit.xml', '<b/>'), 'junit.xml'),
      I('A17: storage-state.json ignorado → INTACTO', () => m.escribir('storage-state.json', '{"x":1}'), 'storage-state.json'),
      I('A17: mi-storage-state-2.json → INTACTO', () => m.escribir('mi-storage-state-2.json', '{}'), 'mi-storage-state-2.json'),
      I('A17: auth-state.json → INTACTO', () => m.escribir('auth-state.json', '{}'), 'auth-state.json'),
      I('A17: coverage.xml → INTACTO', () => m.escribir('coverage.xml', '<a/>'), 'coverage.xml'),
      I('A17: test-report-1.xml → INTACTO', () => m.escribir('test-report-1.xml', '<a/>'), 'test-report-1.xml'),
      R('A17: pero otro .json (config.json) sí cuenta → ROTA', () => m.escribir('config.json', '{}'), 'config.json'),
    ]);
  });

  test('A15 — un error al resolver la raíz (git no ejecutable) no es «no existe»', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const sinGitPath = path.join(m.dir, 'path-sin-git');
    fs.mkdirSync(sinGitPath, { recursive: true });
    const envSG = m.conEnv({});
    for (const k of Object.keys(envSG)) if (/^path$/i.test(k)) delete envSG[k];
    envSG[process.platform === 'win32' ? 'Path' : 'PATH'] = sinGitPath;
    const id = await m.foto();
    let x = await m.run(['comparar', id], { env: envSG });
    ok(x.code === 4 && /^DESCONOCIDO/.test(x.out) && !/^ROTA/.test(x.out) && /no se pudo resolver/.test(x.out), 'A15: git no ejecutable al comparar → DESCONOCIDO con causa (no ROTA «ya no existe»)', x.code + ' ' + x.out);
    x = await m.run(['comparar', id, m.repo], { env: envSG });
    ok(x.code === 4 && !/otro repo/.test(x.out) && /no se pudo resolver/.test(x.out), 'A15: con repo esperado, un error de git NO es «la foto es de otro repo»', x.code + ' ' + x.out);
    x = await m.run(['foto', m.repo], { env: envSG });
    ok(x.code === 4 && /no se pudo resolver/.test(x.out), 'A15: git no ejecutable al tomar la foto → DESCONOCIDO con causa (no «no es un repo git»)', x.code + ' ' + x.out);
    // Lo que SÍ es «no existe / no es repo» sigue siendo ROTA / DESCONOCIDO como antes.
    const quitado = m.nuevoRepo({ 'a.txt': 'a\n' });
    const id2 = await m.foto();
    fs.rmSync(path.join(quitado, '.git'), { recursive: true, force: true });
    x = await m.run(['comparar', id2]);
    ok(x.code === 3 && /ya no existe o dejó de ser repo git/.test(x.out), 'A15: la carpeta ya no es repo (sin .git) → ROTA como antes', x.code + ' ' + x.out);
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const id3 = await m.foto();
    fs.rmSync(m.repo, { recursive: true, force: true });
    x = await m.run(['comparar', id3]);
    ok(x.code === 3 && /ya no existe o dejó de ser repo git/.test(x.out), 'A15: el repo desapareció → ROTA como antes', x.code + ' ' + x.out);
  });

  test('A18 — los hooks dicen QUÉ repo midieron', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const b18 = { session_id: 's', cwd: m.repo, agent_id: 'a18', agent_type: 'uae-verifier' };
    const nombreRepo = path.basename(m.repo).toLowerCase();
    let r = await m.hook('hook-inicio', b18);
    const ctxIni = (json(r.out).hookSpecificOutput || {}).additionalContext || '';
    ok(/repo medido: /.test(ctxIni) && ctxIni.toLowerCase().includes(nombreRepo), 'A18: el aviso de hook-inicio dice «repo medido: <raíz>»', r.out);
    m.escribir('a.txt', 'trampa\n');
    r = await m.hook('hook-fin', { ...b18, stop_hook_active: false });
    const j = json(r.out);
    ok(j.decision === 'block' && /repo medido: /.test(j.reason || '') && (j.reason || '').toLowerCase().includes(nombreRepo), 'A18: el block de hook-fin dice «repo medido: <raíz>»', r.out);
  });

  // ================================================================================== Ciclo 5 — una regresión por punto A21-A27
  test('A21 / A22 / A23 — .playwright no es salida; env/ ya no es carpeta podada (un venv se poda por pyvenv.cfg); de .yarn solo cache y unplugged', async () => {
    await todos([
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' }, '');
        await m.rota('A21: .playwright/cli.config.json NUEVO sin ignorar → ROTA', () => m.escribir('.playwright/cli.config.json', '{"a":1}\n'), '.playwright/cli.config.json');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' }, '.playwright/\n');
        m.escribir('.playwright/cli.config.json', '{"a":1}\n');
        await m.rota('A21: .playwright/cli.config.json IGNORADO y modificado → ROTA', () => m.escribir('.playwright/cli.config.json', '{"a":2}\n'), '.playwright/cli.config.json');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' }, '');
        await m.intacto('A21: .playwright-cli/page-x.yml NUEVO → INTACTO (evidencia)', () => m.escribir('.playwright-cli/page-x.yml', '- a\n'));
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' }, 'env/\n');
        m.escribir('env/.env.local', 'A=1\n');
        await m.rota('A22: env/.env.local IGNORADO y modificado → ROTA', () => m.escribir('env/.env.local', 'A=2\n'), 'env/.env.local');
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' }, 'env/\n');
        m.escribir('env/pyvenv.cfg', 'home = x\n');
        m.escribir('env/lib/m.py', 'x\n');
        await m.intacto('A22: env/ con pyvenv.cfg y .py (un venv) → INTACTO', () => m.escribir('env/lib/m.py', 'y\n'));
      },
      async () => {
        const m = new Mundo();
        m.nuevoRepo({ 'a.txt': 'a\n' }, '.yarn/\n');
        m.escribir('.yarn/plugins/x.cjs', 'uno\n');
        m.escribir('.yarn/unplugged/p/index.js', 'uno\n');
        m.escribir('.yarn/cache/p.js', 'uno\n');
        await m.tanda([
          R('A23: .yarn/plugins/x.cjs IGNORADO y modificado → ROTA', () => m.escribir('.yarn/plugins/x.cjs', 'dos\n'), '.yarn/plugins/x.cjs'),
          I('A23: .yarn/unplugged/p/index.js IGNORADO y modificado → INTACTO (podado)', () => m.escribir('.yarn/unplugged/p/index.js', 'dos\n'), '.yarn/unplugged/p/index.js'),
          I('A23: .yarn/cache/p.js IGNORADO y modificado → INTACTO (podado)', () => m.escribir('.yarn/cache/p.js', 'dos\n'), '.yarn/cache/p.js'),
        ]);
      },
    ]);
  });

  test('A24 / A28 — TOML: tabla repetida, clave repetida, escapes Unicode inválidos, [[…]] y choques clave/tabla en tablas omitidas → bytes completos', async () => {
    const ini = 'model = "a"\n';
    await tandaToml([
      ['A24: hide = false duplicado en [notice] (cambia el segundo) → ROTA', ini + '[notice]\nhide = false\nhide = false\n', ini + '[notice]\nhide = false\nhide = true\n', true],
      ['A24: clave duplicada con distinta forma (a y "a") → ROTA', ini + '[notice]\na = 1\n"a" = 1\n', ini + '[notice]\na = 1\n"a" = 2\n', true],
      ['A24: [notice] repetida → ROTA', ini + '[notice]\na = 1\n[otra]\nk = 1\n[notice]\nb = 2\n', ini + '[notice]\na = 1\n[otra]\nk = 1\n[notice]\nb = 3\n', true],
      ['A24: [notice] y [ notice ] (mismo encabezado con espacios) → ROTA', ini + '[notice]\na = 1\n[ notice ]\nb = 2\n', ini + '[notice]\na = 1\n[ notice ]\nb = 3\n', true],
      ['A24: "\\U00110000" (fuera de Unicode) → ROTA', ini + '[notice]\nx = "\\U00110000"\n', ini + '[notice]\nx = "\\U00110001"\n', true],
      ['A24: "\\uD800" (sustituto) → ROTA', ini + '[notice]\nx = "\\uD800"\n', ini + '[notice]\nx = "\\uD801"\n', true],
      ['A24 (control): escapes válidos (\\U0001F600, \\u00e9), claves distintas y tablas distintas → INTACTO',
        ini + '[notice]\nx = "\\U0001F600"\ny = "\\u00e9"\n[notice.m]\nx = 1\n[projects.a]\nx = 1\n[projects.b]\nx = 1\n',
        ini + '[notice]\nx = "\\U0001F601"\ny = "\\u00ea"\n[notice.m]\nx = 2\n[projects.a]\nx = 2\n[projects.b]\nx = 2\n', false],
      // Un [[…]] en una tabla omitida no se normaliza (ciclo 6, A28).
      ['A24/A28: [[notice.lista]] repetida (arreglo de tablas) → ROTA (toml-crudo)', ini + '[[notice.lista]]\nx = 1\n[[notice.lista]]\nx = 2\n', ini + '[[notice.lista]]\nx = 3\n[[notice.lista]]\nx = 4\n', true],
      ['A28: [[notice]] tras [notice] → ROTA', ini + '[notice]\nhide = true\n[[notice]]\nx = 1\n', ini + '[notice]\nhide = true\n[[notice]]\nx = 2\n', true],
      ['A28: [[tui.lista]] sola → ROTA', ini + '[[tui.lista]]\nx = 1\n', ini + '[[tui.lista]]\nx = 2\n', true],
      ['A28: [notice.hide] cuando [notice] define hide → ROTA', ini + '[notice]\nhide = true\n[notice.hide]\nx = 1\n', ini + '[notice]\nhide = true\n[notice.hide]\nx = 2\n', true],
      ['A28: [notice.hide] primero y luego [notice] con hide → ROTA', ini + '[notice.hide]\nx = 1\n[notice]\nhide = true\n', ini + '[notice.hide]\nx = 2\n[notice]\nhide = true\n', true],
      ['A28: encabezado [notice."\\ud800"] (sustituto) → ROTA', ini + '[notice."\\ud800"]\nx = 1\n', ini + '[notice."\\ud800"]\nx = 2\n', true],
      ['A28 (control; pasa también contra el respaldo anterior, no discrimina): encabezado [projects."\\U00110000"] → ROTA', ini + '[projects."\\U00110000"]\nx = 1\n', ini + '[projects."\\U00110000"]\nx = 2\n', true],
      ['A28 (control; pasa también contra el respaldo anterior, no discrimina): encabezado [x."\\ud800"] FUERA de tablas omitidas → ROTA', ini + '[x."\\ud800"]\nx = 1\n', ini + '[x."\\ud800"]\nx = 2\n', true],
      ['A28 (control): encabezado con escapes válidos [notice."\\u00e9\\U0001F600"] → INTACTO', ini + '[notice."\\u00e9\\U0001F600"]\nx = 1\n', ini + '[notice."\\u00e9\\U0001F600"]\nx = 2\n', false],
      ['A28 (control): forma real de Codex (projects.\'ruta\', tui, nux, model_migrations) → INTACTO',
        ini + "[projects.'C:\\proyectos\\x']\ntrust_level = \"trusted\"\n[tui]\nx = 1\n[tui.model_availability_nux]\n\"gpt-6\" = 2\n[notice]\nhide = true\n[notice.model_migrations]\n\"a\" = \"b\"\n",
        ini + "[projects.'C:\\proyectos\\x']\ntrust_level = \"untrusted\"\n[tui]\nx = 5\n[tui.model_availability_nux]\n\"gpt-6\" = 9\n[notice]\nhide = false\n[notice.model_migrations]\n\"a\" = \"c\"\n", false],
    ]);
  });

  test('C6 (ciclo 7) — TOML: tabla omitida definida en línea o con clave con puntos, en cualquier nivel → bytes completos', async () => {
    const ini = 'model = "a"\n';
    // Cada caso cambia un valor DENTRO de una tabla omitida: si el archivo no se interpreta (toml-crudo), eso es ROTA.
    const tuiX = (v) => '[tui]\nx = ' + v + '\n';
    const formasC6 = [
      ['notice en línea en la raíz', 'notice = { hide = false }\n' + tuiX(1), 'notice = { hide = false }\n' + tuiX(2)],
      ['notice en línea sin espacios', 'notice={hide=false}\n' + tuiX(1), 'notice={hide=false}\n' + tuiX(2)],
      ['notice con puntos en la raíz', 'notice.hide = false\n' + tuiX(1), 'notice.hide = false\n' + tuiX(2)],
      ['projects en línea en la raíz', 'projects = { a = 1 }\n' + tuiX(1), 'projects = { a = 1 }\n' + tuiX(2)],
      ['tui con puntos en la raíz', 'tui.x = 1\n[notice]\nhide = true\n', 'tui.x = 1\n[notice]\nhide = false\n'],
      ['clave "notice" entre comillas en línea', '"notice" = { hide = false }\n' + tuiX(1), '"notice" = { hide = false }\n' + tuiX(2)],
      ["clave 'tui' literal con puntos", "'tui'.x = 1\n[notice]\nhide = true\n", "'tui'.x = 1\n[notice]\nhide = false\n"],
      ['notice con puntos DENTRO de otra tabla (después de [tui])', tuiX(1) + '[a]\nnotice.hide = false\n', tuiX(2) + '[a]\nnotice.hide = false\n'],
      ['notice en línea dentro de otra tabla (antes de [tui])', '[a]\nnotice = { hide = false }\n' + tuiX(1), '[a]\nnotice = { hide = false }\n' + tuiX(2)],
      ['tabla omitida anidada en una tabla en línea', 'a = { tui = { x = 1 } }\n[notice]\nhide = true\n', 'a = { tui = { x = 1 } }\n[notice]\nhide = false\n'],
      ['projects con puntos a tres niveles de profundidad', '[a.b.c]\nprojects.x.trust_level = "t"\n' + tuiX(1), '[a.b.c]\nprojects.x.trust_level = "t"\n' + tuiX(2)],
      ['tabla omitida tras otras claves en una tabla en línea', 'a = { b = 1, notice.hide = false }\n' + tuiX(1), 'a = { b = 1, notice.hide = false }\n' + tuiX(2)],
      ['notice con puntos intermedio (a.notice.x)', 'a.notice.x = 1\n' + tuiX(1), 'a.notice.x = 1\n' + tuiX(2)],
    ];
    // Controles: NO deben caer a toml-crudo (se siguen normalizando → cambio en tabla omitida = INTACTO).
    const controlesC6 = [
      ['texto con «notice = 1» dentro de una cadena', 'command = "notice = 1, tui.x = 2"\n'],
      ['clave de nombre parecido (noticeboard, tuiextra)', 'noticeboard = 1\ntuiextra = { a = 1 }\n'],
      ['valores «tui» y «notice» como elementos de arreglo', 'x = ["tui", "notice", "projects"]\n'],
      ['env en línea con valor «tui» (no es clave)', '[mcp_servers.x]\nenv = { A = "tui", B = "notice" }\n'],
    ];
    await tandaToml([
      ...formasC6.map(([nombre, antes, despues]) => ['C6: ' + nombre + ' → ROTA (toml-crudo)', ini + antes, ini + despues, true]),
      // Transición del hallazgo SEC-002: válido → inválido con un [notice] agregado, sin falso INTACTO.
      ['C6/SEC-002: notice = { hide = false } + [tui], luego se agrega [notice] → ROTA',
        'model = "x"\nnotice = { hide = false }\n[tui]\ntheme = "dark"\n', 'model = "x"\nnotice = { hide = false }\n[tui]\ntheme = "dark"\n[notice]\nhide = true\n', true],
      ['C6/SEC-002: notice.hide = false + [tui], luego se agrega [notice] → ROTA',
        'model = "x"\nnotice.hide = false\n[tui]\ntheme = "dark"\n', 'model = "x"\nnotice.hide = false\n[tui]\ntheme = "dark"\n[notice]\nhide = true\n', true],
      ['C6/SEC-002: orden inverso ([notice] y luego [a] notice.hide) → ROTA',
        'model = "x"\n[notice]\nhide = false\n[a]\nnotice.hide = false\n', 'model = "x"\n[notice]\nhide = true\n[a]\nnotice.hide = false\n', true],
      ...controlesC6.map(([nombre, base]) => ['C6 (control): ' + nombre + ' → INTACTO (sigue normalizándose)', ini + base + tuiX(1), ini + base + tuiX(2), false]),
      // D8 (ciclo 2): las tablas que Codex reescribe no anulan; cualquier otra cosa sí.
      ["D8: config.toml de Codex: tabla [projects.'x'] agregada → INTACTO", 'model = "a"\n\n[otra]\nk = 1\n', 'model = "a"\n\n[otra]\nk = 1\n' + "\n[projects.'C:\\x']\ntrust_level = \"trusted\"\n", false],
      ['D8: config.toml: tablas [tui*] y [notice*] agregadas → INTACTO', 'model = "a"\n\n[otra]\nk = 1\n', 'model = "a"\n\n[otra]\nk = 1\n' + '\n[tui.notificaciones]\nx = 1\n\n[notice]\ny = 2\n', false],
      ['D8: config.toml: otra clave (model) cambiada → ROTA', 'model = "a"\n\n[otra]\nk = 1\n', 'model = "b"\n\n[otra]\nk = 1\n', true],
      ['D8: config.toml: tabla [mcp_servers.x] agregada → ROTA', 'model = "a"\n\n[otra]\nk = 1\n', 'model = "a"\n\n[otra]\nk = 1\n' + '\n[mcp_servers.x]\nurl = "http://x"\n', true],
    ]);
  });

  test('A25 — EXT_EVIDENCIA suma trace, network, ndjson y pdf (solo dentro de carpetas de evidencia)', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' }, '');
    await m.tanda([
      ...['x.trace', 'x.network', 'x.ndjson', 'x.pdf', 'x.zip'].map((n) => I('A25: .playwright-cli/' + n + ' NUEVO → INTACTO', () => m.escribir('.playwright-cli/' + n, 'datos\n'), '.playwright-cli/' + n)),
      R('A25: pero un .trace FUERA de carpetas de evidencia sigue contando → ROTA', () => m.escribir('src/x.trace', 'datos\n'), 'src/x.trace'),
    ]);
  });

  // ======================================================================= El arnés por defecto (CLAUDE_CONFIG_DIR, CODEX_HOME…)
  // Sin UAEH_ARNES, la lista sale de claudeHome()/codexHome() y suma la raíz de ESTE plugin (aquí, una copia privada del
  // script con su lib/) y el espejo <uaehHome>/estable. Estas pruebas sustituyen a la «casa falsa» del origen (que
  // reemplazaba os.homedir()) y a las de las skills de seguridad fijas, que ahora viven en vendor/ del propio plugin.
  test('Arnés por defecto: un cambio en <claudeHome>/hooks, settings.json, <codexHome>/AGENTS.md o en el espejo da ROTA', async () => {
    const m = new Mundo().porDefecto();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    m.escribirEn(m.claude, 'hooks/x.js', 'uno\n');
    m.escribirEn(m.claude, 'settings.json', '{}');
    m.escribirEn(m.codex, 'AGENTS.md', 'agentes\n');
    await m.intacto('sin cambios → INTACTO con la lista por defecto', () => {});
    await m.rota('hooks/x.js de CLAUDE_CONFIG_DIR cambiado → ROTA', () => m.escribirEn(m.claude, 'hooks/x.js', 'dos\n'), 'hooks/x.js');
    await m.rota('settings.json de CLAUDE_CONFIG_DIR cambiado → ROTA', () => m.escribirEn(m.claude, 'settings.json', '{"a":1}'), 'settings.json');
    await m.rota('AGENTS.md de CODEX_HOME cambiado → ROTA', () => m.escribirEn(m.codex, 'AGENTS.md', 'otros\n'), 'AGENTS.md');
    await m.rota('ESPEJO: <uaehHome>/estable/cualquier.cjs nuevo → ROTA', () => m.escribirEn(path.join(m.uaeh, 'estable'), 'cualquier.cjs', 'x\n'), 'estable/cualquier.cjs');
  });

  test('Arnés por defecto: qué se mide y qué no (claudeHome, codexHome, raíz del plugin, espejo; ni OTROS plugins ni <uaehHome> suelto)', async () => {
    const m = new Mundo().porDefecto();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const estable = path.join(m.uaeh, 'estable');
    const w = (base, rel, txt) => m.escribirEn(base, rel, txt);
    const clave = (base, rel) => path.join(base, rel).split(path.sep).join('/');
    const R2 = (nombre, base, rel, txt) => R(nombre, () => w(base, rel, txt || 'cambiado\n'), clave(base, rel));
    const I2 = (nombre, base, rel, txt) => I(nombre, () => w(base, rel, txt || 'cambiado\n'), clave(base, rel));
    // Lo que existe al tomar la foto.
    for (const [base, rel] of [
      [m.claude, 'settings.json'], [m.claude, 'CLAUDE.md'], [m.claude, 'hooks/uno.js'], [m.claude, 'hooks/sub/aux.js'],
      [m.claude, 'hooks/node_modules/pkg/i.js'], [m.claude, 'agents/uae-verifier.md'], [m.claude, 'scripts/uaeh-algo.cjs'], [m.claude, 'scripts/otro.cjs'],
      [m.claude, 'git-hooks/pre-commit'], [m.claude, 'skills/uae-x/SKILL.md'], [m.claude, 'skills/uae-x/referencias/r.md'], [m.claude, 'skills/otra/SKILL.md'],
      [m.claude, 'plugins/otro/x.js'], [m.claude, 'projects/p/t.jsonl'],
      [m.codex, 'astra.config.toml'], [m.codex, 'AGENTS.md'], [m.codex, 'agents/uae_verifier.toml'],
      [estable, 'cualquier.cjs'], [estable, 'wsl/scripts/escaner.sh'], [m.uaeh, 'integridad/x.foto.json'], [m.uaeh, 'otros/hallazgos.md'], [m.uaeh, 'registro.jsonl'],
      [m.plugin, 'vendor/cyber-neo/scripts/scan.py'], [m.plugin, 'vendor/cyber-neo/__pycache__/x.pyc'], [m.plugin, 'vendor/security-audit/SKILL.md'],
      [m.plugin, 'skills/uae-security/referencias/checklist-prelanzamiento.md'], [m.plugin, 'scripts/__pycache__/y.pyc'],
    ]) w(base, rel, 'original\n');
    w(m.codex, 'config.toml', 'model = "a"\n');
    await m.tanda([
      R2('<claudeHome>/settings.json', m.claude, 'settings.json'),
      R2('<claudeHome>/CLAUDE.md', m.claude, 'CLAUDE.md'),
      R2('<claudeHome>/hooks/uno.js (por CLAUDE_CONFIG_DIR, no por ~/.claude)', m.claude, 'hooks/uno.js'),
      R2('A2: hooks del arnés — auxiliar existente en subcarpeta modificado', m.claude, 'hooks/sub/aux.js'),
      R2('A2: hooks del arnés — subcarpeta nueva con un .js', m.claude, 'hooks/nueva/x.js'),
      I2('A2: hooks del arnés — node_modules no se mide', m.claude, 'hooks/node_modules/pkg/i.js'),
      R2('<claudeHome>/agents/uae-verifier.md', m.claude, 'agents/uae-verifier.md'),
      R2('<claudeHome>/scripts/uaeh-algo.cjs', m.claude, 'scripts/uaeh-algo.cjs'),
      I2('<claudeHome>/scripts/otro.cjs (no empieza por uaeh-) no se mide', m.claude, 'scripts/otro.cjs'),
      R2('A27: <claudeHome>/git-hooks/pre-commit', m.claude, 'git-hooks/pre-commit'),
      R2('A27: archivo nuevo en una subcarpeta de git-hooks', m.claude, 'git-hooks/sub/otro.sh'),
      R2('D16: recurso nuevo en una skill uae-* (recursivo)', m.claude, 'skills/uae-x/referencias/nuevo.md'),
      R2('D16: recurso existente de una skill uae-* modificado', m.claude, 'skills/uae-x/referencias/r.md'),
      I2('D16: skill que NO es uae-* → no se mide', m.claude, 'skills/otra/SKILL.md'),
      I2('<claudeHome>/plugins/** de OTROS plugins no se mide', m.claude, 'plugins/otro/x.js'),
      I2('<claudeHome>/projects/** (transcripciones) no se mide', m.claude, 'projects/p/t.jsonl'),
      R2('D16: <codexHome>/config.toml (por CODEX_HOME)', m.codex, 'config.toml', 'model = "b"\n'),
      R2('D16: <codexHome>/astra.config.toml', m.codex, 'astra.config.toml'),
      R2('D16: <codexHome>/AGENTS.md', m.codex, 'AGENTS.md'),
      R2('<codexHome>/agents/uae_verifier.toml', m.codex, 'agents/uae_verifier.toml'),
      R2('ESPEJO: <uaehHome>/estable/cualquier.cjs', estable, 'cualquier.cjs'),
      R2('ESPEJO: archivo nuevo en una subcarpeta de estable/', estable, 'nueva/sub.sh'),
      R2('A19: ESPEJO — estable/wsl/scripts/escaner.sh (recursivo)', estable, 'wsl/scripts/escaner.sh'),
      I2('A19: <uaehHome>/integridad/ (fotos y registro) NO se mide', m.uaeh, 'integridad/x.foto.json'),
      I2('A19: otras carpetas de <uaehHome> fuera de estable/ NO se miden', m.uaeh, 'otros/hallazgos.md'),
      I2('<uaehHome>/registro.jsonl NO se mide', m.uaeh, 'registro.jsonl'),
      R2('PLUGIN: vendor/cyber-neo/scripts/scan.py (A9: las skills de seguridad viven en vendor/ del plugin)', m.plugin, 'vendor/cyber-neo/scripts/scan.py'),
      I2('PLUGIN: vendor/cyber-neo/__pycache__ no se mide', m.plugin, 'vendor/cyber-neo/__pycache__/x.pyc'),
      R2('PLUGIN: vendor/security-audit/SKILL.md', m.plugin, 'vendor/security-audit/SKILL.md'),
      R2('PLUGIN: skills/uae-security/referencias/checklist-prelanzamiento.md', m.plugin, 'skills/uae-security/referencias/checklist-prelanzamiento.md'),
      I2('PLUGIN: scripts/__pycache__ no se mide', m.plugin, 'scripts/__pycache__/y.pyc'),
      R2('PLUGIN: archivo nuevo en hooks/ del plugin', m.plugin, 'hooks/h.js'),
      R('PLUGIN: la propia biblioteca lib/comun.cjs (se le añade un comentario)', () => fs.appendFileSync(path.join(m.plugin, 'scripts', 'lib', 'comun.cjs'), '\n// cambio\n'), clave(m.plugin, 'scripts/lib/comun.cjs')),
    ]);
  });

  test('Arnés por defecto: sin CLAUDE_CONFIG_DIR, CODEX_HOME ni UAEH_HOME cuelga de ~/.claude y ~/.codex de la casa (HOME)', async () => {
    const m = new Mundo().porDefecto();
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'UAEH_HOME']) delete m.env[k];
    const claude = path.join(E.home, '.claude');
    const codex = path.join(E.home, '.codex');
    const clave = (...partes) => path.join(...partes).split(path.sep).join('/');
    m.nuevoRepo({ 'a.txt': 'a\n' });
    m.escribirEn(claude, 'hooks/x.js', 'uno\n');
    m.escribirEn(codex, 'AGENTS.md', 'agentes\n');
    m.escribirEn(path.join(claude, 'uaeh', 'estable'), 'cualquier.cjs', 'espejo\n');
    await m.tanda([
      R('~/.claude/hooks/x.js de la casa', () => m.escribirEn(claude, 'hooks/x.js', 'dos\n'), clave(claude, 'hooks/x.js')),
      R('~/.codex/AGENTS.md de la casa', () => m.escribirEn(codex, 'AGENTS.md', 'otros\n'), clave(codex, 'AGENTS.md')),
      R('~/.claude/uaeh/estable/cualquier.cjs (UAEH_HOME por defecto)', () => m.escribirEn(path.join(claude, 'uaeh', 'estable'), 'cualquier.cjs', 'otro\n'), clave(claude, 'uaeh/estable/cualquier.cjs')),
    ]);
  });

  test('Arnés por defecto: settings.local.json de <claudeHome> normaliza los permisos aprobados y los hooks anulan', async () => {
    const m = new Mundo().porDefecto();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    m.escribirEn(m.claude, 'settings.json', '{}');
    m.escribirEn(m.claude, 'settings.local.json', JSON.stringify({ permissions: { allow: [] } }));
    await m.intacto('permissions.allow en <claudeHome>/settings.local.json → INTACTO', () => m.escribirEn(m.claude, 'settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(x)'] } })));
    await m.rota('hooks en <claudeHome>/settings.local.json → ROTA', () => m.escribirEn(m.claude, 'settings.local.json', JSON.stringify({ hooks: {} })), 'settings.local.json');
  });

  test('A27 — el arnés mide <claudeHome>/git-hooks/** y el VALOR del core.hooksPath global (no el ~/.gitconfig completo)', async () => {
    const m = new Mundo().porDefecto();
    const gcfg = path.join(m.dir, 'gitconfig27');
    m.precarga = crearPrecarga({ gitGlobal: gcfg });
    m.escribirEn(m.claude, 'settings.json', '{}');
    m.escribirEn(m.claude, 'git-hooks/pre-commit', '#!/bin/sh\nexit 0\n');
    m.escribirEn(m.claude, 'git-hooks/sub/ayuda.sh', 'uno\n');
    fs.writeFileSync(gcfg, '[core]\n\thooksPath = ' + path.join(m.claude, 'git-hooks').replace(/\\/g, '/') + '\n');
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const clave = (rel) => path.join(m.claude, rel).split(path.sep).join('/');
    // Los cambios en archivos de git-hooks, juntos; los del VALOR global de core.hooksPath, uno por uno (se excluyen entre sí).
    await m.tanda([
      R('A27: un archivo de git-hooks cambiado → ROTA', () => m.escribirEn(m.claude, 'git-hooks/pre-commit', '#!/bin/sh\nexit 1\n'), clave('git-hooks/pre-commit')),
      R('A27: un archivo nuevo en una subcarpeta de git-hooks → ROTA', () => m.escribirEn(m.claude, 'git-hooks/sub/otro.sh', 'x\n'), clave('git-hooks/sub/otro.sh')),
      I('A27: un archivo de git-hooks que no se toca → no figura', () => {}, clave('git-hooks/sub/ayuda.sh')),
    ]);
    const casos = [
      ['core.hooksPath global cambiado a otro valor → ROTA', () => fs.writeFileSync(gcfg, '[core]\n\thooksPath = /otro/lugar\n')],
      ['core.hooksPath global quitado → ROTA', () => fs.writeFileSync(gcfg, '[user]\n\tname = t\n')],
      // sin valor al inicio (el caso anterior lo dejó así) y luego aparece → ROTA
      ['core.hooksPath global que aparece (antes sin valor) → ROTA', () => fs.writeFileSync(gcfg, '[core]\n\thooksPath = /nuevo\n')],
    ];
    for (const [nombre, cambio] of casos) {
      const x = await m.caso(cambio);
      ok(x.code === 3 && x.out.includes('git-config-global:core.hooksPath'), 'A27: ' + nombre, x.code + ' ' + x.out);
    }
    // El arnés mide solo el VALOR del hooksPath, no el ~/.gitconfig completo (en un proceso aparte, con la misma casa falsa).
    const medirHijo = async () => {
      const js = 'const m = require(' + JSON.stringify(m.script) + ').medir(' + JSON.stringify(m.repo) + ');' +
        'process.stdout.write(JSON.stringify(m.arnes && m.arnes["git-config-global:core.hooksPath"] === undefined ? null : m.arnes["git-config-global:core.hooksPath"]));';
      const h = await m.nodo(js);
      return h.code === 0 ? JSON.parse(h.out) : 'ERROR ' + h.code + ' ' + h.err.slice(0, 300);
    };
    fs.writeFileSync(gcfg, '[core]\n\thooksPath = /nuevo\n');
    const v1 = await medirHijo();
    fs.appendFileSync(gcfg, '[alias]\n\tzz = status\n');
    const v2 = await medirHijo();
    ok(v1 === 'valor:/nuevo' && v2 === v1, 'A27: el valor del hooksPath se mide solo (no el ~/.gitconfig completo)', JSON.stringify([v1, v2]));
  });

  test('A27 — carpetas opcionales ausentes (git-hooks, skills, espejo, codexHome) se registran como ausentes, sin error', async () => {
    const m = new Mundo().porDefecto();
    const gcfg = path.join(m.dir, 'gitconfig27b');
    fs.writeFileSync(gcfg, '');
    m.precarga = crearPrecarga({ gitGlobal: gcfg });
    m.escribirEn(m.claude, 'settings.json', '{}');
    m.nuevoRepo({ 'a.txt': 'a\n' });
    await m.intacto('A27: git-hooks ausente y hooksPath sin valor → INTACTO (no es error)', () => {});
  });

  // ===================================================================================== arnes.extra y entradas explícitas
  test('arnes.extra de uaeh.config.json suma carpetas al arnés por defecto; UAEH_ARNES lo reemplaza todo; una configuración rota es un error', async () => {
    const m = new Mundo().porDefecto();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const clave = (base, rel) => path.join(base, rel).split(path.sep).join('/');
    const extra = path.join(m.dir, 'mis-reglas');
    const plana = path.join(m.dir, 'mis-reglas-planas');
    m.escribirEn(extra, 'a.md', 'uno\n');
    m.escribirEn(extra, 'sub/b.md', 'dos\n');
    m.escribirEn(extra, 'c.txt', 'tres\n');
    m.escribirEn(plana, 'p.md', 'plano\n');
    m.escribirEn(plana, 'hondo/q.md', 'hondo\n');
    fs.mkdirSync(m.uaeh, { recursive: true });
    const conf = path.join(m.uaeh, 'uaeh.config.json');
    fs.writeFileSync(conf, JSON.stringify({ arnes: { extra: [[extra, '\\.md$', true], [plana, '\\.md$']] } }));
    await m.tanda([
      R('arnes.extra recursivo: archivo .md cambiado → ROTA', () => m.escribirEn(extra, 'a.md', 'uno cambiado\n'), clave(extra, 'a.md')),
      R('arnes.extra recursivo: archivo de una subcarpeta cambiado → ROTA', () => m.escribirEn(extra, 'sub/b.md', 'dos cambiado\n'), clave(extra, 'sub/b.md')),
      I('arnes.extra: un archivo que no cumple el patrón no se mide', () => m.escribirEn(extra, 'c.txt', 'tres cambiado\n'), clave(extra, 'c.txt')),
      R('arnes.extra no recursivo: archivo de la carpeta cambiado → ROTA', () => m.escribirEn(plana, 'p.md', 'plano cambiado\n'), clave(plana, 'p.md')),
      I('arnes.extra no recursivo: el de una subcarpeta no se mide', () => m.escribirEn(plana, 'hondo/q.md', 'hondo cambiado\n'), clave(plana, 'hondo/q.md')),
    ]);
    // UAEH_ARNES reemplaza la lista ENTERA (también lo de arnes.extra).
    const solo = path.join(m.dir, 'solo-esto');
    m.escribirEn(solo, 'z.md', 'z\n');
    m.escribirEn(m.claude, 'settings.json', '{}');
    m.escribirEn(path.join(m.uaeh, 'estable'), 'cualquier.cjs', 'espejo\n');
    await m.tanda([
      R('UAEH_ARNES: su carpeta sí se mide', () => m.escribirEn(solo, 'z.md', 'z cambiado\n'), clave(solo, 'z.md')),
      I('UAEH_ARNES reemplaza todo: arnes.extra ya no se mide', () => m.escribirEn(extra, 'a.md', 'uno otra vez\n'), clave(extra, 'a.md')),
      I('UAEH_ARNES reemplaza todo: <claudeHome>/settings.json ya no se mide', () => m.escribirEn(m.claude, 'settings.json', '{"a":1}'), clave(m.claude, 'settings.json')),
      I('UAEH_ARNES reemplaza todo: el espejo estable ya no se mide', () => m.escribirEn(path.join(m.uaeh, 'estable'), 'cualquier.cjs', 'espejo cambiado\n'), clave(path.join(m.uaeh, 'estable'), 'cualquier.cjs')),
      I('UAEH_ARNES reemplaza todo: la raíz del plugin ya no se mide', () => m.escribirEn(m.plugin, 'hooks/h.js', 'nuevo\n'), clave(m.plugin, 'hooks/h.js')),
    ], m.conEnv({ UAEH_ARNES: JSON.stringify([[solo, '\\.md$']]) }));
    // Una configuración que se leería «de menos» es un ERROR (DESCONOCIDO), nunca menos arnés en silencio.
    fs.writeFileSync(conf, JSON.stringify({ arnes: { extra: 'esto no es una lista' } }));
    let rp = await m.run(['foto', m.repo]);
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out) && /arnes\.extra/.test(rp.out), 'arnes.extra con forma inválida → DESCONOCIDO (y dice por qué)', rp.code + ' ' + rp.out);
    fs.writeFileSync(conf, '{esto no es json');
    rp = await m.run(['foto', m.repo]);
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'uaeh.config.json ilegible → DESCONOCIDO', rp.code + ' ' + rp.out);
    ok(!rp.out.includes('esto no es json'), 'y el mensaje no vuelca el contenido del archivo', rp.out);
    fs.writeFileSync(conf, JSON.stringify({ arnes: { extra: [[extra, '(sin cerrar', true]] } }));
    rp = await m.run(['foto', m.repo]);
    ok(rp.code === 4 && /^DESCONOCIDO/.test(rp.out), 'arnes.extra con un patrón que no compila → DESCONOCIDO', rp.code + ' ' + rp.out);
    // Una clave desconocida en la configuración es solo un aviso de config.cjs: no impide medir.
    fs.writeFileSync(conf, JSON.stringify({ claveQueNoExiste: 1 }));
    await m.intacto('una clave desconocida en uaeh.config.json no impide medir', () => {});
    fs.unlinkSync(conf);
    await m.intacto('sin uaeh.config.json el sello funciona igual', () => {});
  });

  test('Una entrada EXPLÍCITA del arnés bajo plugins/cache/ no la poda ninguna regla (ni «plugins/** no se mide» ni la poda de carpetas de salida)', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const cache = path.join(m.claude, 'plugins', 'cache', 'x');
    const clave = (rel) => path.join(cache, rel).split(path.sep).join('/');
    const w = (rel, txt) => m.escribirEn(cache, rel, txt);
    w('hooks/h.js', 'uno\n');
    w('hooks/sub/aux.json', '{}');
    // Nombres que la poda de IGNORADOS recorta cuando son del repo revisado: aquí son del arnés y se miden igual.
    for (const d of ['vendor', 'build', '.cache', 'dist', 'out']) w(d + '/v.md', 'v\n');
    w('node_modules/n.md', 'n\n');
    const hooks = m.conEnv({ UAEH_ARNES: JSON.stringify([[path.join(cache, 'hooks'), '\\.(js|json)$', true]]) });
    await m.rota('un hook bajo plugins/cache/x/hooks/ (UAEH_ARNES explícito) cambiado → ROTA', () => w('hooks/h.js', 'dos\n'), 'plugins/cache/x/hooks/h.js', hooks);
    await m.rota('un archivo nuevo en una subcarpeta bajo plugins/cache/x/hooks/ → ROTA', () => w('hooks/nueva/n.js', 'n\n'), 'plugins/cache/x/hooks/nueva/n.js', hooks);
    const toda = m.conEnv({ UAEH_ARNES: JSON.stringify([[cache, '.', true]]) });
    await m.tanda([
      R('plugins/cache/x/hooks/sub/aux.json', () => w('hooks/sub/aux.json', '{"a":1}'), clave('hooks/sub/aux.json')),
      ...['vendor', 'build', '.cache', 'dist', 'out'].map((d) => R(`plugins/cache/x/${d}/ (nombre de carpeta de salida) también se mide`, () => w(d + '/v.md', 'cambiado\n'), clave(d + '/v.md'))),
      I('node_modules/ dentro del arnés recursivo sí se omite', () => w('node_modules/n.md', 'cambiado\n'), clave('node_modules/n.md')),
    ], toda);
    // La lista por defecto NO mide plugins/ de otros plugins (ver la prueba del arnés por defecto), pero esa omisión no se contagia a lo explícito.
  });

  // ==================================================================================== Identidad: prefijo del plugin
  test('Hooks: el agente de plugin «uaeh-harness:uae-verifier» se trata igual que «uae-verifier»; los que no son revisores, no', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'a.txt': 'a\n' });
    const base = { session_id: 's', cwd: m.repo, agent_id: 'pref1', agent_type: 'uaeh-harness:uae-verifier' };
    let r = await m.hook('hook-inicio', { ...base, hook_event_name: 'SubagentStart' });
    let j = json(r.out);
    ok(r.code === 0 && j.hookSpecificOutput && /activo sobre/.test(j.hookSpecificOutput.additionalContext), 'hook-inicio con agent_type «uaeh-harness:uae-verifier» → foto + aviso', r.out);
    ok(fs.existsSync(path.join(m.fotos, 'agente-pref1.foto.json')), 'y guarda la foto del agente');
    r = await m.hook('hook-fin', { ...base, hook_event_name: 'SubagentStop', stop_hook_active: false });
    ok(r.code === 0 && r.out === '', 'hook-fin sin cambios → deja terminar', r.out);
    await m.hook('hook-inicio', { ...base, agent_id: 'pref2' });
    m.escribir('a.txt', 'trampa\n');
    r = await m.hook('hook-fin', { ...base, agent_id: 'pref2', stop_hook_active: false });
    j = json(r.out);
    ok(j.decision === 'block' && /ANULADO/.test(j.reason) && /a\.txt/.test(j.reason) && /BLOCKED/.test(j.reason), 'hook-fin con cambios y prefijo → obliga a reportar BLOCKED con la lista', r.out);
    const registro = fs.readFileSync(path.join(m.fotos, 'registro.jsonl'), 'utf8');
    ok(/"id":"agente-pref2","agente":"uae-verifier"[^\n]*"resultado":"ROTA"/.test(registro), 'el registro guarda el agente SIN el prefijo del plugin', registro);
    m.git(['checkout', '--', 'a.txt']);
    // Todos los revisores, con prefijo.
    const nombres = [...MOD.REVISORES];
    ok(nombres.length >= 6 && ['uae-verifier', 'uae-security', 'browser-verifier', 'uae-triage', 'uae-architect', 'design-auditor'].every((n) => nombres.includes(n)), 'REVISORES contiene los seis agentes de revisión', nombres.join(','));
    await todos(nombres.map((n, i) => async () => {
      const x = await m.hook('hook-inicio', { ...base, agent_id: 'rev' + i, agent_type: 'uaeh-harness:' + n });
      ok(x.code === 0 && fs.existsSync(path.join(m.fotos, 'agente-rev' + i + '.foto.json')), `«uaeh-harness:${n}» se reconoce como revisor`, x.out);
    }));
    // Los que no son revisores, aunque lleven prefijo, no activan el sello.
    for (const [i, tipo] of ['uaeh-harness:uae-builder', 'uaeh-harness:Explore', 'otro-plugin:general-purpose'].entries()) {
      r = await m.hook('hook-inicio', { ...base, agent_id: 'nor' + i, agent_type: tipo });
      ok(r.code === 0 && r.out === '' && !fs.existsSync(path.join(m.fotos, 'agente-nor' + i + '.foto.json')), `«${tipo}» no es un revisor → nada`, r.out);
    }
  });

  // ============================================================================================== Almacenamiento y encabezado
  test('Respaldo de almacenamiento: si la carpeta de fotos no admite escritura, usa la temporal del sistema', async () => {
    const m = new Mundo();
    m.nuevoRepo({ 'src/app.test.js': 'test\n' });
    const tmp = path.join(m.dir, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    const env = m.conEnv({ UAEH_INTEGRIDAD_DIR: path.join(m.repo, 'src', 'app.test.js', 'imposible'), TEMP: tmp, TMP: tmp, TMPDIR: tmp });
    const rf = await m.run(['foto', m.repo], { env });
    ok(rf.code === 0 && fs.existsSync(path.join(tmp, 'uaeh-integridad', rf.out + '.foto.json')), 'carpeta principal no escribible → usa la temporal', rf.out + ' ' + rf.err);
    const rc = await m.run(['comparar', rf.out], { env });
    ok(rc.code === 0 && rc.out.startsWith('INTACTO'), 'y la comparación la encuentra ahí', rc.code + ' ' + rc.out);
  });

  test('A20 / A26 / A7 — el encabezado está sincronizado con el código y declara perillas, residuales y coberturas', () => {
    const texto = fs.readFileSync(SCRIPT, 'utf8');
    const lineas = texto.split(/\r?\n/);
    const cab = lineas.filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
    ok(/sello de integridad de los revisores/.test(lineas[1]) && /ciclo 7/.test(lineas[1]), 'A20/A26: la línea 2 del encabezado identifica el sello y su ciclo', lineas[1]);
    const bloque = (ini, fin) => { const a = cab.indexOf(ini); const b = cab.indexOf(fin, a); return a < 0 || b < 0 ? null : cab.slice(a + ini.length, b); };
    ok(MOD.DIRS_SALIDA instanceof Set && MOD.DIRS_SALIDA.size > 0 && Array.isArray(MOD.EXCLUSIONES_NOMBRE), 'A20: el módulo exporta DIRS_SALIDA y EXCLUSIONES_NOMBRE');
    const podadas = bloque('CARPETAS PODADAS', 'FIN DE LA LISTA.');
    ok(podadas !== null, 'A20: el encabezado tiene el bloque «CARPETAS PODADAS … FIN DE LA LISTA.»');
    const tokens = new Set((podadas || '').toLowerCase().split(/\s+/).filter(Boolean));
    const faltan = [...(MOD.DIRS_SALIDA || [])].filter((d) => !tokens.has(d.toLowerCase()));
    ok(podadas !== null && faltan.length === 0, 'A20: cada entrada de DIRS_SALIDA aparece en el encabezado', 'faltan: ' + faltan.join(' '));
    const nombres = bloque('EXCLUIDOS POR NOMBRE', 'FIN DE LA LISTA DE NOMBRES.');
    const tn = new Set((nombres || '').split(/\s+/).filter(Boolean));
    const faltanN = (MOD.EXCLUSIONES_NOMBRE || []).filter((g) => !tn.has(g));
    ok(nombres !== null && faltanN.length === 0, 'A20: cada exclusión por nombre aparece en el encabezado', 'faltan: ' + faltanN.join(' '));
    for (const palabra of ['pyvenv.cfg', 'www/config.php', 'plugins', '.claude.json', 'toml-crudo', 'storage-state', '.auth/', '.yarn/cache', 'git-hooks', 'core.hooksPath',
      'UAEH_ARNES', 'UAEH_PRESUPUESTO_MS', 'UAEH_TOPE_SENSIBLES', 'UAEH_INTEGRIDAD_DIR', 'UAEH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'junctions', 'worktrees', 'no se miden',
      'estable', 'arnes.extra']) {
      ok(cab.includes(palabra), 'A20/A26/A7: el encabezado menciona «' + palabra + '»');
    }
    ok(cab.toLowerCase().includes('raíz de este plugin'), 'el encabezado declara que se mide la raíz de ESTE plugin');
  });

});

describe('sellosAbiertos (revisiones vivas de otras sesiones)', () => {
  // Función pura sobre una carpeta de fotos: UAEH_INTEGRIDAD_DIR la fija (y excluye la de respaldo del sistema).
  function conCarpeta(fn) {
    const dir = path.join(E.dir, 'sellos-' + (++nPrecargas));
    const antes = process.env.UAEH_INTEGRIDAD_DIR;
    process.env.UAEH_INTEGRIDAD_DIR = dir;
    try { return fn(dir); } finally { if (antes === undefined) delete process.env.UAEH_INTEGRIDAD_DIR; else process.env.UAEH_INTEGRIDAD_DIR = antes; }
  }
  const sembrar = (dir, id, minutos, extra) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, id + '.foto.json');
    fs.writeFileSync(f, JSON.stringify({ id, repo: '/repo/x', etiqueta: 'hook uae-verifier', ...(extra || {}) }));
    const t = new Date(Date.now() - minutos * 60000);
    fs.utimesSync(f, t, t);
  };

  test('carpeta inexistente = lista vacía; nunca lanza', () => {
    conCarpeta(() => assert.deepEqual(MOD.sellosAbiertos(), []));
    conCarpeta((dir) => { fs.mkdirSync(path.dirname(dir), { recursive: true }); fs.writeFileSync(dir, 'esto es un archivo, no una carpeta'); assert.deepEqual(MOD.sellosAbiertos(), []); });
  });

  test('foto reciente sin cierre = abierta, con id, repo, etiqueta y minutos', () => conCarpeta((dir) => {
    sembrar(dir, 'agente-a1', 7);
    const r = MOD.sellosAbiertos();
    assert.equal(r.length, 1);
    assert.equal(r[0].id, 'agente-a1');
    assert.equal(r[0].repo, '/repo/x');
    assert.equal(r[0].etiqueta, 'hook uae-verifier');
    assert.ok(r[0].minutos >= 6 && r[0].minutos <= 8, String(r[0].minutos));
  }));

  test('foto vieja (más del umbral) no cuenta; maxMin lo cambia', () => conCarpeta((dir) => {
    sembrar(dir, 'agente-vieja', 200);
    sembrar(dir, 'agente-media', 40);
    assert.deepEqual(MOD.sellosAbiertos().map((s) => s.idCompleto), ['agente-media']);
    assert.deepEqual(MOD.sellosAbiertos({ maxMin: 10 }), []);
    assert.equal(MOD.sellosAbiertos({ maxMin: 500 }).length, 2);
  }));

  test('una foto con cierre en el registro (INTACTO, ROTA o DESCONOCIDO) ya no está abierta; FOTO_OK sigue abierta', () => conCarpeta((dir) => {
    for (const id of ['a-intacto', 'a-rota', 'a-desc', 'a-abierta']) sembrar(dir, id, 3);
    fs.writeFileSync(path.join(dir, 'registro.jsonl'), [
      { id: 'a-intacto', resultado: 'INTACTO' }, { id: 'a-rota', resultado: 'ROTA' }, { id: 'a-desc', resultado: 'DESCONOCIDO' },
      { id: 'a-abierta', resultado: 'FOTO_OK' },
    ].map((f) => JSON.stringify(f)).join('\n') + '\n{línea cortada');
    assert.deepEqual(MOD.sellosAbiertos().map((s) => s.idCompleto), ['a-abierta']);
  }));

  test('archivos que no son fotos o con id inseguro se ignoran; una foto ilegible se lista igual', () => conCarpeta((dir) => {
    sembrar(dir, 'ok-1', 1);
    fs.writeFileSync(path.join(dir, 'registro.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'raro.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'ilegible.foto.json'), '{no es json');
    const ids = MOD.sellosAbiertos().map((s) => s.idCompleto).sort();
    assert.deepEqual(ids, ['ilegible', 'ok-1']);
  }));
});
