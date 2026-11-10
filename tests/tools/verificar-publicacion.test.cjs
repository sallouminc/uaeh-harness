// Pruebas de tools/verificar-publicacion.cjs. Herméticas: cada prueba crea un repositorio git temporal
// (con la configuración de git aislada de tests/helpers/entorno.cjs) y corre la herramienta real sobre
// él con --raiz. Lo que la lista pública marca se arma en tiempo de ejecución; la lista privada de estas pruebas es ficticia.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { entornoTemporal, correr, git, requiereHerramienta, RAIZ_REPO } = require('../helpers/entorno.cjs');
const { motivoProhibido, MAX_BYTES } = require('../../tools/verificar-publicacion.cjs');

const HERRAMIENTA = path.join(RAIZ_REPO, 'tools', 'verificar-publicacion.cjs');
const IDS = ['lista-negra', 'prohibidos', 'json', 'shell', 'bom', 'fin-de-linea', 'tamano', 'manifiesto', 'terceros', 'version'];
const u = (a, b) => a + b;
const BOM = String.fromCharCode(0xFEFF);
const esc = (texto) => texto.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

// El lint de publicación resuelve las rutas contra la raíz de ESTE repo y en Windows no puede cruzar de
// unidad (en CI el repo vive en D: y os.tmpdir() en C:). Los repos temporales van en la misma unidad.
function baseTemporal() {
  const unidad = (p) => path.parse(path.resolve(p)).root.toLowerCase();
  const candidatos = [process.env.RUNNER_TEMP, os.tmpdir(), path.dirname(RAIZ_REPO)].filter(Boolean);
  return candidatos.find((c) => unidad(c) === unidad(RAIZ_REPO)) || os.tmpdir();
}

function textoManifiesto({ importados = [], nuevos = [], grandes = [], terceros = [] } = {}) {
  return ['[importados]', ...importados, '', '[nuevos]', ...nuevos, '', '[grandes-permitidos]', ...grandes, '', '[terceros]', ...terceros, ''].join('\n');
}

// Repo git temporal con ayudantes. Devuelve null (y salta la prueba) si falta git.
function nuevoRepo(t) {
  if (!requiereHerramienta(t, 'git')) return null;
  const e = entornoTemporal('uaeh-vp-');
  e.env.UAEH_LINT_PRIVADO = ['cupoficticio', 'ClienteFicticio'].join('\n'); // lista privada ficticia para los repos de juguete
  const dir = fs.mkdtempSync(path.join(baseTemporal(), 'uaeh-vp-repo-'));
  t.after(() => {
    e.limpiar();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* en Windows puede quedar un instante bloqueado */ }
  });
  git(dir, ['init', '-q'], e.env);
  const r = {
    dir,
    e,
    escribir(rel, contenido) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contenido);
      return abs;
    },
    manifiesto(datos) { return r.escribir('tools/manifiesto-importacion.txt', textoManifiesto(datos)); },
    preparar(...rels) { git(dir, ['add', '-f', '--', ...(rels.length ? rels : ['.'])], e.env); },
    confirmar(mensaje = 'prueba') { git(dir, ['commit', '-q', '-m', mensaje], e.env); },
    etiquetar(nombre) { git(dir, ['tag', nombre], e.env); },
    verificar(args = []) { return correr(HERRAMIENTA, ['--raiz', dir, ...args], { env: e.env, cwd: e.dir }); },
  };
  return r;
}

const PLUGIN_X = ['plugins/x/.claude-plugin/plugin.json', 'plugins/x/skills/a/SKILL.md', 'plugins/x/git-hooks/pre-commit'];
const pluginJson = (version, nombre = 'x') => `${JSON.stringify({ name: nombre, version }, null, 2)}\n`;
const skillA = (descripcion = 'Prueba.') => `---\nname: a\ndescription: ${descripcion}\n---\n\n# a\n`;

