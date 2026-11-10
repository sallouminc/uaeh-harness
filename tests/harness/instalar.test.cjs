// Pruebas de plugins/uaeh-harness/scripts/instalar.cjs: config, git-guard (espejo + humo + core.hooksPath global en un
// gitconfig GLOBAL temporal), codex (bloque entre marcadores, TOML renderizados) y todo. Nunca toca la configuración real.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, git, gitConfigGlobal, RAIZ_HARNESS, SECRETO_FALSO } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_HARNESS, 'scripts', 'instalar.cjs');
const INST = require(SCRIPT);
const COMUN = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'comun.cjs'));
const VERSION = COMUN.versionPlugin();
const CLAVE = INST.CLAVE_HOOKS; // «core.» + «hooksPath», armada por partes en el instalador

function conCasa(fn) {
  const e = entornoTemporal('uaeh-inst-');
  gitConfigGlobal(e); // gitconfig global temporal SIN guarda
  try { return fn(e); } finally { e.limpiar(); }
}

function instalar(e, args, extraEnv) {
  const r = correr(SCRIPT, [...args, '--json'], { env: { ...e.env, ...(extraEnv || {}) }, cwd: e.proyecto, timeout: 180000 });
  let informe = null;
  try { informe = JSON.parse(r.stdout); } catch { /* abajo */ }
  assert.ok(informe, `salida no es JSON (status ${r.status}): ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
  return { r, informe, tipos: informe.acciones.map((a) => a.tipo), detalles: informe.acciones.map((a) => `${a.tipo} ${a.detalle}`) };
}

function hooksPathGlobal(e) {
  const r = git(e.dir, ['config', '--global', '--get', CLAVE], e.env, { tolerar: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

const espejoDe = (e) => path.join(e.uaehHome, 'estable', 'uaeh-harness');
const arbol = (dir) => {
  const salida = [];
  const recorrer = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, x.name); if (x.isDirectory()) recorrer(p); else salida.push(path.relative(dir, p).replace(/\\/g, '/')); } };
  if (fs.existsSync(dir)) recorrer(dir);
  return salida.sort();
};

// ── uso ──────────────────────────────────────────────────────────────────────────────────

test('uso incorrecto: sin subcomando, subcomando desconocido o --quitar fuera de git-guard → código 2', () => conCasa((e) => {
  for (const args of [[], ['nada'], ['config', '--quitar'], ['config', '--rara'], ['config', '--reemplazar'], ['git-guard', '--quitar', '--reemplazar']]) {
    const r = correr(SCRIPT, args, { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Uso:/);
  }
}));

// ── config ───────────────────────────────────────────────────────────────────────────────

test('config: en seco no escribe; con --aplicar crea uaeh.config.json desde la plantilla; nunca pisa uno existente', () => conCasa((e) => {
  const destino = path.join(e.uaehHome, 'uaeh.config.json');
  const seco = instalar(e, ['config']);
  assert.deepEqual(seco.tipos, ['HARÍA']);
  assert.ok(!fs.existsSync(destino));
  const hecho = instalar(e, ['config', '--aplicar']);
  assert.deepEqual(hecho.tipos, ['HECHO']);
  assert.equal(fs.readFileSync(destino, 'utf8'), fs.readFileSync(path.join(RAIZ_HARNESS, 'templates', 'uaeh.config.example.json'), 'utf8'));
  fs.writeFileSync(destino, JSON.stringify({ commits: { credito: 'prohibir' }, rara: 1 }), 'utf8');
  const otra = instalar(e, ['config', '--aplicar']);
  assert.deepEqual(otra.tipos, ['SIN CAMBIOS']);
  assert.match(otra.informe.acciones[0].detalle, /rara/);
  assert.equal(JSON.parse(fs.readFileSync(destino, 'utf8')).commits.credito, 'prohibir');
}));

// ── git-guard ─────────────────────────────────────────────────────────────────────────────

test('git-guard en seco: lista las copias, corre la prueba de humo sobre el plugin y NO escribe ni toca git', () => conCasa((e) => {
  const { informe, tipos } = instalar(e, ['git-guard']);
  assert.equal(informe.codigo, 0, JSON.stringify(informe, null, 1));
  assert.ok(informe.humo && informe.humo.ok, JSON.stringify(informe.humo));
  assert.deepEqual(informe.humo.pasos.map((p) => p.ok), [true, true, true]);
  assert.ok(tipos.filter((t) => t === 'HARÍA').length >= INST.COPIAS_ESPEJO.length + INST.HOOKS_CLAVE.length + 2);
  assert.ok(!tipos.includes('HECHO') && !tipos.includes('ERROR'));
  assert.ok(informe.acciones.some((a) => a.tipo === 'HARÍA' && a.detalle.includes(`fijar ${CLAVE}`)));
  assert.ok(!fs.existsSync(espejoDe(e)));
  assert.equal(hooksPathGlobal(e), null);
}));

test('git-guard --aplicar: espejo completo (hooks LF), VERSION, package.json, humo contra el espejo y hooksPath global fijado; segunda corrida sin cambios', () => conCasa((e) => {
  const { informe } = instalar(e, ['git-guard', '--aplicar']);
  assert.equal(informe.codigo, 0, JSON.stringify(informe, null, 1));
  assert.ok(informe.humo.ok);
  const espejo = espejoDe(e);
  const archivos = arbol(espejo);
  for (const rel of [...INST.COPIAS_ESPEJO, 'VERSION', 'package.json', INST.ARCHIVO_ESTADO_GUARDA, ...INST.HOOKS_CLAVE.map((h) => `git-hooks/${h}`)]) {
    assert.ok(archivos.includes(rel), `falta ${rel} en el espejo: ${archivos.join(', ')}`);
  }
  assert.equal(fs.readFileSync(path.join(espejo, 'VERSION'), 'utf8').trim(), VERSION);
  assert.equal(JSON.parse(fs.readFileSync(path.join(espejo, 'package.json'), 'utf8')).type, 'commonjs');
  for (const h of fs.readdirSync(path.join(espejo, 'git-hooks'))) {
    const texto = fs.readFileSync(path.join(espejo, 'git-hooks', h), 'utf8');
    assert.ok(!texto.includes('\r'), `${h} con CR`);
    assert.ok(texto.startsWith('#!/bin/sh'), `${h} sin #!/bin/sh`);
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(espejo, 'git-hooks', h)).mode & 0o111, `${h} sin +x`);
  }
  const esperado = path.join(espejo, 'git-hooks').replace(/\\/g, '/');
  assert.equal(hooksPathGlobal(e), esperado);
  const estado = JSON.parse(fs.readFileSync(path.join(espejo, INST.ARCHIVO_ESTADO_GUARDA), 'utf8'));
  assert.equal(estado.anterior, null);
  assert.equal(estado.version, VERSION);

  const otra = instalar(e, ['git-guard', '--aplicar']);
  assert.equal(otra.informe.codigo, 0);
  assert.ok(otra.tipos.every((t) => t === 'SIN CAMBIOS'), otra.detalles.join('\n'));
  assert.ok(otra.informe.acciones.some((a) => a.detalle.includes('ya apunta al espejo')));
}));

