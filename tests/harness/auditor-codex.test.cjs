// Pruebas de plugins/uaeh-harness/skills/uae-security/scripts/auditor-codex.cjs — Codex como auditor de solo lectura.
//
// Sin Codex real: la línea de comando, el parche, la plantilla y la validación se prueban en el proceso; la ejecución
// completa (stdin, salida, resumen, tope de tiempo que mata el árbol de procesos) usa un «codex» falso vía CODEX_JS.
// La configuración es la de una casa temporal (los modelos por defecto o los que escribe cada prueba).
// La lógica de --probar-sandbox (testigo, reintento, fallo duro al escribir) se prueba con un codex falso; el sandbox
// real se mide aparte: node auditor-codex.cjs --probar-sandbox o doctor-puertas --puerta codex --vivo (SANDBOX_OK).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal } = require('../helpers/entorno.cjs');

const SKILL = path.join(RAIZ_HARNESS, 'skills', 'uae-security');
const SCRIPT = path.join(SKILL, 'scripts', 'auditor-codex.cjs');
const A = require(SCRIPT);
const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
const WIN = process.platform === 'win32';

const E = entornoTemporal('uaeh-auditor-codex-');
process.on('exit', () => E.limpiar());
const BASE = configLib.cargarConfig({ env: E.env }).config; // sin uaeh.config.json → modelos de fábrica
// Las auditorías de estas pruebas corren con consentimiento (codex.habilitado=true); el caso sin él tiene su prueba.
const CONFIG = { ...BASE, codex: { ...BASE.codex, habilitado: true } };