// Contenido mínimo que pasa las diez comprobaciones: README, un plugin con skill y hook, y su manifiesto.
function baseLimpia(r, { nuevos = [], importados = [], grandes = [] } = {}) {
  r.escribir('README.md', '# Repo de prueba\n');
  r.escribir(PLUGIN_X[0], pluginJson('0.1.0'));
  r.escribir(PLUGIN_X[1], skillA());
  r.escribir(PLUGIN_X[2], '#!/bin/sh\nexit 0\n');
  r.manifiesto({ nuevos: [...PLUGIN_X, ...nuevos], importados, grandes });
}

test('un repo limpio pasa: exit 0, nueve comprobaciones OK y el aviso de que aún no hay tags', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.preparar(); // solo preparado, sin commit: lo preparado también se revisa
  const res = r.verificar();
  assert.equal(res.status, 0, res.stdout + res.stderr);
  for (const id of IDS.filter((x) => x !== 'version')) assert.match(res.stdout, new RegExp(`^OK  ${id} — `, 'm'), `${id}\n${res.stdout}`);
  assert.match(res.stdout, /^OK  lista-negra — 5 archivo\(s\) revisados, 0 hallazgos; lista privada: 2 patrón\(es\)$/m);
  assert.match(res.stdout, /^AVISO  version — sin tags todavía/m);
  assert.doesNotMatch(res.stdout, /FALLÓ {2}/);
  assert.match(res.stdout, /verificar-publicacion: OK — 0 comprobación\(es\) con FALLÓ, 1 con AVISO, 9 OK · 5 archivo\(s\) revisados\./);
  assert.match(res.stdout, /^OK  terceros — sin carpetas de terceros declaradas$/m);
});

test('lista-negra: un nombre prohibido en un archivo rastreado hace fallar la verificación', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('docs/nota.md', `una ruta ${u('Desk', 'top')}\\cosa\n`);
  r.preparar();
  const res = r.verificar();
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, new RegExp(`^FALLÓ  lista-negra — docs/nota\\.md: línea 1: «${u('Desk', 'top')}»`, 'm'));
  assert.match(res.stdout, /verificar-publicacion: FALLÓ — 1 comprobación\(es\) con FALLÓ/);
});

test('prohibidos: logs, .jsonl, .env*, llaves, respaldos, credenciales y node_modules fallan; los parecidos no', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  const malos = ['cosa.log', 'datos.jsonl', '.env', '.env.local', 'llave.pem', 'clave.key', 'settings.local.json', '.credentials.json', 'viejo.bak', 'viejo.bak.1', 'sub/node_modules/pkg/index.js'];
  const buenos = ['notas.md', 'catalogo.log.md', 'entorno.md', 'llavero.md', 'environment.md', 'monkey.md'];
  for (const rel of [...malos, ...buenos]) r.escribir(rel, rel.endsWith('.json') ? '{}\n' : 'x\n');
  r.preparar();
  const res = r.verificar();
  assert.equal(res.status, 1, res.stdout);
  for (const rel of malos) assert.match(res.stdout, new RegExp(`^FALLÓ  prohibidos — ${esc(rel)}: ruta o extensión prohibida`, 'm'), rel);
  for (const rel of buenos) assert.doesNotMatch(res.stdout, new RegExp(`prohibidos — ${esc(rel)}`), rel);
});

test('motivoProhibido ignora mayúsculas y no confunde nombres parecidos', () => {
  assert.equal(motivoProhibido('A/B/X.LOG'), '*.log');
  assert.equal(motivoProhibido('.ENV'), '.env / .env.*');
  assert.equal(motivoProhibido('config/.env.produccion'), '.env / .env.*');
  assert.equal(motivoProhibido('NODE_MODULES/x.js'), null, 'solo la carpeta exacta node_modules');
  assert.equal(motivoProhibido('a/node_modules/x.js'), 'carpeta node_modules/');
  assert.equal(motivoProhibido('.environment'), null);
  assert.equal(motivoProhibido('README.md'), null);
});

