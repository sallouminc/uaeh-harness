// Pruebas de plugins/uaeh-harness/hooks/uaeh-guardia-cierre.js: anota los revisores y los commits de lista blanca y no deja
// cerrar la sesión sin registrar la tarea. Cada prueba usa su propia casa temporal (UAEH_HOME dentro de ella) y repos git
// temporales: nunca toca el estado real ni la configuración del usuario.
// Correr: node --test tests/harness/uaeh-guardia-cierre.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr, git, repoTemporal, escribir } = require('../helpers/entorno.cjs');

const GUARDIA = path.join(RAIZ_HARNESS, 'hooks', 'uaeh-guardia-cierre.js');
// Las rutas que el hook pone en sus mensajes: absolutas, con «/» y entre comillas dobles.
const RUTA_GUARDIA = GUARDIA.replace(/\\/g, '/');
const RUTA_REGISTRO = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-registro.cjs').replace(/\\/g, '/');
const SESION = 'prueba-sesion-0123456789abcdef';
const T0 = '2026-03-15T15:00:00.000Z';

function conEntorno(fn) {
  const e = entornoTemporal('uaeh-guardia-');
  try { return fn(e); } finally { e.limpiar(); }
}

// Corre el hook con una operación (revisor | commit | cierre | directo | descartar | ninguna) y su stdin.
//   extra.args  argumentos tras la operación · extra.env  variables que pisan el entorno (undefined = quitar)
//   extra.sesionEnv  CLAUDE_CODE_SESSION_ID · extra.script  otra copia del hook
function ejecutar(e, op, stdin, extra = {}) {
  const env = { ...e.env, UAEH_AHORA: T0, ...(extra.env || {}) };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (extra.sesionEnv) env.CLAUDE_CODE_SESSION_ID = extra.sesionEnv;
  const args = [...(op === undefined ? [] : [op]), ...(extra.args || [])];
  let r = null;
  for (let intento = 1; intento <= 3; intento++) {
    r = correr(extra.script || GUARDIA, args, { stdin, env, cwd: e.proyecto });
    // El hook solo sale con 0 (o con 1 si la línea de comandos de directo/descartar está mal usada). Otro código, una señal
    // o un error al arrancar son fallos del entorno (carga, antivirus), no una decisión del hook: se reintenta.
    if (!r.error && (r.status === 0 || r.status === 1)) return r;
  }
  return r;
}

function rutaEstado(e, sesion = SESION) {
  return path.join(e.uaehHome, 'sesiones', `${sesion}.json`);
}
function estado(e) {
  return fs.existsSync(rutaEstado(e)) ? JSON.parse(fs.readFileSync(rutaEstado(e), 'utf8')) : null;
}
function salidaJson(r) {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

const revisorStdin = (agente, id) => ({ session_id: SESION, hook_event_name: 'SubagentStop', agent_type: agente, agent_id: id || 'a1', stop_hook_active: false });
const cierreStdin = (activo) => ({ session_id: SESION, hook_event_name: 'Stop', stop_hook_active: !!activo });
const commitStdin = (command, cwd) => ({ session_id: SESION, hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });

// Deja un archivo preparado (git add) en un repo nuevo de la casa `e` y devuelve la ruta del repo.
function repoConArchivo(e, rel) {
  const repo = repoTemporal(e);
  escribir(path.join(repo, rel), 'x\n');
  git(repo, ['add', '.'], e.env);
  return repo;
}

// Banco de pruebas de la lista blanca: una casa nueva con `rel` ya preparado (git add) y `fn(commitCon)`, donde
// commitCon(config) corre el hook de commit con esa configuración (objeto, texto o null = sin archivo) sobre un estado
// limpio y devuelve { salida, estado }.
function bancoDeCommit(rel, fn) {
  return conEntorno((e) => {
    const repo = repoConArchivo(e, rel);
    const archivoConfig = path.join(e.uaehHome, 'uaeh.config.json');
    return fn((config) => {
      fs.rmSync(path.join(e.uaehHome, 'sesiones'), { recursive: true, force: true });
      fs.rmSync(archivoConfig, { force: true });
      if (config != null) escribir(archivoConfig, typeof config === 'string' ? config : JSON.stringify(config));
      const r = ejecutar(e, 'commit', commitStdin('git commit -m "prueba"', repo));
      return { salida: salidaJson(r), estado: estado(e) };
    });
  });
}

// ── Las 19 pruebas del hook original ──────────────────────────────────────────────────

test('revisor anota el agente en el estado de la sesión', () => conEntorno((e) => {
  assert.equal(ejecutar(e, 'revisor', revisorStdin('uae-verifier')).status, 0);
  assert.equal(ejecutar(e, 'revisor', revisorStdin('uae-security', 'a2')).status, 0);
  assert.equal(ejecutar(e, 'revisor', revisorStdin('Explore', 'a3')).status, 0, 'otro agente no truena');
  assert.deepEqual(estado(e).revisores.map((r) => r.agente), ['uae-verifier', 'uae-security']);
}));

test('cierre sin estado: silencio y exit 0', () => conEntorno((e) => {
  const r = ejecutar(e, 'cierre', cierreStdin());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
}));

test('cierre con revisores sin registro: bloquea UNA vez con el comando de registro, el id y la nota del sello', () => conEntorno((e) => {
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  const j = salidaJson(ejecutar(e, 'cierre', cierreStdin()));
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /uaeh-registro\.cjs/);
  assert.match(j.reason, new RegExp(SESION));
  assert.match(j.reason, /sello del orquestador/);
  assert.equal(ejecutar(e, 'cierre', cierreStdin()).stdout, '', 'la segunda vez calla');
}));