let n = 0;
const tmp = () => { const d = path.join(E.dir, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: E.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const silencio = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

// «codex» falso: un .js que CODEX_JS señala. Se restaura la variable al terminar.
async function conCodexFalso(cuerpo, fn) {
  const archivo = path.join(tmp(), 'codex-falso.js');
  fs.writeFileSync(archivo, cuerpo);
  const antes = process.env.CODEX_JS;
  process.env.CODEX_JS = archivo;
  try { return await fn(archivo); } finally { if (antes === undefined) delete process.env.CODEX_JS; else process.env.CODEX_JS = antes; }
}
// Guarda argv y stdin en <cwd>/llamada.json y escribe una salida válida donde diga -o.
const CODEX_QUE_RESPONDE = `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2); let entrada = '';
process.stdin.on('data', (d) => { entrada += d; }).on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), 'llamada.json'), JSON.stringify({ a, entrada }));
  fs.writeFileSync(a[a.indexOf('-o') + 1], JSON.stringify({ hallazgos: [], cobertura: [], limites: '' }));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }) + '\\n');
});`;

// ── Argumentos y niveles ──────────────────────────────────────────────────────────────

test('parseArgs · completa con valores por defecto (nivel equilibrado; sin --timeout-min el tope lo pone la configuración)', () => {
  const o = A.parseArgs(['run1', 'completa']);
  assert.equal(o.modo, 'completa');
  assert.equal(o.modelo, 'equilibrado');
  assert.equal(o.timeoutMin, null);
});

test('parseArgs · niveles y alias heredados (astra = profundo, sol = equilibrado), amenazas y tope', () => {
  const o = A.parseArgs(['run1', 'completa', '--modelo', 'astra', '--amenazas', 'a.md', '--timeout-min', '5']);
  assert.equal(o.modelo, 'profundo');
  assert.equal(o.amenazas, 'a.md');
  assert.equal(o.timeoutMin, 5);
  assert.equal(A.parseArgs(['r', 'completa', '--modelo', 'sol']).modelo, 'equilibrado');
  for (const nivel of A.NIVELES) assert.equal(A.parseArgs(['r', 'completa', '--modelo', nivel]).modelo, nivel);
});

test('parseArgs · rechaza modos, modelos y opciones inválidas', () => {
  assert.throws(() => A.parseArgs(['run1', 'rapida']), /modo invalido/);
  for (const malo of ['gpt-6.1-sol', 'luna', 'constructor', '__proto__', 'Profundo']) {
    assert.throws(() => A.parseArgs(['run1', 'completa', '--modelo', malo]), /modelo invalido/, malo);
  }
  assert.throws(() => A.parseArgs(['run1', 'completa', '--raro']), /desconocida/);
  assert.throws(() => A.parseArgs(['run1', 'completa', '--timeout-min', '0']), /positivo/);
  assert.throws(() => A.parseArgs(['run1']), /uso/);
  assert.throws(() => A.parseArgs(['run1', 'diff', '--base', 'abc']), /--repo/);
  assert.throws(() => A.parseArgs(['run1', 'diff', '--repo', '.']), /--base/);
  assert.throws(() => A.parseArgs(['run1', 'diff', '--repo', '.', '--base', '--evil']), /requiere un valor/);
  assert.throws(() => A.parseArgs(['--probar-sandbox', 'x']), /no admite/);
});

test('parseArgs · diff completo', () => {
  const o = A.parseArgs(['run1', 'diff', '--repo', 'r', '--base', 'abc123']);
  assert.equal(o.modo, 'diff');
  assert.equal(o.base, 'abc123');
  assert.equal(o.repo, path.resolve('r'));
});

// ── Línea de comando ──────────────────────────────────────────────────────────────────

test('línea de comando · solo lectura, efímera, prompt por stdin y sin modos peligrosos, en los tres niveles', () => {
  for (const modelo of [...A.NIVELES, 'astra', 'sol']) {
    const args = A.construirArgs({ modelo, fuente: 'F', schema: 'S', salida: 'O', config: CONFIG });
    const linea = args.join(' ');
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--ephemeral'));
    assert.equal(args[args.indexOf('-s') + 1], 'read-only');
    assert.equal(args[args.length - 1], '-');
    for (const mala of ['danger-full-access', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox', 'review --uncommitted']) {
      assert.ok(!linea.includes(mala), `no debe contener ${mala}`);
    }
  }
  const linea = (modelo) => A.construirArgs({ modelo, fuente: 'F', schema: 'S', salida: 'O', config: CONFIG }).join(' ');
  assert.ok(linea('profundo').includes('-m gpt-6-astra') && linea('profundo').includes('model_reasoning_effort="high"'));
  assert.ok(linea('equilibrado').includes('-m gpt-6-sol') && linea('equilibrado').includes('model_reasoning_effort="medium"'));
  assert.ok(linea('rapido').includes('-m gpt-6-luna'));
  assert.throws(() => A.construirArgs({ modelo: 'otro', fuente: 'F', schema: 'S', salida: 'O', config: CONFIG }), /modelo invalido/);
});

test('modelos · salen de codex.modelos de uaeh.config.json (los del usuario pisan los de fábrica)', () => {
  const e = entornoTemporal('uaeh-auditor-codex-cfg-');
  try {
    e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ codex: { modelos: { profundo: { modelo: 'modelo-de-prueba', esfuerzo: 'xhigh' } } } }));
    const config = configLib.cargarConfig({ env: e.env }).config;
    const linea = A.construirArgs({ modelo: 'astra', fuente: 'F', schema: 'S', salida: 'O', config }).join(' ');
    assert.ok(linea.includes('-m modelo-de-prueba'), linea);
    assert.ok(linea.includes('model_reasoning_effort="xhigh"'), linea);
    assert.ok(A.construirArgs({ modelo: 'sol', fuente: 'F', schema: 'S', salida: 'O', config }).join(' ').includes('-m gpt-6-sol'));
  } finally { e.limpiar(); }
});

test('sandbox · windows.sandbox="elevated" solo en Windows; en Linux, -s read-only sin extras', () => {
  assert.deepEqual(A.sandboxArgs('win32'), ['-c', 'windows.sandbox="elevated"']);
  assert.deepEqual(A.sandboxArgs('linux'), []);
  assert.deepEqual(A.SANDBOX_ARGS, A.sandboxArgs(process.platform));
  const linea = A.construirArgs({ modelo: 'equilibrado', fuente: 'F', schema: 'S', salida: 'O', config: CONFIG }).join(' ');
  assert.equal(linea.includes('windows.sandbox="elevated"'), WIN);
  assert.equal(A.variantesSandbox('linux').length, 1);
  assert.deepEqual(A.variantesSandbox('win32').map((v) => v.extra), [[], ['-c', 'windows.sandbox="elevated"']]);
});