test('json: un .json que no parsea falla y los válidos (incluso con BOM) no fallan aquí', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('datos/roto.json', '{"a": ');
  r.escribir('datos/bien.json', '{"a": 1}\n');
  r.escribir('datos/vacio.json', '');
  r.escribir('datos/con-bom.json', `${BOM}{"a": 1}\n`);
  r.preparar();
  const res = r.verificar();
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^FALLÓ  json — datos\/roto\.json: no es JSON válido/m);
  assert.match(res.stdout, /^FALLÓ  json — datos\/vacio\.json: no es JSON válido/m);
  assert.doesNotMatch(res.stdout, /json — datos\/bien\.json/);
  assert.doesNotMatch(res.stdout, /json — datos\/con-bom\.json/, 'el BOM lo reporta la comprobación bom, no json');
  assert.match(res.stdout, /^FALLÓ  bom — datos\/con-bom\.json/m);
});

test('shell: CRLF, shebang ausente o ajeno en *.sh, git-hooks y wsl/bin falla; los válidos pasan', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r, { nuevos: ['plugins/x/git-hooks/commit-msg', 'plugins/x/wsl/bin/herramienta', 'plugins/x/git-hooks/crlf',
    'plugins/x/wsl/bin/ok-bash', 'plugins/x/wsl/bin/ok-python', 'plugins/x/wsl/ok-instalar.sh', 'plugins/x/wsl/python-fuera-de-bin.sh'] });
  // wsl/: programas de root con intérprete fijo (#!/bin/bash; en wsl/bin también #!/usr/bin/python3 -I); fuera de wsl/ no.
  r.escribir('plugins/x/wsl/bin/ok-bash', '#!/bin/bash\nset -eu\n');
  r.escribir('plugins/x/wsl/bin/ok-python', '#!/usr/bin/python3 -I\nprint(1)\n');
  r.escribir('plugins/x/wsl/ok-instalar.sh', '#!/bin/bash\nset -eu\n');
  r.escribir('plugins/x/wsl/python-fuera-de-bin.sh', '#!/usr/bin/python3 -I\nprint(1)\n');
  r.escribir('scripts/bash-fijo.sh', '#!/bin/bash\nset -e\n');
  r.escribir('scripts/crlf.sh', '#!/bin/sh\r\necho hola\r\n');
  r.escribir('scripts/sin-shebang.sh', 'echo hola\n');
  r.escribir('scripts/node.sh', '#!/usr/bin/env node\nconsole.log(1)\n');
  r.escribir('scripts/vacio.sh', '');
  r.escribir('plugins/x/git-hooks/commit-msg', 'exit 0\n');
  r.escribir('plugins/x/wsl/bin/herramienta', '#!/usr/bin/env python3\nprint(1)\n');
  r.escribir('plugins/x/git-hooks/crlf', '#!/bin/sh\r\nexit 0\r\n');
  r.escribir('scripts/ok-sh.sh', '#!/bin/sh\nexit 0\n');
  r.escribir('scripts/ok-bash.sh', '#!/usr/bin/env bash\nset -e\n');
  r.escribir('scripts/ok-env-sh.sh', '#!/usr/bin/env sh\nexit 0\n');
  r.preparar();
  const res = r.verificar();
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^FALLÓ  shell — scripts\/crlf\.sh: contiene CR/m);
  assert.match(res.stdout, /^FALLÓ  shell — scripts\/sin-shebang\.sh: primera línea «echo hola» inválida/m);
  assert.match(res.stdout, /^FALLÓ  shell — scripts\/node\.sh: primera línea «#!\/usr\/bin\/env node» inválida/m);
  assert.match(res.stdout, /^FALLÓ  shell — scripts\/vacio\.sh: primera línea «» inválida/m);
  assert.match(res.stdout, /^FALLÓ  shell — plugins\/x\/git-hooks\/commit-msg: primera línea/m, 'lo que cuelga de git-hooks cuenta aunque no termine en .sh');
  assert.match(res.stdout, /^FALLÓ  shell — plugins\/x\/wsl\/bin\/herramienta: primera línea «#!\/usr\/bin\/env python3» inválida/m);
  assert.match(res.stdout, /^FALLÓ  shell — plugins\/x\/git-hooks\/crlf: contiene CR/m);
  assert.doesNotMatch(res.stdout, /shell — scripts\/ok-/);
  assert.doesNotMatch(res.stdout, /shell — plugins\/x\/git-hooks\/pre-commit/);
  assert.doesNotMatch(res.stdout, /shell — plugins\/x\/wsl\/(bin\/ok-|ok-)/);
  assert.match(res.stdout, /^FALLÓ  shell — plugins\/x\/wsl\/python-fuera-de-bin\.sh: primera línea/m, 'python fijo solo en wsl/bin');
  assert.match(res.stdout, /^FALLÓ  shell — scripts\/bash-fijo\.sh: primera línea «#!\/bin\/bash» inválida/m, '#!/bin/bash solo bajo wsl/');
});

test('bom: un archivo de texto con BOM UTF-8 falla y un binario no', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('docs/bom.md', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hola\n')]));
  r.escribir('docs/limpio.md', 'hola\n');
  r.escribir('assets/raro.bin', Buffer.from([0xEF, 0xBB, 0xBF, 0x00, 0x01, 0x02]));
  r.preparar();
  const res = r.verificar();
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /^FALLÓ  bom — docs\/bom\.md: empieza con BOM UTF-8/m);
  assert.doesNotMatch(res.stdout, /bom — docs\/limpio\.md/);
  assert.doesNotMatch(res.stdout, /bom — assets\/raro\.bin/);
});

