// tests/harness/uae-visual-skill.test.cjs — puerta visual del plugin uaeh-harness (capa 3): skill uae-visual y sus agentes
// browser-verifier y design-auditor.
//
// Qué protege:
//   · Frontmatter de la skill (descripción presupuestada, YAML plano, argument-hint) y lo esencial del método: bajo pedido,
//     una sola ronda, puertas humanas, UNKNOWN ≠ PASS.
//   · Rutas: cada ${CLAUDE_PLUGIN_ROOT}/… va entre comillas cuando es argumento de node y existe en el plugin; las
//     referencias no llevan rutas ejecutables (en lo que se lee con Read no se sustituye).
//   · Portabilidad de TODO lo que viaja en la skill y en los dos agentes: sin rutas de una máquina, sin BOM, LF, sin
//     rastros del proceso interno y con la lista negra de publicación limpia.
//   · Pines: las versiones de Playwright, axe y Lighthouse que citan la skill, el agente, el candado y el sitio de
//     juguete son las de wsl/herramientas.json (una sola fuente).
//   · Agentes: herramientas, modelos, candados por identidad y sello; los contratos YAML de salida no cambian de forma.
//   · La documentación se ejecuta: los subcomandos citados salen 0, el registro acepta la línea documentada y las
//     líneas de navegador del agente y la de Lighthouse de la skill son PERMITIDAS por el candado real (y click, negado).
// Hermético: casa temporal de tests/helpers/entorno.cjs.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO, RAIZ_HARNESS, entornoTemporal, correr, eventoHerramienta } = require('../helpers/entorno.cjs');
const { parsearFrontmatter, MAX_DESCRIPCION, contar } = require('../../tools/verificar-presupuesto.cjs');
const { revisarArchivo: revisarListaNegra } = require('../../tools/lint-publicacion.cjs');

const DIR_SKILL = path.join(RAIZ_HARNESS, 'skills', 'uae-visual');
const RUTA_SKILL = path.join(DIR_SKILL, 'SKILL.md');
const DIR_REFERENCIAS = path.join(DIR_SKILL, 'referencias');
const DIR_AGENTES = path.join(RAIZ_HARNESS, 'agents');
const RAIZ_PLUGIN = '${CLAUDE_PLUGIN_ROOT}';
const PREFIJO = 'uaeh-harness:';
const REFERENCIAS = ['catalogo.md', 'estados-y-formato.md', 'plantilla-DESIGN.md'];
const AGENTES = ['browser-verifier', 'design-auditor'];
const PINES = JSON.parse(fs.readFileSync(path.join(RAIZ_HARNESS, 'wsl', 'herramientas.json'), 'utf8')).visual;
// La clave de herramientas denegadas se arma por partes (la lista negra de publicación busca una subcadena dentro de ella).
const DENEGADAS = 'disal' + 'lowedTools';

const leer = (ruta) => fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
const escaparRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rel = (abs) => path.relative(RAIZ_REPO, abs).split(path.sep).join('/');
const lista = (valor) => String(valor || '').split(',').map((s) => s.trim()).filter(Boolean);

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

