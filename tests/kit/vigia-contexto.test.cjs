// Pruebas de plugins/uaeh-kit/hooks/vigia-contexto.js (UserPromptSubmit «prompt» · SessionStart «inicio»)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { entornoTemporal, correr, lineaUso, settingsBasico, RAIZ_KIT } = require('../helpers/entorno.cjs');

const HOOK = path.join(RAIZ_KIT, 'hooks', 'vigia-contexto.js');
const COMUN = path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs');
const { LIMITE_CLAUDE_MD: LIMITE } = require(COMUN);
const TOPE = 100000; // autoCompactWindow de los ajustes de usuario de estas pruebas: 80 % = 80K, 90 % = 90K

// En modo «inicio» el hook sube por TODOS los ancestros del cwd hasta la raíz del disco (como Claude Code).
// Si el directorio temporal del sistema cuelga de una carpeta con un CLAUDE.md que ya pasa del límite, el
// «no hay aviso» deja de ser hermético: la prueba se omite con el motivo (y en CI estricto, falla).
// Hermeticidad: si un CLAUDE.md ajeno (ancestro del temporal del sistema) pasa del límite, el vigía avisaría
// por una razón externa a la prueba. Compartida en tests/helpers/entorno.cjs.
const exigirAncestrosLimpios = (t) => require('../helpers/entorno.cjs').exigirAncestrosLimpios(t, { bloque: false, tamano: true });

// Casa temporal con ajustes de usuario que fijan el tope de compactación (0 = sin autoCompactWindow).
function casa(autoCompactWindow = TOPE) {
  const e = entornoTemporal();
  e.escribir(path.join(e.claudeHome, 'settings.json'), settingsBasico(autoCompactWindow ? { autoCompactWindow } : {}));
  return e;
}

// Línea de transcript cuyo contexto (entrada + caché leída + caché escrita) suma exactamente `total`.
// Lleva 500 tokens de salida: no deben contarse.
function usoTotal(total, extra = {}) {
  return lineaUso({ entrada: 1000, cacheEscrita: 2000, cacheLeida: total - 3000, salida: 500, ...extra });
}

const transcript = (e, lineas, nombre = 'sesion.jsonl') => e.escribir(path.join(e.dir, nombre), lineas.join('\n') + '\n');

function prompt(e, ruta, { sesion = 'sesion-1', env = e.env, cwd = e.proyecto, script = HOOK } = {}) {
  return correr(script, ['prompt'], {
    stdin: { session_id: sesion, transcript_path: ruta, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'hola' },
    env, cwd: e.proyecto,
  });
}

function inicio(e, { cwd = e.proyecto, stdin, env = e.env, script = HOOK } = {}) {
  return correr(script, ['inicio'], {
    stdin: stdin !== undefined ? stdin : { session_id: 'sesion-1', cwd, hook_event_name: 'SessionStart', source: 'startup' },
    env, cwd: e.proyecto,
  });
}

// Silencio total: salida 0 y nada en stdout.
function callado(r, mensaje = 'debe quedar callado') {
  assert.equal(r.status, 0, `${mensaje} (salida ${r.status})`);
  assert.equal(r.stdout, '', mensaje);
}

