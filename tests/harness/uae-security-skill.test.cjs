// tests/harness/uae-security-skill.test.cjs — skill uae-security del plugin uaeh-harness (capa 3, versión pública).
//
// Qué protege:
//   · Frontmatter: nombre, descripción presupuestada (≤ 350) y YAML plano válido, argument-hint.
//   · Rutas: cada ${CLAUDE_PLUGIN_ROOT}/… va entre comillas dobles y apunta a algo que existe en el plugin (vendor incluido).
//   · Referencias: las siete propias (con la lista previa al lanzamiento) + codex.md están enlazadas desde SKILL.md y no llevan rutas ejecutables (en archivos
//     leídos con Read no se sustituye ${CLAUDE_PLUGIN_ROOT}).
//   · Portabilidad: sin rutas con letra de unidad, sin BOM, sin nada de la lista negra de publicación.
//   · Agentes con prefijo del plugin y comandos de barra cualificados.
//   · La documentación se ejecuta: los subcomandos de uaeh-config.cjs que cita la skill salen 0, pasada-determinista.cjs sin
//     argumentos explica su uso y la línea de uso de la caja de arena es PERMITIDA por el candado de solo lectura.
// Todo es hermético: casa temporal de tests/helpers/entorno.cjs; nada lee la configuración real.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO, RAIZ_HARNESS, entornoTemporal, correr, eventoHerramienta } = require('../helpers/entorno.cjs');
const { parsearFrontmatter, MAX_DESCRIPCION, contar } = require('../../tools/verificar-presupuesto.cjs');
const { revisarArchivo: revisarListaNegra } = require('../../tools/lint-publicacion.cjs');

const DIR_SKILL = path.join(RAIZ_HARNESS, 'skills', 'uae-security');
const RUTA_SKILL = path.join(DIR_SKILL, 'SKILL.md');
const DIR_REFERENCIAS = path.join(DIR_SKILL, 'referencias');
const RAIZ_PLUGIN = '${CLAUDE_PLUGIN_ROOT}';
const PREFIJO = 'uaeh-harness:';

const REFERENCIAS_PROPIAS = ['caja-de-arena.md', 'dinero-toctou.md', 'escala-y-estados.md', 'filtro-falsos-positivos.md', 'lanzamiento.md', 'roles-y-presupuesto.md', 'checklist-prelanzamiento.md'];
const REFERENCIAS_ENLAZADAS = [...REFERENCIAS_PROPIAS, 'codex.md'];

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

// Archivos de texto propios de esta skill que se publican (el contenido de scripts/ es de otros tramos: no se mira aquí).
const ARCHIVOS_DOC = [RUTA_SKILL, ...REFERENCIAS_ENLAZADAS.map((n) => path.join(DIR_REFERENCIAS, n)),
  path.join(DIR_REFERENCIAS, 'prompt-codex.md'), path.join(DIR_REFERENCIAS, 'prompt-codex.en.md')].filter((p) => fs.existsSync(p));
const SKILL = leer(RUTA_SKILL);

// ── Frontmatter ────────────────────────────────────────────────────────────────────────

