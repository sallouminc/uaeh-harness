// tests/harness/codex-plantillas.test.cjs — plantillas opcionales de Codex del plugin uaeh-harness (carpeta codex/).
//
// Son PLANTILLAS: el instalador las rinde sustituyendo marcadores {{…}} y las escribe en la configuración de Codex del
// usuario. Estas pruebas fijan lo que el instalador y el sello necesitan de ellas:
//   · AGENTS.md: delimitado EXACTAMENTE por «<!-- UAEH:BEGIN v{{VERSION}} -->» y «<!-- UAEH:END -->» (así lo reconoce y
//     lo reemplaza el instalador sin tocar el resto del archivo del usuario), con las rutas de los scripts como
//     {{UAEH_ESTABLE}} y sin ninguna ruta de la máquina del autor.
//   · agents/uae_*.toml: modelo y esfuerzo como marcadores del MISMO nivel (profundo / equilibrado / rápido), sandbox_mode
//     presente y declarado «no es garantía», instrucciones en una cadena multilínea cerrada. La sintaxis se valida con un
//     lector mínimo y ESTRICTO (solo admite lo que estas plantillas usan): una línea rara es un error, no se ignora.
//   · config.snippet.toml: SOLO cuatro claves, cada una con su comentario; el plugin nunca toca el config.toml del usuario.
// Hermético: no lee la configuración real de Codex ni de Claude.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO, RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');
const { revisarArchivo: revisarListaNegra } = require('../../tools/lint-publicacion.cjs');

const comun = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'comun.cjs'));
const { modelosCodex, CONFIG_DEFECTO } = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));

const DIR_CODEX = path.join(RAIZ_HARNESS, 'codex');
const DIR_TOML = path.join(DIR_CODEX, 'agents');
const RUTA_AGENTS = path.join(DIR_CODEX, 'AGENTS.md');
const RUTA_SNIPPET = path.join(DIR_CODEX, 'config.snippet.toml');
const RUTA_README = path.join(DIR_CODEX, 'README.md');

const MARCADORES = ['VERSION', 'UAEH_ESTABLE', 'MODELO_PROFUNDO', 'ESFUERZO_PROFUNDO', 'MODELO_EQUILIBRADO', 'ESFUERZO_EQUILIBRADO', 'MODELO_RAPIDO', 'ESFUERZO_RAPIDO'];
const NIVEL_POR_AGENTE = { uae_architect: 'PROFUNDO', uae_security: 'PROFUNDO', uae_verifier: 'EQUILIBRADO', uae_builder: 'RAPIDO', uae_triage: 'RAPIDO' };
const SANDBOX_POR_AGENTE = { uae_architect: 'read-only', uae_security: 'read-only', uae_verifier: 'read-only', uae_triage: 'read-only', uae_builder: 'workspace-write' };
const ESFUERZOS = ['low', 'medium', 'high', 'xhigh'];

const leer = (ruta) => fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const rel = (abs) => path.relative(RAIZ_REPO, abs).split(path.sep).join('/');

function archivosDe(dir) {
  const salida = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) salida.push(...archivosDe(p));
    else salida.push(p);
  }
  return salida.sort();
}

function renderizar(texto, valores) {
  return texto.replace(/\{\{([A-Z_]+)\}\}/g, (todo, clave) => (Object.prototype.hasOwnProperty.call(valores, clave) ? valores[clave] : todo));
}

// Lector mínimo y estricto de las plantillas TOML: comentarios, líneas en blanco, `clave = "cadena"` y
// `clave = """` … `"""`. Cualquier otra forma lanza. Devuelve { claves, comentarios }.
function leerPlantilla(texto) {
  const lineas = texto.split('\n');
  const claves = {};
  const comentarios = [];
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    if (!linea.trim()) continue;
    if (linea.trimStart().startsWith('#')) { comentarios.push(linea); continue; }
    let m = /^([A-Za-z_][A-Za-z0-9_]*) = """$/.exec(linea);
    if (m) {
      assert.ok(!(m[1] in claves), `clave repetida: ${m[1]}`);
      const cuerpo = [];
      let cerrada = false;
      for (i++; i < lineas.length; i++) {
        if (lineas[i] === '"""') { cerrada = true; break; }
        cuerpo.push(lineas[i]);
      }
      claves[m[1]] = { tipo: 'multilinea', valor: cuerpo.join('\n'), cerrada };
      continue;
    }
    m = /^([A-Za-z_][A-Za-z0-9_]*) = "([^"\\]*)"$/.exec(linea);
    if (m) {
      assert.ok(!(m[1] in claves), `clave repetida: ${m[1]}`);
      claves[m[1]] = { tipo: 'cadena', valor: m[2] };
      continue;
    }
    throw new Error(`línea que la plantilla no admite: «${linea}»`);
  }
  return { claves, comentarios };
}