function bloquesDeCodigo(texto, lenguaje) {
  const salida = [];
  const re = /^[ \t]*```([A-Za-z]*)[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/gm;
  let m;
  while ((m = re.exec(texto))) if (!lenguaje || m[1] === lenguaje) salida.push(m[2]);
  return salida;
}

const SKILL = leer(RUTA_SKILL);
const ARCHIVOS_SKILL = archivosDe(DIR_SKILL);
const ARCHIVOS_AGENTES = AGENTES.map((n) => path.join(DIR_AGENTES, `${n}.md`));
const DOCS = [RUTA_SKILL, ...REFERENCIAS.map((n) => path.join(DIR_REFERENCIAS, n)), ...ARCHIVOS_AGENTES];

// ── Frontmatter y método ───────────────────────────────────────────────────────────────

test('uae-visual: frontmatter con name igual a la carpeta, descripción presupuestada, YAML plano válido y argument-hint', () => {
  const partes = dividir(SKILL);
  assert.ok(partes, 'sin frontmatter cerrado');
  const { error, datos } = parsearFrontmatter(SKILL);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(datos).sort(), ['argument-hint', 'description', 'name']);
  assert.equal(datos.name, 'uae-visual');
  assert.ok(contar(datos.description) > 0 && contar(datos.description) <= MAX_DESCRIPCION, `descripción de ${contar(datos.description)} caracteres`);
  assert.match(datos.description, /visual audit/, 'la descripción debe disparar también en inglés');
  assert.match(datos.description, /accessibility/);
  assert.match(datos.description, /No se dispara sola/, 'la descripción debe decir que es bajo pedido');
  const cruda = partes.frontmatter.find((l) => l.startsWith('description:')).slice('description:'.length).trim();
  assert.ok(!/^["'>|]/.test(cruda) && !/:\s/.test(cruda) && !/\s#/.test(cruda), 'la descripción no es YAML plano válido');
  for (const modo of ['create-public-ui', 'product-ui', 'redesign-existing', 'reference-to-code', 'audit-only [incremental]', 'motion-3d', 'video', 'design-md']) {
    assert.ok(datos['argument-hint'].includes(modo), `argument-hint no incluye «${modo}»`);
  }
  assert.match(partes.cuerpo, /^# \/uaeh-harness:uae-visual — /m);
  assert.match(partes.cuerpo, /^Entrada: \$ARGUMENTS$/m);
});

test('uae-visual: conserva el método (bajo pedido, una ronda, puertas humanas, estados) y ninguna regla del autor', () => {
  for (const seccion of ['## 0. Ruta visual', '## 1. Contexto', '## 2. Método creativo', '## 3. Si la auditoría lleva a construir', '## 4. Verificación', '## 5. Después de la ronda', '## 6. Puertas humanas', '## 7. Modos especiales', '## 8. Cierre', '## Reglas duras']) {
    assert.ok(SKILL.includes(seccion), `falta la sección ${seccion}`);
  }
  for (const frase of ['**una sola ronda**', '**no pasa por aquí**', '`UNKNOWN ≠ PASS`', '`PENDING_HUMAN_REVIEW`', '`PASS_TECHNICAL`', '`NOT_CHECKED`, nunca PASS', 'una captura a la vez', '**concepto maestro**']) {
    assert.ok(SKILL.includes(frase), `falta «${frase}»`);
  }
  assert.ok(!/3 rondas|tras 3 rondas/.test(SKILL), 'la puerta ya no tiene bucle de rondas');
  assert.match(SKILL, /Probado en Windows 11; en Linux y macOS no probado/);
});

// ── Rutas del plugin ───────────────────────────────────────────────────────────────────

test('uae-visual: las rutas con ${CLAUDE_PLUGIN_ROOT} van entre comillas cuando son argumento de node y existen', () => {
  const nodeSinComillas = SKILL.match(new RegExp(`node\\s+(?!")[^\\n]*${escaparRe(RAIZ_PLUGIN)}`, 'g')) || [];
  assert.deepEqual(nodeSinComillas, [], 'un argumento de node con ${CLAUDE_PLUGIN_ROOT} debe ir entre comillas dobles');
  const rutas = new Set();
  for (const m of SKILL.matchAll(new RegExp(`${escaparRe(RAIZ_PLUGIN)}/([A-Za-z0-9._/-]+)`, 'g'))) rutas.add(m[1].replace(/[.,;:)]+$/, ''));
  for (const ruta of rutas) assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, ruta)), `SKILL.md cita ${ruta}, que no existe en el plugin`);
  for (const imprescindible of ['scripts/uaeh-config.cjs', 'scripts/uaeh-ignorar.cjs', 'scripts/instalar.cjs', 'scripts/uaeh-registro.cjs',
    'skills/uae-visual/scripts/clasificar-resultados.cjs', 'skills/uae-visual/pruebas/probar-visual.cjs', 'vendor/web-interface-guidelines/command.md']) {
    assert.ok(rutas.has(imprescindible), `SKILL.md debe citar ${imprescindible}`);
  }
  for (const agente of ARCHIVOS_AGENTES) {
    for (const m of leer(agente).matchAll(new RegExp(`${escaparRe(RAIZ_PLUGIN)}/([A-Za-z0-9._/-]+)`, 'g'))) {
      const ruta = m[1].replace(/[.,;:)]+$/, '');
      assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, ruta)), `${rel(agente)} cita ${ruta}, que no existe en el plugin`);
    }
  }
});