test('con stop_hook_active no bloquea aunque falte el registro', () => conEntorno((e) => {
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  const r = ejecutar(e, 'cierre', cierreStdin(true));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(!estado(e).avisos.registro, 'no gasta el aviso');
}));

test('si el registro tiene una línea posterior al primer revisor, cierra limpio y limpia el estado', () => conEntorno((e) => {
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  escribir(path.join(e.uaehHome, 'registro.jsonl'), JSON.stringify({ fecha: '2026-03-15T15:05:00.000Z', proyecto: 'demo', estado: 'PASS_TECHNICAL' }) + '\n');
  const r = ejecutar(e, 'cierre', cierreStdin());
  assert.equal(r.stdout, '');
  const st = estado(e);
  assert.equal(st.revisores.length, 0);
  assert.equal(st.cerrados[0].como, 'registro');
}));

test('una línea de registro ANTERIOR al revisor no cuenta', () => conEntorno((e) => {
  escribir(path.join(e.uaehHome, 'registro.jsonl'), JSON.stringify({ fecha: '2026-03-15T14:00:00.000Z', proyecto: 'demo' }) + '\n');
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  const j = salidaJson(ejecutar(e, 'cierre', cierreStdin()));
  assert.equal(j && j.decision, 'block');
}));

test('la nota del sello desaparece si consta un comparar del orquestador', () => conEntorno((e) => {
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  escribir(path.join(e.uaehHome, 'integridad', 'registro.jsonl'),
    JSON.stringify({ fecha: '2026-03-15T15:10:00.000Z', id: '20260315-x', repo: 'r', etiqueta: null, resultado: 'INTACTO', cambios: [] }) + '\n');
  const j = salidaJson(ejecutar(e, 'cierre', cierreStdin()));
  assert.equal(j.decision, 'block');
  assert.doesNotMatch(j.reason, /sello del orquestador/);
}));

test('commit con archivo de lista blanca ya preparado: avisa por additionalContext y anota', () => conEntorno((e) => {
  const repo = repoConArchivo(e, 'src/config/pricing.config.ts');
  const j = salidaJson(ejecutar(e, 'commit', commitStdin('git commit -m "precio nuevo"', repo)));
  assert.ok(j && j.hookSpecificOutput, 'debe devolver hookSpecificOutput');
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(j.hookSpecificOutput.additionalContext, /lista blanca/);
  assert.match(j.hookSpecificOutput.additionalContext, /pricing\.config\.ts/);
  assert.equal('permissionDecision' in j.hookSpecificOutput, false, 'nunca decide permisos');
  assert.equal(estado(e).listaBlanca[0].archivos[0].categoria, 'dinero');
}));