test('la guarda instalada desde el espejo revisa commits REALES en otro repo: limpio pasa, .env y secreto se niegan sin mostrar el valor', () => conCasa((e) => {
  instalar(e, ['git-guard', '--aplicar']);
  const repo = path.join(e.dir, 'repo-real');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q'], e.env);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt'], e.env);
  assert.equal(git(repo, ['commit', '-q', '-m', 'limpio'], e.env, { tolerar: true }).status, 0);
  fs.writeFileSync(path.join(repo, '.env'), 'X=1\n');
  git(repo, ['add', '.env'], e.env);
  const env = git(repo, ['commit', '-q', '-m', 'con env'], e.env, { tolerar: true });
  assert.notEqual(env.status, 0);
  assert.match(env.stderr, /Guardia UAEH/);
  git(repo, ['rm', '-q', '--cached', '.env'], e.env);
  fs.writeFileSync(path.join(repo, 'k.js'), `const k = '${SECRETO_FALSO}';\n`);
  git(repo, ['add', 'k.js'], e.env);
  const sec = git(repo, ['commit', '-q', '-m', 'con secreto'], e.env, { tolerar: true });
  assert.notEqual(sec.status, 0);
  assert.match(sec.stderr, /Guardia UAEH/);
  assert.ok(!sec.stderr.includes(SECRETO_FALSO), 'el valor del secreto nunca se imprime');
}));

