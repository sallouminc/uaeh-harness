// Pruebas de plugins/uaeh-harness/scripts/doctor.cjs (doctor de la capa 2). Herméticas: casa temporal por prueba,
// gitconfig global temporal y, para la guarda, un espejo instalado dentro de esa casa. Nunca leen la configuración real.
// Un archivo solo: node --test tests/harness/doctor.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  entornoTemporal, correr, gitConfigGlobal, requiereHerramienta, requiereBash, RAIZ_HARNESS,
} = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_HARNESS, 'scripts', 'doctor.cjs');
const INSTALAR = path.join(RAIZ_HARNESS, 'scripts', 'instalar.cjs');
const DOCTOR = require(SCRIPT);
const COMUN = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'comun.cjs'));
const VERSION = COMUN.versionPlugin();

const espejoDe = (e) => path.join(e.uaehHome, 'estable', 'uaeh-harness');

function doctor(e, args = [], { raiz = null } = {}) {
  const a = ['--json', ...args];
  if (raiz) a.push('--raiz', raiz);
  const r = correr(SCRIPT, a, { env: e.env, cwd: e.proyecto, timeout: 180000 });
  const informe = r.json();
  assert.ok(informe, `salida no es JSON (status ${r.status}): ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
  const por = Object.fromEntries(informe.comprobaciones.map((c) => [c.id, c]));
  return { r, informe, por };
}

// Casa nueva con git global temporal; con `espejo` copia el espejo ya instalado de la casa base (sin reinstalar).
function casa({ espejo = false, guarda = false } = {}) {
  const e = entornoTemporal('uaeh-doc-');
  if (espejo) require('../helpers/entorno.cjs').copiarCarpeta(espejoDe(base), espejoDe(e));
  gitConfigGlobal(e, { hooksPath: guarda ? path.join(espejoDe(e), 'git-hooks') : null });
  return e;
}

// Casa base: espejo recién instalado con `instalar.cjs git-guard --aplicar` (humo incluido). Se hace una sola vez.
let base = null;
let instalado = false;
before(() => {
  base = entornoTemporal('uaeh-doc-base-');
  gitConfigGlobal(base);
  const r = correr(INSTALAR, ['git-guard', '--aplicar', '--json'], { env: base.env, cwd: base.proyecto, timeout: 180000 });
  instalado = r.status === 0 && fs.existsSync(path.join(espejoDe(base), 'VERSION'));
});
after(() => { if (base) base.limpiar(); });

function exigirEspejo(t) {
  if (instalado) return true;
  const motivo = 'no se pudo instalar el espejo de base (¿faltan git o sh?)';
  if (process.env.UAEH_CI === '1' || process.env.UAEH_PRUEBAS_ESTRICTO === '1') throw new Error(`prueba omitida en modo estricto: ${motivo}`);
  t.skip(motivo);
  return false;
}

// Copia mínima del plugin para sembrar fallas: hooks/, scripts/, git-hooks/, agents/, solo los SKILL.md y el manifiesto.
function copiaPlugin(e) {
  const destino = path.join(e.dir, 'plugin-copia');
  for (const d of ['hooks', 'scripts', 'git-hooks', 'agents', '.claude-plugin']) {
    require('../helpers/entorno.cjs').copiarCarpeta(path.join(RAIZ_HARNESS, d), path.join(destino, d));
  }
  for (const s of fs.readdirSync(path.join(RAIZ_HARNESS, 'skills'), { withFileTypes: true })) {
    const md = path.join(RAIZ_HARNESS, 'skills', s.name, 'SKILL.md');
    if (s.isDirectory() && fs.existsSync(md)) {
      fs.mkdirSync(path.join(destino, 'skills', s.name), { recursive: true });
      fs.copyFileSync(md, path.join(destino, 'skills', s.name, 'SKILL.md'));
    }
  }
  return destino;
}

// ── informe sano ─────────────────────────────────────────────────────────────────────────

test('espejo recién instalado con la guarda fijada: sin FALLÓ y espejo/guarda-git/humo/candado/sello en OK', (t) => {
  if (!requiereHerramienta(t, 'git') || !requiereBash(t) || !exigirEspejo(t)) return;
  const e = casa({ espejo: true, guarda: true });
  try {
    const { r, informe, por } = doctor(e);
    assert.equal(informe.capa, 'arnes');
    assert.equal(informe.version, VERSION);
    assert.equal(informe.resumen['FALLÓ'], 0, JSON.stringify(informe.comprobaciones.filter((c) => c.estado === 'FALLÓ')));
    assert.equal(r.status, 0);
    assert.equal(informe.codigo, 0);
    for (const id of ['node', 'git', 'hooks-json', 'duplicados', 'espejo', 'guarda-git', 'humo', 'candado', 'sello']) {
      assert.equal(por[id].estado, 'OK', `${id}: ${por[id].estado} ${por[id].detalle}`);
    }
    assert.match(por.espejo.detalle, new RegExp(`v${VERSION.replace(/\./g, '\\.')} al día`));
    assert.match(por.humo.detalle, /3\/3 pasos .*del espejo/);
    assert.match(por.sello.detalle, /INTACTO.*ROTA.*\(\d+\.\d s\)/);
    assert.deepEqual(informe.comprobaciones.map((c) => c.id), DOCTOR.COMPROBACIONES.map(([id]) => id));
    for (const c of informe.comprobaciones) assert.ok(!/[\r\n]/.test(c.detalle), `${c.id}: el detalle debe ser una línea`);
  } finally { e.limpiar(); }
});

test('salida humana: encabezado, filas alineadas y línea de resumen', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const r = correr(SCRIPT, ['--rapido'], { env: e.env, cwd: e.proyecto });
    assert.match(r.stdout, /^Doctor del arnés UAEH \(capa 2\)/);
    assert.match(r.stdout, /^OMITIDA\s+humo\s+— se prueba sin --rapido$/m);
    assert.match(r.stdout, /^Resumen: \d+ OK · \d+ AVISO · \d+ FALLÓ · 3 OMITIDA/m);
  } finally { e.limpiar(); }
});

// ── espejo ───────────────────────────────────────────────────────────────────────────────

test('espejo ausente: NO_INSTALADA; la guarda sin definir: AVISO; humo usa la copia del plugin', (t) => {
  if (!requiereHerramienta(t, 'git') || !requiereBash(t)) return;
  const e = casa();
  try {
    const { por, informe } = doctor(e);
    assert.equal(por.espejo.estado, 'NO_INSTALADA');
    assert.match(por.espejo.detalle, /git-guard/);
    assert.equal(por['guarda-git'].estado, 'AVISO');
    assert.match(por['guarda-git'].detalle, /sin guarda de git: \/uaeh-harness:setup git-guard/);
    assert.equal(por.humo.estado, 'OK');
    assert.match(por.humo.detalle, /del plugin/);
    assert.equal(informe.resumen['FALLÓ'], 0);
  } finally { e.limpiar(); }
});

test('espejo con un archivo alterado, VERSION vieja o un hook sin ejecutable: AVISO con la lista', (t) => {
  if (!requiereHerramienta(t, 'git') || !exigirEspejo(t)) return;
  const e = casa({ espejo: true, guarda: true });
  try {
    fs.appendFileSync(path.join(espejoDe(e), 'hooks', 'guardia-git.js'), '\n// alterado\n');
    const a = doctor(e, ['--rapido']);
    assert.equal(a.por.espejo.estado, 'AVISO');
    assert.match(a.por.espejo.detalle, /desactualizado: 1 archivo\(s\) distinto\(s\): hooks\/guardia-git\.js/);
    assert.match(a.por.espejo.detalle, /git-guard --aplicar/);

    fs.writeFileSync(path.join(espejoDe(e), 'VERSION'), '0.0.1\n');
    const b = doctor(e, ['--rapido']);
    assert.equal(b.por.espejo.estado, 'AVISO');
    assert.match(b.por.espejo.detalle, /VERSION 0\.0\.1, el plugin es /);
    assert.match(b.por.espejo.detalle, /VERSION/);

    fs.rmSync(path.join(espejoDe(e), 'git-hooks', 'commit-msg'));
    const c = doctor(e, ['--rapido']);
    assert.match(c.por.espejo.detalle, /git-hooks\/commit-msg \(falta\)/);
    assert.equal(c.informe.resumen['FALLÓ'], 0);
  } finally { e.limpiar(); }
});

test('espejo con git-hooks en CRLF sigue al día (se comparan normalizados a LF)', (t) => {
  if (!requiereHerramienta(t, 'git') || !exigirEspejo(t)) return;
  const e = casa({ espejo: true, guarda: true });
  try {
    const ruta = path.join(espejoDe(e), 'git-hooks', 'pre-commit');
    fs.writeFileSync(ruta, fs.readFileSync(ruta, 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.equal(doctor(e, ['--rapido']).por.espejo.estado, 'OK');
  } finally { e.limpiar(); }
});

// Solo POSIX: en Windows no hay bit de ejecución. Una prueba que no aplica a un sistema no se registra en él (nunca
// t.skip): la batería sostiene «0 omitidas» y con UAEH_CI=1 una omitida es fallo.
if (process.platform !== 'win32') {
  test('espejo POSIX: un git-hook sin bit de ejecución es AVISO', (t) => {
    if (!requiereHerramienta(t, 'git') || !exigirEspejo(t)) return;
    const e = casa({ espejo: true, guarda: true });
    try {
      fs.chmodSync(path.join(espejoDe(e), 'git-hooks', 'commit-msg'), 0o644);
      const { por } = doctor(e, ['--rapido']);
      assert.equal(por.espejo.estado, 'AVISO');
      assert.match(por.espejo.detalle, /commit-msg \(sin permiso de ejecución\)/);
    } finally { e.limpiar(); }
  });
}

// ── guarda de git ────────────────────────────────────────────────────────────────────────

test('guarda-git: otro valor global es AVISO «otra guarda» y no se toca', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const otra = path.join(e.dir, 'otra-guarda');
    fs.mkdirSync(otra);
    gitConfigGlobal(e, { hooksPath: otra });
    const antes = fs.readFileSync(e.env.GIT_CONFIG_GLOBAL, 'utf8');
    const { por, informe } = doctor(e, ['--rapido']);
    assert.equal(por['guarda-git'].estado, 'AVISO');
    assert.match(por['guarda-git'].detalle, /^otra guarda: .*otra-guarda/);
    assert.equal(informe.resumen['FALLÓ'], 0);
    assert.equal(fs.readFileSync(e.env.GIT_CONFIG_GLOBAL, 'utf8'), antes, 'el doctor no escribe');
  } finally { e.limpiar(); }
});

// ── hooks duplicados y copias personales ─────────────────────────────────────────────────

test('duplicados: un hook de settings que llama a guardia-git.js es AVISO con el puntero JSON; nunca edita', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const hook = (cmd) => ({ hooks: [{ type: 'command', command: cmd }] });
    const global = { hooks: { PreToolUse: [hook('echo hola'), { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo x' }, { type: 'command', command: 'node "/ruta/vieja/hooks/guardia-git.js"' }] }] } };
    const local = { hooks: { Stop: [hook('node /otra/uaeh-guardia-cierre.js cierre')] } };
    const ruta1 = e.escribir(path.join(e.claudeHome, 'settings.json'), JSON.stringify(global, null, 2));
    const ruta2 = e.escribir(path.join(e.proyecto, '.claude', 'settings.local.json'), JSON.stringify(local, null, 2));
    const antes = [fs.readFileSync(ruta1, 'utf8'), fs.readFileSync(ruta2, 'utf8')];
    const { por } = doctor(e, ['--rapido']);
    assert.equal(por.duplicados.estado, 'AVISO');
    assert.match(por.duplicados.detalle, /\/hooks\/PreToolUse\/1\/hooks\/1 \(guardia-git\.js\)/);
    assert.match(por.duplicados.detalle, /\/hooks\/Stop\/0\/hooks\/0 \(uaeh-guardia-cierre\.js\)/);
    assert.match(por.duplicados.detalle, /correrían dos veces/);
    assert.doesNotMatch(por.duplicados.detalle, /\/hooks\/PreToolUse\/0\//);
    assert.deepEqual([fs.readFileSync(ruta1, 'utf8'), fs.readFileSync(ruta2, 'utf8')], antes);
  } finally { e.limpiar(); }
});

test('duplicados: settings con otros hooks → OK', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    e.escribir(path.join(e.claudeHome, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo guardia-git.js.bak' }] }] } }));
    const { por } = doctor(e, ['--rapido']);
    assert.equal(por.duplicados.estado, 'OK');
  } finally { e.limpiar(); }
});

test('copias-personales: un agente personal con el nombre de uno del plugin es AVISO; skills genéricas no cuentan', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    assert.equal(doctor(e, ['--rapido']).por['copias-personales'].estado, 'OK');
    e.escribir(path.join(e.claudeHome, 'agents', 'uae-verifier.md'), '---\nname: uae-verifier\n---\n');
    e.escribir(path.join(e.claudeHome, 'skills', 'setup', 'SKILL.md'), '---\nname: setup\n---\n');
    const a = doctor(e, ['--rapido']).por['copias-personales'];
    assert.equal(a.estado, 'AVISO');
    assert.match(a.detalle, /quedan dos copias: la personal y la del plugin \(uaeh-harness:<nombre>\)/);
    assert.match(a.detalle, /agente uae-verifier/);
    assert.doesNotMatch(a.detalle, /skill setup/);
    e.escribir(path.join(e.claudeHome, 'skills', 'uae-loop', 'SKILL.md'), '---\nname: uae-loop\n---\n');
    assert.match(doctor(e, ['--rapido']).por['copias-personales'].detalle, /skill uae-loop/);
  } finally { e.limpiar(); }
});

// ── guardia de cierre, rutas, configuración ──────────────────────────────────────────────

test('guardia-cierre: el archivo guardia-cierre.apagada es AVISO; sin él, OK', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    assert.equal(doctor(e, ['--rapido']).por['guardia-cierre'].estado, 'OK');
    e.escribir(path.join(e.uaehHome, 'guardia-cierre.apagada'), '');
    const { por } = doctor(e, ['--rapido']);
    assert.equal(por['guardia-cierre'].estado, 'AVISO');
    assert.match(por['guardia-cierre'].detalle, /apagada \(borra .*guardia-cierre\.apagada para encenderla\)/);
  } finally { e.limpiar(); }
});

test('config y politica-commits: sin archivo → AVISO con valores por defecto; con archivo → OK y la política', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const a = doctor(e, ['--rapido']).por;
    assert.equal(a.config.estado, 'AVISO');
    assert.match(a.config.detalle, /valores por defecto/);
    assert.equal(a['politica-commits'].estado, 'OK');
    assert.match(a['politica-commits'].detalle, /crédito de Claude (permitido|prohibido) · (sin firma|firma «)/);
    e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ commits: { credito: 'prohibir', firma: 'Firma de prueba' } }));
    const b = doctor(e, ['--rapido']).por;
    assert.equal(b.config.estado, 'OK');
    assert.equal(b['politica-commits'].detalle, 'crédito de Claude prohibido · firma «Firma de prueba»');
  } finally { e.limpiar(); }
});

test('rutas: sin la carpeta de estado es AVISO; con ella, OK', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    fs.rmSync(e.uaehHome, { recursive: true, force: true });
    assert.equal(doctor(e, ['--rapido']).por.rutas.estado, 'AVISO');
    fs.mkdirSync(e.uaehHome, { recursive: true });
    // Con caracteres no ASCII en la ruta el doctor avisa a propósito (algunos scripts de shell pueden fallar).
    assert.equal(doctor(e, ['--rapido']).por.rutas.estado, /[^\x20-\x7e]/.test(e.uaehHome) ? 'AVISO' : 'OK');
  } finally { e.limpiar(); }
});

// ── --rapido, --json, uso ────────────────────────────────────────────────────────────────

test('--rapido: las tres autopruebas quedan OMITIDA y no se ejecuta ninguna', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    // Con la copia del plugin rota: si alguna autoprueba corriera, saldría FALLÓ; en --rapido ni se mira.
    const raiz = copiaPlugin(e);
    fs.writeFileSync(path.join(raiz, 'hooks', 'solo-lectura.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    const { por, informe } = doctor(e, ['--rapido'], { raiz });
    for (const id of ['humo', 'candado', 'sello']) {
      assert.equal(por[id].estado, 'OMITIDA', id);
      assert.equal(por[id].detalle, 'se prueba sin --rapido');
    }
    assert.equal(informe.resumen.OMITIDA, 3);
    assert.equal(informe.resumen['FALLÓ'], 0);
  } finally { e.limpiar(); }
});

test('--json parsea y trae capa, version, comprobaciones, resumen y codigo', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const r = correr(SCRIPT, ['--json', '--rapido'], { env: e.env, cwd: e.proyecto });
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), ['capa', 'version', 'comprobaciones', 'resumen', 'codigo']);
    assert.equal(j.comprobaciones.length, DOCTOR.COMPROBACIONES.length);
    assert.ok(j.comprobaciones.every((c) => typeof c.id === 'string' && typeof c.estado === 'string' && typeof c.detalle === 'string'));
  } finally { e.limpiar(); }
});

test('argumento desconocido, valor ausente o carpeta inexistente → código 2; --ayuda → 0', () => {
  const e = entornoTemporal('uaeh-doc-uso-');
  try {
    for (const args of [['--rara'], ['--cwd'], ['--cwd', path.join(e.dir, 'no-existe')], ['--raiz', path.join(e.dir, 'no-existe')]]) {
      const r = correr(SCRIPT, args, { env: e.env, cwd: e.proyecto });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /Uso:/);
    }
    assert.equal(correr(SCRIPT, ['--ayuda'], { env: e.env, cwd: e.proyecto }).status, 0);
  } finally { e.limpiar(); }
});

test('el doctor no deja carpetas temporales propias ni escribe en la casa', (t) => {
  if (!requiereHerramienta(t, 'git') || !requiereBash(t)) return;
  const e = casa();
  try {
    const antes = fs.readdirSync(e.tmp).sort();
    const casaAntes = JSON.stringify(fs.readdirSync(e.uaehHome).sort());
    doctor(e);
    assert.deepEqual(fs.readdirSync(e.tmp).sort(), antes, 'las autopruebas borran sus temporales');
    assert.equal(JSON.stringify(fs.readdirSync(e.uaehHome).sort()), casaAntes);
  } finally { e.limpiar(); }
});

// ── mutación: las autopruebas detectan un arnés roto ─────────────────────────────────────

test('mutación: solo-lectura.js que nunca niega → candado FALLÓ (código 1)', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const raiz = copiaPlugin(e);
    // control: la copia sin tocar da OK
    assert.equal(doctor(e, [], { raiz }).por.candado.estado, 'OK');
    fs.writeFileSync(path.join(raiz, 'hooks', 'solo-lectura.js'), "'use strict';\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
    const { r, por, informe } = doctor(e, [], { raiz });
    assert.equal(por.candado.estado, 'FALLÓ');
    assert.match(por.candado.detalle, /el revisor pudo borrar/);
    assert.equal(informe.codigo, 1);
    assert.equal(r.status, 1);
  } finally { e.limpiar(); }
});

test('mutación: solo-lectura.js que niega a todos → candado FALLÓ (la sesión principal no debe bloquearse)', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const raiz = copiaPlugin(e);
    fs.writeFileSync(path.join(raiz, 'hooks', 'solo-lectura.js'),
      "'use strict';\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } })); });\n");
    const { por } = doctor(e, [], { raiz });
    assert.equal(por.candado.estado, 'FALLÓ');
    assert.match(por.candado.detalle, /la sesión principal quedó bloqueada/);
  } finally { e.limpiar(); }
});

test('mutación: uaeh-integridad.cjs que siempre dice INTACTO → sello FALLÓ', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const raiz = copiaPlugin(e);
    assert.equal(doctor(e, [], { raiz }).por.sello.estado, 'OK', 'control: la copia sin tocar da OK');
    fs.writeFileSync(path.join(raiz, 'scripts', 'uaeh-integridad.cjs'),
      "'use strict';\nconsole.log(process.argv[2] === 'foto' ? 'foto-falsa-0001' : 'INTACTO: siempre');\nprocess.exitCode = 0;\n");
    const { por, informe } = doctor(e, [], { raiz });
    assert.equal(por.sello.estado, 'FALLÓ');
    assert.match(por.sello.detalle, /debía dar ROTA \(3\) y dio código 0/);
    assert.equal(informe.codigo, 1);
  } finally { e.limpiar(); }
});

test('mutación: hooks.json que apunta a un script inexistente → hooks-json FALLÓ', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    const raiz = copiaPlugin(e);
    fs.rmSync(path.join(raiz, 'hooks', 'solo-navegador.js'));
    const { por } = doctor(e, ['--rapido'], { raiz });
    assert.equal(por['hooks-json'].estado, 'FALLÓ');
    assert.match(por['hooks-json'].detalle, /hooks\/solo-navegador\.js/);
  } finally { e.limpiar(); }
});

test('mutación: una guarda de git que no niega nada → humo FALLÓ con el paso que falló', (t) => {
  if (!requiereHerramienta(t, 'git') || !requiereBash(t)) return;
  const e = casa();
  try {
    const raiz = copiaPlugin(e);
    for (const h of ['prepare-commit-msg', 'pre-applypatch', 'commit-msg', 'applypatch-msg', 'pre-commit']) {
      fs.writeFileSync(path.join(raiz, 'git-hooks', h), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const { por } = doctor(e, [], { raiz });
    assert.equal(por.humo.estado, 'FALLÓ');
    assert.match(por.humo.detalle, /falló «commit con \.env se niega»/);
  } finally { e.limpiar(); }
});

test('sellos-abiertos: OK sin revisiones; AVISO con una foto reciente sin comparar; OK si es vieja o ya está comparada', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  const e = casa();
  try {
    assert.equal(doctor(e, ['--rapido']).por['sellos-abiertos'].estado, 'OK');
    const dir = path.join(e.uaehHome, 'integridad');
    fs.mkdirSync(dir, { recursive: true });
    const sembrar = (id, minutos) => {
      const f = path.join(dir, `${id}.foto.json`);
      fs.writeFileSync(f, JSON.stringify({ id, etiqueta: 'hook uae-verifier', repo: path.join(e.dir, 'repo') }), 'utf8');
      const m = new Date(Date.now() - minutos * 60000);
      fs.utimesSync(f, m, m);
    };
    sembrar('agente-vieja', 600);
    assert.equal(doctor(e, ['--rapido']).por['sellos-abiertos'].estado, 'OK', 'una foto vieja no cuenta');
    sembrar('agente-viva', 3);
    const { por, informe } = doctor(e, ['--rapido']);
    assert.equal(por['sellos-abiertos'].estado, 'AVISO');
    assert.match(por['sellos-abiertos'].detalle, /1 revisión\(es\) abierta\(s\)/);
    assert.match(por['sellos-abiertos'].detalle, /agente-viva/);
    assert.match(por['sellos-abiertos'].detalle, /no instalar ni cambiar la configuración hasta que terminen/);
    assert.equal(informe.codigo, 0, 'un AVISO no hace fallar el doctor');
    fs.appendFileSync(path.join(dir, 'registro.jsonl'), JSON.stringify({ id: 'agente-viva', resultado: 'INTACTO' }) + '\n');
    assert.equal(doctor(e, ['--rapido']).por['sellos-abiertos'].estado, 'OK', 'comparada = cerrada');
  } finally { e.limpiar(); }
});