test('commit compuesto sin preparar (git add x && git commit) también se detecta', () => conEntorno((e) => {
  const repo = repoTemporal(e);
  escribir(path.join(repo, 'lib/auth/login.ts'), 'x\n');
  const j = salidaJson(ejecutar(e, 'commit', commitStdin('git add lib/auth/login.ts && git commit -m "login"', repo)));
  assert.ok(j && j.hookSpecificOutput);
  assert.match(j.hookSpecificOutput.additionalContext, /cuentas: lib\/auth\/login\.ts/);
}));

test('commit con cd previo y git add . detecta la carpeta correcta', () => conEntorno((e) => {
  const repo = repoTemporal(e);
  escribir(path.join(repo, 'supabase/migrations/001_tablas.sql'), 'x\n');
  const comando = `cd "${repo}" && git add . && git commit -m "migracion"`;
  const j = salidaJson(ejecutar(e, 'commit', commitStdin(comando, e.tmp)));
  assert.ok(j && j.hookSpecificOutput, 'debe detectar vía cd');
  assert.match(j.hookSpecificOutput.additionalContext, /base de datos/);
}));

test('commit sin lista blanca o con rutas excluidas: silencio y sin estado', () => conEntorno((e) => {
  const repo = repoTemporal(e);
  for (const rel of ['src/colores.ts', 'tasks/plan-precios.md', 'docs/auth-notas.md', 'src/tokens.css']) escribir(path.join(repo, rel), 'x\n');
  git(repo, ['add', '.'], e.env);
  const r = ejecutar(e, 'commit', commitStdin('git commit -m "colores"', repo));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(estado(e), null);
}));

test('comandos que no son commit o fuera de un repo: silencio', () => conEntorno((e) => {
  for (const c of ['git status', 'git log --oneline | grep commit', 'ls']) {
    const r = ejecutar(e, 'commit', commitStdin(c, e.tmp));
    assert.equal(r.status, 0, c);
    assert.equal(r.stdout, '', c);
  }
  const r = ejecutar(e, 'commit', commitStdin('git commit -m x', e.tmp));
  assert.equal(r.stdout, '');
}));

test('lista blanca sin revisores: bloquea una vez; directo con motivo deja huella y libera', () => conEntorno((e) => {
  const repo = repoConArchivo(e, 'api/pagos/cobro.php');
  ejecutar(e, 'commit', commitStdin('git commit -m "cobro"', repo));
  const j = salidaJson(ejecutar(e, 'cierre', cierreStdin()));
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /no corrió ningún revisor/);
  assert.match(j.reason, /directo --sesion/);
  assert.equal(ejecutar(e, 'cierre', cierreStdin()).stdout, '', 'segunda vez calla');
  const d = ejecutar(e, 'directo', undefined, { args: ['--sesion', SESION, 'es un script de prueba, no cobra'] });
  assert.equal(d.status, 0, d.stderr);
  const huellas = fs.readFileSync(path.join(e.uaehHome, 'excepciones.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(huellas[0].tipo, 'directo');
  assert.equal(huellas[0].archivos[0].archivo, 'api/pagos/cobro.php');
  assert.equal(estado(e).listaBlanca.length, 0);
}));

test('lista blanca con revisores que sí corrieron: no pide directo, pide registro', () => conEntorno((e) => {
  const repo = repoConArchivo(e, 'src/suscripciones.ts');
  ejecutar(e, 'commit', commitStdin('git commit -m "suscripciones"', repo));
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  const j = salidaJson(ejecutar(e, 'cierre', cierreStdin()));
  assert.match(j.reason, /NO está en el registro/);
  assert.doesNotMatch(j.reason, /no corrió ningún revisor/);
}));

test('descartar toma la sesión de CLAUDE_CODE_SESSION_ID, deja huella y el cierre calla', () => conEntorno((e) => {
  ejecutar(e, 'revisor', revisorStdin('uae-security'));
  const d = ejecutar(e, 'descartar', undefined, { args: ['re-verificación de la tarea ya registrada'], sesionEnv: SESION });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /Anotado \(descartar\)/);
  assert.equal(ejecutar(e, 'cierre', cierreStdin()).stdout, '');
  assert.equal(estado(e).cerrados[0].como, 'descartado');
}));