test('git-guard respeta un core.hooksPath ajeno (no lo pisa; código 1) y --quitar solo actúa sobre el espejo', () => conCasa((e) => {
  const ajeno = path.join(e.dir, 'husky').replace(/\\/g, '/');
  fs.mkdirSync(ajeno);
  git(e.dir, ['config', '--global', CLAVE, ajeno], e.env);
  const r = instalar(e, ['git-guard', '--aplicar']);
  assert.equal(r.informe.codigo, 1);
  assert.ok(r.informe.acciones.some((a) => a.tipo === 'ERROR' && a.detalle.includes(ajeno)));
  assert.equal(hooksPathGlobal(e), ajeno);
  assert.ok(fs.existsSync(espejoDe(e)), 'el espejo sí se escribe: lo único que no se toca es el hooksPath ajeno');
  const q = instalar(e, ['git-guard', '--quitar', '--aplicar']);
  assert.deepEqual(q.tipos, ['SIN CAMBIOS']);
  assert.equal(hooksPathGlobal(e), ajeno);
}));

test('git-guard --reemplazar: el error sin la opción la sugiere; en seco anuncia sin tocar; aplicado sustituye tras el humo, anota el anterior y --quitar lo restaura', () => conCasa((e) => {
  const ajeno = path.join(e.dir, 'guarda-anterior').replace(/\\/g, '/');
  fs.mkdirSync(ajeno);
  git(e.dir, ['config', '--global', CLAVE, ajeno], e.env);
  const esperado = path.join(espejoDe(e), 'git-hooks').replace(/\\/g, '/');
  const estado = () => JSON.parse(fs.readFileSync(path.join(espejoDe(e), INST.ARCHIVO_ESTADO_GUARDA), 'utf8'));

  // Sin la opción: no se toca y el mensaje NO manda a quitarla a mano (el valor se perdería para la reversa).
  const sin = instalar(e, ['git-guard', '--aplicar']);
  assert.equal(sin.informe.codigo, 1);
  const error = sin.informe.acciones.find((a) => a.tipo === 'ERROR');
  assert.ok(error && error.detalle.includes('--reemplazar'), sin.detalles.join('\n'));
  assert.ok(!error.detalle.includes('--unset'), error.detalle);

  const seco = instalar(e, ['git-guard', '--reemplazar']);
  assert.equal(seco.informe.codigo, 0, seco.detalles.join('\n'));
  assert.ok(seco.informe.humo.ok);
  assert.ok(seco.informe.acciones.some((a) => a.tipo === 'HARÍA' && a.detalle.includes(ajeno) && a.detalle.includes(esperado)), seco.detalles.join('\n'));
  assert.equal(hooksPathGlobal(e), ajeno);

  const hecho = instalar(e, ['git-guard', '--reemplazar', '--aplicar']);
  assert.equal(hecho.informe.codigo, 0, hecho.detalles.join('\n'));
  assert.ok(hecho.informe.humo.ok);
  assert.equal(hooksPathGlobal(e), esperado);
  assert.equal(estado().anterior, ajeno);
  assert.ok(hecho.informe.acciones.some((a) => a.tipo === 'HECHO' && a.detalle.includes(ajeno) && a.detalle.includes('--quitar')), hecho.detalles.join('\n'));

  // Repetirlo (p. ej. tras actualizar el plugin) no pierde el anterior anotado.
  const otra = instalar(e, ['git-guard', '--reemplazar', '--aplicar']);
  assert.equal(otra.informe.codigo, 0, otra.detalles.join('\n'));
  assert.equal(estado().anterior, ajeno);

  const q = instalar(e, ['git-guard', '--quitar', '--aplicar']);
  assert.deepEqual(q.tipos, ['HECHO']);
  assert.equal(hooksPathGlobal(e), ajeno);
}));