// ── Plantilla, parche y salida ────────────────────────────────────────────────────────

test('plantilla · sustituye los 4 marcadores (completa)', () => {
  const t = 'A={{ALCANCE}}|M={{AMENAZAS}}|P={{PARCHE}}|F={{FUENTE}}';
  const r = A.rellenarPlantilla(t, { modo: 'completa', amenazas: null, parche: null, fuente: 'X:/x/fuente' });
  assert.equal(r, 'A=todo el repositorio|M=no disponible|P=no aplica|F=X:/x/fuente');
});

test('plantilla · diff, con amenazas y parche, sin interpretar $&', () => {
  const r = A.rellenarPlantilla('{{ALCANCE}}|{{AMENAZAS}}|{{PARCHE}}', { modo: 'diff', amenazas: 'riesgo $& alto', parche: 'X:/p.patch', fuente: 'f' });
  assert.equal(r, 'solo los cambios del parche, con el contexto necesario|riesgo $& alto|X:/p.patch');
});

test('plantillas del plugin · español e inglés con los 4 marcadores y la orden de solo lectura', () => {
  for (const [archivo, solo] of [['prompt-codex.md', /SOLO LECTURA/], ['prompt-codex.en.md', /READ-ONLY/]]) {
    const t = fs.readFileSync(path.join(SKILL, 'referencias', archivo), 'utf8');
    for (const m of ['{{FUENTE}}', '{{ALCANCE}}', '{{PARCHE}}', '{{AMENAZAS}}']) assert.ok(t.includes(m), `${archivo}: ${m}`);
    assert.match(t, solo, archivo);
  }
});