test('directo sin motivo o sin sesión: exit 1 con uso', () => conEntorno((e) => {
  const r = ejecutar(e, 'directo', undefined, { args: ['--sesion', SESION, 'no'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Uso:/);
  const r2 = ejecutar(e, 'directo', undefined, { args: ['motivo suficiente'] });
  assert.equal(r2.status, 1);
}));

test('interruptor apagado: nada se anota ni se bloquea', () => conEntorno((e) => {
  escribir(path.join(e.uaehHome, 'guardia-cierre.apagada'), '');
  ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  assert.equal(estado(e), null);
  assert.equal(ejecutar(e, 'cierre', cierreStdin()).stdout, '');
  assert.match(ejecutar(e, 'directo', undefined, { args: ['--sesion', SESION, 'motivo suficiente'] }).stdout, /guardia de cierre está apagada/);
}));

test('stdin ilegible o sin session_id: exit 0 y silencio', () => conEntorno((e) => {
  for (const op of ['revisor', 'commit', 'cierre']) {
    const r = ejecutar(e, op, 'esto no es json');
    assert.equal(r.status, 0, op);
    assert.equal(r.stdout, '', op);
    const r2 = ejecutar(e, op, { hook_event_name: 'x' });
    assert.equal(r2.status, 0, op);
    assert.equal(r2.stdout, '', op);
  }
  assert.equal(fs.existsSync(path.join(e.uaehHome, 'sesiones')), false);
}));

test('sin subcomando: uso y exit 1; subcomando desconocido: exit 0 (nunca rompe un hook)', () => conEntorno((e) => {
  assert.equal(ejecutar(e, undefined, '').status, 1);
  assert.equal(ejecutar(e, 'otra-cosa', '').status, 0);
}));

// ── Lista blanca configurable (uaeh.config.json → listaBlanca) ────────────────────────

test('lista blanca configurable · agregar patrones propios (listaBlanca.agregar) clasifica el commit; sin ellos no cuenta', () => bancoDeCommit('scripts/servidor_subir.sh', (commitCon) => {
  const sin = commitCon(null);
  assert.equal(sin.salida, null, 'de fábrica ese nombre no encaja con ningún patrón');
  assert.equal(sin.estado, null);
  const con = commitCon({ listaBlanca: { agregar: { produccion: ['servidor_'] } } });
  assert.match(con.salida.hookSpecificOutput.additionalContext, /producción: scripts\/servidor_subir\.sh/);
  assert.deepEqual(con.estado.listaBlanca[0].archivos, [{ archivo: 'scripts/servidor_subir.sh', categoria: 'producción' }]);
}));

test('lista blanca configurable · una categoría nueva en agregar se muestra con el nombre de su clave', () => bancoDeCommit('src/paciente.ts', (commitCon) => {
  assert.equal(commitCon(null).salida, null);
  const r = commitCon({ listaBlanca: { agregar: { salud: ['paciente'] } } });
  assert.match(r.salida.hookSpecificOutput.additionalContext, /salud: src\/paciente\.ts/);
  assert.equal(r.estado.listaBlanca[0].archivos[0].categoria, 'salud');
}));

test('lista blanca configurable · excluirRutas saca una carpeta propia de la cuenta', () => bancoDeCommit('privado/token.ts', (commitCon) => {
  assert.match(commitCon(null).salida.hookSpecificOutput.additionalContext, /cuentas: privado\/token\.ts/);
  const excluida = commitCon({ listaBlanca: { excluirRutas: ['privado'] } });
  assert.equal(excluida.salida, null);
  assert.equal(excluida.estado, null);
}));

test('lista blanca configurable · excluirExtensiones saca una extensión propia de la cuenta', () => bancoDeCommit('src/auth.ts', (commitCon) => {
  assert.match(commitCon(null).salida.hookSpecificOutput.additionalContext, /cuentas: src\/auth\.ts/);
  const excluida = commitCon({ listaBlanca: { excluirExtensiones: ['ts'] } });
  assert.equal(excluida.salida, null);
  assert.equal(excluida.estado, null);
}));

test('lista blanca configurable · categorias reemplaza los patrones de una categoría de fábrica', () => bancoDeCommit('src/pricing.ts', (commitCon) => {
  assert.match(commitCon(null).salida.hookSpecificOutput.additionalContext, /dinero: src\/pricing\.ts/);
  const reemplazada = commitCon({ listaBlanca: { categorias: { dinero: ['^nunca-coincide$'] } } });
  assert.equal(reemplazada.salida, null);
  assert.equal(reemplazada.estado, null);
}));

test('lista blanca configurable · una configuración rota no apaga la guarda: rige la lista de fábrica', () => bancoDeCommit('src/config/pricing.config.ts', (commitCon) => {
  for (const rota of ['{ esto no es json', '[]', '"texto"']) {
    const r = commitCon(rota);
    assert.match(r.salida.hookSpecificOutput.additionalContext, /dinero: src\/config\/pricing\.config\.ts/, rota);
  }
}));

test('lista blanca de fábrica · reconoce las cuatro categorías genéricas y solo esas', () => conEntorno((e) => {
  const repo = repoTemporal(e);
  const esperadas = {
    'src/billing/checkout.ts': 'dinero', 'src/auth/session.ts': 'cuentas',
    'db/migrations/001_users.sql': 'base de datos', '.github/workflows/release.yml': 'producción',
  };
  const ninguna = ['src/colores.ts', 'src/componentes/boton.tsx', 'README.md'];
  for (const rel of [...Object.keys(esperadas), ...ninguna]) escribir(path.join(repo, rel), 'x\n');
  git(repo, ['add', '.'], e.env);
  salidaJson(ejecutar(e, 'commit', commitStdin('git commit -m "todo junto"', repo)));
  const hallados = Object.fromEntries(estado(e).listaBlanca[0].archivos.map((a) => [a.archivo, a.categoria]));
  assert.deepEqual(hallados, esperadas);
}));

// ── Mensajes: rutas absolutas del propio plugin, hora en la zona configurada ──────────

test('los mensajes llevan la ruta ABSOLUTA del hook y de uaeh-registro.cjs, con «/» y entre comillas dobles', () => conEntorno((e) => {
  assert.ok(fs.existsSync(RUTA_REGISTRO), 'el script de registro al que apuntan los mensajes debe existir');
  const repo = repoConArchivo(e, 'src/config/pricing.config.ts');
  const aviso = salidaJson(ejecutar(e, 'commit', commitStdin('git commit -m "precio"', repo))).hookSpecificOutput.additionalContext;
  assert.ok(aviso.includes(`node "${RUTA_GUARDIA}" directo "motivo"`), aviso);

  // lista blanca sin ningún revisor
  const sinRevisores = salidaJson(ejecutar(e, 'cierre', cierreStdin())).reason;
  assert.ok(sinRevisores.includes(`node "${RUTA_GUARDIA}" directo --sesion ${SESION} "motivo"`), sinRevisores);

  // revisores sin registro (en otra casa para que el aviso de lista blanca no oculte este)
  conEntorno((e2) => {
    ejecutar(e2, 'revisor', revisorStdin('uae-verifier'));
    const sinRegistro = salidaJson(ejecutar(e2, 'cierre', cierreStdin())).reason;
    assert.ok(sinRegistro.includes(`node "${RUTA_REGISTRO}" --proyecto <carpeta>`), sinRegistro);
    assert.ok(sinRegistro.includes(`node "${RUTA_GUARDIA}" descartar --sesion ${SESION} "motivo"`), sinRegistro);
    for (const texto of [aviso, sinRevisores, sinRegistro]) {
      assert.ok(path.isAbsolute(RUTA_GUARDIA), 'la ruta del hook es absoluta');
      assert.doesNotMatch(texto, /node "[^"]*\\[^"]*"/, 'las rutas de los mensajes no llevan barras invertidas');
      assert.doesNotMatch(texto, /~\/|\.claude\/scripts|\.claude\/hooks/, 'ni rutas relativas a un perfil concreto');
    }
  });
}));

test('UAEH_AHORA fija las fechas del estado y de las huellas; la hora del mensaje sigue la zona (UAEH_TZ o zonaHoraria)', () => {
  conEntorno((e) => {
    ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
    const st = estado(e);
    assert.equal(st.creado, T0);
    assert.equal(st.revisores[0].fecha, T0);
    assert.match(salidaJson(ejecutar(e, 'cierre', cierreStdin())).reason, /el primero a las 15:00\)/, 'UAEH_TZ=UTC de la casa temporal');
    assert.equal(estado(e).avisos.registro, T0);
    const d = ejecutar(e, 'directo', undefined, { args: ['--sesion', SESION, 'es una prueba de fecha'] });
    assert.equal(d.status, 0, d.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(e.uaehHome, 'excepciones.jsonl'), 'utf8').trim()).fecha, T0);
  });
  conEntorno((e) => {
    const env = { UAEH_TZ: 'Asia/Kolkata' };
    ejecutar(e, 'revisor', revisorStdin('uae-verifier'), { env });
    assert.match(salidaJson(ejecutar(e, 'cierre', cierreStdin(), { env })).reason, /el primero a las 20:30\)/, 'UTC+05:30');
  });
  conEntorno((e) => {
    escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'Asia/Kolkata' }));
    const env = { UAEH_TZ: undefined };
    ejecutar(e, 'revisor', revisorStdin('uae-verifier'), { env });
    assert.match(salidaJson(ejecutar(e, 'cierre', cierreStdin(), { env })).reason, /el primero a las 20:30\)/, 'zonaHoraria de la configuración');
  });
});