test('git-guard --reemplazar con la prueba de humo fallida no toca el hooksPath ajeno ni anota nada', () => conCasa((e) => {
  const ajeno = path.join(e.dir, 'guarda-anterior').replace(/\\/g, '/');
  fs.mkdirSync(ajeno);
  git(e.dir, ['config', '--global', CLAVE, ajeno], e.env);
  // Temporal inexistente: el humo no puede crear su repo y falla (cerrado) antes de decidir nada sobre el hooksPath.
  const inexistente = path.join(e.dir, 'temporal-que-no-existe');
  const r = instalar(e, ['git-guard', '--reemplazar', '--aplicar'], { TEMP: inexistente, TMP: inexistente, TMPDIR: inexistente });
  assert.equal(r.informe.codigo, 1, r.detalles.join('\n'));
  assert.equal(r.informe.humo.ok, false);
  assert.equal(hooksPathGlobal(e), ajeno);
  assert.ok(!fs.existsSync(path.join(espejoDe(e), INST.ARCHIVO_ESTADO_GUARDA)));
}));

test('git-guard --quitar: en seco anuncia; aplicado quita el hooksPath (o restaura el anterior) y conserva el espejo', () => conCasa((e) => {
  instalar(e, ['git-guard', '--aplicar']);
  const seco = instalar(e, ['git-guard', '--quitar']);
  assert.deepEqual(seco.tipos, ['HARÍA']);
  assert.ok(hooksPathGlobal(e));
  const hecho = instalar(e, ['git-guard', '--quitar', '--aplicar']);
  assert.deepEqual(hecho.tipos, ['HECHO']);
  assert.equal(hooksPathGlobal(e), null);
  assert.ok(fs.existsSync(path.join(espejoDe(e), 'VERSION')));
  const nada = instalar(e, ['git-guard', '--quitar', '--aplicar']);
  assert.deepEqual(nada.tipos, ['SIN CAMBIOS']);
  // reversa con valor anterior anotado
  fs.writeFileSync(path.join(espejoDe(e), INST.ARCHIVO_ESTADO_GUARDA), JSON.stringify({ anterior: 'C:/otra/guarda', fijado: 'x', version: VERSION }));
  git(e.dir, ['config', '--global', CLAVE, path.join(espejoDe(e), 'git-hooks').replace(/\\/g, '/')], e.env);
  const rest = instalar(e, ['git-guard', '--quitar', '--aplicar']);
  assert.deepEqual(rest.tipos, ['HECHO']);
  assert.equal(hooksPathGlobal(e), 'C:/otra/guarda');
}));

test('la prueba de humo detecta una guarda rota (hooks que no revisan) y entonces no se fija el hooksPath', () => conCasa((e) => {
  const falsa = path.join(e.dir, 'guarda-falsa');
  fs.mkdirSync(falsa, { recursive: true });
  for (const h of INST.HOOKS_CLAVE) fs.writeFileSync(path.join(falsa, h), '#!/bin/sh\nexit 0\n');
  const humo = INST.humo(falsa);
  assert.equal(humo.ok, false);
  assert.equal(humo.pasos[0].ok, true, 'el commit limpio sí pasa');
  assert.equal(humo.pasos[1].ok, false, 'el .env debió negarse');
  assert.match(humo.pasos[1].detalle, /no corrió/);
}));

