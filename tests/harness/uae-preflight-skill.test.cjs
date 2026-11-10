// tests/harness/uae-preflight-skill.test.cjs — preflight del plugin uaeh-harness (capa 3): skill uae-preflight y sus 5 referencias.
//
// Qué protege:
//   · Frontmatter (descripción presupuestada, YAML plano, contexto aparte con agente y modelo) y lo esencial del método:
//     bajo pedido, solo escribe en docs/harness/, no lanza subagentes (devuelve delegaciones), los 9 documentos, el sello.
//   · Rutas: cada ${CLAUDE_PLUGIN_ROOT}/… va entre comillas cuando es argumento de node y existe en el plugin; las
//     referencias no llevan rutas ejecutables (en lo que se lee con Read no se sustituye).
//   · Referencias saneadas: «fuente de verdad: este archivo», sin la numeración ni las citas del documento de origen,
//     aviso legal y jurisdicción configurable; lo que citan de las plantillas de verificación existe en ellas.
//   · Portabilidad: sin rutas de una máquina, sin BOM, LF, sin rastros del proceso y con la lista negra limpia.
//   · Coherencia: las categorías y vigencias que cita son las de uaeh-huella.cjs; los modos que delega existen en
//     uae-security y uae-visual; los 9 documentos coinciden con las salidas de referencias/formato.md.
//   · La documentación se ejecuta: comparar → sellar → comparar, jurisdiccion, runs-dir e ignorar con --docs-harness.
// Hermético: casa temporal de tests/helpers/entorno.cjs.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO, RAIZ_HARNESS, entornoTemporal, correr, git, repoTemporal } = require('../helpers/entorno.cjs');
const { parsearFrontmatter, MAX_DESCRIPCION, contar } = require('../../tools/verificar-presupuesto.cjs');
const { revisarArchivo: revisarListaNegra } = require('../../tools/lint-publicacion.cjs');

const DIR_SKILL = path.join(RAIZ_HARNESS, 'skills', 'uae-preflight');
const RUTA_SKILL = path.join(DIR_SKILL, 'SKILL.md');
const DIR_REFERENCIAS = path.join(DIR_SKILL, 'referencias');
const RAIZ_PLUGIN = '${CLAUDE_PLUGIN_ROOT}';
const REFERENCIAS = ['checks-por-stack.md', 'escala.md', 'formato.md', 'legal.md', 'seguridad.md'];
const DOCUMENTOS = ['PROJECT_PROFILE.md', 'ASSET_DATA_MAP.md', 'THREAT_MODEL.md', 'SECURITY_BASELINE.md', 'LEGAL_MATRIX.md',
  'SCALE_PLAN.md', 'ACCEPTANCE_MATRIX.md', 'AUDIT_REPORT.md', 'ROUTING_LESSONS.md'];
const HUELLA = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-huella.cjs');
const CONFIG = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs');
const IGNORAR = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-ignorar.cjs');

const leer = (ruta) => fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const escaparRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function dividir(texto) {
  const lineas = texto.split('\n');
  if (lineas[0].trimEnd() !== '---') return null;
  const fin = lineas.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (fin === -1) return null;
  return { frontmatter: lineas.slice(1, fin), cuerpo: lineas.slice(fin + 1).join('\n') };
}

const SKILL = leer(RUTA_SKILL);
const ARCHIVOS_SKILL = archivosDe(DIR_SKILL);
const DOCS = [RUTA_SKILL, ...REFERENCIAS.map((n) => path.join(DIR_REFERENCIAS, n))];

// ── Frontmatter y método ───────────────────────────────────────────────────────────────

