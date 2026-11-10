// tests/harness/agentes-y-skills.test.cjs — agentes de revisión y skill uae-loop del plugin uaeh-harness (capa 2).
//
// Qué protege cada grupo de pruebas:
//   · Frontmatter: un agente de plugin IGNORA `hooks`, `permissionMode`, `mcpServers` e `initialPrompt`. Si alguno
//     reaparece, el candado o el permiso que creemos tener no existe. Además la descripción de cada agente y skill se
//     carga en TODAS las sesiones: se presupuesta (≤ 350 caracteres) y debe ser YAML plano válido.
//   · Herramientas: los revisores y los agentes de solo lectura niegan escribir; el constructor sí puede.
//   · Contratos de máquina: el YAML del verificador, el JSON del triage y los seis estados finales no cambian de forma
//     (otros scripts, el registro y la guardia de cierre dependen de ellos).
//   · Portabilidad: ni agentes ni skill llevan rutas de una máquina ni de la configuración personal; las rutas del plugin
//     solo viajan en SKILL.md vía ${CLAUDE_PLUGIN_ROOT} (en las referencias y en los archivos que se leen con Read no se
//     sustituye) y siempre entre comillas, porque la carpeta de instalación puede tener espacios.
//   · La documentación se ejecuta: los comandos que SKILL.md manda correr funcionan contra los scripts reales.
// Todo es hermético: casa temporal de tests/helpers/entorno.cjs; nada lee la configuración real.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO, RAIZ_HARNESS, entornoTemporal, correr } = require('../helpers/entorno.cjs');
const { parsearFrontmatter, MAX_DESCRIPCION, contar } = require('../../tools/verificar-presupuesto.cjs');
const { revisarArchivo: revisarListaNegra } = require('../../tools/lint-publicacion.cjs');

const DIR_AGENTES = path.join(RAIZ_HARNESS, 'agents');
const DIR_SKILL = path.join(RAIZ_HARNESS, 'skills', 'uae-loop');
const RUTA_SKILL = path.join(DIR_SKILL, 'SKILL.md');
const DIR_REFERENCIAS = path.join(DIR_SKILL, 'referencias');

const RAIZ_PLUGIN = '${CLAUDE_PLUGIN_ROOT}';
const PREFIJO = 'uaeh-harness:';
const AGENTES_CAPA_2 = ['uae-architect', 'uae-builder', 'uae-security', 'uae-triage', 'uae-verifier'];
const ESTADOS_FINALES = ['PASS_TECHNICAL', 'PASS_RELEASE_READY', 'PENDING_HUMAN_REVIEW', 'BLOCKED_SECURITY', 'FAIL', 'UNKNOWN'];

// Claves que un agente de plugin acepta, y las que ignora en silencio (por eso están prohibidas). La clave de herramientas
// denegadas se arma por partes para no activar la lista negra de publicación, que busca una subcadena dentro de ella.
const DENEGADAS = 'disal' + 'lowedTools';
const CLAVES_ACEPTADAS = new Set(['name', 'description', 'model', 'effort', 'maxTurns', 'autoCompactWindow', 'tools', DENEGADAS, 'skills', 'memory', 'background', 'omitClaudeMd', 'isolation', 'color']);
const CLAVES_IGNORADAS = ['hooks', 'permissionMode', 'mcpServers', 'initialPrompt'];

const leer = (ruta) => fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const escaparRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lista = (valor) => String(valor || '').split(',').map((s) => s.trim()).filter(Boolean);
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

// Líneas del frontmatter (entre las dos primeras «---») y cuerpo. null si no hay frontmatter cerrado.
function dividir(texto) {
  const lineas = texto.split('\n');
  if (lineas[0].trimEnd() !== '---') return null;
  const fin = lineas.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (fin === -1) return null;
  return { frontmatter: lineas.slice(1, fin), cuerpo: lineas.slice(fin + 1).join('\n') };
}