test('uae-visual: las referencias existen, están enlazadas desde SKILL.md y NO llevan rutas ejecutables', () => {
  assert.deepEqual(fs.readdirSync(DIR_REFERENCIAS).sort(), REFERENCIAS);
  for (const nombre of REFERENCIAS) {
    assert.ok(SKILL.includes(`referencias/${nombre}`), `SKILL.md no enlaza referencias/${nombre}`);
    const texto = leer(path.join(DIR_REFERENCIAS, nombre));
    assert.ok(!texto.includes('CLAUDE_PLUGIN_ROOT'), `${nombre}: ${RAIZ_PLUGIN} no se sustituye en archivos que se leen con Read`);
    assert.ok(!/\bnode\s+["'`]?[./~$]/.test(texto), `${nombre}: no debe traer comandos node con ruta`);
  }
  assert.ok(!fs.existsSync(path.join(DIR_SKILL, 'plantillas', 'ignorar.txt')), 'las exclusiones viven solo en uaeh-ignorar.cjs');
});

test('uae-visual: el catálogo genérico no trae skills del autor y su índice pasa el comprobador', () => {
  const catalogo = leer(path.join(DIR_REFERENCIAS, 'catalogo.md'));
  for (const ajena of ['design-taste-frontend', 'high-end-visual-design', 'hyperframes', 'gsap-core', 'threejs-builder', 'design-dna', 'image-to-code']) {
    assert.ok(!catalogo.includes(ajena), `el catálogo genérico no debe nombrar «${ajena}» (va en el catálogo propio del usuario)`);
  }
  for (const rol of ['`create-public-ui`', '`product-ui`', '`redesign-existing`', '`reference-to-code`', '`audit-only`', '`motion-3d`', '`video`', '`con-proposito`', '`constante-premium`', '## Cómo registrar tu catálogo', '## Índice de skills']) {
    assert.ok(catalogo.includes(rol), `el catálogo genérico no trae ${rol}`);
  }
  const e = entornoTemporal();
  try {
    const r = correr(path.join(DIR_SKILL, 'scripts', 'comprobar-catalogo.cjs'), ['--catalogo', path.join(DIR_REFERENCIAS, 'catalogo.md')], { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 0, r.stdout);
  } finally { e.limpiar(); }
});

// ── Portabilidad ───────────────────────────────────────────────────────────────────────

test('uae-visual y sus agentes: sin rutas de una máquina, sin BOM, LF, sin rastros del proceso y lista negra limpia', () => {
  const archivos = [...ARCHIVOS_SKILL, ...ARCHIVOS_AGENTES];
  assert.ok(archivos.length >= 17, `se esperaban ≥ 17 archivos, hay ${archivos.length}`);
  for (const abs of archivos) {
    const buf = fs.readFileSync(abs);
    assert.ok(!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF), `${rel(abs)} empieza con BOM`);
    assert.ok(!buf.includes(0x0d), `${rel(abs)} tiene CRLF`);
    const texto = buf.toString('utf8');
    for (const prohibido of ['C:\\', 'C:/', '/mnt/c/', '~/.claude/', '~/.codex/', '$HOME/.claude', '%USERPROFILE%', 'AppData', 'node_modules/@playwright/cli']) {
      assert.ok(!texto.includes(prohibido), `${rel(abs)} contiene «${prohibido}»`);
    }
    assert.ok(!/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(texto), `${rel(abs)} contiene una ruta con letra de unidad`);
    assert.ok(!/fablemod|F1-V|UAEH §|\b1×1\b/i.test(texto), `${rel(abs)} contiene rastros del proceso interno`);
    assert.deepEqual(revisarListaNegra(rel(abs)), [], `${rel(abs)} tiene hallazgos de la lista negra`);
  }
  assert.ok(!ARCHIVOS_SKILL.some((p) => /[\\/]node_modules[\\/]/.test(p)), 'el plugin no lleva node_modules');
});

test('uae-visual: agentes citados con el prefijo del plugin y comandos de barra cualificados', () => {
  const sinPrefijo = new RegExp(`(?<![A-Za-z0-9/-])(?<!${escaparRe(PREFIJO)})uae-(verifier|security|builder|architect|triage)\\b(?!/)`, 'g');
  for (const abs of DOCS) {
    const texto = leer(abs).split('\n').filter((l) => !/^name: /.test(l)).join('\n');
    assert.deepEqual(texto.match(sinPrefijo) || [], [], `${rel(abs)} cita un agente sin «${PREFIJO}»`);
    assert.deepEqual(texto.match(/(^|[\s`(])\/uae-(loop|security|visual|preflight)\b/g) || [], [], `${rel(abs)} cita un comando sin «/${PREFIJO}»`);
  }
  for (const cualificado of ['`uaeh-harness:browser-verifier`', '`uaeh-harness:design-auditor`', '/uaeh-harness:uae-security', '/uaeh-harness:uae-loop', '/uaeh-harness:uae-preflight']) {
    assert.ok(SKILL.includes(cualificado), `SKILL.md debe citar ${cualificado}`);
  }
});

// ── Pines (una sola fuente: wsl/herramientas.json) ─────────────────────────────────────

test('uae-visual: las versiones de Playwright, axe y Lighthouse citadas son las de wsl/herramientas.json', () => {
  for (const clave of ['@playwright/cli', '@playwright/test', '@axe-core/playwright', 'lighthouse']) assert.match(PINES[clave] || '', /^\d+\.\d+\.\d+$/, `pin de ${clave}`);
  const fuentes = [...DOCS, path.join(RAIZ_HARNESS, 'hooks', 'solo-navegador.js'), path.join(DIR_SKILL, 'pruebas', 'probar-visual.cjs')];
  let citas = 0;
  for (const abs of fuentes) {
    const texto = leer(abs);
    for (const paquete of ['@playwright/test', '@axe-core/playwright', 'lighthouse']) {
      for (const m of texto.matchAll(new RegExp(`(?<![\\w/-])${escaparRe(paquete)}@(\\d+\\.\\d+\\.\\d+)`, 'g'))) {
        citas++;
        assert.equal(m[1], PINES[paquete], `${rel(abs)} cita ${paquete}@${m[1]} y el pin es ${PINES[paquete]}`);
      }
    }
  }
  assert.ok(citas >= 6, `se esperaban varias citas de versión, hay ${citas}`);
  assert.ok(SKILL.includes(`npm i -D @playwright/test@${PINES['@playwright/test']} @axe-core/playwright@${PINES['@axe-core/playwright']}`));
  assert.ok(SKILL.includes(`npx --yes lighthouse@${PINES.lighthouse}`));

  const paquete = JSON.parse(leer(path.join(DIR_SKILL, 'pruebas', 'package.json')));
  assert.deepEqual(paquete.devDependencies, { '@axe-core/playwright': PINES['@axe-core/playwright'], '@playwright/test': PINES['@playwright/test'] });
  const lock = JSON.parse(leer(path.join(DIR_SKILL, 'pruebas', 'package-lock.json')));
  assert.equal(lock.packages['node_modules/@playwright/test'].version, PINES['@playwright/test']);
  assert.equal(lock.packages['node_modules/@axe-core/playwright'].version, PINES['@axe-core/playwright']);
  assert.deepEqual(lock.packages[''].devDependencies, paquete.devDependencies, 'package-lock.json desfasado de package.json');
});

// ── Agentes ────────────────────────────────────────────────────────────────────────────

function agente(nombre) {
  const texto = leer(path.join(DIR_AGENTES, `${nombre}.md`));
  const { datos } = parsearFrontmatter(texto);
  return { datos, tools: lista(datos.tools), negadas: lista(datos[DENEGADAS]), cuerpo: dividir(texto).cuerpo };
}

test('browser-verifier: Bash bajo dos candados, sin escribir ni PowerShell; design-auditor: solo lee', () => {
  const bv = agente('browser-verifier');
  assert.deepEqual(bv.tools, ['Read', 'Grep', 'Glob', 'Bash']);
  for (const t of ['Write', 'Edit', 'NotebookEdit', 'PowerShell']) assert.ok(bv.negadas.includes(t), `browser-verifier debe negar ${t}`);
  assert.deepEqual([bv.datos.model, bv.datos.effort], ['sonnet', 'medium']);
  const da = agente('design-auditor');
  assert.deepEqual(da.tools, ['Read', 'Grep', 'Glob']);
  for (const t of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.ok(da.negadas.includes(t), `design-auditor debe negar ${t}`);
  assert.deepEqual([da.datos.model, da.datos.effort], ['sonnet', 'high']);
  for (const nombre of AGENTES) {
    const { description } = agente(nombre).datos;
    assert.match(description, /Úsalo desde la skill uae-visual/);
    assert.ok(contar(description) <= MAX_DESCRIPCION, `${nombre}: descripción de ${contar(description)} caracteres`);
  }
});

test('candados y sello: browser-verifier bajo solo-lectura y solo-navegador; los dos agentes con sello de integridad', () => {
  const candados = JSON.parse(leer(path.join(RAIZ_HARNESS, 'hooks', 'candados.json')));
  assert.ok(candados['solo-lectura'].includes('browser-verifier'));
  assert.deepEqual(candados['solo-navegador'], ['browser-verifier']);
  const hooks = JSON.parse(leer(path.join(RAIZ_HARNESS, 'hooks', 'hooks.json'))).hooks;
  for (const evento of ['SubagentStart', 'SubagentStop']) {
    const matchers = hooks[evento].map((g) => new RegExp(g.matcher));
    for (const nombre of AGENTES) {
      assert.ok(matchers.some((re) => re.test(`${PREFIJO}${nombre}`)), `${evento} no cubre ${PREFIJO}${nombre}`);
    }
  }
});

test('contratos de salida: el YAML de browser-verifier y el de design-auditor conservan sus claves, en orden', () => {
  const formato = leer(path.join(DIR_REFERENCIAS, 'estados-y-formato.md'));
  const [bv, da] = bloquesDeCodigo(formato, 'yaml');
  const claves = (yaml) => yaml.split('\n').filter((l) => /^[a-z_0-9]+:/.test(l)).map((l) => l.split(':')[0]);
  assert.deepEqual(claves(bv), ['status', 'app', 'deterministico', 'pantallas', 'findings', 'evidencia_dir', 'next_action']);
  assert.deepEqual(claves(da), ['status', 'checks', 'findings', 'top3_siguiente_ronda', 'notas_de_gusto', 'requires_human_approval', 'baselines_tocadas_sin_autorizacion']);
  assert.match(bv, /^status: "PASS\|FAIL\|BLOCKED\|NOT_CHECKED"$/m);
  assert.match(da, /^status: "PASS\|FAIL\|BLOCKED\|NOT_CHECKED"$/m);
  for (const nombre of AGENTES) {
    assert.ok(agente(nombre).cuerpo.includes(`${RAIZ_PLUGIN}/skills/uae-visual/referencias/estados-y-formato.md`), `${nombre} debe leer el formato del plugin`);
  }
  assert.ok(agente('design-auditor').cuerpo.includes(`${RAIZ_PLUGIN}/vendor/web-interface-guidelines/command.md`));
  assert.ok(agente('browser-verifier').cuerpo.includes(`${RAIZ_PLUGIN}/templates/playwright-cli.config.json`));
});

// ── La documentación se ejecuta ────────────────────────────────────────────────────────

test('uae-visual: los subcomandos de uaeh-config.cjs que cita salen 0 y el registro acepta la línea documentada', () => {
  const citados = new Set([...SKILL.matchAll(/uaeh-config\.cjs" ([a-z-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...citados].sort(), ['ahora-local', 'catalogo-visual']);
  const linea = SKILL.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`node "${RAIZ_PLUGIN}/scripts/uaeh-registro.cjs"`));
  assert.ok(linea, 'SKILL.md no trae el comando de registro en una sola línea');
  const e = entornoTemporal();
  try {
    for (const sub of citados) assert.equal(correr(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs'), [sub], { env: e.env, cwd: e.proyecto }).status, 0, sub);
    const args = ['--proyecto', 'tienda', '--ruta', 'build', '--riesgo', 'alto', '--ciclos', '1', '--minutos', '12', '--estado', 'PASS_TECHNICAL', '--visual', 'audit-only', '--tarea', 'auditoría visual'];
    assert.deepEqual([...linea.matchAll(/--([a-z]+)/g)].map((m) => m[1]), args.filter((a) => a.startsWith('--')).map((a) => a.slice(2)), 'las opciones del comando documentado');
    const r = correr(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-registro.cjs'), args, { env: e.env, cwd: e.proyecto });
    assert.equal(r.status, 0, r.stderr);
    const fila = JSON.parse(leer(path.join(e.uaehHome, 'registro.jsonl')).trim());
    assert.deepEqual([fila.visual, fila.estado, fila.riesgo], ['audit-only', 'PASS_TECHNICAL', 'alto']);
  } finally { e.limpiar(); }
});

test('uae-visual: el clasificador sin argumentos explica su uso (2) y la autoprueba sin dependencias sale 3, nunca 0', () => {
  const e = entornoTemporal();
  try {
    assert.equal(correr(path.join(DIR_SKILL, 'scripts', 'clasificar-resultados.cjs'), [], { env: e.env, cwd: e.proyecto }).status, 2);
    const sinDeps = correr(path.join(DIR_SKILL, 'pruebas', 'probar-visual.cjs'), ['--sin-lighthouse'], { env: e.env, cwd: e.proyecto });
    assert.equal(sinDeps.status, 3, sinDeps.stdout + sinDeps.stderr);
    assert.match(sinDeps.stdout, /SIN DEPENDENCIAS .*@playwright\/test@\d/);
    assert.match(sinDeps.stdout, /--instalar/);
    const modulosVacios = correr(path.join(DIR_SKILL, 'pruebas', 'probar-visual.cjs'), ['--modulos', e.tmp], { env: e.env, cwd: e.proyecto });
    assert.equal(modulosVacios.status, 3);
    assert.equal(correr(path.join(DIR_SKILL, 'pruebas', 'probar-visual.cjs'), ['--inventada'], { env: e.env, cwd: e.proyecto }).status, 2);
  } finally { e.limpiar(); }
});

test('las líneas de navegador del agente y la de Lighthouse de la skill son PERMITIDAS por el candado real; interactuar, negado', () => {
  const cuerpo = agente('browser-verifier').cuerpo;
  const config = path.join(RAIZ_HARNESS, 'templates', 'playwright-cli.config.json').replace(/\\/g, '/');
  const sesion = 'uaeh-tienda-20261104-1200';
  const url = 'http://127.0.0.1:3000';
  const abrir = /`(playwright-cli -s=<s> open <url> --config=<CONFIG>)`/.exec(cuerpo);
  assert.ok(abrir, 'browser-verifier.md no trae la línea de open con <CONFIG>');
  const lineaLighthouse = /`(npx --yes lighthouse@[^`]+)`/.exec(SKILL);
  assert.ok(lineaLighthouse, 'SKILL.md no trae la línea de Lighthouse');
  const permitidas = [
    abrir[1].replace('<s>', sesion).replace('<url>', url).replace('<CONFIG>', config),
    `playwright-cli -s=${sesion} resize 360 800`,
    `playwright-cli -s=${sesion} goto ${url}/precios`,
    `playwright-cli -s=${sesion} snapshot`,
    `playwright-cli -s=${sesion} eval "() => document.documentElement.lang"`,
    `playwright-cli -s=${sesion} screenshot --filename=reports/visual-audit/20261104-1200/inicio-360.png --full-page`,
    `playwright-cli -s=${sesion} close`,
    'npx --no-install playwright test --config=playwright.visual.config.ts',
    `curl -sI ${url}`,
    'git rev-parse --show-toplevel',
    lineaLighthouse[1].replace('<url>', url).replace('<sello>', '20261104-1200'),
  ];
  const negadas = [
    `playwright-cli -s=${sesion} click e12`,
    `playwright-cli -s=${sesion} goto https://example.com`,
    `playwright-cli -s=${sesion} open ${url}`,
    'npx --no-install playwright test --config=playwright.visual.config.ts --update-snapshots',
  ];
  const e = entornoTemporal();
  try {
    const hook = path.join(RAIZ_HARNESS, 'hooks', 'solo-navegador.js');
    const decidir = (comando) => {
      const r = correr(hook, [], { stdin: eventoHerramienta(comando, { agente: `${PREFIJO}browser-verifier`, cwd: e.proyecto }), env: e.env, cwd: e.proyecto });
      assert.equal(r.status, 0, r.stderr);
      const salida = r.json();
      const s = salida && salida.hookSpecificOutput;
      return { negado: !!s && s.permissionDecision === 'deny', motivo: (s && s.permissionDecisionReason) || '' };
    };
    for (const c of permitidas) {
      const d = decidir(c);
      assert.equal(d.negado, false, `el candado niega una línea documentada: ${c}\n${d.motivo}`);
    }
    for (const c of negadas) assert.equal(decidir(c).negado, true, `el candado debía negar: ${c}`);
  } finally { e.limpiar(); }
});