test('uae-preflight: frontmatter con contexto aparte (fork + general-purpose + sonnet), descripción presupuestada y YAML plano', () => {
  const partes = dividir(SKILL);
  assert.ok(partes, 'sin frontmatter cerrado');
  const { error, datos } = parsearFrontmatter(SKILL);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(datos).sort(), ['agent', 'argument-hint', 'context', 'description', 'model', 'name']);
  assert.equal(datos.name, 'uae-preflight');
  assert.equal(datos.context, 'fork', 'el preflight lee mucho: corre en un contexto aparte y devuelve solo el resumen');
  assert.equal(datos.agent, 'general-purpose');
  assert.equal(datos.model, 'sonnet');
  assert.ok(contar(datos.description) > 0 && contar(datos.description) <= MAX_DESCRIPCION, `descripción de ${contar(datos.description)} caracteres`);
  assert.match(datos.description, /project audit/, 'la descripción debe disparar también en inglés');
  assert.match(datos.description, /launch readiness/);
  assert.match(datos.description, /No se dispara sola/, 'la descripción debe decir que es bajo pedido');
  const cruda = partes.frontmatter.find((l) => l.startsWith('description:')).slice('description:'.length).trim();
  assert.ok(!/^["'>|]/.test(cruda) && !/:\s/.test(cruda) && !/\s#/.test(cruda), 'la descripción no es YAML plano válido');
  for (const pieza of ['<ruta del repo>', 'completa|incremental <categorías>', 'riesgo critico|alto|medio|bajo', '[local]']) {
    assert.ok(datos['argument-hint'].includes(pieza), `argument-hint no incluye «${pieza}»`);
  }
  assert.match(partes.cuerpo, /^# \/uaeh-harness:uae-preflight — /m);
  assert.match(partes.cuerpo, /^Entrada: \$ARGUMENTS/m);
});

test('uae-preflight: conserva el método (bajo pedido, solo docs/harness, delegaciones, 9 documentos, sello) y ninguna regla del autor', () => {
  for (const seccion of ['## Prefijos', '## Reglas duras', '## 1. ¿Hace falta?', '## 2. ¿Al repo o local?', '## 3. Consolidar lo que ya existe',
    '## 4. Inventario y documentos', '## 5. Sello', '## 6. Respuesta']) {
    assert.ok(SKILL.includes(seccion), `falta la sección ${seccion}`);
  }
  for (const frase of ['solo escribes en `docs/harness/`', '**devuelven como delegaciones**', 'solo los nombres', '`POR_CONFIRMAR`',
    '`APLICA | NO_APLICA | POR_CONFIRMAR | REQUIERE_ABOGADO`', '**No vuelvas a auditar lo ya medido.**', '40 líneas como máximo',
    'Nunca con la primera tarea de un proyecto', 'Nunca toques el `.gitignore` de un repo ajeno']) {
    assert.ok(SKILL.includes(frase), `falta «${frase}»`);
  }
  for (const doc of DOCUMENTOS) assert.ok(SKILL.includes(`\`${doc}\``), `SKILL.md no nombra ${doc}`);
  assert.match(SKILL, /Probado en Windows 11; en Linux y macOS no probado/);
  // Nada de la máquina del autor: ni repos de clientes con nombre, ni carpetas de reportes en el escritorio.
  assert.ok(!/Escritorio|cyber-neo-report|security-audit-skill/i.test(SKILL));
});

test('uae-preflight: los 9 documentos son las salidas obligatorias de referencias/formato.md', () => {
  const formato = leer(path.join(DIR_REFERENCIAS, 'formato.md'));
  const bloque = formato.match(/```text\ndocs\/harness\/\n([\s\S]*?)```/);
  assert.ok(bloque, 'formato.md debe listar las salidas en un bloque text');
  const enFormato = bloque[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(enFormato, DOCUMENTOS);
});

// ── Rutas del plugin ───────────────────────────────────────────────────────────────────

test('uae-preflight: las rutas con ${CLAUDE_PLUGIN_ROOT} van entre comillas cuando son argumento de node y existen', () => {
  const nodeSinComillas = SKILL.match(new RegExp(`node\\s+(?!")[^\\n]*${escaparRe(RAIZ_PLUGIN)}`, 'g')) || [];
  assert.deepEqual(nodeSinComillas, [], 'un argumento de node con ${CLAUDE_PLUGIN_ROOT} debe ir entre comillas dobles');
  const rutas = new Set();
  for (const m of SKILL.matchAll(new RegExp(`${escaparRe(RAIZ_PLUGIN)}/([A-Za-z0-9._/-]+)`, 'g'))) rutas.add(m[1].replace(/[.,;:)]+$/, ''));
  for (const ruta of rutas) assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, ruta)), `SKILL.md cita ${ruta}, que no existe en el plugin`);
  for (const imprescindible of ['scripts/uaeh-huella.cjs', 'scripts/uaeh-config.cjs', 'scripts/uaeh-ignorar.cjs', 'templates/verify.ps1', 'templates/verify.sh']) {
    assert.ok(rutas.has(imprescindible), `SKILL.md debe citar ${imprescindible}`);
  }
  assert.ok(!SKILL.includes('~/.claude/scripts'), 'los scripts se citan desde el plugin, no desde la carpeta personal');
});