test('en seco, el humo también se cuenta aunque el espejo no exista: el usuario sabe antes si su máquina puede correr la guarda', () => conCasa((e) => {
  const { informe } = instalar(e, ['git-guard']);
  assert.ok(informe.humo.ok);
  assert.match(informe.humo.detalle, /git-hooks/);
}));

// ── codex ─────────────────────────────────────────────────────────────────────────────────

test('codex: en seco anuncia; --aplicar escribe el bloque UAEH entre marcadores en AGENTS.md y los TOML con los modelos de la config; idempotente', () => conCasa((e) => {
  const codexHome = path.join(e.home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ codex: { habilitado: true, modelos: { profundo: { modelo: 'modelo-p', esfuerzo: 'xhigh' } } } }), 'utf8');
  const env = { CODEX_HOME: codexHome };
  const seco = instalar(e, ['codex'], env);
  assert.equal(seco.informe.codigo, 0, seco.detalles.join('\n'));
  assert.ok(seco.tipos.includes('HARÍA') && !seco.tipos.includes('HECHO'));
  assert.ok(!fs.existsSync(path.join(codexHome, 'AGENTS.md')));
  assert.ok(seco.informe.acciones.some((a) => a.tipo === 'NOTA' && /OpenAI/.test(a.detalle)), 'consentimiento');
  assert.ok(seco.informe.acciones.some((a) => a.tipo === 'NOTA' && a.snippet && /project_doc_fallback_filenames/.test(a.snippet)), 'fragmento de config.toml');

  const hecho = instalar(e, ['codex', '--aplicar'], env);
  assert.equal(hecho.informe.codigo, 0, hecho.detalles.join('\n'));
  const agents = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  assert.match(agents, new RegExp(`<!-- UAEH:BEGIN v${VERSION.replace(/\./g, '\\.')} -->`));
  assert.match(agents, /<!-- UAEH:END -->\s*$/);
  const espejo = path.join(e.uaehHome, 'estable', 'uaeh-harness').replace(/\\/g, '/');
  assert.ok(agents.includes(`${espejo}/scripts/uaeh-integridad.cjs`), 'ruta del espejo renderizada');
  assert.ok(!agents.includes('{{'), 'sin marcadores sin renderizar');
  const tomls = fs.readdirSync(path.join(codexHome, 'agents')).sort();
  assert.deepEqual(tomls, ['uae_architect.toml', 'uae_builder.toml', 'uae_security.toml', 'uae_triage.toml', 'uae_verifier.toml']);
  const security = fs.readFileSync(path.join(codexHome, 'agents', 'uae_security.toml'), 'utf8');
  assert.match(security, /model = "modelo-p"/);
  assert.match(security, /model_reasoning_effort = "xhigh"/);
  const verifier = fs.readFileSync(path.join(codexHome, 'agents', 'uae_verifier.toml'), 'utf8');
  assert.match(verifier, /model = "gpt-6-sol"/);
  for (const t of tomls) assert.ok(!fs.readFileSync(path.join(codexHome, 'agents', t), 'utf8').includes('{{'), t);
  assert.ok(!fs.existsSync(path.join(codexHome, 'config.toml')), 'config.toml nunca se crea ni se edita');

  const otra = instalar(e, ['codex', '--aplicar'], env);
  assert.ok(otra.tipos.filter((t) => t !== 'NOTA').every((t) => t === 'SIN CAMBIOS'), otra.detalles.join('\n'));
}));