test('uae-security: frontmatter con name igual a la carpeta, descripción presupuestada, YAML plano válido y argument-hint', () => {
  const partes = dividir(SKILL);
  assert.ok(partes, 'sin frontmatter cerrado');
  assert.ok(!partes.frontmatter.join('\n').includes('---'));
  const { error, datos } = parsearFrontmatter(SKILL);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(datos).sort(), ['argument-hint', 'description', 'name']);
  assert.equal(datos.name, 'uae-security');
  assert.ok(contar(datos.description) > 0 && contar(datos.description) <= MAX_DESCRIPCION, `descripción de ${contar(datos.description)} caracteres`);
  assert.match(datos.description, /security audit/, 'la descripción debe disparar también en inglés');
  assert.match(datos.description, /pentest/);
  assert.ok(!/WSL/.test(datos.description), 'la descripción no cita la plataforma');
  const cruda = partes.frontmatter.find((l) => l.startsWith('description:')).slice('description:'.length).trim();
  assert.ok(!/^["'>|]/.test(cruda), 'la descripción va como valor YAML plano');
  assert.ok(!/:\s/.test(cruda), 'un «: » dentro de un valor YAML plano lo vuelve inválido');
  assert.ok(!/\s#/.test(cruda), 'un « #» dentro de un valor YAML plano abre un comentario y recorta la descripción');
  for (const modo of ['quick', 'standard', 'deep', 'diff <base>', 'incremental <categorías>', 'reprobar <id>', 'lanzamiento']) {
    assert.ok(datos['argument-hint'].includes(modo), `argument-hint no incluye «${modo}»`);
  }
  assert.match(partes.cuerpo, /^# \/uaeh-harness:uae-security — /m);
});

test('uae-security: conserva las 4 garantías, los modos, los estados y las reglas duras de la versión original', () => {
  for (const frase of ['**Independencia:**', '**Herramientas sin opinión primero:**', '**Confirmado = reproducido**', '**Corregido = re-probado por el auditor**']) {
    assert.ok(SKILL.includes(frase), `falta la garantía ${frase}`);
  }
  for (const modo of ['## 1. Modo completo', '## 2. Modo `diff <base>`', '## 3. Modo `incremental <categorías>`', '## 4. Modo `reprobar <id>`', '## 5. Modo `lanzamiento`', '## Reglas duras']) {
    assert.ok(SKILL.includes(modo), `falta la sección ${modo}`);
  }
  for (const estado of ['`PASS`', '`BLOCKED_SECURITY`', '`UNKNOWN`', '`corregido-verificado`', '`por_validar`', '`aceptado`']) assert.ok(SKILL.includes(estado), `falta ${estado}`);
  const escala = leer(path.join(DIR_REFERENCIAS, 'escala-y-estados.md'));
  for (const estado of ['confirmado', 'por_validar', 'rechazado', 'corregido-verificado', 'aceptado']) assert.ok(escala.includes(`**${estado}**`), `escala-y-estados.md: falta ${estado}`);
  assert.match(SKILL, /macOS no está soportada/);
  assert.match(SKILL, /Windows 11 con WSL2 \(probado\)/);
  // Linux corre nativo en la CI desde la capa 3 (trabajos linux-integracion e instaladores-contenedor).
  assert.match(SKILL, /Linux Ubuntu 24\.04 x86_64 \(probado en la CI, de forma nativa\)/);
  assert.doesNotMatch(SKILL, /no probado/);
});

// ── Rutas del plugin ───────────────────────────────────────────────────────────────────

test('uae-security: las rutas con ${CLAUDE_PLUGIN_ROOT} van entre comillas dobles cuando son argumento de node y existen', () => {
  const todas = SKILL.match(new RegExp(escaparRe(RAIZ_PLUGIN), 'g')) || [];
  assert.ok(todas.length >= 10, 'la skill debe citar varios archivos del plugin');
  // Todo «node <algo>» que usa la raíz del plugin la lleva entre comillas dobles.
  const nodeSinComillas = SKILL.match(new RegExp(`node\\s+(?!")[^\\n]*${escaparRe(RAIZ_PLUGIN)}`, 'g')) || [];
  assert.deepEqual(nodeSinComillas, [], 'un argumento de node con ${CLAUDE_PLUGIN_ROOT} debe ir entre comillas dobles (la carpeta de instalación puede tener espacios)');
  const conNode = SKILL.match(new RegExp(`node "${escaparRe(RAIZ_PLUGIN)}/[^"\\n]+"`, 'g')) || [];
  assert.ok(conNode.length >= 8, `se esperaban ≥ 8 comandos node con la raíz del plugin, hay ${conNode.length}`);
  // Cada ruta citada (con comillas o dentro de comillas invertidas) existe.
  const rutas = new Set();
  for (const m of SKILL.matchAll(new RegExp(`${escaparRe(RAIZ_PLUGIN)}/([A-Za-z0-9._/-]+)`, 'g'))) rutas.add(m[1].replace(/[.,;:)]+$/, ''));
  for (const ruta of rutas) {
    assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, ruta)), `SKILL.md cita ${ruta}, que no existe en el plugin`);
  }
  for (const imprescindible of ['scripts/uaeh-config.cjs', 'scripts/uaeh-integridad.cjs', 'scripts/uaeh-huella.cjs', 'scripts/uaeh-registro.cjs', 'scripts/uaeh-ignorar.cjs',
    'scripts/aplicar-parche-cyber-neo.cjs', 'skills/uae-security/scripts/pasada-determinista.cjs', 'skills/uae-security/scripts/auditor-codex.cjs']) {
    assert.ok(rutas.has(imprescindible), `SKILL.md debe citar ${imprescindible}`);
  }
});

