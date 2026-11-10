// Pruebas de plugins/uaeh-kit/hooks/inyectar-contexto.js (SessionStart)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { entornoTemporal, correr, RAIZ_KIT } = require('../helpers/entorno.cjs');

const HOOK = path.join(RAIZ_KIT, 'hooks', 'inyectar-contexto.js');
const COMUN = path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs');
const MARCA = '[uaeh-kit ctx v1]';
const BLOQUE = '<!-- UAEH:BEGIN v0.1.0 -->\nReglas del método.\n<!-- UAEH:END -->\n';
const SIN_REGLAS = { reglas: { inyectar: false } };
const MAX_MAPA = 7500;

// Texto exacto de lo que el hook inyecta (el contrato: cualquier cambio aquí es un cambio visible).
const REGLAS_ES = [
  'MÉTODO UAEH (capa 1, informativo):',
  '· Cabina limpia: lo que meta mucho texto y no necesites ver crudo va a un subagente que devuelve solo la conclusión; buscar/rastrear en muchos archivos → agente Explore.',
  '· Juntar pasos: lo que no depende del resultado anterior va en el mismo mensaje (llamadas en paralelo) o en un solo comando; el mismo cambio en 3+ archivos → script. Depurar sí va paso a paso.',
  '· Contexto chico: 1 sesión = 1 bloque de trabajo; si el vigía avisa (80 % del tope), termina, guarda y abre sesión nueva.',
  '· Lee lo que dice el mapa de contexto (tasks/context-map.md), no explores a ciegas. Al cerrar un bloque: actualiza el estado en CLAUDE.md (reemplazar, no acumular; ≤ 40K caracteres), tasks/todo.md y tasks/lessons.md.',
  '· Verificar antes de declarar terminado: abre el artefacto real; sin pruebas ejecutadas se dice «sin pruebas», no «funciona».',
].join('\n');
const REGLAS_EN = [
  'UAEH METHOD (layer 1, informative):',
  "· Clean cockpit: anything that pulls a lot of text you don't need raw goes to a subagent that returns only its conclusion; searching many files → the Explore agent.",
  "· Batch steps: whatever doesn't depend on the previous result goes in the same message (parallel calls) or one command; the same change in 3+ files → a script. Debugging stays step by step.",
  '· Small context: 1 session = 1 block of work; when the watchdog warns (80 % of the cap), finish, save and open a new session.',
  "· Read what the context map says (tasks/context-map.md); don't explore blindly. When closing a block: update the state in CLAUDE.md (replace, don't pile up; ≤ 40K chars), tasks/todo.md and tasks/lessons.md.",
  '· Verify before declaring done: open the real artifact; with no tests executed say "untested", never "works".',
].join('\n');
const SIN_MAPA_ES = '📍 Este proyecto no tiene tasks/context-map.md. Si es un proyecto real, créalo con /uaeh-kit:setup proyecto para que las próximas sesiones arranquen sin recontexto.';
const SIN_MAPA_EN = '📍 This project has no tasks/context-map.md. If it is a real project, create it with /uaeh-kit:setup proyecto so future sessions start without re-discovery.';
const TRUNCADO_ES = '\n…[mapa truncado: ver tasks/context-map.md completo]';
const TRUNCADO_EN = '\n…[map truncated: see the full tasks/context-map.md]';
const ENCABEZADO_ES = (ruta) => `📍 MAPA DE ESTE PROYECTO (${ruta}):`;
const ENCABEZADO_EN = (ruta) => `📍 CONTEXT MAP OF THIS PROJECT (${ruta}):`;

// El hook sube por TODOS los ancestros del cwd hasta la raíz del disco (como Claude Code). Si el directorio
// temporal del sistema cuelga de una carpeta con un CLAUDE.md que ya trae el bloque UAEH, «las reglas se
// inyectan» deja de ser hermético: la prueba se omite con el motivo (y en CI estricto, falla).
// Hermeticidad: si un CLAUDE.md ajeno (ancestro del temporal del sistema) ya trae el bloque UAEH, el hook
// omitiría las reglas por una razón externa a la prueba. Compartida en tests/helpers/entorno.cjs.
const exigirAncestrosLimpios = (t) => require('../helpers/entorno.cjs').exigirAncestrosLimpios(t, { bloque: true, tamano: false });