// ── Más casos del flujo de commit y del estado ────────────────────────────────────────

test('git commit -am detecta los archivos rastreados que cambiaron sin prepararse', () => conEntorno((e) => {
  const repo = repoTemporal(e);
  escribir(path.join(repo, 'src/auth.ts'), 'uno\n');
  git(repo, ['add', '.'], e.env);
  git(repo, ['commit', '-q', '-m', 'base'], e.env);
  escribir(path.join(repo, 'src/auth.ts'), 'dos\n');
  const j = salidaJson(ejecutar(e, 'commit', commitStdin('git commit -am "cambio"', repo)));
  assert.match(j.hookSpecificOutput.additionalContext, /cuentas: src\/auth\.ts/);
}));

test('git -C <repo> commit detecta la carpeta del repo aunque el directorio de trabajo sea otro', () => conEntorno((e) => {
  const repo = repoConArchivo(e, 'src/payments/stripe.ts');
  const j = salidaJson(ejecutar(e, 'commit', commitStdin(`git -C "${repo}" commit -m "pago"`, e.tmp)));
  assert.match(j.hookSpecificOutput.additionalContext, /dinero: src\/payments\/stripe\.ts/);
}));

test('un commit con muchos archivos de lista blanca guarda 20 y resume «y N más»', () => conEntorno((e) => {
  const repo = repoTemporal(e);
  for (let i = 1; i <= 25; i++) escribir(path.join(repo, `src/precio_${i}.ts`), 'x\n');
  git(repo, ['add', '.'], e.env);
  const j = salidaJson(ejecutar(e, 'commit', commitStdin('git commit -m "precios"', repo)));
  assert.match(j.hookSpecificOutput.additionalContext, /y 21 más/);
  assert.equal(estado(e).listaBlanca[0].archivos.length, 20);
}));