test('fin-de-linea: copia de trabajo distinta del eol= de .gitattributes avisa (no falla); la que coincide y la que no pide eol, no', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('.gitattributes', '* text=auto\n*.ps1 text eol=crlf\n*.md text eol=lf\n');
  r.escribir('scripts/lf.ps1', 'Write-Output 1\nexit 0\n');
  r.escribir('scripts/crlf.ps1', 'Write-Output 1\r\nexit 0\r\n');
  r.escribir('scripts/mezcla.ps1', 'Write-Output 1\r\nexit 0\n');
  r.escribir('docs/crlf.md', 'hola\r\nmundo\r\n');
  r.escribir('docs/libre.txt', 'hola\r\n');
  r.preparar();
  r.confirmar();
  const res = r.verificar();
  assert.equal(res.status, 0, 'solo avisa: lo publicado no cambia\n' + res.stdout);
  assert.match(res.stdout, /^AVISO  fin-de-linea — scripts\/lf\.ps1: la copia de trabajo está en LF y \.gitattributes pide CRLF/m);
  assert.match(res.stdout, /^AVISO  fin-de-linea — scripts\/mezcla\.ps1: la copia de trabajo mezcla LF y CRLF; \.gitattributes pide CRLF$/m);
  assert.match(res.stdout, /^AVISO  fin-de-linea — docs\/crlf\.md: la copia de trabajo está en CRLF y \.gitattributes pide LF/m);
  assert.doesNotMatch(res.stdout, /fin-de-linea — scripts\/crlf\.ps1/);
  assert.doesNotMatch(res.stdout, /fin-de-linea — docs\/libre\.txt/, 'sin eol= en sus atributos no se compara');
  assert.doesNotMatch(res.stdout, /fin-de-linea — README\.md/);
  // Reescribirla en CRLF y volver a prepararla quita el aviso sin cambiar el contenido rastreado.
  r.escribir('scripts/lf.ps1', 'Write-Output 1\r\nexit 0\r\n');
  r.preparar('scripts/lf.ps1');
  const despues = r.verificar();
  assert.doesNotMatch(despues.stdout, /fin-de-linea — scripts\/lf\.ps1/, despues.stdout);
  assert.equal(git(r.dir, ['status', '--porcelain', '--', 'scripts/lf.ps1'], r.e.env).stdout.trim(), '', 'sin cambios pendientes');
});