test('uae-security: los nombres de archivo de cyber-neo que cita la skill son los 14 de la referencia', () => {
  const esperados = ['auth-authz-patterns', 'cicd-security', 'crypto-patterns', 'cwe-top-25', 'error-handling-patterns', 'iac-docker', 'lang-javascript',
    'lang-python', 'logging-patterns', 'owasp-top-10', 'report-template', 'secrets-patterns', 'supply-chain', 'web-security-patterns'];
  for (const nombre of esperados) assert.ok(SKILL.includes(`\`${nombre}\``), `SKILL.md no cita la referencia de cyber-neo «${nombre}»`);
  assert.ok(SKILL.includes('vendor/cyber-neo/references/'));
});

test('uae-security: las líneas de vendor/security-audit/SKILL.md que se citan siguen siendo las de esas secciones', () => {
  // Si se sube de commit upstream y el texto se mueve, la cita debe moverse con él.
  const lineas = leer(path.join(RAIZ_HARNESS, 'vendor', 'security-audit', 'SKILL.md')).split('\n');
  assert.ok(SKILL.includes('vendor/security-audit/SKILL.md` líneas 96-105'));
  assert.match(lineas[95], /^If prior runs exist, read every compatible `coverage-ledger\.json` and `findings\.json`/, 'línea 96: corridas previas');
  assert.match(lineas[104], /^If no prior ledger exists, say so in the final coverage statement/, 'línea 105: cierre de la sección de corridas previas');
  assert.ok(leer(path.join(DIR_REFERENCIAS, 'roles-y-presupuesto.md')).includes('`security-audit/SKILL.md:119-134`'));
  assert.equal(lineas[118], '#### Cost budget', 'línea 119: presupuesto');
  assert.match(lineas[133], /^A strict total-agent budget can still be exceeded/, 'línea 134: cierre de la regla de reservas y paro');
});

// ── Referencias ────────────────────────────────────────────────────────────────────────

test('uae-security: las referencias existen, están enlazadas desde SKILL.md y NO llevan rutas ejecutables', () => {
  const presentes = fs.readdirSync(DIR_REFERENCIAS);
  for (const nombre of REFERENCIAS_ENLAZADAS) {
    assert.ok(presentes.includes(nombre), `falta referencias/${nombre}`);
    assert.ok(SKILL.includes(`referencias/${nombre}`), `SKILL.md no enlaza referencias/${nombre}`);
    const texto = leer(path.join(DIR_REFERENCIAS, nombre));
    assert.ok(!texto.includes('CLAUDE_PLUGIN_ROOT'), `${nombre}: ${RAIZ_PLUGIN} no se sustituye en archivos que se leen con Read`);
    assert.ok(!/\bnode\s+["'`]?[./~$]/.test(texto), `${nombre}: no debe traer comandos node con ruta`);
    assert.ok(!texto.trimStart().startsWith('<!--'), `${nombre}: sin comentario HTML inicial`);
  }
  // La lista previa al lanzamiento la citan también las dos referencias que dependen de ella.
  assert.ok(leer(path.join(DIR_REFERENCIAS, 'lanzamiento.md')).includes('checklist-prelanzamiento.md'));
  assert.ok(leer(path.join(DIR_REFERENCIAS, 'filtro-falsos-positivos.md')).includes('checklist-prelanzamiento.md'));
});

test('uae-security: las referencias usan los marcadores y remiten a SKILL.md para sus valores', () => {
  const caja = leer(path.join(DIR_REFERENCIAS, 'caja-de-arena.md'));
  for (const marcador of ['<PREFIJO_MOTOR>', '<PREFIJO_CAJA>', '<RUN_MOTOR>']) assert.ok(caja.includes(marcador), `caja-de-arena.md no usa ${marcador}`);
  assert.match(caja, /SKILL\.md/);
  assert.ok(!/F1-V|docker 29|Docker Engine \d/i.test(caja), 'sin versión fija de Docker ni jerga interna');
  for (const marcador of ['<PREFIJO_MOTOR>', '<PREFIJO_CAJA>', '<RUN_MOTOR>']) assert.ok(SKILL.includes(`\`${marcador}\``), `SKILL.md no define ${marcador}`);
});

// ── Portabilidad ───────────────────────────────────────────────────────────────────────

test('uae-security: sin rutas de una máquina ni letra de unidad, sin BOM, LF y lista negra de publicación limpia', () => {
  assert.ok(ARCHIVOS_DOC.length >= 10, `se esperaban ≥ 10 archivos, hay ${ARCHIVOS_DOC.length}`);
  for (const abs of ARCHIVOS_DOC) {
    const buf = fs.readFileSync(abs);
    assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), `${rel(abs)} empieza con BOM`);
    assert.ok(!buf.includes(0x0d), `${rel(abs)} tiene CRLF`);
    const texto = buf.toString('utf8');
    for (const prohibido of ['C:\\', 'C:/', '/mnt/c/', '~/.claude/', '~/.codex/', '$HOME/.claude', '%USERPROFILE%', '~/security-audit-skill']) {
      assert.ok(!texto.includes(prohibido), `${rel(abs)} contiene «${prohibido}»`);
    }
    assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(texto), `${rel(abs)} contiene una ruta con letra de unidad`);
    assert.ok(!/fablemod|F1-V|UAEH §/i.test(texto), `${rel(abs)} contiene rastros del proceso interno`);
    assert.deepEqual(revisarListaNegra(rel(abs)), [], `${rel(abs)} tiene hallazgos de la lista negra`);
  }
});