// Un «plugin» incompleto: solo el hook (y, si se pide, la biblioteca común), sin ventana-contexto.cjs.
function pluginIncompleto(e, { conComun = false } = {}) {
  const raiz = path.join(e.dir, 'plugin-incompleto');
  fs.mkdirSync(path.join(raiz, 'hooks'), { recursive: true });
  fs.copyFileSync(HOOK, path.join(raiz, 'hooks', 'vigia-contexto.js'));
  if (conComun) {
    fs.mkdirSync(path.join(raiz, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(COMUN, path.join(raiz, 'scripts', 'lib', 'comun.cjs'));
  }
  return path.join(raiz, 'hooks', 'vigia-contexto.js');
}

// ── prompt: contexto frente al tope ───────────────────────────────────────────────────

test('prompt: 79 % calla; 80 % avisa con el porcentaje (systemMessage) y el recordatorio al modelo (additionalContext)', () => {
  const e = casa();
  try {
    callado(prompt(e, transcript(e, [usoTotal(79000)], 'bajo.jsonl')), '79 % del tope no avisa');

    const r = prompt(e, transcript(e, [usoTotal(80000)], 'alto.jsonl'));
    assert.equal(r.status, 0);
    const j = r.json();
    assert.ok(j, `stdout debe ser JSON: ${r.stdout}`);
    assert.deepEqual(Object.keys(j).sort(), ['hookSpecificOutput', 'systemMessage']);
    assert.match(j.systemMessage, /^Contexto en 80K tokens \(80 % del tope\)/, 'la salida del modelo (500) no se suma');
    assert.match(j.systemMessage, /Se compacta sola en 100K\.$/);
    assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(j.hookSpecificOutput.additionalContext, /^VIGÍA DE CONTEXTO: esta conversación ya relee ~80K tokens/);
    assert.match(j.hookSpecificOutput.additionalContext, /avisa al usuario/);
  } finally { e.limpiar(); }
});

test('prompt: avisa una sola vez por sesión y umbral; otro umbral u otra sesión avisan de nuevo', () => {
  const e = casa();
  try {
    const t80 = transcript(e, [usoTotal(80000)], 't80.jsonl');
    const t90 = transcript(e, [usoTotal(90000)], 't90.jsonl');

    assert.ok(prompt(e, t80, { sesion: 'uno' }).json(), 'primer aviso, al 80 %');
    callado(prompt(e, t80, { sesion: 'uno' }), 'mismo umbral y misma sesión: callado');

    const j90 = prompt(e, t90, { sesion: 'uno' }).json();
    assert.ok(j90, 'el 90 % es otro umbral: avisa');
    assert.match(j90.systemMessage, /^Contexto en 90K tokens \(90 % del tope\)/);
    callado(prompt(e, t90, { sesion: 'uno' }), 'el 90 % ya se avisó');

    assert.ok(prompt(e, t80, { sesion: 'dos' }).json(), 'otra sesión: avisa de nuevo');

    // Las marcas viven en <tmp>/uaeh-vigia-contexto (el helper redirige el temporal a la casa).
    const marcas = fs.readdirSync(path.join(e.tmp, 'uaeh-vigia-contexto'));
    assert.equal(marcas.length, 3);
    assert.equal(marcas.filter((m) => m.startsWith('uno-')).length, 2);
    assert.equal(marcas.filter((m) => m.startsWith('dos-')).length, 1);
  } finally { e.limpiar(); }
});

test('prompt: el session_id no puede sacar la marca de su carpeta', () => {
  const e = casa();
  try {
    const t80 = transcript(e, [usoTotal(80000)], 't80.jsonl');
    assert.ok(prompt(e, t80, { sesion: '../../evil' }).json());
    // «../../» desde la carpeta de marcas llevaría a e.dir: ahí y en e.tmp no debe aparecer nada.
    for (const fuera of [e.tmp, e.dir]) {
      assert.ok(!fs.readdirSync(fuera).some((n) => n.includes('evil')), `no debe escribir fuera de uaeh-vigia-contexto (${fuera})`);
    }
    assert.ok(fs.readdirSync(path.join(e.tmp, 'uaeh-vigia-contexto')).some((n) => n.startsWith('evil-')));
  } finally { e.limpiar(); }
});

test('prompt: ignora las líneas de subagentes (isSidechain) y usa la principal anterior', () => {
  const e = casa();
  try {
    const j = prompt(e, transcript(e, [usoTotal(80000), usoTotal(95000, { lateral: true })], 'mezcla.jsonl'), { sesion: 'x1' }).json();
    assert.ok(j, 'la principal (80 %) avisa aunque la última línea sea de un subagente');
    assert.match(j.systemMessage, /\(80 % del tope\)/, 'se usa la principal, no el 95 % del subagente');

    callado(prompt(e, transcript(e, [usoTotal(50000), usoTotal(95000, { lateral: true })], 'bajo.jsonl'), { sesion: 'x2' }), 'el subagente al 95 % no cuenta');
    callado(prompt(e, transcript(e, [usoTotal(95000, { lateral: true })], 'solo-lateral.jsonl'), { sesion: 'x3' }), 'solo subagentes: nada que medir');

    // Con espacios en el JSON la marca textual no coincide, pero la propiedad sí.
    const compacta = usoTotal(95000, { lateral: true });
    const conEspacio = compacta.replace('"isSidechain":true', '"isSidechain": true');
    assert.ok(compacta.includes('"isSidechain":true') && conEspacio.includes('"isSidechain": true') && !conEspacio.includes('"isSidechain":true'));
    callado(prompt(e, transcript(e, [usoTotal(50000), conEspacio], 'espacio.jsonl'), { sesion: 'x4' }), 'isSidechain con espacio también se ignora');
  } finally { e.limpiar(); }
});

test('prompt: transcript sin usage, vacío, inexistente, carpeta o sin ruta → calla con salida 0', () => {
  const e = casa();
  try {
    const sinUso = transcript(e, [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hola' } })], 'sin-uso.jsonl');
    callado(prompt(e, sinUso, { sesion: 'a' }), 'sin usage');
    callado(prompt(e, e.escribir(path.join(e.dir, 'vacio.jsonl'), ''), { sesion: 'b' }), 'vacío');
    callado(prompt(e, path.join(e.dir, 'no-existe.jsonl'), { sesion: 'c' }), 'inexistente');
    callado(prompt(e, e.dir, { sesion: 'd' }), 'una carpeta, no un archivo');
    callado(correr(HOOK, ['prompt'], { stdin: { session_id: 'e', cwd: e.proyecto }, env: e.env, cwd: e.proyecto }), 'sin transcript_path');
  } finally { e.limpiar(); }
});

test('prompt: una línea final cortada o con ruido no tapa el último uso válido', () => {
  const e = casa();
  try {
    const lineas = [usoTotal(85000), '{"message":{"usage":{"input_tokens":5', 'ruido con "usage" pero sin JSON'];
    const j = prompt(e, transcript(e, lineas, 'ruido.jsonl')).json();
    assert.ok(j, 'avisa con la última línea válida');
    assert.match(j.systemMessage, /^Contexto en 85K tokens \(85 % del tope\)/);
  } finally { e.limpiar(); }
});

test('prompt: en un transcript de varios MB lee el final (la ventana empieza a media línea)', () => {
  const e = casa();
  try {
    const relleno = `{"type":"user","message":{"content":"${'x'.repeat(900)}"}}\n`.repeat(3500); // ≈ 3.3 MB sin usage
    const ruta = e.escribir(path.join(e.dir, 'grande.jsonl'), `${usoTotal(60000)}\n${relleno}${usoTotal(85000)}\n`);
    assert.ok(fs.statSync(ruta).size > 3 * 1024 * 1024);
    const j = prompt(e, ruta).json();
    assert.ok(j);
    assert.match(j.systemMessage, /^Contexto en 85K tokens \(85 % del tope\)/);
  } finally { e.limpiar(); }
});

test('prompt: CLAUDE_CODE_AUTO_COMPACT_WINDOW manda sobre los ajustes (200k → el 80 % son 160K)', () => {
  const e = casa();
  try {
    const env = { ...e.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200k' };
    callado(prompt(e, transcript(e, [usoTotal(80000)], 'a.jsonl'), { env, sesion: 'v1' }), '80K ya es solo el 40 % de 200K');
    const j = prompt(e, transcript(e, [usoTotal(160000)], 'b.jsonl'), { env, sesion: 'v2' }).json();
    assert.ok(j);
    assert.match(j.systemMessage, /^Contexto en 160K tokens \(80 % del tope\)/);
    assert.match(j.systemMessage, /Se compacta sola en 200K\.$/);
  } finally { e.limpiar(); }
});

test('prompt: el tope respeta los ajustes del proyecto (cwd del evento) sobre los del usuario', () => {
  const e = casa(400000);
  try {
    e.escribir(path.join(e.proyecto, '.claude', 'settings.local.json'), settingsBasico({ autoCompactWindow: TOPE }));
    const t80 = transcript(e, [usoTotal(80000)], 't80.jsonl');
    assert.ok(prompt(e, t80, { sesion: 'p1' }).json(), 'con el cwd del proyecto el tope es 100K y 80K avisa');

    const otro = path.join(e.dir, 'otro-proyecto');
    fs.mkdirSync(otro);
    callado(prompt(e, t80, { sesion: 'p2', cwd: otro }), 'otro cwd: manda el tope del usuario (400K)');

    // Sin `cwd` en el evento, la carpeta sale de workspace.current_dir.
    const deEspacio = (dir, sesion) => correr(HOOK, ['prompt'], { stdin: { session_id: sesion, transcript_path: t80, workspace: { current_dir: dir } }, env: e.env, cwd: otro });
    assert.ok(deEspacio(e.proyecto, 'p3').json(), 'workspace.current_dir del proyecto: tope de 100K');
    callado(deEspacio(otro, 'p4'), 'workspace.current_dir de otro proyecto: tope del usuario');
  } finally { e.limpiar(); }
});

test('prompt: el modelo de la última línea del transcript elige el tope por modelo', () => {
  const e = casa();
  try {
    e.escribir(path.join(e.claudeHome, 'settings.json'), settingsBasico({
      autoCompactWindow: 400000,
      modelSettings: { 'claude-sonnet-5-5': { autoCompactWindow: TOPE } },
    }));
    const sonnet = transcript(e, [usoTotal(80000, { modelo: 'claude-sonnet-5-5' })], 'sonnet.jsonl');
    const opus = transcript(e, [usoTotal(80000, { modelo: 'claude-opus-5-5' })], 'opus.jsonl');
    assert.ok(prompt(e, sonnet, { sesion: 'm1' }).json(), 'sonnet tiene tope propio de 100K');
    callado(prompt(e, opus, { sesion: 'm2' }), 'opus usa el general de 400K');
  } finally { e.limpiar(); }
});

test('prompt: sin tope configurado se usa el de Claude Code con ventana de 1M (967K)', () => {
  const e = casa(0);
  try {
    callado(prompt(e, transcript(e, [usoTotal(700000)], 'a.jsonl'), { sesion: 's1' }), '700K es el 72 % de 967K');
    const j = prompt(e, transcript(e, [usoTotal(800000)], 'b.jsonl'), { sesion: 's2' }).json();
    assert.ok(j);
    assert.match(j.systemMessage, /^Contexto en 800K tokens \(83 % del tope\)/);
    assert.match(j.systemMessage, /Se compacta sola en 967K\.$/);
  } finally { e.limpiar(); }
});

test('prompt: si el módulo del tope no carga se usa 400K; si falta hasta la biblioteca común, calla con 0', () => {
  const e = casa();
  try {
    const sinVentana = pluginIncompleto(e, { conComun: true });
    callado(prompt(e, transcript(e, [usoTotal(319000)], 'a.jsonl'), { sesion: 'f1', script: sinVentana }), '319K no llega al 80 % de 400K');
    const j = prompt(e, transcript(e, [usoTotal(320000)], 'b.jsonl'), { sesion: 'f2', script: sinVentana }).json();
    assert.ok(j, 'sin ventana-contexto.cjs, el 80 % de 400K avisa');
    assert.match(j.systemMessage, /^Contexto en 320K tokens \(80 % del tope\)/);
    assert.match(j.systemMessage, /Se compacta sola en 400K\.$/);

    const sinNada = path.join(e.dir, 'plugin-roto', 'hooks', 'vigia-contexto.js');
    fs.mkdirSync(path.dirname(sinNada), { recursive: true });
    fs.copyFileSync(HOOK, sinNada);
    const alto = transcript(e, [usoTotal(95000)], 'c.jsonl');
    callado(prompt(e, alto, { sesion: 'f3', script: sinNada }), 'sin biblioteca común: silencio');
    callado(inicio(e, { script: sinNada }), 'sin biblioteca común (inicio): silencio');
  } finally { e.limpiar(); }
});

// ── inicio: CLAUDE.md demasiado grandes ───────────────────────────────────────────────

test('inicio: CLAUDE.md del proyecto de más de 40K caracteres → aviso que nombra el archivo y sugiere /uaeh-kit:dieta', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    const gordo = e.escribir(path.join(e.proyecto, 'CLAUDE.md'), `# Proyecto\n${'x'.repeat(LIMITE + 1000)}`);
    const r = inicio(e);
    assert.equal(r.status, 0);
    const j = r.json();
    assert.ok(j, `stdout debe ser JSON: ${r.stdout}`);
    assert.deepEqual(Object.keys(j), ['hookSpecificOutput'], 'en SessionStart solo hookSpecificOutput');
    assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = j.hookSpecificOutput.additionalContext;
    assert.match(ctx, /^VIGÍA DE CONTEXTO: CLAUDE\.md por encima del presupuesto de 40K caracteres: /);
    assert.ok(ctx.includes(gordo), 'nombra el archivo');
    assert.match(ctx, /41K caracteres ≈ 11K tokens/);
    assert.ok(ctx.includes('/uaeh-kit:dieta'));
  } finally { e.limpiar(); }
});

test('inicio: sin CLAUDE.md, con uno pequeño o justo en el límite → calla; un carácter por encima avisa', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    callado(inicio(e), 'sin ningún CLAUDE.md');
    e.escribir(path.join(e.proyecto, 'CLAUDE.md'), '# Pequeño\n');
    callado(inicio(e), 'CLAUDE.md pequeño');
    e.escribir(path.join(e.proyecto, 'CLAUDE.md'), 'x'.repeat(LIMITE));
    callado(inicio(e), `justo ${LIMITE} caracteres: dentro del presupuesto`);
    e.escribir(path.join(e.proyecto, 'CLAUDE.md'), 'x'.repeat(LIMITE + 1));
    assert.ok(inicio(e).json(), `${LIMITE + 1} caracteres: se pasó`);
  } finally { e.limpiar(); }
});

test('inicio: el CLAUDE.md global gordo también avisa (y un hijo gordo no tapa al global)', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    const global = e.escribir(path.join(e.claudeHome, 'CLAUDE.md'), 'x'.repeat(LIMITE + 5000));
    let ctx = inicio(e).json().hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(global), 'nombra el global');
    assert.match(ctx, /45K caracteres/);

    const proyecto = e.escribir(path.join(e.proyecto, 'CLAUDE.md'), 'y'.repeat(LIMITE + 2000));
    ctx = inicio(e).json().hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(proyecto) && ctx.includes(global), 'lista los dos');
    assert.ok(ctx.indexOf(proyecto) < ctx.indexOf(global), 'primero los del proyecto, luego el global');
  } finally { e.limpiar(); }
});