test('tamano: más de 200 KB falla salvo que esté en [grandes-permitidos]', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  assert.equal(MAX_BYTES, 200 * 1024);
  baseLimpia(r);
  r.escribir('docs/grande.txt', 'a'.repeat(201 * 1024));
  r.escribir('docs/justo.txt', 'b'.repeat(200 * 1024));
  r.preparar();
  const mal = r.verificar();
  assert.equal(mal.status, 1, mal.stdout);
  assert.match(mal.stdout, /^FALLÓ  tamano — docs\/grande\.txt: pesa 201 KB \(máximo 200 KB\)/m);
  assert.doesNotMatch(mal.stdout, /tamano — docs\/justo\.txt/, '200 KB exactos caben');

  baseLimpia(r, { grandes: ['docs/grande.txt'] });
  r.preparar();
  const bien = r.verificar();
  assert.equal(bien.status, 0, bien.stdout);
  assert.match(bien.stdout, /^OK  tamano — /m);
});

test('manifiesto: un archivo bajo plugins/ sin origen declarado falla; declararlo lo arregla', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('plugins/x/extra.txt', 'sin declarar\n');
  r.escribir('plugins/x/importado.txt', 'viene de afuera\n');
  r.escribir('docs/fuera-de-plugins.md', 'no necesita declaración\n');
  r.manifiesto({ nuevos: PLUGIN_X, importados: ['K/algo/importado.txt -> plugins/x/importado.txt'] });
  r.preparar();
  const mal = r.verificar();
  assert.equal(mal.status, 1, mal.stdout);
  assert.match(mal.stdout, /^FALLÓ  manifiesto — plugins\/x\/extra\.txt: sin origen declarado/m);
  assert.doesNotMatch(mal.stdout, /manifiesto — plugins\/x\/importado\.txt/, 'un destino de [importados] cuenta como declarado');
  assert.doesNotMatch(mal.stdout, /manifiesto — docs\//, 'solo se exige bajo plugins/');

  r.manifiesto({ nuevos: [...PLUGIN_X, 'plugins/x/extra.txt'], importados: ['K/algo/importado.txt -> plugins/x/importado.txt'] });
  r.preparar();
  const bien = r.verificar();
  assert.equal(bien.status, 0, bien.stdout);
  assert.match(bien.stdout, /^OK  manifiesto — 5 archivo\(s\) bajo plugins\/ con origen declarado/m);
});