// Bloques de código con cercado ``` (con o sin sangría) → contenido de cada uno.
function bloquesDeCodigo(texto, lenguaje) {
  const salida = [];
  const re = /^[ \t]*```([A-Za-z]*)[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm;
  let m;
  while ((m = re.exec(texto))) if (!lenguaje || m[1] === lenguaje) salida.push(m[2]);
  return salida;
}

const NOMBRES_ARCHIVOS_AGENTES = fs.existsSync(DIR_AGENTES) ? fs.readdirSync(DIR_AGENTES).filter((f) => f.endsWith('.md')).sort() : [];
const ARCHIVOS_PUBLICOS = [...(fs.existsSync(DIR_AGENTES) ? archivosDe(DIR_AGENTES) : []), ...(fs.existsSync(DIR_SKILL) ? archivosDe(DIR_SKILL) : [])];
const REFERENCIAS = ['concurrencia.md', 'estados-y-paro.md', 'puertas.md'];

// ── Agentes: forma ─────────────────────────────────────────────────────────────────────

test('el plugin se llama uaeh-harness (el prefijo que citan agentes y skill) y trae los cinco agentes de la capa 2', () => {
  const manifiesto = JSON.parse(leer(path.join(RAIZ_HARNESS, '.claude-plugin', 'plugin.json')));
  assert.equal(manifiesto.name, 'uaeh-harness');
  assert.equal(PREFIJO, `${manifiesto.name}:`);
  for (const nombre of AGENTES_CAPA_2) assert.ok(NOMBRES_ARCHIVOS_AGENTES.includes(`${nombre}.md`), `falta agents/${nombre}.md`);
});

for (const archivo of NOMBRES_ARCHIVOS_AGENTES) {
  const nombre = archivo.replace(/\.md$/, '');
  const texto = leer(path.join(DIR_AGENTES, archivo));

  test(`agente ${nombre}: frontmatter cerrado, name igual al archivo y solo claves que el plugin respeta`, () => {
    const partes = dividir(texto);
    assert.ok(partes, 'sin frontmatter cerrado por «---»');
    assert.ok(!partes.frontmatter.join('\n').includes('---'), 'una «---» dentro del frontmatter lo cortaría antes de tiempo');
    const { error, datos } = parsearFrontmatter(texto);
    assert.equal(error, null);
    assert.equal(datos.name, nombre);
    for (const clave of CLAVES_IGNORADAS) assert.ok(!(clave in datos), `«${clave}» lo ignora un agente de plugin: no sirve y engaña`);
    for (const clave of Object.keys(datos)) assert.ok(CLAVES_ACEPTADAS.has(clave), `clave de frontmatter desconocida: ${clave}`);
    assert.ok(partes.cuerpo.trim().length > 200, 'el cuerpo (las instrucciones del agente) está vacío o es demasiado corto');
  });

  test(`agente ${nombre}: descripción no vacía, ≤ ${MAX_DESCRIPCION} caracteres y YAML plano válido`, () => {
    const { datos } = parsearFrontmatter(texto);
    assert.ok(datos.description, 'descripción vacía');
    assert.ok(contar(datos.description) <= MAX_DESCRIPCION, `la descripción tiene ${contar(datos.description)} caracteres`);
    assert.match(datos.description, /Úsalo/, 'recortar la descripción no puede quitarle el «cuándo usarlo»');
    const cruda = dividir(texto).frontmatter.find((l) => l.startsWith('description:')).slice('description:'.length).trim();
    if (!/^["'>|]/.test(cruda)) {
      assert.ok(!/:\s/.test(cruda), 'un «: » dentro de un valor YAML plano lo vuelve inválido; usa «—» o paréntesis');
      assert.ok(!/\s#/.test(cruda), 'un « #» dentro de un valor YAML plano abre un comentario y recorta la descripción');
    }
  });
}

// ── Agentes: herramientas y modelos ────────────────────────────────────────────────────

function agente(nombre) {
  const { datos } = parsearFrontmatter(leer(path.join(DIR_AGENTES, `${nombre}.md`)));
  return { datos, tools: lista(datos.tools), negadas: lista(datos[DENEGADAS]), cuerpo: dividir(leer(path.join(DIR_AGENTES, `${nombre}.md`))).cuerpo };
}

test('uae-verifier y uae-security: revisores de solo lectura (sin Write/Edit/NotebookEdit en tools y negados aparte)', () => {
  for (const nombre of ['uae-verifier', 'uae-security']) {
    const a = agente(nombre);
    for (const t of ['Write', 'Edit', 'NotebookEdit']) {
      assert.ok(a.negadas.includes(t), `${nombre}: debe negar ${t}`);
      assert.ok(!a.tools.includes(t), `${nombre}: no debe ofrecer ${t}`);
    }
    assert.ok(a.tools.includes('Bash'), `${nombre}: corre pruebas con Bash (el candado de solo lectura lo vigila)`);
  }
});

test('uae-architect y uae-triage: solo leen (Read, Grep, Glob) y niegan escribir y ejecutar', () => {
  for (const nombre of ['uae-architect', 'uae-triage']) {
    const a = agente(nombre);
    assert.deepEqual(a.tools, ['Read', 'Grep', 'Glob'], `${nombre}: tools`);
    for (const t of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.ok(a.negadas.includes(t), `${nombre}: debe negar ${t}`);
  }
});

test('uae-builder: es el único que escribe, y no niega herramientas', () => {
  const a = agente('uae-builder');
  assert.ok(a.tools.includes('Write') && a.tools.includes('Edit'));
  assert.deepEqual(a.negadas, []);
});

test('modelo y esfuerzo de cada agente (security y architect en el modelo profundo; el resto en el económico)', () => {
  const esperado = {
    'uae-security': ['opus', 'high'], 'uae-architect': ['opus', 'high'],
    'uae-verifier': ['sonnet', 'high'], 'uae-builder': ['sonnet', 'medium'], 'uae-triage': ['sonnet', 'low'],
  };
  for (const [nombre, [modelo, esfuerzo]] of Object.entries(esperado)) {
    const { datos } = agente(nombre);
    assert.equal(datos.model, modelo, `${nombre}: model`);
    assert.equal(datos.effort, esfuerzo, `${nombre}: effort`);
  }
});

test('hooks/candados.json: los agentes bajo el candado de solo lectura que existen aquí también niegan escribir', () => {
  const candados = JSON.parse(leer(path.join(RAIZ_HARNESS, 'hooks', 'candados.json')));
  const bajoCandado = candados['solo-lectura'];
  assert.ok(bajoCandado.includes('uae-verifier') && bajoCandado.includes('uae-security'));
  for (const nombre of bajoCandado) {
    if (!NOMBRES_ARCHIVOS_AGENTES.includes(`${nombre}.md`)) continue; // browser-verifier llega con la capa 3
    const a = agente(nombre);
    for (const t of ['Write', 'Edit', 'NotebookEdit']) assert.ok(a.negadas.includes(t), `${nombre}: debe negar ${t}`);
  }
});

// ── Agentes: contenido y contratos ─────────────────────────────────────────────────────

test('uae-verifier: el YAML de salida conserva sus claves, en orden, y no depende de un script del autor', () => {
  const { cuerpo } = agente('uae-verifier');
  const [yaml] = bloquesDeCodigo(cuerpo, 'yaml');
  assert.ok(yaml, 'falta el bloque yaml de salida');
  const claves = yaml.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
  assert.deepEqual(claves, ['status', 'checks', 'findings', 'changed_files_reviewed', 'out_of_scope_changes', 'security_flags', 'next_action']);
  assert.match(yaml, /^status: "PASS\|FAIL\|UNKNOWN\|BLOCKED"$/m);
  assert.match(yaml, /^next_action: "run_security_gate\|repair\|human_review\|done"$/m);
  for (const campo of ['name:', 'command:', 'exit_code:', 'executed_tests:', 'result:', 'evidence:', 'id: "VER-001"', 'file:', 'issue:', 'signature:']) assert.ok(yaml.includes(campo), `falta ${campo}`);
  assert.ok(!cuerpo.includes('verify.ps1'), 'el verificador no debe citar un script concreto del autor');
  assert.match(cuerpo, /script de verificación del proyecto, si existe/);
});

test('uae-triage: el JSON de salida es válido, conserva sus claves y la lista blanca viene de la configuración', () => {
  const { cuerpo } = agente('uae-triage');
  const [json] = bloquesDeCodigo(cuerpo, 'json');
  assert.ok(json, 'falta el bloque json de salida');
  const datos = JSON.parse(json);
  assert.deepEqual(Object.keys(datos), ['entra_a_uae_loop', 'lista_blanca', 'risk', 'impacted_areas', 'data_classes', 'security_gate', 'tests_del_area', 'files_likely', 'rationale']);
  assert.match(cuerpo, /`listaBlanca`/);
  assert.match(cuerpo, /uaeh\.config\.json/);
  for (const categoria of ['dinero', 'cuentas', 'base de datos', 'publicar a producción']) assert.ok(cuerpo.includes(categoria), `falta la categoría por defecto «${categoria}»`);
});

test('uae-security: formato de salida intacto y la caja de arena es condicional a la capa 3', () => {
  const { cuerpo } = agente('uae-security');
  for (const clave of ['SEC-NNN', '`confirmed | needs_validation | rejected`', '`corregido-verificado`', '`PASS | UNKNOWN | BLOCKED_SECURITY`', 'prueba de regresión exigida', 'reproducción segura']) assert.ok(cuerpo.includes(clave), `falta «${clave}»`);
  assert.match(cuerpo, /Si la capa 3 \(puerta de seguridad\) está instalada/);
  assert.match(cuerpo, /si no hay caja de arena, el hallazgo queda `needs_validation`, nunca `confirmed`/);
  assert.match(cuerpo, /el candado de solo lectura del plugin lo impide/);
  assert.ok(!/uaeh-sandbox|\/opt\/uaeh|MSYS_NO_PATHCONV|wsl -d/.test(cuerpo), 'el comando de la caja de arena vive en la skill de la capa 3, no en el agente');
});

test('uae-builder: el commit sigue la política del usuario y no fija ninguna firma', () => {
  const { cuerpo } = agente('uae-builder');
  assert.match(cuerpo, /política de commits del usuario \(`commits\.credito` y `commits\.firma` de `uaeh\.config\.json`\)/);
  assert.ok(!/Authored By/i.test(cuerpo), 'la firma es del usuario, no del plugin');
});

// ── Portabilidad ───────────────────────────────────────────────────────────────────────

test('agentes y skill: sin rutas de una máquina ni de la configuración personal (solo la carpeta de estado, como valor por defecto)', () => {
  assert.ok(ARCHIVOS_PUBLICOS.length >= 9, `se esperaban ≥ 9 archivos, hay ${ARCHIVOS_PUBLICOS.length}`);
  for (const abs of ARCHIVOS_PUBLICOS) {
    const texto = leer(abs).split('~/.claude/uaeh').join('');
    for (const prohibido of ['C:\\', 'C:/', '/mnt/c/', '~/.claude/', '~/.codex/', '$HOME/.claude', '%USERPROFILE%']) {
      assert.ok(!texto.includes(prohibido), `${rel(abs)} contiene «${prohibido}»`);
    }
    assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(texto), `${rel(abs)} contiene una ruta con letra de unidad`);
  }
});

test('agentes y skill: sin BOM y pasan la lista negra de publicación', () => {
  for (const abs of ARCHIVOS_PUBLICOS) {
    const buf = fs.readFileSync(abs);
    assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), `${rel(abs)} empieza con BOM`);
    assert.deepEqual(revisarListaNegra(rel(abs)), [], `${rel(abs)} tiene hallazgos de la lista negra`);
  }
});

// ── Skill uae-loop ─────────────────────────────────────────────────────────────────────

test('uae-loop: frontmatter con name igual a la carpeta, descripción presupuestada y argument-hint', () => {
  const texto = leer(RUTA_SKILL);
  const partes = dividir(texto);
  assert.ok(partes, 'sin frontmatter cerrado');
  assert.ok(!partes.frontmatter.join('\n').includes('---'));
  const { error, datos } = parsearFrontmatter(texto);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(datos).sort(), ['argument-hint', 'description', 'name']);
  assert.equal(datos.name, 'uae-loop');
  assert.equal(datos['argument-hint'], '<tarea concreta>');
  assert.ok(contar(datos.description) > 0 && contar(datos.description) <= MAX_DESCRIPCION, `descripción de ${contar(datos.description)} caracteres`);
  assert.match(datos.description, /SOLO para/, 'la descripción debe decir cuándo entra la skill');
  assert.match(datos.description, /NO para/, 'la descripción debe decir cuándo NO se usa');
  const cruda = partes.frontmatter.find((l) => l.startsWith('description:')).slice('description:'.length).trim();
  assert.ok(!/:\s/.test(cruda) && !/\s#/.test(cruda), 'la descripción no es YAML plano válido');
  assert.match(partes.cuerpo, /^Tarea: \$ARGUMENTS$/m);
});

test('uae-loop: los scripts del plugin se citan con ${CLAUDE_PLUGIN_ROOT}, entre comillas, y existen', () => {
  const texto = leer(RUTA_SKILL);
  for (const ruta of ['scripts/uaeh-integridad.cjs', 'scripts/uaeh-registro.cjs', 'scripts/uaeh-resumen.cjs', 'hooks/uaeh-guardia-cierre.js']) {
    assert.ok(texto.includes(`node "${RAIZ_PLUGIN}/${ruta}"`), `SKILL.md debe mandar correr node "${RAIZ_PLUGIN}/${ruta}"`);
  }
  const todas = texto.match(new RegExp(escaparRe(RAIZ_PLUGIN), 'g')) || [];
  const entreComillas = texto.match(new RegExp(`"${escaparRe(RAIZ_PLUGIN)}/[^"\\n]+"`, 'g')) || [];
  assert.equal(entreComillas.length, todas.length, 'toda ruta con ${CLAUDE_PLUGIN_ROOT} va entre comillas dobles (la carpeta de instalación puede tener espacios)');
  for (const m of entreComillas) {
    const ruta = m.slice(1 + RAIZ_PLUGIN.length + 1, -1);
    assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, ruta)), `SKILL.md cita ${ruta}, que no existe en el plugin`);
  }
});