test('parche · incluye rastreados y nuevos no rastreados; excluye .env y respeta .gitignore', () => {
  const repo = tmp();
  sh(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), 'uno\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignorado.txt\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'base');
  const base = sh(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.js'), 'uno\ndos-modificado\n');
  fs.writeFileSync(path.join(repo, 'nuevo.js'), 'contenido-nuevo-visible\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=valor-que-no-sale\n');
  fs.writeFileSync(path.join(repo, '.env.local'), 'SECRETO=otro\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'SECRETO=cambiame\n');
  fs.writeFileSync(path.join(repo, 'ignorado.txt'), 'no-debe-salir\n');
  const p = A.construirParche(repo, base);
  assert.match(p, /dos-modificado/);
  assert.match(p, /contenido-nuevo-visible/);
  assert.match(p, /cambiame/);
  assert.doesNotMatch(p, /valor-que-no-sale/);
  assert.doesNotMatch(p, /SECRETO=otro/);
  assert.doesNotMatch(p, /no-debe-salir/);
});

test('parche · un .env rastreado y modificado tampoco entra', () => {
  const repo = tmp();
  sh(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.env'), 'K=viejo\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'base');
  const base = sh(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, '.env'), 'K=nuevo-valor\n');
  assert.doesNotMatch(A.construirParche(repo, base), /nuevo-valor|viejo/);
});

test('validarSalida · ausente, inválido, sin arreglo y válido', () => {
  const f = path.join(tmp(), 'hallazgos.json');
  assert.match(A.validarSalida(f).motivo, /no existe/);
  fs.writeFileSync(f, '{no json');
  assert.match(A.validarSalida(f).motivo, /no es JSON valido/);
  fs.writeFileSync(f, JSON.stringify({ hallazgos: 'x' }));
  assert.match(A.validarSalida(f).motivo, /arreglo/);
  fs.writeFileSync(f, JSON.stringify({ hallazgos: [], cobertura: [], limites: '' }));
  assert.equal(A.validarSalida(f).ok, true);
});

// ── Ejecución con un codex falso ──────────────────────────────────────────────────────

test('auditar · sin consentimiento (codex.habilitado=false): NO_HABILITADO, código 3 y Codex nunca se lanza', async () => {
  const run = tmp();
  fs.mkdirSync(path.join(run, 'fuente'));
  await conCodexFalso(CODEX_QUE_RESPONDE, async () => {
    const opts = { ...A.parseArgs([run, 'completa']), config: BASE };
    assert.equal(BASE.codex.habilitado, false, 'el defecto debe ser apagado');
    assert.equal(await silencio(() => A.auditar(opts)), 3);
  });
  const r = JSON.parse(fs.readFileSync(path.join(run, 'codex', 'resumen.json'), 'utf8'));
  assert.equal(r.estado, 'NO_HABILITADO');
  assert.match(r.motivo, /consentimiento/);
  assert.ok(!fs.existsSync(path.join(run, 'codex', 'llamada.json')), 'Codex no debía ejecutarse');
  assert.ok(!fs.existsSync(path.join(run, 'codex', 'hallazgos.json')));
});

test('auditar · sin carpeta fuente: FALLÓ, código 2 y resumen.json escrito, sin llamar a Codex', async () => {
  const run = tmp();
  const opts = { ...A.parseArgs([run, 'completa']), config: CONFIG };
  const code = await silencio(() => A.auditar(opts));
  assert.equal(code, 2);
  const r = JSON.parse(fs.readFileSync(path.join(run, 'codex', 'resumen.json'), 'utf8'));
  assert.equal(r.estado, 'FALLÓ');
  assert.match(r.motivo, /no existe/);
});

test('auditar completa · Codex recibe solo lectura, el modelo del nivel y el prompt por stdin; resumen OK con uso de tokens', async () => {
  const run = tmp();
  fs.mkdirSync(path.join(run, 'fuente'));
  await conCodexFalso(CODEX_QUE_RESPONDE, async () => {
    const opts = { ...A.parseArgs([run, 'completa', '--modelo', 'astra']), config: CONFIG };
    assert.equal(await silencio(() => A.auditar(opts)), 0);
  });
  const llamada = JSON.parse(fs.readFileSync(path.join(run, 'codex', 'llamada.json'), 'utf8'));
  assert.equal(llamada.a[llamada.a.indexOf('-s') + 1], 'read-only');
  assert.equal(llamada.a[llamada.a.indexOf('-m') + 1], 'gpt-6-astra');
  assert.equal(llamada.a[llamada.a.indexOf('-C') + 1], path.join(run, 'fuente'));
  assert.equal(llamada.a.includes('windows.sandbox="elevated"'), WIN);
  assert.match(llamada.entrada, /SOLO LECTURA/);
  assert.ok(llamada.entrada.includes(path.join(run, 'fuente')), 'el prompt nombra la copia limpia');
  const r = JSON.parse(fs.readFileSync(path.join(run, 'codex', 'resumen.json'), 'utf8'));
  assert.equal(r.estado, 'OK');
  assert.equal(r.nivel, 'profundo');
  assert.equal(r.modelo, 'gpt-6-astra');
  assert.equal(r.n_hallazgos, 0);
  assert.deepEqual(r.uso_tokens, { input_tokens: 5, output_tokens: 2 });
});

test('auditar diff · escribe cambios.patch sin .env y el prompt lo cita', async () => {
  const repo = tmp();
  sh(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'pagos.js'), 'cobrar()\n');
  sh(repo, 'add', '.'); sh(repo, 'commit', '-q', '-m', 'base');
  const base = sh(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'pagos.js'), 'cobrar(montoDelCliente)\n');
  fs.writeFileSync(path.join(repo, '.env'), 'CLAVE=valor-que-no-sale\n');
  const run = tmp();
  fs.mkdirSync(path.join(run, 'fuente'));
  await conCodexFalso(CODEX_QUE_RESPONDE, async () => {
    const opts = { ...A.parseArgs([run, 'diff', '--repo', repo, '--base', base]), config: CONFIG };
    assert.equal(await silencio(() => A.auditar(opts)), 0);
  });
  const parche = fs.readFileSync(path.join(run, 'codex', 'cambios.patch'), 'utf8');
  assert.match(parche, /montoDelCliente/);
  assert.doesNotMatch(parche, /valor-que-no-sale/);
  const llamada = JSON.parse(fs.readFileSync(path.join(run, 'codex', 'llamada.json'), 'utf8'));
  assert.ok(llamada.entrada.includes(path.join(run, 'codex', 'cambios.patch')));
  assert.match(llamada.entrada, /solo los cambios del parche/);
});