test('codex: un AGENTS.md propio se conserva (el bloque se añade al final o se reemplaza entre marcadores, con respaldo y CRLF intactos)', () => conCasa((e) => {
  const codexHome = path.join(e.home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const propio = '# Mis reglas\r\n\r\nUna línea mía.\r\n';
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), propio, 'utf8');
  const env = { CODEX_HOME: codexHome };
  instalar(e, ['codex', '--aplicar'], env);
  let texto = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  assert.ok(texto.startsWith('# Mis reglas\r\n\r\nUna línea mía.\r\n'));
  assert.ok(/<!-- UAEH:BEGIN v[^ ]+ -->\r\n/.test(texto), 'el bloque adopta el CRLF del destino');
  assert.equal((texto.match(/UAEH:BEGIN/g) || []).length, 1);
  assert.ok(fs.readdirSync(codexHome).some((f) => f.startsWith('AGENTS.md.uaeh-respaldo-')), 'respaldo');
  // bloque viejo → se reemplaza, no se duplica
  texto = texto.replace(/<!-- UAEH:BEGIN v[^ ]+ -->/, '<!-- UAEH:BEGIN v0.0.0 -->').replace('Una línea mía.', 'Una línea mía.\r\n\r\nOtra línea al final.');
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), texto, 'utf8');
  instalar(e, ['codex', '--aplicar'], env);
  const final = fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8');
  assert.equal((final.match(/UAEH:BEGIN/g) || []).length, 1);
  assert.ok(!final.includes('v0.0.0'));
  assert.ok(final.includes('Otra línea al final.'));
}));

test('conBloque y renderizar (unitarias): vacío, sin marcadores, con marcadores y BOM', () => {
  const bloque = '<!-- UAEH:BEGIN v1 -->\ncuerpo\n<!-- UAEH:END -->';
  assert.equal(INST.conBloque(null, bloque), bloque + '\n');
  assert.equal(INST.conBloque('hola\n', bloque), 'hola\n\n' + bloque + '\n');
  assert.equal(INST.conBloque('a\n<!-- UAEH:BEGIN v0 -->\nviejo\n<!-- UAEH:END -->\nb\n', bloque), 'a\n' + bloque + '\nb\n');
  const bom = String.fromCharCode(0xFEFF);
  assert.ok(INST.conBloque(bom + 'x\n', bloque).startsWith(bom + 'x\n'));
  assert.equal(INST.renderizar('a {{X}} b {{Y}} {{Z}}', { X: '1', Y: '2' }), 'a 1 b 2 {{Z}}');
});

// ── todo ──────────────────────────────────────────────────────────────────────────────────

test('todo: config + git-guard; codex solo si codex.habilitado', () => conCasa((e) => {
  const codexHome = path.join(e.home, '.codex');
  const sin = instalar(e, ['todo', '--aplicar'], { CODEX_HOME: codexHome });
  assert.equal(sin.informe.codigo, 0, sin.detalles.join('\n'));
  assert.ok(fs.existsSync(path.join(e.uaehHome, 'uaeh.config.json')));
  assert.ok(hooksPathGlobal(e));
  assert.ok(!fs.existsSync(path.join(codexHome, 'AGENTS.md')));
  assert.ok(sin.informe.acciones.some((a) => a.tipo === 'NOTA' && /codex\.habilitado es false/.test(a.detalle)));
  fs.writeFileSync(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ codex: { habilitado: true } }), 'utf8');
  const con = instalar(e, ['todo', '--aplicar'], { CODEX_HOME: codexHome });
  assert.equal(con.informe.codigo, 0, con.detalles.join('\n'));
  assert.ok(fs.existsSync(path.join(codexHome, 'AGENTS.md')));
}));

// ── codex --quitar ────────────────────────────────────────────────────────────────────────