const ARCHIVOS_CODEX = fs.existsSync(DIR_CODEX) ? archivosDe(DIR_CODEX) : [];

// ── AGENTS.md ──────────────────────────────────────────────────────────────────────────

test('AGENTS.md: empieza con UAEH:BEGIN v{{VERSION}}, termina con UAEH:END y trae {{UAEH_ESTABLE}} al menos dos veces', () => {
  const t = leer(RUTA_AGENTS);
  assert.ok(t.startsWith('<!-- UAEH:BEGIN v{{VERSION}} -->\n'), 'la primera línea debe ser el marcador de inicio con la versión');
  assert.ok(t.trimEnd().endsWith('\n<!-- UAEH:END -->'), 'la última línea debe ser el marcador de fin');
  assert.equal((t.match(/UAEH:BEGIN/g) || []).length, 1);
  assert.equal((t.match(/UAEH:END/g) || []).length, 1);
  assert.ok((t.match(/\{\{UAEH_ESTABLE\}\}/g) || []).length >= 2);
  assert.ok(!t.includes('$HOME/.claude'), 'los scripts se citan por {{UAEH_ESTABLE}}, no por una ruta fija del usuario');
  for (const prohibido of ['~/.claude/', '~/.codex/', 'C:\\', 'C:/', '/mnt/c/']) assert.ok(!t.includes(prohibido), `AGENTS.md contiene «${prohibido}»`);
});

test('AGENTS.md: ya rendido, el instalador del kit y del arnés reconocen el bloque (marcadores y versión)', () => {
  const rendido = renderizar(leer(RUTA_AGENTS), { VERSION: '1.2.3', UAEH_ESTABLE: '/espejo/uaeh-harness' });
  assert.ok(!rendido.includes('{{'), 'quedó un marcador sin rellenar');
  assert.deepEqual(comun.bloqueUaeh(rendido), { presente: true, version: '1.2.3' });
  // Dentro del archivo de un usuario, entre contenido propio: sigue reconociéndose.
  assert.deepEqual(comun.bloqueUaeh(`# Mis notas\n\n${rendido}\n## Otras reglas\n`), { presente: true, version: '1.2.3' });
});

test('AGENTS.md: contiene el protocolo (lista blanca, sello, registro, relevo) con los seis estados finales', () => {
  const t = leer(RUTA_AGENTS);
  for (const trozo of ['Lista blanca', 'Todo lo demás va DIRECTO', 'Dentro de la lista blanca', 'Relevo desde Claude Code', 'Juntar pasos', '<carpeta-de-copias>/<proyecto>-<tarea>', '`listaBlanca`', '`commits.credito`', '`commits.firma`']) {
    assert.ok(t.includes(trozo), `AGENTS.md: falta «${trozo}»`);
  }
  for (const estado of ['PASS_TECHNICAL', 'PASS_RELEASE_READY', 'PENDING_HUMAN_REVIEW', 'BLOCKED_SECURITY', 'FAIL', 'UNKNOWN']) assert.ok(t.includes(estado), `AGENTS.md: falta el estado ${estado}`);
  assert.ok(!/Authored By/i.test(t), 'la firma de los commits es política del usuario, no del plugin');
});