test('uae-security: agentes citados con el prefijo del plugin y comandos de barra siempre cualificados', () => {
  const sinPrefijo = new RegExp(`(?<![A-Za-z0-9/-])(?<!${escaparRe(PREFIJO)})uae-(verifier|security|builder|architect|triage)\\b(?!/)`, 'g');
  for (const abs of ARCHIVOS_DOC) {
    const texto = leer(abs).split('\n').filter((l) => !/^name: uae-/.test(l)).join('\n');
    assert.deepEqual(texto.match(sinPrefijo) || [], [], `${rel(abs)} cita un agente sin «${PREFIJO}»`);
    assert.deepEqual(texto.match(/(^|[\s`(])\/uae-(loop|security|visual|preflight)\b/g) || [], [], `${rel(abs)} cita un comando sin «/${PREFIJO}»`);
  }
  for (const cualificado of ['`uaeh-harness:uae-security`', '`uaeh-harness:uae-verifier`', '/uaeh-harness:uae-loop', '/uaeh-harness:uae-preflight', '`/security-review`', '`Explore`']) {
    assert.ok(SKILL.includes(cualificado), `SKILL.md debe citar ${cualificado}`);
  }
});

// ── La documentación se ejecuta ────────────────────────────────────────────────────────

test('uae-security: los subcomandos de uaeh-config.cjs que cita la skill salen 0 en una casa temporal', () => {
  const citados = new Set([...SKILL.matchAll(/uaeh-config\.cjs" ([a-z-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...citados].sort(), ['ahora-local', 'prefijo-caja', 'prefijo-motor', 'runs-dir', 'ruta-motor']);
  assert.ok(SKILL.includes('uaeh-config.cjs" runs-dir --repo <repo>'));
  assert.ok(SKILL.includes('uaeh-config.cjs" ruta-motor <run>'));
  const e = entornoTemporal();
  try {
    const script = path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs');
    const run = path.join(e.proyecto, 'run-1');
    const casos = { 'runs-dir': ['runs-dir', '--repo', e.proyecto], 'ahora-local': ['ahora-local'], 'prefijo-motor': ['prefijo-motor'], 'prefijo-caja': ['prefijo-caja'], 'ruta-motor': ['ruta-motor', run] };
    for (const [nombre, args] of Object.entries(casos)) {
      const r = correr(script, args, { env: e.env, cwd: e.proyecto });
      assert.equal(r.status, 0, `${nombre}: ${r.stderr}`);
    }
    const caja = correr(script, ['prefijo-caja'], { env: e.env, cwd: e.proyecto }).stdout.trim();
    assert.match(caja, /\/opt\/uaeh\/bin\/uaeh-sandbox ejecutar$/);
  } finally { e.limpiar(); }
});

test('uae-security: pasada-determinista.cjs sin argumentos sale 2 con su uso', () => {
  const script = path.join(DIR_SKILL, 'scripts', 'pasada-determinista.cjs');
  const e = entornoTemporal();
  try {
    const r = correr(script, [], { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr + r.stdout, /pasada-determinista/);
  } finally { e.limpiar(); }
});

test('uae-security: aplicar-parche-cyber-neo.cjs --verificar da PARCHEADO (0) para la copia del plugin, como documenta la skill', () => {
  const script = path.join(RAIZ_HARNESS, 'scripts', 'aplicar-parche-cyber-neo.cjs');
  assert.match(SKILL, /`PARCHEADO` \(0\) · `SIN_PARCHE` \(3\) · `DESCONOCIDO` \(4\)/);
  const e = entornoTemporal();
  try {
    const r = correr(script, ['--verificar'], { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PARCHEADO /);
  } finally { e.limpiar(); }
});

test('uae-security: la línea de uso de la caja de arena documentada es PERMITIDA por el candado de solo lectura (y encadenar algo, negado)', () => {
  const caja = leer(path.join(DIR_REFERENCIAS, 'caja-de-arena.md'));
  const bloque = [...caja.matchAll(/^```\n([\s\S]*?)\n```$/gm)].map((m) => m[1]).find((b) => b.includes('<PREFIJO_CAJA>'));
  assert.ok(bloque, 'caja-de-arena.md no trae la línea de uso en un bloque de código');
  assert.ok(bloque.startsWith('MSYS_NO_PATHCONV=1 <PREFIJO_CAJA> --run <RUN_MOTOR> --agente v01 [--deps <volumen>] [--bd] [--segundos 120] [--env CLAVE=valor] -- sh -c '));

  const e = entornoTemporal();
  try {
    const prefijo = correr(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs'), ['prefijo-caja'], { env: e.env, cwd: e.proyecto }).stdout.trim();
    const runMotor = correr(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs'), ['ruta-motor', path.join(e.dir || e.proyecto, 'runs', 'repo', 'run-1')], { env: e.env, cwd: e.proyecto }).stdout.trim();
    assert.ok(prefijo && runMotor);
    const linea = bloque
      .replace('<PREFIJO_CAJA>', prefijo)
      .replace('<RUN_MOTOR>', runMotor)
      .replace('[--deps <volumen>]', '--deps uaeh-deps-repo-abc123')
      .replace('[--bd]', '--bd')
      .replace('[--segundos 120]', '--segundos 120')
      .replace('[--env CLAVE=valor]', '--env CLAVE=valor');
    assert.ok(!/[\[\]<>]/.test(linea.replace(/&&/g, '')), `quedaron marcadores sin sustituir: ${linea}`);

    const hook = path.join(RAIZ_HARNESS, 'hooks', 'solo-lectura.js');
    const decidir = (comando) => {
      const r = correr(hook, [], { stdin: eventoHerramienta(comando, { agente: 'uaeh-harness:uae-security', cwd: e.proyecto }), env: e.env, cwd: e.proyecto });
      assert.equal(r.status, 0, r.stderr);
      const salida = r.json();
      const salidaHook = salida && salida.hookSpecificOutput;
      return { negado: !!salidaHook && salidaHook.permissionDecision === 'deny', motivo: (salidaHook && salidaHook.permissionDecisionReason) || '' };
    };

    const permitido = decidir(linea);
    assert.equal(permitido.negado, false, `el candado niega la línea documentada: ${permitido.motivo}\n${linea}`);
    // Desde Git Bash en Windows lleva el prefijo; en otras shells se omite: las dos formas son válidas.
    const sinPrefijoMsys = decidir(linea.replace(/^MSYS_NO_PATHCONV=1 /, ''));
    assert.equal(sinPrefijoMsys.negado, false, `la forma sin MSYS_NO_PATHCONV: ${sinPrefijoMsys.motivo}`);

    const encadenado = decidir(`${linea}; rm -rf /`);
    assert.equal(encadenado.negado, true, 'encadenar un comando fuera de las comillas debe negarse');
  } finally { e.limpiar(); }
});