test('codex --quitar: ida y vuelta; en seco no toca; el AGENTS.md propio y config.toml se conservan; idempotente', () => conCasa((e) => {
  const codexHome = path.join(e.home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const propio = '# Mis reglas\n\nUna línea mía.\n';
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), propio, 'utf8');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n', 'utf8');
  const env = { CODEX_HOME: codexHome };
  instalar(e, ['codex', '--aplicar'], env);
  assert.match(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), /UAEH:BEGIN/);
  assert.equal(fs.readdirSync(path.join(codexHome, 'agents')).length, 5);

  const seco = instalar(e, ['codex', '--quitar'], env);
  assert.equal(seco.informe.codigo, 0, seco.detalles.join('\n'));
  assert.ok(seco.tipos.includes('HARÍA') && !seco.tipos.includes('HECHO'));
  assert.match(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), /UAEH:BEGIN/);
  assert.equal(fs.readdirSync(path.join(codexHome, 'agents')).length, 5);

  const hecho = instalar(e, ['codex', '--quitar', '--aplicar'], env);
  assert.equal(hecho.informe.codigo, 0, hecho.detalles.join('\n'));
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), propio, 'vuelve al texto propio');
  assert.deepEqual(fs.readdirSync(path.join(codexHome, 'agents')).filter((n) => n.endsWith('.toml')), []);
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), 'model = "x"\n', 'config.toml intacto');
  assert.ok(hecho.informe.acciones.some((a) => a.tipo === 'NOTA' && /config\.toml/.test(a.detalle) && /quítalo tú/.test(a.detalle)), hecho.detalles.join('\n'));

  const otra = instalar(e, ['codex', '--quitar', '--aplicar'], env);
  assert.equal(otra.informe.codigo, 0);
  assert.ok(otra.tipos.filter((t) => t !== 'NOTA').every((t) => t === 'SIN CAMBIOS'), otra.detalles.join('\n'));
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), propio);
}));

test('codex --quitar: un TOML cambiado por el usuario se conserva y se avisa; un AGENTS.md que era solo el bloque queda vacío', () => conCasa((e) => {
  const codexHome = path.join(e.home, '.codex');
  const env = { CODEX_HOME: codexHome };
  instalar(e, ['codex', '--aplicar'], env);
  const mio = path.join(codexHome, 'agents', 'uae_builder.toml');
  fs.appendFileSync(mio, '# cambio mío\n');
  const q = instalar(e, ['codex', '--quitar', '--aplicar'], env);
  assert.equal(q.informe.codigo, 0, q.detalles.join('\n'));
  assert.deepEqual(fs.readdirSync(path.join(codexHome, 'agents')).filter((n) => n.endsWith('.toml')), ['uae_builder.toml']);
  assert.match(fs.readFileSync(mio, 'utf8'), /cambio mío/);
  assert.ok(q.informe.acciones.some((a) => a.tipo === 'NOTA' && /uae_builder\.toml/.test(a.detalle) && /difiere/.test(a.detalle)), q.detalles.join('\n'));
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), '');
}));

test('codex --quitar: con una marca UAEH suelta no toca el AGENTS.md; sin nada instalado no hace nada', () => conCasa((e) => {
  const codexHome = path.join(e.home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const env = { CODEX_HOME: codexHome };
  const vacio = instalar(e, ['codex', '--quitar', '--aplicar'], env);
  assert.equal(vacio.informe.codigo, 0);
  assert.ok(vacio.tipos.filter((t) => t !== 'NOTA').every((t) => t === 'SIN CAMBIOS'), vacio.detalles.join('\n'));
  const roto = '# mío\n<!-- UAEH:BEGIN v1 -->\nsin fin\n';
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), roto, 'utf8');
  const r = instalar(e, ['codex', '--quitar', '--aplicar'], env);
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), roto);
  assert.ok(r.informe.acciones.some((a) => a.tipo === 'SIN CAMBIOS' && /suelta/.test(a.detalle)));
}));

test('--forzar solo aplica a los subcomandos que escriben en el arnés (visual lo rechaza: código 2)', () => conCasa((e) => {
  const r = correr(SCRIPT, ['visual', '--registrar-skills', '--forzar'], { env: e.env, cwd: e.proyecto });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--forzar/);
}));

// ── sellos abiertos de otras sesiones ─────────────────────────────────────────────────────