test('AGENTS.md: los comandos del sello y del registro existen en el plugin y el de registro funciona una vez rendido', () => {
  const t = leer(RUTA_AGENTS);
  assert.ok(t.includes('node "{{UAEH_ESTABLE}}/scripts/uaeh-integridad.cjs" foto <repo>'));
  assert.ok(t.includes('node "{{UAEH_ESTABLE}}/scripts/uaeh-integridad.cjs" comparar <id> <repo>'));
  for (const script of ['uaeh-integridad.cjs', 'uaeh-registro.cjs']) assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, 'scripts', script)), `el espejo estable debe llevar scripts/${script}`);

  const linea = t.split('\n').map((l) => l.trim()).find((l) => l.startsWith('node "{{UAEH_ESTABLE}}/scripts/uaeh-registro.cjs"'));
  assert.ok(linea, 'AGENTS.md no trae el comando de registro en una sola línea');
  assert.deepEqual([...linea.matchAll(/--([a-z]+)/g)].map((m) => m[1]).sort(), ['ciclos', 'escalamiento', 'estado', 'minutos', 'proyecto', 'riesgo', 'ruta', 'tarea']);
  const ruta = /--ruta <([a-z|]+)>/.exec(linea)[1].split('|')[0];
  const riesgo = /--riesgo <([a-z|]+)>/.exec(linea)[1].split('|')[0];

  const e = entornoTemporal();
  try {
    const r = correr(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-registro.cjs'), [
      '--proyecto', 'proyecto-de-prueba', '--ruta', ruta, '--riesgo', riesgo, '--ciclos', '1', '--minutos', '12',
      '--escalamiento', 'ninguno', '--estado', 'PASS_TECHNICAL', '--tarea', 'prueba desde AGENTS.md',
    ], { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 0, r.stderr);
    const filas = leer(path.join(e.uaehHome, 'registro.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(filas.length, 1);
    assert.equal(filas[0].estado, 'PASS_TECHNICAL');
  } finally { e.limpiar(); }
});

// ── agents/uae_*.toml ──────────────────────────────────────────────────────────────────

test('agents/: están los cinco agentes de Codex y nada más', () => {
  assert.deepEqual(fs.readdirSync(DIR_TOML).sort(), Object.keys(NIVEL_POR_AGENTE).sort().map((n) => `${n}.toml`));
});

for (const nombre of Object.keys(NIVEL_POR_AGENTE)) {
  test(`plantilla ${nombre}.toml: name igual al archivo, modelo y esfuerzo del mismo nivel, sandbox_mode e instrucciones cerradas`, () => {
    const { claves, comentarios } = leerPlantilla(leer(path.join(DIR_TOML, `${nombre}.toml`)));
    assert.deepEqual(Object.keys(claves).sort(), ['description', 'developer_instructions', 'model', 'model_reasoning_effort', 'name', 'sandbox_mode']);
    assert.equal(claves.name.valor, nombre);
    const nivel = NIVEL_POR_AGENTE[nombre];
    assert.equal(claves.model.valor, `{{MODELO_${nivel}}}`);
    assert.equal(claves.model_reasoning_effort.valor, `{{ESFUERZO_${nivel}}}`);
    assert.equal(claves.sandbox_mode.valor, SANDBOX_POR_AGENTE[nombre]);
    assert.ok(claves.description.valor.length > 20 && claves.description.valor.startsWith('UAEH:'));
    const instr = claves.developer_instructions;
    assert.equal(instr.tipo, 'multilinea');
    assert.ok(instr.cerrada, 'la cadena multilínea de developer_instructions no está cerrada con «"""»');
    assert.ok(instr.valor.trim().length > 200, 'developer_instructions está vacía o es demasiado corta');
    assert.ok(!instr.valor.includes('\\'), 'una barra invertida dentro de una cadena TOML básica es una secuencia de escape');
    assert.ok(comentarios.some((c) => /sandbox_mode NO es una garantía/.test(c)), 'falta el comentario de que el sandbox no es garantía');
    assert.ok(comentarios.some((c) => /sello de integridad/.test(c)), 'el comentario debe decir cuál es la garantía real');
    for (const c of comentarios) assert.ok(!c.includes('{{'), 'los comentarios no nombran marcadores (el instalador los sustituiría también ahí)');
  });
}

test('plantillas de Codex: rendidas con los modelos por defecto de la configuración quedan completas y con un esfuerzo válido', () => {
  const modelos = modelosCodex(CONFIG_DEFECTO);
  assert.deepEqual(Object.keys(modelos).sort(), ['equilibrado', 'profundo', 'rapido']);
  const valores = {};
  for (const [nivel, { modelo, esfuerzo }] of Object.entries(modelos)) {
    valores[`MODELO_${nivel.toUpperCase()}`] = modelo;
    valores[`ESFUERZO_${nivel.toUpperCase()}`] = esfuerzo;
    assert.ok(ESFUERZOS.includes(esfuerzo), `esfuerzo de «${nivel}» fuera de ${ESFUERZOS.join('|')}`);
  }
  for (const nombre of Object.keys(NIVEL_POR_AGENTE)) {
    const rendido = renderizar(leer(path.join(DIR_TOML, `${nombre}.toml`)), valores);
    assert.ok(!rendido.includes('{{'), `${nombre}: quedó un marcador sin rellenar`);
    const { claves } = leerPlantilla(rendido);
    const nivel = NIVEL_POR_AGENTE[nombre].toLowerCase();
    assert.equal(claves.model.valor, modelos[nivel].modelo);
    assert.equal(claves.model_reasoning_effort.valor, modelos[nivel].esfuerzo);
  }
});