test('el estado conserva a lo sumo 20 revisores y 20 commits (los más recientes)', () => conEntorno((e) => {
  const previo = { sesion: SESION, creado: T0, revisores: [], listaBlanca: [], cerrados: [], avisos: {}, excepciones: [] };
  for (let i = 1; i <= 25; i++) {
    previo.revisores.push({ agente: 'uae-verifier', agent_id: `viejo-${i}`, fecha: T0 });
    previo.listaBlanca.push({ fecha: T0, repo: 'r', archivos: [{ archivo: `src/pago_${i}.ts`, categoria: 'dinero' }] });
  }
  escribir(rutaEstado(e), JSON.stringify(previo));
  assert.equal(ejecutar(e, 'revisor', revisorStdin('uae-security', 'nuevo')).status, 0);
  let st = estado(e);
  assert.equal(st.revisores.length, 20);
  assert.equal(st.revisores[19].agent_id, 'nuevo');
  assert.equal(st.revisores[0].agent_id, 'viejo-7');
  const repo = repoConArchivo(e, 'src/config/pricing.config.ts');
  assert.equal(ejecutar(e, 'commit', commitStdin('git commit -m "precio"', repo)).status, 0);
  st = estado(e);
  assert.equal(st.listaBlanca.length, 20);
  assert.equal(st.listaBlanca[19].archivos[0].archivo, 'src/config/pricing.config.ts');
}));