test('uae-loop: las referencias existen, están enlazadas desde SKILL.md y NO llevan rutas ejecutables', () => {
  const skill = leer(RUTA_SKILL);
  assert.deepEqual(fs.readdirSync(DIR_REFERENCIAS).sort(), REFERENCIAS);
  for (const nombre of REFERENCIAS) {
    assert.ok(skill.includes(`referencias/${nombre}`), `SKILL.md no enlaza referencias/${nombre}`);
    const texto = leer(path.join(DIR_REFERENCIAS, nombre));
    assert.ok(!texto.includes('CLAUDE_PLUGIN_ROOT'), `${nombre}: ${RAIZ_PLUGIN} no se sustituye en archivos que se leen con Read`);
    assert.ok(!/\bnode\s+["'`]?[./~$]/.test(texto), `${nombre}: no debe traer comandos node con ruta`);
    assert.ok(!texto.trimStart().startsWith('<!--'), `${nombre}: sin comentario HTML inicial con rutas de respaldo`);
  }
});

test('agentes citados con el prefijo del plugin y comandos de barra siempre cualificados', () => {
  const archivos = [RUTA_SKILL, ...REFERENCIAS.map((n) => path.join(DIR_REFERENCIAS, n)), ...NOMBRES_ARCHIVOS_AGENTES.map((n) => path.join(DIR_AGENTES, n))];
  const sinPrefijo = new RegExp(`(?<!${escaparRe(PREFIJO)})\\buae-(verifier|security|builder|architect|triage)\\b`, 'g');
  for (const abs of archivos) {
    // La línea `name:` del frontmatter de un agente lleva su nombre sin prefijo (así lo exige el plugin).
    const texto = leer(abs).split('\n').filter((l) => !/^name: uae-/.test(l)).join('\n');
    assert.deepEqual(texto.match(sinPrefijo) || [], [], `${rel(abs)} cita un agente sin «${PREFIJO}»`);
    assert.deepEqual(texto.match(/(^|[\s`(])\/uae-(loop|security|visual|preflight)\b/g) || [], [], `${rel(abs)} cita un comando sin «/${PREFIJO}»`);
  }
});

test('uae-loop: los seis estados finales están en la skill y en estados-y-paro.md', () => {
  const skill = leer(RUTA_SKILL);
  const estados = leer(path.join(DIR_REFERENCIAS, 'estados-y-paro.md'));
  for (const estado of ESTADOS_FINALES) {
    assert.ok(skill.includes(`- \`${estado}\`:`), `SKILL.md: falta el estado ${estado}`);
    assert.ok(estados.includes(`- \`${estado}\`:`), `estados-y-paro.md: falta el estado ${estado}`);
  }
  assert.match(skill, /`UNKNOWN`: falta evidencia\. \*\*Jamás\*\* se reporta como PASS\./);
});

test('uae-loop: la guardia de cierre que describe está cableada en los tres eventos de hooks.json', () => {
  const hooks = JSON.parse(leer(path.join(RAIZ_HARNESS, 'hooks', 'hooks.json'))).hooks;
  const eventos = Object.entries(hooks)
    .filter(([, grupos]) => grupos.some((g) => (g.hooks || []).some((h) => (h.args || []).some((a) => String(a).includes('uaeh-guardia-cierre.js')))))
    .map(([evento]) => evento).sort();
  assert.deepEqual(eventos, ['PreToolUse', 'Stop', 'SubagentStop']);
  const skill = leer(RUTA_SKILL);
  for (const evento of eventos) assert.ok(skill.includes(`\`${evento}\``), `SKILL.md no nombra el evento ${evento}`);
});

// ── La documentación se ejecuta ────────────────────────────────────────────────────────

test('uae-loop: el comando de registro documentado funciona con los seis estados, las dos rutas y los riesgos que la skill nombra', () => {
  const skill = leer(RUTA_SKILL);
  const comando = skill.split('\n').find((l) => l.startsWith(`node "${RAIZ_PLUGIN}/scripts/uaeh-registro.cjs"`));
  assert.ok(comando, 'SKILL.md no trae el comando de registro en una sola línea');
  assert.deepEqual([...comando.matchAll(/--([a-z]+)/g)].map((m) => m[1]).sort(), ['ciclos', 'escalamiento', 'estado', 'minutos', 'proyecto', 'riesgo', 'ruta', 'tarea']);
  const rutas = /--ruta <([a-z|]+)>/.exec(comando)[1].split('|');
  assert.deepEqual(rutas, ['build', 'deep']);
  const riesgosDocumentados = /--riesgo <([a-z|]+)>/.exec(comando)[1].split('|');
  assert.deepEqual(riesgosDocumentados, ['high', 'critical']);
  const estados = [...skill.matchAll(/^- `([A-Z_]+)`:/gm)].map((m) => m[1]);
  assert.deepEqual(estados, ESTADOS_FINALES);

  const e = entornoTemporal();
  try {
    const script = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-registro.cjs');
    estados.forEach((estado, i) => {
      const r = correr(script, [
        '--proyecto', 'proyecto-de-prueba', '--ruta', rutas[i % 2], '--riesgo', riesgosDocumentados[i % 2], '--ciclos', '1', '--minutos', String(10 + i),
        '--escalamiento', 'ninguno', '--estado', estado, '--tarea', `prueba ${estado}`,
      ], { env: e.env, cwd: e.proyecto });
      assert.equal(r.status, 0, `${estado}: ${r.stderr}`);
    });
    const filas = leer(path.join(e.uaehHome, 'registro.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(filas.map((f) => f.estado), ESTADOS_FINALES);
    assert.deepEqual(filas.map((f) => f.ruta), ['build', 'deep', 'build', 'deep', 'build', 'deep']);
    assert.deepEqual(filas.map((f) => f.riesgo), ['alto', 'critico', 'alto', 'critico', 'alto', 'critico']);
    assert.deepEqual(filas.map((f) => f.minutos), [10, 11, 12, 13, 14, 15]);

    const resumen = correr(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-resumen.cjs'), ['7'], { env: e.env, cwd: e.proyecto });
    assert.equal(resumen.status, 0, resumen.stderr);
    assert.ok(resumen.stdout.includes('PASS_TECHNICAL') && resumen.stdout.includes('UNKNOWN'), `el resumen no refleja el registro: ${resumen.stdout}`);
  } finally { e.limpiar(); }
});

test('uae-loop: «directo» y «descartar» de la guardia de cierre, tal como los documenta la skill, dejan huella', () => {
  const skill = leer(RUTA_SKILL);
  for (const tipo of ['directo', 'descartar']) assert.ok(skill.includes(`node "${RAIZ_PLUGIN}/hooks/uaeh-guardia-cierre.js" ${tipo} "motivo"`), `SKILL.md no documenta «${tipo}»`);
  const e = entornoTemporal();
  try {
    const script = path.join(RAIZ_HARNESS, 'hooks', 'uaeh-guardia-cierre.js');
    const env = { ...e.env, CLAUDE_CODE_SESSION_ID: 'sesion-de-prueba-0123456789' };
    for (const tipo of ['directo', 'descartar']) {
      const r = correr(script, [tipo, 'motivo de la prueba'], { env, cwd: e.proyecto });
      assert.equal(r.status, 0, `${tipo}: ${r.stderr}`);
    }
    const huellas = leer(path.join(e.uaehHome, 'excepciones.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(huellas.map((h) => h.tipo), ['directo', 'descartar']);
    assert.ok(huellas.every((h) => h.motivo === 'motivo de la prueba' && h.sesion === 'sesion-de-prueba-0123456789'));
  } finally { e.limpiar(); }
});

test('uae-loop: los subcomandos del sello que documenta la skill existen en uaeh-integridad.cjs', () => {
  const skill = leer(RUTA_SKILL);
  assert.ok(skill.includes(`node "${RAIZ_PLUGIN}/scripts/uaeh-integridad.cjs" foto <repo>`));
  assert.ok(skill.includes(`node "${RAIZ_PLUGIN}/scripts/uaeh-integridad.cjs" comparar <id> <repo>`));
  const script = leer(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-integridad.cjs'));
  assert.match(script, /uaeh-integridad\.cjs foto <repo>/);
  assert.match(script, /uaeh-integridad\.cjs comparar <id>/);
});