test('terceros: carpeta de vendor íntegra pasa y cuenta como declarada; huella cambiada, archivo suelto o faltante y sin LICENSE fallan', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  const V = 'plugins/x/vendor/lib-a';
  const huella = (texto) => require('crypto').createHash('sha256').update(texto.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const archivos = { LICENSE: 'MIT License\n\nCopyright (c) 2026 Autor\n', 'src/a.py': 'print("a")\n' };
  const upstream = (extra = {}) => JSON.stringify({
    origen: 'https://example.com/lib-a', licencia: 'MIT', commit: 'a'.repeat(40),
    archivos: Object.fromEntries(Object.entries({ ...archivos, ...extra }).map(([k, v]) => [k, { sha256: huella(v) }])),
  }, null, 2);
  baseLimpia(r);
  for (const [k, v] of Object.entries(archivos)) r.escribir(`${V}/${k}`, v);
  r.escribir(`${V}/UPSTREAM.json`, upstream());
  r.escribir(`${V}/PATCHES/0001-x.patch`, 'explicación\n');
  r.manifiesto({ nuevos: PLUGIN_X, terceros: [V] });
  r.preparar();
  const bien = r.verificar();
  assert.equal(bien.status, 0, bien.stdout);
  assert.match(bien.stdout, /^OK  terceros — 1 carpeta\(s\) de terceros · 2 archivo\(s\) con su huella de origen$/m);
  assert.doesNotMatch(bien.stdout, /sin origen declarado/, 'lo que cuelga de [terceros] cuenta como declarado');

  r.escribir(`${V}/src/a.py`, 'print("cambiado")\n');
  r.escribir(`${V}/src/suelto.py`, 'x = 1\n');
  r.escribir(`${V}/UPSTREAM.json`, upstream({ 'src/falta.py': 'y = 2\n' }));
  r.preparar();
  const mal = r.verificar();
  assert.equal(mal.status, 1, mal.stdout);
  assert.match(mal.stdout, /^FALLÓ  terceros — plugins\/x\/vendor\/lib-a\/src\/a\.py: huella distinta de la de UPSTREAM\.json/m);
  assert.match(mal.stdout, /^FALLÓ  terceros — plugins\/x\/vendor\/lib-a\/src\/suelto\.py: no declarado en UPSTREAM\.json/m);
  assert.match(mal.stdout, /^FALLÓ  terceros — plugins\/x\/vendor\/lib-a\/src\/falta\.py: declarado en UPSTREAM\.json pero no está en el repo/m);

  fs.rmSync(path.join(r.dir, V), { recursive: true, force: true });
  r.escribir(`${V}/src/a.py`, archivos['src/a.py']);
  r.escribir(`${V}/UPSTREAM.json`, JSON.stringify({ origen: 'http://inseguro', archivos: {} }));
  git(r.dir, ['add', '-A', '--', 'plugins'], r.e.env);
  const sinLicencia = r.verificar();
  assert.equal(sinLicencia.status, 1, sinLicencia.stdout);
  for (const motivo of ['sin «origen» https', 'sin «licencia»', 'sin «commit»', 'carpeta de terceros sin LICENSE', 'src/a.py: no declarado']) {
    assert.ok(sinLicencia.stdout.includes(motivo), `${motivo}\n${sinLicencia.stdout}`);
  }
});

test('lista-negra con terceros: el texto de origen intacto se exime en la raíz verificada; cambiado o en UPSTREAM.json, no', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  const V = 'plugins/x/vendor/lib-a';
  const huella = (texto) => require('crypto').createHash('sha256').update(texto.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  const palabra = 'cupoficticio'; // palabra de la lista privada FICTICIA de esta prueba (la real no vive en el repo)
  const archivos = { LICENSE: 'MIT License\n\nCopyright (c) 2026 Autor\n', 'docs/a.md': `Per-user ${palabra} limits.\n` };
  const upstream = (extra = {}) => JSON.stringify({
    origen: 'https://example.com/lib-a', licencia: 'MIT', commit: 'b'.repeat(40), ...extra,
    archivos: Object.fromEntries(Object.entries(archivos).map(([k, v]) => [k, { sha256: huella(v) }])),
  }, null, 2);
  baseLimpia(r);
  for (const [k, v] of Object.entries(archivos)) r.escribir(`${V}/${k}`, v);
  r.escribir(`${V}/UPSTREAM.json`, upstream());
  r.manifiesto({ nuevos: PLUGIN_X, terceros: [V] });
  r.preparar();
  const bien = r.verificar();
  assert.equal(bien.status, 0, bien.stdout);
  assert.match(bien.stdout, /^OK  lista-negra — \d+ archivo\(s\) revisados, 0 hallazgos \(2 de terceros idénticos a su origen, eximidos\); lista privada: 2 patrón\(es\)$/m);

  r.escribir(`${V}/docs/a.md`, `Per-user ${palabra} limits (local).\n`);
  r.escribir(`${V}/UPSTREAM.json`, upstream({ incluye: `docs sobre ${palabra}` }));
  r.preparar();
  const mal = r.verificar();
  assert.equal(mal.status, 1, mal.stdout);
  assert.match(mal.stdout, /^FALLÓ  lista-negra — plugins\/x\/vendor\/lib-a\/docs\/a\.md: línea 1/m);
  assert.match(mal.stdout, /^FALLÓ  lista-negra — plugins\/x\/vendor\/lib-a\/UPSTREAM\.json: línea \d+/m);
});