test('auditar · al vencer el tope mata a Codex Y a sus hijos (árbol de procesos), FALLÓ con motivo', { timeout: 60000 }, async () => {
  const run = tmp();
  fs.mkdirSync(path.join(run, 'fuente'));
  const pidNieto = path.join(run, 'nieto.pid');
  const cuelga = `
const { spawn } = require('child_process'); const fs = require('fs');
const nieto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidNieto)}, String(nieto.pid));
setInterval(() => {}, 1000);`;
  const inicio = Date.now();
  await conCodexFalso(cuelga, async () => {
    const opts = { ...A.parseArgs([run, 'completa', '--timeout-min', '0.03']), config: CONFIG }; // ≈ 1.8 s
    assert.equal(await silencio(() => A.auditar(opts)), 2);
  });
  assert.ok(Date.now() - inicio < 30000, 'no esperó a que Codex terminara solo');
  const r = JSON.parse(fs.readFileSync(path.join(run, 'codex', 'resumen.json'), 'utf8'));
  assert.match(r.motivo, /tiempo limite/);
  const pid = Number(fs.readFileSync(pidNieto, 'utf8'));
  const vivo = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const hasta = Date.now() + 10000;
  while (vivo() && Date.now() < hasta) await new Promise((res) => setTimeout(res, 200));
  const sigue = vivo();
  if (sigue) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
  assert.equal(sigue, false, 'el proceso nieto debe morir con el árbol');
});

test('auditar · Codex que sale con error o sin salida válida: FALLÓ con el motivo', async () => {
  const run = tmp();
  fs.mkdirSync(path.join(run, 'fuente'));
  await conCodexFalso("process.stdin.resume(); process.stdin.on('end', () => process.exit(3));", async () => {
    const opts = { ...A.parseArgs([run, 'completa']), config: CONFIG };
    assert.equal(await silencio(() => A.auditar(opts)), 2);
  });
  assert.match(JSON.parse(fs.readFileSync(path.join(run, 'codex', 'resumen.json'), 'utf8')).motivo, /hallazgos\.json no existe/);
});

// ── Localizar Codex ───────────────────────────────────────────────────────────────────

test('resolverCodex · CODEX_JS existente gana; inexistente no se devuelve', () => {
  const real = path.join(tmp(), 'codex.js');
  fs.writeFileSync(real, '');
  assert.equal(A.resolverCodex({ CODEX_JS: real, PATH: '' }).origen, real);
  const falso = path.join(os.tmpdir(), 'no-existe-uaeh-xyz.js');
  try { assert.notEqual(A.resolverCodex({ CODEX_JS: falso, PATH: '' }).origen, falso); } catch (e) { assert.match(e.message, /No se encontro Codex CLI/); }
});