// Deja una foto de revisión en la carpeta de fotos de la casa; `minutos` = antigüedad; `cerrada` = ya comparada.
function sembrarFoto(e, { id = 'agente-abc123', minutos = 5, cerrada = false } = {}) {
  const dir = path.join(e.uaehHome, 'integridad');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.foto.json`);
  fs.writeFileSync(f, JSON.stringify({ version: 3, id, etiqueta: 'hook uae-verifier', repo: path.join(e.dir, 'repo-revisado'), medicion: {} }), 'utf8');
  const t = new Date(Date.now() - minutos * 60000);
  fs.utimesSync(f, t, t);
  if (cerrada) fs.appendFileSync(path.join(dir, 'registro.jsonl'), JSON.stringify({ id, resultado: 'INTACTO' }) + '\n');
  return f;
}

test('sellos abiertos: sin carpeta de fotos no avisa ni niega', () => conCasa((e) => {
  const r = instalar(e, ['config', '--aplicar']);
  assert.equal(r.informe.codigo, 0, r.detalles.join('\n'));
  assert.deepEqual(r.tipos, ['HECHO']);
}));

test('sellos abiertos: en seco avisa (AVISO con la lista) y no escribe; el código sigue 0', () => conCasa((e) => {
  sembrarFoto(e);
  const r = instalar(e, ['config']);
  assert.equal(r.informe.codigo, 0);
  assert.equal(r.tipos[0], 'AVISO');
  assert.match(r.informe.acciones[0].detalle, /agente-abc123/);
  assert.match(r.informe.acciones[0].detalle, /hace \d+ min/);
  assert.ok(r.tipos.includes('HARÍA'));
  assert.ok(!fs.existsSync(path.join(e.uaehHome, 'uaeh.config.json')));
}));

test('sellos abiertos: --aplicar se niega (código 1, nada escrito) en config, git-guard, codex, todo y puertas; --forzar sigue y deja el AVISO', () => conCasa((e) => {
  sembrarFoto(e);
  const env = { CODEX_HOME: path.join(e.home, '.codex') };
  for (const args of [['config'], ['git-guard'], ['codex'], ['todo'], ['puertas', 'codex']]) {
    const r = instalar(e, [...args, '--aplicar'], env);
    assert.equal(r.informe.codigo, 1, args.join(' '));
    assert.equal(r.informe.aplicado, false);
    assert.deepEqual(r.tipos, ['ERROR']);
    assert.match(r.informe.acciones[0].detalle, /NEGADO/);
    assert.match(r.informe.acciones[0].detalle, /agente-abc123/);
    assert.match(r.informe.acciones[0].detalle, /--forzar/);
  }
  assert.ok(!fs.existsSync(path.join(e.uaehHome, 'uaeh.config.json')));
  assert.ok(!fs.existsSync(espejoDe(e)));
  assert.equal(hooksPathGlobal(e), null);
  assert.ok(!fs.existsSync(path.join(e.home, '.codex', 'AGENTS.md')));
  const f = instalar(e, ['config', '--aplicar', '--forzar']);
  assert.equal(f.informe.codigo, 0, f.detalles.join('\n'));
  assert.equal(f.tipos[0], 'AVISO');
  assert.ok(f.tipos.includes('HECHO'));
  assert.ok(fs.existsSync(path.join(e.uaehHome, 'uaeh.config.json')));
}));

test('sellos abiertos: una foto vieja o ya comparada no cuenta; la reversa de git-guard también se niega (el sello mide la ruta global de hooks)', () => conCasa((e) => {
  sembrarFoto(e, { id: 'agente-vieja', minutos: 600 });
  sembrarFoto(e, { id: 'agente-cerrada', minutos: 2, cerrada: true });
  const r = instalar(e, ['config', '--aplicar']);
  assert.equal(r.informe.codigo, 0, r.detalles.join('\n'));
  assert.deepEqual(r.tipos, ['HECHO']);
  sembrarFoto(e, { id: 'agente-viva', minutos: 1 });
  const q = instalar(e, ['git-guard', '--quitar', '--aplicar']);
  assert.equal(q.informe.codigo, 1, q.detalles.join('\n'));
  assert.deepEqual(q.tipos, ['ERROR']);
  const forzado = instalar(e, ['git-guard', '--quitar', '--aplicar', '--forzar']);
  assert.ok(forzado.tipos.includes('AVISO') && forzado.informe.codigo === 0, forzado.detalles.join('\n'));
}));