// Casa temporal; `config` (objeto o texto) se escribe como uaeh.config.json.
function casa(config) {
  const e = entornoTemporal();
  if (config !== undefined) e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return e;
}

// Carpeta `niveles` por debajo del proyecto. A 5 niveles, las 5 carpetas donde el hook busca el mapa (el cwd
// y 4 ancestros) quedan dentro de la casa temporal: «sin mapa» no depende de la máquina.
function bajar(e, niveles) {
  const dir = path.join(e.proyecto, ...['a', 'b', 'c', 'd', 'e', 'f'].slice(0, niveles));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function lanzar(e, stdin, cwdProceso) {
  const r = correr(HOOK, [], { stdin, env: e.env, cwd: cwdProceso || e.proyecto });
  const salida = r.json();
  const ctx = salida && salida.hookSpecificOutput ? salida.hookSpecificOutput.additionalContext : undefined;
  return { r, salida, ctx };
}

const escribirMapa = (e, contenido, rel = path.join('tasks', 'context-map.md'), base = e.proyecto) => e.escribir(path.join(base, rel), contenido);

// ── formato de salida ─────────────────────────────────────────────────────────────────

test('SessionStart: JSON con la marca como primer texto, aun sin reglas ni mapa', () => {
  const e = casa(SIN_REGLAS);
  try {
    const cwd = bajar(e, 5);
    const { r, salida, ctx } = lanzar(e, { cwd, hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' }, cwd);
    assert.equal(r.status, 0);
    assert.ok(salida, `stdout debe ser JSON: ${r.stdout}`);
    assert.deepEqual(Object.keys(salida), ['hookSpecificOutput']);
    assert.equal(salida.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(ctx.startsWith(`${MARCA}\n`), 'la marca es lo primero');
    assert.equal(ctx, `${MARCA}\n${SIN_MAPA_ES}`);
  } finally { e.limpiar(); }
});

// ── reglas ────────────────────────────────────────────────────────────────────────────

test('reglas: por defecto se inyectan tal cual, entre la marca y el mapa, en no más de 900 caracteres', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    assert.ok(REGLAS_ES.length <= 900, `reglas ES: ${REGLAS_ES.length}`);
    assert.ok(REGLAS_EN.length <= 900, `reglas EN: ${REGLAS_EN.length}`);
    const cwd = bajar(e, 5);
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${REGLAS_ES}\n\n${SIN_MAPA_ES}`);

    escribirMapa(e, '# Mapa\n- punto', undefined, cwd);
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${REGLAS_ES}\n\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n# Mapa\n- punto`);
  } finally { e.limpiar(); }
});

test('reglas: reglas.inyectar=false las omite y el mapa sigue', () => {
  const e = casa(SIN_REGLAS);
  try {
    escribirMapa(e, '# Mapa\n- punto');
    const { ctx } = lanzar(e, { cwd: e.proyecto });
    assert.ok(!ctx.includes('MÉTODO UAEH'));
    assert.equal(ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n# Mapa\n- punto`);
  } finally { e.limpiar(); }
});

test('reglas: si el CLAUDE.md del proyecto (o de un ancestro) trae el bloque UAEH, no se duplican', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    const cwd = bajar(e, 3);
    const pidiendo = () => lanzar(e, { cwd }, cwd).ctx;
    assert.ok(pidiendo().includes('MÉTODO UAEH'), 'control: sin bloque se inyectan');

    // CLAUDE.md de un ancestro del cwd (la raíz del proyecto, 3 carpetas más arriba).
    e.escribir(path.join(e.proyecto, 'CLAUDE.md'), `# Mi proyecto\n${BLOQUE}`);
    assert.ok(!pidiendo().includes('MÉTODO UAEH'), 'bloque en un ancestro: ya se carga solo');
    assert.equal(pidiendo(), `${MARCA}\n${SIN_MAPA_ES}`);

    fs.rmSync(path.join(e.proyecto, 'CLAUDE.md'));
    e.escribir(path.join(cwd, 'CLAUDE.md'), BLOQUE);
    assert.ok(!pidiendo().includes('MÉTODO UAEH'), 'bloque en el CLAUDE.md del propio cwd');

    e.escribir(path.join(cwd, 'CLAUDE.md'), '# Sin bloque\nSolo notas.\n');
    assert.ok(pidiendo().includes('MÉTODO UAEH'), 'un CLAUDE.md sin bloque no cuenta');
    e.escribir(path.join(cwd, 'CLAUDE.md'), '<!-- UAEH:BEGIN v0.1.0 -->\nsin cierre\n');
    assert.ok(pidiendo().includes('MÉTODO UAEH'), 'un bloque sin cierre no cuenta');
  } finally { e.limpiar(); }
});