test('marcadores: las plantillas usan solo los que el instalador rellena y cada uno se usa al menos una vez', () => {
  const usados = new Set();
  for (const abs of [RUTA_AGENTS, RUTA_SNIPPET, ...fs.readdirSync(DIR_TOML).map((f) => path.join(DIR_TOML, f))]) {
    for (const m of leer(abs).matchAll(/\{\{([A-Z_]+)\}\}/g)) usados.add(m[1]);
  }
  assert.deepEqual([...usados].sort(), [...MARCADORES].sort());
});

// ── config.snippet.toml ────────────────────────────────────────────────────────────────

test('config.snippet.toml: exactamente las cuatro claves, cada una con su comentario, y ninguna otra asignación', () => {
  const lineas = leer(RUTA_SNIPPET).split('\n');
  assert.ok(lineas[0].startsWith('# Fragmento para pegar a mano en ~/.codex/config.toml; el plugin nunca lo copia ni lo edita'));
  const activas = lineas.map((linea, i) => ({ linea, i })).filter(({ linea }) => linea.trim() && !linea.trimStart().startsWith('#'));
  assert.deepEqual(activas.map(({ linea }) => linea), [
    'project_doc_fallback_filenames = ["CLAUDE.md"]',
    'project_doc_max_bytes = 49152',
    '[agents]',
    'max_concurrent_threads_per_session = 4',
    '[windows]',
    'sandbox = "elevated"',
  ]);
  assert.equal(activas.filter(({ linea }) => linea.includes('=')).length, 4);
  for (const { linea, i } of activas) {
    if (linea.includes('=')) assert.ok(lineas[i - 1].trimStart().startsWith('#'), `«${linea}» no tiene comentario de para qué sirve`);
  }
});

// ── README.md ──────────────────────────────────────────────────────────────────────────

test('README.md: bilingüe (inglés primero), opcional y apagado, privacidad, instalador en seco y config.toml intacto', () => {
  const t = leer(RUTA_README);
  const iEn = t.indexOf('# uaeh-harness · codex/ — optional Codex templates');
  const iSeparador = t.indexOf('\n---\n');
  const iEs = t.indexOf('# uaeh-harness · codex/ — plantillas opcionales de Codex');
  assert.ok(iEn === 0 && iSeparador > iEn && iEs > iSeparador, 'el orden debe ser: inglés, «---», español');
  const en = t.slice(0, iSeparador);
  const es = t.slice(iSeparador);
  for (const re of [/OFF by default/, /codex\.habilitado = false/, /OpenAI/, /clean copy of your repository/, /scripts\/instalar\.cjs" codex/, /--aplicar/, /never touched automatically/, /not a guarantee/]) assert.match(en, re);
  for (const re of [/APAGADO por defecto/, /codex\.habilitado = false/, /OpenAI/, /copia limpia de tu repositorio/, /scripts\/instalar\.cjs" codex/, /--aplicar/, /nunca se toca automáticamente/, /no es una garantía/]) assert.match(es, re);
  for (const marcador of MARCADORES) {
    assert.ok(en.includes(`{{${marcador}}}`) && es.includes(`{{${marcador}}}`), `el README debe documentar el marcador ${marcador} en los dos idiomas`);
  }
});

// ── Toda la carpeta ────────────────────────────────────────────────────────────────────

test('codex/: contiene exactamente los archivos esperados, sin BOM y sin hallazgos de la lista negra de publicación', () => {
  assert.deepEqual(ARCHIVOS_CODEX.map(rel).sort(), [
    'plugins/uaeh-harness/codex/AGENTS.md',
    ...Object.keys(NIVEL_POR_AGENTE).sort().map((n) => `plugins/uaeh-harness/codex/agents/${n}.toml`),
    'plugins/uaeh-harness/codex/config.snippet.toml',
    'plugins/uaeh-harness/codex/README.md',
  ].sort());
  for (const abs of ARCHIVOS_CODEX) {
    const buf = fs.readFileSync(abs);
    assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), `${rel(abs)} empieza con BOM`);
    assert.deepEqual(revisarListaNegra(rel(abs)), [], `${rel(abs)} tiene hallazgos de la lista negra`);
  }
});