test('manifiesto ausente o mal formado: falla si hay archivos bajo plugins/ y solo avisa si no los hay', (t) => {
  const sin = nuevoRepo(t);
  if (!sin) return;
  sin.escribir('README.md', '# sin plugins\n');
  sin.preparar();
  const aviso = sin.verificar();
  assert.equal(aviso.status, 0, aviso.stdout);
  assert.match(aviso.stdout, /^AVISO  manifiesto — manifiesto ilegible: no se pudo leer el manifiesto/m);

  const con = nuevoRepo(t);
  con.escribir(PLUGIN_X[1], skillA());
  con.preparar();
  const sinManifiesto = con.verificar();
  assert.equal(sinManifiesto.status, 1, sinManifiesto.stdout);
  assert.match(sinManifiesto.stdout, /^FALLÓ  manifiesto — manifiesto ilegible/m);

  con.escribir('tools/manifiesto-importacion.txt', '[importados]\nesto no tiene flecha\n');
  con.preparar();
  const roto = con.verificar();
  assert.equal(roto.status, 1, roto.stdout);
  assert.match(roto.stdout, /^FALLÓ  manifiesto — manifiesto ilegible: manifiesto-importacion\.txt:2:/m);
});

test('version: sin tags avisa; con tag, un plugin cambiado sin subir la version falla y subirla lo arregla', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.preparar();
  r.confirmar('base');
  const sinTags = r.verificar();
  assert.equal(sinTags.status, 0, sinTags.stdout);
  assert.match(sinTags.stdout, /^AVISO  version — sin tags todavía/m);

  r.etiquetar('v0.1.0');
  const igual = r.verificar();
  assert.equal(igual.status, 0, igual.stdout);
  assert.match(igual.stdout, /^OK  version — 1 plugin\(s\) comparados con v0\.1\.0/m);

  r.escribir(PLUGIN_X[1], skillA('Prueba cambiada.'));
  const sinSubir = r.verificar();
  assert.equal(sinSubir.status, 1, sinSubir.stdout);
  assert.match(sinSubir.stdout, /^FALLÓ  version — plugins\/x: cambió desde v0\.1\.0 pero su version sigue en 0\.1\.0: subir version/m);

  r.preparar();
  r.confirmar('cambio del skill');
  assert.equal(r.verificar().status, 1, 'confirmar el cambio no lo exime: se compara contra el tag');

  r.escribir(PLUGIN_X[0], pluginJson('0.2.0'));
  const subida = r.verificar();
  assert.equal(subida.status, 0, subida.stdout);
  assert.doesNotMatch(subida.stdout, /FALLÓ {2}version/);
});

test('version: el último tag se elige por número de versión, y un plugin posterior al tag no exige nada', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.preparar();
  r.confirmar('base');
  r.etiquetar('v0.9.0');
  r.escribir(PLUGIN_X[0], pluginJson('0.10.0'));
  r.preparar();
  r.confirmar('sube a 0.10.0');
  r.etiquetar('v0.10.0');

  r.escribir(PLUGIN_X[1], skillA('Otro cambio.'));
  const res = r.verificar();
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /cambió desde v0\.10\.0 pero su version sigue en 0\.10\.0/, 'v0.10.0 gana a v0.9.0');

  r.escribir(PLUGIN_X[1], skillA());
  r.escribir('plugins/y/.claude-plugin/plugin.json', pluginJson('0.0.1', 'y'));
  r.manifiesto({ nuevos: [...PLUGIN_X, 'plugins/y/.claude-plugin/plugin.json'] });
  r.preparar();
  const nuevoPlugin = r.verificar();
  assert.equal(nuevoPlugin.status, 0, nuevoPlugin.stdout);
  assert.match(nuevoPlugin.stdout, /^OK  version — 2 plugin\(s\) comparados con v0\.10\.0/m);
});