test('resolverCodex · junto al shim del PATH (Windows: codex.cmd + node_modules; POSIX: enlace simbólico a bin/codex.js)', () => {
  const raiz = tmp();
  const rel = path.join('@openai', 'codex', 'bin', 'codex.js');
  if (WIN) {
    const bin = path.join(raiz, 'npm');
    fs.mkdirSync(path.join(bin, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'node_modules', rel), '');
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n');
    assert.equal(A.resolverCodex({ PATH: bin }).origen, path.join(bin, 'node_modules', rel));
  } else {
    const destino = path.join(raiz, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, '');
    const bin = path.join(raiz, 'otro-bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(destino, path.join(bin, 'codex'));
    assert.equal(A.resolverCodex({ PATH: bin }).origen, fs.realpathSync(destino));
  }
});

// ── Código y esquema ──────────────────────────────────────────────────────────────────

test('el código fuente no contiene modos peligrosos ni rutas de una máquina', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/['"]danger-full-access['"]/.test(src));
  assert.ok(!/['"]workspace-write['"]/.test(src));
  assert.ok(!/dangerously-bypass-approvals-and-sandbox/.test(src));
  assert.ok(!/['"]--uncommitted['"]/.test(src));
  assert.ok(!/taskkill/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'la muerte del árbol va por runner.matarArbol');
});

test('esquema de salida · toda propiedad requerida, additionalProperties false, sin palabras prohibidas', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(SKILL, 'referencias', 'codex-salida.schema.json'), 'utf8'));
  const visita = (nodo, ruta) => {
    if (!nodo || typeof nodo !== 'object') return;
    if (nodo.type === 'object') {
      assert.equal(nodo.additionalProperties, false, ruta);
      assert.deepEqual([...nodo.required].sort(), Object.keys(nodo.properties).sort(), ruta);
    }
    for (const k of ['minimum', 'maximum', 'pattern', 'format']) assert.ok(!(k in nodo), `${ruta} usa ${k}`);
    for (const [k, v] of Object.entries(nodo)) visita(v, `${ruta}/${k}`);
  };
  visita(schema, '#');
});

// ── Prueba de aislamiento (--probar-sandbox) con un codex falso ───────────────────────

test('analizarEventosSandbox · la lectura se reconoce por el testigo, aunque el comando termine con error', () => {
  const ev = (o) => JSON.stringify(o);
  const cmd = (salida, codigo) => ev({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: salida, exit_code: codigo } });
  const texto = [
    ev({ type: 'item.started', item: { type: 'command_execution', aggregated_output: 'T1' } }), // empezado: no cuenta
    'no es JSON',
    cmd('T1\r\nAcceso denegado', 1), // leer y escribir en un solo comando: la escritura negada da 1
    cmd('', null),
  ].join('\n');
  assert.deepEqual(A.analizarEventosSandbox(texto, 'T1'), { leyo: true, comandos: 2, codigos: [1, null] });
  assert.equal(A.analizarEventosSandbox(cmd('prueba', 0), 'T1').leyo, false, 'salida sin el testigo no prueba la lectura');
  assert.equal(A.analizarEventosSandbox(cmd('T1', 0), '').leyo, false, 'sin testigo no hay lectura que reconocer');
  assert.deepEqual(A.analizarEventosSandbox('', 'T1'), { leyo: false, comandos: 0, codigos: [] });
});

// Codex falso para --probar-sandbox: lee leeme.txt de la carpeta de -C, cuenta sus llamadas en `contador` y responde con
// eventos JSONL según `guion` (una función que recibe c = { n, elevado, leido, cmd(salida, código), escribir() }).
function codexSandbox(guion, contador) {
  return `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2); const dir = a[a.indexOf('-C') + 1];
let n = 1; try { n = Number(fs.readFileSync(${JSON.stringify(contador)}, 'utf8')) + 1; } catch { /* primera */ }
fs.writeFileSync(${JSON.stringify(contador)}, String(n));
process.stdin.resume().on('end', () => {
  const cmd = (salida, codigo) => process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
    command: 'x', aggregated_output: salida, exit_code: codigo, status: codigo === 0 ? 'completed' : 'failed' } }) + '\\n');
  (${guion.toString()})({ n, elevado: a.includes('windows.sandbox="elevated"'), leido: fs.readFileSync(path.join(dir, 'leeme.txt'), 'utf8'),
    cmd, escribir: () => fs.writeFileSync(path.join(dir, 'PRUEBA.txt'), 'hola') });
});`;
}
async function probarConGuion(guion, so = 'linux') {
  const contador = path.join(tmp(), 'llamadas.txt');
  const lineas = [];
  const log = console.log;
  console.log = (...x) => lineas.push(x.join(' '));
  let codigo;
  try { codigo = await conCodexFalso(codexSandbox(guion, contador), () => A.probarSandbox({ so, config: CONFIG })); } finally { console.log = log; }
  return { codigo, salida: lineas.join('\n'), llamadas: Number(fs.readFileSync(contador, 'utf8')) };
}

test('probarSandbox · lee en un comando y la escritura se niega en otro → SANDBOX_OK a la primera', async () => {
  const r = await probarConGuion((c) => { c.cmd(c.leido + '\r\n', 0); c.cmd('Acceso denegado', 1); });
  assert.equal(r.codigo, 0);
  assert.match(r.salida, /shell pudo LEER: si; 2 comando\(s\) de shell \(códigos 0, 1\)/);
  assert.match(r.salida, /^SANDBOX_OK$/m);
  assert.match(r.salida, /\(coincide\)/);
  assert.equal(r.llamadas, 1);
});

test('probarSandbox · leer y escribir en UN comando que termina con error sigue probando la lectura (regresión 5-nov)', async () => {
  const r = await probarConGuion((c) => { c.cmd(c.leido + '\r\nSet-Content : Acceso denegado', 1); });
  assert.equal(r.codigo, 0);
  assert.match(r.salida, /^SANDBOX_OK$/m);
});

test('probarSandbox · sin lectura visible la variante decisiva se repite UNA vez; al segundo intento concluye', async () => {
  const r = await probarConGuion((c) => { if (c.n > 1) { c.cmd(c.leido, 0); c.cmd('Acceso denegado', 1); } });
  assert.equal(r.codigo, 0);
  assert.equal(r.llamadas, 2);
  assert.match(r.salida, /0 comando\(s\) de shell; codigo 0\n.*\(intento 2\): .*shell pudo LEER: si/);
});

test('probarSandbox · un «prueba» inventado (sin el testigo) no cuenta como lectura: dos intentos y SANDBOX_FALLA', async () => {
  const r = await probarConGuion((c) => { c.cmd('prueba', 0); });
  assert.equal(r.codigo, 1);
  assert.equal(r.llamadas, 2);
  assert.match(r.salida, /^SANDBOX_FALLA$/m);
  assert.doesNotMatch(r.salida, /SANDBOX_OK/);
});

test('probarSandbox · si Codex logra ESCRIBIR es fallo inmediato: nunca se reintenta (aunque no se viera la lectura)', async () => {
  for (const guion of [(c) => { c.escribir(); c.cmd('', 0); }, (c) => { c.cmd(c.leido, 0); c.escribir(); c.cmd('', 0); }]) {
    const r = await probarConGuion(guion);
    assert.equal(r.codigo, 1);
    assert.equal(r.llamadas, 1, 'una escritura no se «arregla» repitiendo');
    assert.match(r.salida, /PRUEBA\.txt SE CREO/);
    assert.match(r.salida, /^SANDBOX_FALLA$/m);
  }
});

test('probarSandbox · Windows: la variante sin aislamiento (shell bloqueado) no se repite; la elevada da SANDBOX_OK', async () => {
  const r = await probarConGuion((c) => { if (c.elevado) { c.cmd(c.leido, 0); c.cmd('Acceso denegado', 1); } }, 'win32');
  assert.equal(r.codigo, 0);
  assert.equal(r.llamadas, 2, 'una corrida por variante');
  assert.match(r.salida, /Variante \[solo --ignore-user-config \+ -s read-only\]: .*LEER: NO/);
  assert.match(r.salida, /Variante \[-c windows\.sandbox="elevated"\]: .*LEER: si/);
  assert.match(r.salida, /\(coincide\)/);
});

test('auditar · el tope sale de la configuración según el modo y --timeout-min lo sustituye', async () => {
  const config = { ...CONFIG, codex: { ...CONFIG.codex, timeoutDiffMin: 7, timeoutCompletaMin: 33 } };
  const tope = async (extra) => {
    const run = tmp();
    fs.mkdirSync(path.join(run, 'fuente'));
    await conCodexFalso(CODEX_QUE_RESPONDE, async () => {
      assert.equal(await silencio(() => A.auditar({ ...A.parseArgs([run, 'completa', ...extra]), config })), 0);
    });
    return JSON.parse(fs.readFileSync(path.join(run, 'codex', 'resumen.json'), 'utf8')).tope_min;
  };
  assert.equal(await tope([]), 33);
  assert.equal(await tope(['--timeout-min', '5']), 5);
  const C = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
  assert.equal(C.topeCodexMin(config, 'diff'), 7);
});