test('un revisor con el prefijo del plugin (uaeh-harness:uae-verifier) cuenta como revisor', () => conEntorno((e) => {
  ejecutar(e, 'revisor', revisorStdin('uaeh-harness:uae-verifier'));
  ejecutar(e, 'revisor', revisorStdin('uaeh-harness:uae-builder', 'a2'));
  assert.deepEqual(estado(e).revisores.map((r) => r.agente), ['uae-verifier']);
}));

// ── A prueba de fallos ────────────────────────────────────────────────────────────────

// Todas las rutas de archivos bajo `dir` (relativas, con «/»).
function archivosBajo(dir) {
  const salida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const ruta = path.join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...archivosBajo(ruta).map((r) => `${entrada.name}/${r}`));
    else salida.push(entrada.name);
  }
  return salida;
}

test('un session_id inseguro (con rutas) no se usa para nombrar archivos y directo lo rechaza', () => conEntorno((e) => {
  const antes = archivosBajo(e.dir).sort();
  for (const malo of ['../../fuera-de-la-casa', '..\\..\\fuera-de-la-casa', 'a/b/c/d/e/f/g', 'con espacios 123456', 'corto']) {
    const r = ejecutar(e, 'revisor', { ...revisorStdin('uae-verifier'), session_id: malo });
    assert.equal(r.status, 0, malo);
    assert.equal(r.stdout, '', malo);
    const d = ejecutar(e, 'directo', undefined, { args: ['--sesion', malo, 'motivo suficiente'] });
    assert.equal(d.status, 1, malo);
    assert.match(d.stderr, /Uso:/, malo);
  }
  // Un nombre con «..» escribiría fuera de sesiones/ (p. ej. en la carpeta de Claude): no debe aparecer NINGÚN archivo nuevo.
  assert.deepEqual(archivosBajo(e.dir).sort(), antes);
  assert.equal(fs.existsSync(path.join(e.uaehHome, 'sesiones')), false);
}));

test('un fallo interno sale 0, calla y se anota en guardia-cierre.log', () => conEntorno((e) => {
  escribir(path.join(e.uaehHome, 'sesiones'), 'esto es un archivo, no una carpeta');
  const r = ejecutar(e, 'revisor', revisorStdin('uae-verifier'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const log = fs.readFileSync(path.join(e.uaehHome, 'guardia-cierre.log'), 'utf8');
  assert.match(log, /\d{4}-\d{2}-\d{2}T[\d:.]+Z revisor: /);
}));

test('sin las bibliotecas del plugin (copia suelta del hook) el hook sale 0 y calla en cada operación', () => conEntorno((e) => {
  const suelto = path.join(e.dir, 'hook-suelto', 'hooks', 'uaeh-guardia-cierre.js');
  fs.mkdirSync(path.dirname(suelto), { recursive: true });
  fs.copyFileSync(GUARDIA, suelto);
  const repo = repoConArchivo(e, 'src/config/pricing.config.ts');
  const entradas = [['revisor', revisorStdin('uae-verifier')], ['commit', commitStdin('git commit -m "precio"', repo)], ['cierre', cierreStdin()]];
  for (const [op, stdin] of entradas) {
    const r = ejecutar(e, op, stdin, { script: suelto });
    assert.equal(r.status, 0, op);
    assert.equal(r.stdout, '', op);
  }
}));