test('inicio: la carpeta sale del evento (cwd o workspace.current_dir), no de la del proceso', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    const otro = path.join(e.dir, 'otro-proyecto');
    const gordo = e.escribir(path.join(otro, 'CLAUDE.md'), 'x'.repeat(LIMITE + 1000));
    callado(inicio(e), 'el proyecto donde corre el proceso no tiene CLAUDE.md');
    assert.ok(inicio(e, { cwd: otro }).json().hookSpecificOutput.additionalContext.includes(gordo), 'cwd del evento');
    assert.ok(inicio(e, { stdin: { workspace: { current_dir: otro } } }).json().hookSpecificOutput.additionalContext.includes(gordo), 'workspace.current_dir');
  } finally { e.limpiar(); }
});

test('inicio: si el cwd es la propia carpeta de configuración, el global no se lista dos veces', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    const global = e.escribir(path.join(e.claudeHome, 'CLAUDE.md'), 'x'.repeat(LIMITE + 1000));
    const ctx = inicio(e, { cwd: e.claudeHome }).json().hookSpecificOutput.additionalContext;
    assert.equal(ctx.split(global).length - 1, 1);
  } finally { e.limpiar(); }
});

// ── robustez ──────────────────────────────────────────────────────────────────────────

test('stdin vacío, basura o con forma rara en modo prompt → calla con salida 0', () => {
  const e = casa();
  try {
    for (const basura of ['', '   ', 'esto no es json {', 'null', '42', '"texto"', '[1,2,3]', '{"transcript_path": 5, "session_id": {}}']) {
      callado(correr(HOOK, ['prompt'], { stdin: basura, env: e.env, cwd: e.proyecto }), `stdin ${JSON.stringify(basura)}`);
    }
    callado(correr(HOOK, [], { stdin: { session_id: 'x' }, env: e.env, cwd: e.proyecto }), 'sin modo');
    callado(correr(HOOK, ['otro-modo'], { stdin: { session_id: 'x' }, env: e.env, cwd: e.proyecto }), 'modo desconocido');
  } finally { e.limpiar(); }
});

test('stdin vacío o basura en modo inicio → calla con salida 0', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    for (const basura of ['', 'esto no es json {', 'null', '42', '[1,2,3]']) {
      callado(inicio(e, { stdin: basura }), `stdin ${JSON.stringify(basura)}`);
    }
  } finally { e.limpiar(); }
});

test('el vigía no lleva el preflight ni rutas sueltas del usuario', () => {
  const fuente = fs.readFileSync(HOOK, 'utf8');
  assert.doesNotMatch(fuente, /uaeh-huella|lineaVigia|preflight/i);
  assert.doesNotMatch(fuente, /homedir/);
  assert.match(fuente, /uaeh-vigia-contexto/);
  assert.match(fuente, /\/uaeh-kit:dieta/);
});