test('uae-preflight: las referencias existen, están enlazadas desde SKILL.md y NO llevan rutas ejecutables', () => {
  assert.deepEqual(fs.readdirSync(DIR_REFERENCIAS).sort(), REFERENCIAS);
  for (const nombre of REFERENCIAS) {
    assert.ok(SKILL.includes(`referencias/${nombre}`), `SKILL.md no enlaza referencias/${nombre}`);
    const texto = leer(path.join(DIR_REFERENCIAS, nombre));
    assert.ok(!texto.includes('CLAUDE_PLUGIN_ROOT'), `${nombre}: ${RAIZ_PLUGIN} no se sustituye en archivos que se leen con Read`);
    assert.ok(!/\bnode\s+["'`]?[./~$]/.test(texto), `${nombre}: no debe traer comandos node con ruta`);
  }
});

test('uae-preflight: referencias saneadas (fuente de verdad, sin la numeración ni las citas del documento de origen)', () => {
  for (const nombre of REFERENCIAS) {
    const texto = leer(path.join(DIR_REFERENCIAS, nombre));
    const lineas = texto.split('\n');
    assert.match(lineas[0], /^# .+ — preflight \(uae-preflight\)$/, `${nombre}: título`);
    assert.ok(lineas.slice(1, 4).some((l) => l === 'Fuente de verdad: este archivo (origen: el Playbook UAEH del autor, no publicado).'), `${nombre}: falta la línea de fuente de verdad`);
    assert.ok(!/TAL CUAL|No editar a mano|Model_Routing/.test(texto), `${nombre}: rastro del extracto original`);
    assert.ok(!/^#{2,3} \d+(\.\d+)*\.? /m.test(texto), `${nombre}: conserva la numeración del documento de origen`);
    assert.ok(!/scale-reviewer|_uaeh-ensayo|Plantilla probada:/.test(texto), `${nombre}: cita una pieza que no viaja con el plugin`);
  }
  const legal = leer(path.join(DIR_REFERENCIAS, 'legal.md'));
  assert.match(legal, /\*\*No es asesoría legal\.\*\*/);
  assert.match(legal, /`preflight\.jurisdiccion`/);
  assert.match(legal, /ARCO en México/, 'ARCO se conserva como ejemplo de una jurisdicción');
  assert.ok(!/derechos ARCO en México\./.test(legal) && !/mexicana o de otra/.test(legal), 'lo mexicano ya no es la regla general');
});

test('uae-preflight: checks-por-stack.md describe las plantillas de verificación tal como son', () => {
  const checks = leer(path.join(DIR_REFERENCIAS, 'checks-por-stack.md'));
  const ps1 = leer(path.join(RAIZ_HARNESS, 'templates', 'verify.ps1'));
  const sh = leer(path.join(RAIZ_HARNESS, 'templates', 'verify.sh'));
  for (const cita of ['`templates/verify.ps1`', '`templates/verify.sh`', '`node-tap`', '`0` todo pasó', '`1` alguna comprobación falló', '`3` ninguna falló']) {
    assert.ok(checks.includes(cita), `checks-por-stack.md no dice ${cita}`);
  }
  for (const [nombre, plantilla] of [['verify.ps1', ps1], ['verify.sh', sh]]) {
    assert.ok(plantilla.includes('node-tap'), `${nombre} no trae el modo node-tap`);
    assert.ok(plantilla.includes('>>> comprobaciones') && plantilla.includes('<<< comprobaciones'), `${nombre}: marcas del bloque editable`);
    assert.match(plantilla, /exit 3/, `${nombre}: sale 3 sin pruebas`);
  }
  // La tabla no se corta: ninguna línea que no sea fila entre la cabecera y la última fila.
  const tabla = checks.split('\n').filter((l, i, a) => i >= a.findIndex((x) => x.startsWith('| Stack')));
  const fin = tabla.findIndex((l) => !l.startsWith('|'));
  assert.ok(fin >= 9, 'la tabla de stacks debe tener cabecera, separador y 7 filas seguidas');
});

// ── Portabilidad ───────────────────────────────────────────────────────────────────────

test('uae-preflight: sin rutas de una máquina, sin BOM, LF, sin rastros del proceso y lista negra limpia', () => {
  assert.equal(ARCHIVOS_SKILL.length, 6, `se esperaban SKILL.md + 5 referencias, hay ${ARCHIVOS_SKILL.length}`);
  for (const abs of ARCHIVOS_SKILL) {
    const buf = fs.readFileSync(abs);
    assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), `${rel(abs)} empieza con BOM`);
    assert.ok(!buf.includes(0x0d), `${rel(abs)} tiene CRLF`);
    const texto = buf.toString('utf8');
    for (const prohibido of ['C:\\', 'C:/', '/mnt/c/', '~/.claude/', '~/.codex/', '$HOME/.claude', '%USERPROFILE%', 'AppData']) {
      assert.ok(!texto.includes(prohibido), `${rel(abs)} contiene «${prohibido}»`);
    }
    assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(texto), `${rel(abs)} contiene una ruta con letra de unidad`);
    assert.ok(!/fablemod|UAEH §|\b1×1\b|medido \d+-oct/i.test(texto), `${rel(abs)} contiene rastros del proceso interno`);
    assert.deepEqual(revisarListaNegra(rel(abs)), [], `${rel(abs)} tiene hallazgos de la lista negra`);
  }
});

test('uae-preflight: comandos de barra y agentes cualificados; los modos que delega existen en uae-security y uae-visual', () => {
  for (const abs of DOCS) {
    const texto = leer(abs).split('\n').filter((l) => !/^name: /.test(l)).join('\n');
    assert.deepEqual(texto.match(/(^|[\s`(])\/uae-(loop|security|visual|preflight)\b/g) || [], [], `${rel(abs)} cita un comando sin «/uaeh-harness:»`);
    assert.deepEqual(texto.match(/(?<![A-Za-z0-9/:-])uae-(verifier|security|builder|architect|triage)\b(?![/-])/g) || [], [], `${rel(abs)} cita un agente sin prefijo`);
    assert.ok(!/claude-db|legal:compliance/.test(texto), `${rel(abs)} nombra una skill de terceros: las delegaciones dicen «la skill que el usuario tenga»`);
  }
  const hint = (skill) => parsearFrontmatter(leer(path.join(RAIZ_HARNESS, 'skills', skill, 'SKILL.md'))).datos['argument-hint'];
  const seguridad = hint('uae-security');
  for (const modo of ['quick', 'standard', 'deep', 'incremental <categorías>', 'lanzamiento']) assert.ok(seguridad.includes(modo), `uae-security no tiene el modo ${modo}`);
  const visual = hint('uae-visual');
  for (const modo of ['design-md', 'audit-only [incremental]']) assert.ok(visual.includes(modo), `uae-visual no tiene el modo ${modo}`);
  for (const delegacion of ['`/uaeh-harness:uae-security <quick|standard|deep>`', '`/uaeh-harness:uae-security incremental <categorías cambiadas>`',
    '`/uaeh-harness:uae-visual design-md`', '`/uaeh-harness:uae-visual audit-only`', '`/uaeh-harness:uae-visual audit-only incremental`']) {
    assert.ok(SKILL.includes(delegacion), `falta la delegación ${delegacion}`);
  }
});

test('uae-preflight: las categorías y vigencias que cita son las de uaeh-huella.cjs', () => {
  const { CATEGORIAS, VIGENCIA } = require(HUELLA);
  const linea = SKILL.split('\n').find((l) => l.startsWith('Categorías de la huella:'));
  assert.ok(linea, 'falta la línea «Categorías de la huella:»');
  assert.deepEqual([...linea.matchAll(/`([a-z]+)`/g)].map((m) => m[1]), CATEGORIAS);
  assert.ok(SKILL.includes(`${VIGENCIA.critico} días en \`critico\`, ${VIGENCIA.alto} en \`alto\`, ${VIGENCIA.medio} en \`medio\``), 'vigencias desfasadas');
  assert.equal(VIGENCIA.bajo, VIGENCIA.medio, 'SKILL.md dice que bajo vence como medio');
});

// ── La documentación se ejecuta ────────────────────────────────────────────────────────

test('uae-preflight: los comandos documentados corren (comparar → sellar → comparar, jurisdiccion, runs-dir, ignorar --docs-harness)', () => {
  const e = entornoTemporal('uaeh-preflight-');
  try {
    const repo = repoTemporal(e, 'app-cliente');
    const corre = (script, args) => {
      const r = correr(script, args, { env: e.env, cwd: repo });
      assert.equal(r.status, 0, `${path.basename(script)} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
      return r.stdout.trim();
    };
    assert.match(corre(HUELLA, ['comparar', repo]), /sin preflight/);
    const sinGit = path.join(e.dir, 'sin-git');
    fs.mkdirSync(sinGit);
    assert.equal(corre(HUELLA, ['comparar', sinGit]), 'sin git', 'SKILL.md: «sin git» → dilo y termina');

    assert.match(corre(IGNORAR, ['--repo', repo, '--local', '--docs-harness', '--aplicar']), /^OK: git ignora/m);
    // La línea de sellar tal como la documenta SKILL.md, con valores de ejemplo.
    const bloque = SKILL.match(/```\n<huella> sellar ([^\n]+)\n```/);
    assert.ok(bloque, 'SKILL.md debe traer la línea de sellar en un bloque');
    const ejemplo = { '<completa|incremental>': 'completa', '<r>': 'alto', '<IDs abiertos>': 'SEC-001,LEG-002', '<n>': '2', '<m>': '0', '<auditadas>': 'auth,env' };
    let documentada = bloque[1];
    for (const [marcador, valor] of Object.entries(ejemplo)) documentada = documentada.split(marcador).join(valor);
    const args = documentada.split(/\s+/).map((p) => (p === '<repo>' ? repo : p));
    assert.ok(!args.some((p) => /[<>]/.test(p)), `marcador sin valor de ejemplo en: ${documentada}`);
    corre(HUELLA, ['sellar', ...args]);
    assert.ok(fs.existsSync(path.join(repo, 'docs', 'harness', '.preflight.json')), 'el sello queda en docs/harness/.preflight.json');
    assert.match(fs.readFileSync(path.join(repo, 'docs', 'harness', 'AUDIT_REPORT.md'), 'utf8'), /## Historial de corridas/);
    assert.equal(git(repo, ['status', '--porcelain'], e.env).stdout.trim(), '', 'con local, docs/harness/ no aparece en git');
    assert.match(corre(HUELLA, ['comparar', repo]), /preflight vigente del .+ NO repetir/);

    assert.equal(corre(CONFIG, ['jurisdiccion']), '');
    assert.ok(path.isAbsolute(corre(CONFIG, ['runs-dir', '--repo', repo])));
  } finally { e.limpiar(); }
});