test('reglas: si el CLAUDE.md global trae el bloque UAEH, no se duplican', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa();
  try {
    const cwd = bajar(e, 5);
    const pidiendo = () => lanzar(e, { cwd }, cwd).ctx;
    assert.ok(pidiendo().includes('MÉTODO UAEH'), 'control: sin bloque se inyectan');
    e.escribir(path.join(e.claudeHome, 'CLAUDE.md'), `# Global\n${BLOQUE}`);
    assert.equal(pidiendo(), `${MARCA}\n${SIN_MAPA_ES}`);
  } finally { e.limpiar(); }
});

test('reglas: una configuración corrupta no las apaga (valores por defecto)', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa('{ esto no es json');
  try {
    const cwd = bajar(e, 5);
    const { r, ctx } = lanzar(e, { cwd }, cwd);
    assert.equal(r.status, 0);
    assert.equal(ctx, `${MARCA}\n${REGLAS_ES}\n\n${SIN_MAPA_ES}`);
  } finally { e.limpiar(); }
});

// ── mapa ──────────────────────────────────────────────────────────────────────────────

test('mapa: tasks/context-map.md va con su encabezado y la ruta relativa; tasks/ gana a context-map.md suelto', () => {
  const e = casa(SIN_REGLAS);
  try {
    const mapa = '# Mapa\n- Qué leer: README\n- Trampas: ninguna';
    escribirMapa(e, `${mapa}\n\n`);
    assert.equal(lanzar(e, { cwd: e.proyecto }).ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n${mapa}`);

    escribirMapa(e, '# Mapa de la raíz', 'context-map.md');
    assert.ok(lanzar(e, { cwd: e.proyecto }).ctx.endsWith(mapa), 'en la misma carpeta gana tasks/context-map.md');

    fs.rmSync(path.join(e.proyecto, 'tasks', 'context-map.md'));
    assert.equal(lanzar(e, { cwd: e.proyecto }).ctx, `${MARCA}\n${ENCABEZADO_ES('context-map.md')}\n\n# Mapa de la raíz`);
  } finally { e.limpiar(); }
});

test('mapa: se encuentra en carpetas superiores (cwd 2 niveles abajo) hasta 4 carpetas arriba; a 5 ya no', () => {
  const e = casa(SIN_REGLAS);
  try {
    escribirMapa(e, '# Mapa del proyecto');
    const dos = bajar(e, 2);
    assert.equal(lanzar(e, { cwd: dos }, dos).ctx, `${MARCA}\n${ENCABEZADO_ES('../../tasks/context-map.md')}\n\n# Mapa del proyecto`);

    const cuatro = bajar(e, 4);
    assert.ok(lanzar(e, { cwd: cuatro }, cuatro).ctx.includes(ENCABEZADO_ES('../../../../tasks/context-map.md')), 'el cwd y 4 ancestros se revisan');

    const cinco = bajar(e, 5);
    assert.equal(lanzar(e, { cwd: cinco }, cinco).ctx, `${MARCA}\n${SIN_MAPA_ES}`, 'a 5 carpetas ya no se sube');
  } finally { e.limpiar(); }
});

test('mapa: un mapa con BOM no deja el BOM en lo inyectado', () => {
  const e = casa(SIN_REGLAS);
  try {
    escribirMapa(e, '\uFEFF# Mapa con BOM\n- punto\n');
    const { ctx } = lanzar(e, { cwd: e.proyecto });
    assert.ok(!ctx.includes('\uFEFF'));
    assert.equal(ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n# Mapa con BOM\n- punto`);
  } finally { e.limpiar(); }
});

test('mapa: uno de 20,000 caracteres se trunca a 7,500 más el aviso; 7,500 exactos pasan enteros', () => {
  const e = casa(SIN_REGLAS);
  try {
    const grande = `# Mapa grande\n${'x'.repeat(20000)}`.slice(0, 20000);
    assert.equal(grande.length, 20000);
    escribirMapa(e, grande);
    const { ctx } = lanzar(e, { cwd: e.proyecto });
    assert.equal(ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n${grande.slice(0, MAX_MAPA)}${TRUNCADO_ES}`);

    escribirMapa(e, 'm'.repeat(MAX_MAPA));
    assert.equal(lanzar(e, { cwd: e.proyecto }).ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n${'m'.repeat(MAX_MAPA)}`, '7,500 exactos: sin aviso');
    escribirMapa(e, 'm'.repeat(MAX_MAPA + 1));
    assert.equal(lanzar(e, { cwd: e.proyecto }).ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n${'m'.repeat(MAX_MAPA)}${TRUNCADO_ES}`, '7,501: se recorta');
  } finally { e.limpiar(); }
});

test('mapa: al truncar no se parte un emoji por la mitad (JSON siempre válido y sin sustitutos sueltos)', () => {
  const e = casa(SIN_REGLAS);
  try {
    escribirMapa(e, `${'a'.repeat(MAX_MAPA - 1)}😀${'b'.repeat(100)}`);
    const { ctx } = lanzar(e, { cwd: e.proyecto });
    assert.ok(ctx.endsWith(`${'a'.repeat(MAX_MAPA - 1)}${TRUNCADO_ES}`), 'se corta antes del emoji');
    assert.doesNotMatch(ctx, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'sin mitades de par sustituto');
  } finally { e.limpiar(); }
});

test('mapa: sin mapa (o uno vacío) → la línea que sugiere /uaeh-kit:setup proyecto', () => {
  const e = casa(SIN_REGLAS);
  try {
    const cwd = bajar(e, 5);
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${SIN_MAPA_ES}`);
    assert.ok(SIN_MAPA_ES.includes('/uaeh-kit:setup proyecto'));

    escribirMapa(e, '  \n\n', undefined, cwd);
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${SIN_MAPA_ES}`, 'un mapa en blanco equivale a no tener mapa');

    fs.rmSync(path.join(cwd, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'tasks', 'context-map.md'), { recursive: true }); // una carpeta con ese nombre no es un mapa
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${SIN_MAPA_ES}`);

    escribirMapa(e, '# Mapa real', 'context-map.md', cwd); // y tampoco tapa al mapa real que haya al lado
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${ENCABEZADO_ES('context-map.md')}\n\n# Mapa real`);
  } finally { e.limpiar(); }
});

// ── idioma ────────────────────────────────────────────────────────────────────────────

test('idioma en: reglas y línea de «sin mapa» salen en inglés', (t) => {
  if (!exigirAncestrosLimpios(t)) return;
  const e = casa({ idioma: 'en' });
  try {
    const cwd = bajar(e, 5);
    assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${REGLAS_EN}\n\n${SIN_MAPA_EN}`);
  } finally { e.limpiar(); }
});

test('idioma en: encabezado del mapa y aviso de truncado salen en inglés', () => {
  const e = casa({ idioma: 'en', ...SIN_REGLAS });
  try {
    escribirMapa(e, '# Map\n- point');
    assert.equal(lanzar(e, { cwd: e.proyecto }).ctx, `${MARCA}\n${ENCABEZADO_EN('tasks/context-map.md')}\n\n# Map\n- point`);
    escribirMapa(e, 'm'.repeat(MAX_MAPA + 10));
    assert.equal(lanzar(e, { cwd: e.proyecto }).ctx, `${MARCA}\n${ENCABEZADO_EN('tasks/context-map.md')}\n\n${'m'.repeat(MAX_MAPA)}${TRUNCADO_EN}`);
  } finally { e.limpiar(); }
});

test('idioma auto o no reconocido → español', () => {
  for (const idioma of ['auto', 'fr', 'es']) {
    const e = casa({ idioma, ...SIN_REGLAS });
    try {
      const cwd = bajar(e, 5);
      assert.equal(lanzar(e, { cwd }, cwd).ctx, `${MARCA}\n${SIN_MAPA_ES}`, `idioma ${idioma}`);
    } finally { e.limpiar(); }
  }
});

// ── de dónde sale el cwd ──────────────────────────────────────────────────────────────

test('cwd: si no viene `cwd` se toma workspace.current_dir; `cwd` gana cuando vienen los dos', () => {
  const e = casa(SIN_REGLAS);
  try {
    const aislado = bajar(e, 5);
    const a = path.join(e.dir, 'proyecto-a');
    const b = path.join(e.dir, 'proyecto-b');
    escribirMapa(e, '# Mapa A', undefined, a);
    escribirMapa(e, '# Mapa B', undefined, b);

    assert.equal(lanzar(e, { workspace: { current_dir: b } }, aislado).ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n# Mapa B`);
    assert.equal(lanzar(e, { cwd: a, workspace: { current_dir: b } }, aislado).ctx, `${MARCA}\n${ENCABEZADO_ES('tasks/context-map.md')}\n\n# Mapa A`);
    assert.ok(lanzar(e, { cwd: '', workspace: { current_dir: b } }, aislado).ctx.endsWith('# Mapa B'), 'un cwd vacío no cuenta');
    assert.equal(lanzar(e, {}, aislado).ctx, `${MARCA}\n${SIN_MAPA_ES}`, 'sin nada, el cwd del proceso');
  } finally { e.limpiar(); }
});

// ── robustez: nunca rompe la sesión ───────────────────────────────────────────────────

test('stdin vacío, basura o con forma rara → igual sale JSON válido con la marca y salida 0', () => {
  const e = casa(SIN_REGLAS);
  try {
    const cwd = bajar(e, 5);
    const entradas = ['', '   ', 'esto no es json {', 'null', '42', '"texto"', '[1,2,3]', '{"cwd": 123}', '{"workspace": {"current_dir": 5}}', { cwd: path.join(e.dir, 'no-existe') }];
    for (const stdin of entradas) {
      const { r, salida, ctx } = lanzar(e, stdin, cwd);
      const etiqueta = JSON.stringify(stdin);
      assert.equal(r.status, 0, `stdin ${etiqueta}`);
      assert.ok(salida, `stdout debe ser JSON con stdin ${etiqueta}: ${r.stdout}`);
      assert.equal(salida.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(ctx.startsWith(MARCA), `stdin ${etiqueta}`);
    }
    assert.equal(lanzar(e, '', cwd).ctx, `${MARCA}\n${SIN_MAPA_ES}`, 'sin entrada usa el cwd del proceso');
  } finally { e.limpiar(); }
});

test('si falta la biblioteca común (plugin dañado) calla y sale con 0', () => {
  const e = casa();
  try {
    const roto = path.join(e.dir, 'plugin-roto', 'hooks', 'inyectar-contexto.js');
    fs.mkdirSync(path.dirname(roto), { recursive: true });
    fs.copyFileSync(HOOK, roto);
    const r = correr(roto, [], { stdin: { cwd: e.proyecto }, env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { e.limpiar(); }
});

test('el hook no usa rutas sueltas del usuario: la casa sale de comun.cjs', () => {
  const fuente = fs.readFileSync(HOOK, 'utf8');
  assert.match(fuente, /comun\.cjs/);
  assert.doesNotMatch(fuente, /homedir/);
});