test('--json entrega las diez comprobaciones con estado, detalle y hallazgos', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('cosa.log', 'x\n');
  r.preparar();
  const res = r.verificar(['--json']);
  assert.equal(res.status, 1);
  const j = res.json();
  assert.deepEqual(j.comprobaciones.map((c) => c.id), IDS);
  assert.equal(j.archivos, 6);
  assert.deepEqual(j.totales, { ok: 8, avisos: 1, fallaron: 1 });
  const prohibidos = j.comprobaciones.find((c) => c.id === 'prohibidos');
  assert.equal(prohibidos.estado, 'FALLÓ');
  assert.deepEqual(prohibidos.items.map((i) => [i.estado, i.archivo]), [['FALLÓ', 'cosa.log']]);
  assert.equal(j.comprobaciones.find((c) => c.id === 'version').estado, 'AVISO');
  assert.equal(j.comprobaciones.find((c) => c.id === 'json').estado, 'OK');
});

test('--con-nuevos suma los archivos sin git add; por defecto solo cuentan los rastreados y preparados', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.preparar();
  r.escribir('suelto.log', 'aún sin git add\n');
  const porDefecto = r.verificar();
  assert.equal(porDefecto.status, 0, porDefecto.stdout);
  const conNuevos = r.verificar(['--con-nuevos']);
  assert.equal(conNuevos.status, 1, conNuevos.stdout);
  assert.match(conNuevos.stdout, /^FALLÓ  prohibidos — suelto\.log/m);
});

test('un archivo borrado del disco y aún no preparado no se revisa', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  baseLimpia(r);
  r.escribir('cosa.log', 'x\n');
  r.preparar();
  fs.rmSync(path.join(r.dir, 'cosa.log'));
  const res = r.verificar();
  assert.equal(res.status, 0, res.stdout);
});

test('uso incorrecto: opción desconocida, --raiz sin valor, carpeta inexistente o que no es repo salen con 2', (t) => {
  const r = nuevoRepo(t);
  if (!r) return;
  assert.equal(correr(HERRAMIENTA, ['--rara'], { env: r.e.env }).status, 2);
  const sinValor = correr(HERRAMIENTA, ['--raiz'], { env: r.e.env });
  assert.equal(sinValor.status, 2);
  assert.match(sinValor.stderr, /falta el valor de --raiz/);
  const noExiste = correr(HERRAMIENTA, ['--raiz', path.join(r.dir, 'no-existe')], { env: r.e.env });
  assert.equal(noExiste.status, 2);
  assert.match(noExiste.stderr, /no existe la carpeta/);
  // Una carpeta que no es repositorio; el techo de git impide que suba a un repositorio ajeno.
  const vacia = path.join(r.dir, 'vacia');
  fs.mkdirSync(vacia);
  const env = { ...r.e.env, GIT_CEILING_DIRECTORIES: r.dir };
  const noRepo = correr(HERRAMIENTA, ['--raiz', vacia], { env, cwd: r.e.dir });
  // Dentro de r.dir (que sí es repo) git sí encuentra el repo si el techo no lo impide; aquí lo impide.
  assert.equal(noRepo.status, 2, noRepo.stdout + noRepo.stderr);
  assert.match(noRepo.stderr, /no es un repositorio git/);
});

test('sobre el repo real corre sin tronar y su código de salida es coherente con su informe', (t) => {
  const e = entornoTemporal('uaeh-vp-real-');
  t.after(() => e.limpiar());
  if (!requiereHerramienta(t, 'git')) return;
  const res = correr(HERRAMIENTA, ['--json'], { env: e.env });
  assert.ok(res.status === 0 || res.status === 1, `salida inesperada ${res.status}\n${res.stderr}`);
  const j = res.json();
  assert.ok(j && Array.isArray(j.comprobaciones), 'JSON legible');
  assert.deepEqual(j.comprobaciones.map((c) => c.id), IDS);
  assert.equal(res.status === 1, j.totales.fallaron > 0);
  const texto = correr(HERRAMIENTA, [], { env: e.env });
  assert.equal(texto.status, res.status);
  assert.match(texto.stdout, /verificar-publicacion: (OK|FALLÓ) — /);
});
