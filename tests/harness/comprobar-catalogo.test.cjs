// tests/harness/comprobar-catalogo.test.cjs — comprobador del catálogo de la puerta visual
// (skills/uae-visual/scripts/comprobar-catalogo.cjs).
//
// Qué protege:
//   · El índice («nombre | origen | anuncio») y las directivas (familias-on, silenciado, ajenas) se leen bien y los
//     errores se nombran; ningún nombre de skill del autor va fijo en el script (todo sale del catálogo).
//   · Coherencia con skillOverrides de settings.json, existencia de las skills locales y la marca de las «manual».
//   · Valores por defecto desde la casa del usuario: el catálogo vigente (el genérico del plugin, o el propio en la carpeta
//     de estado si existe), <CLAUDE_HOME>/settings.json (si falta, cuenta como vacío) y <CLAUDE_HOME>/skills.
// Hermético: casa temporal de tests/helpers/entorno.cjs.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_HARNESS, entornoTemporal, correr, escribir } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_HARNESS, 'skills', 'uae-visual', 'scripts', 'comprobar-catalogo.cjs');
const GENERICO = path.join(RAIZ_HARNESS, 'skills', 'uae-visual', 'referencias', 'catalogo.md');

const BASE = [
  'familias-on = uae-visual, ux-design',
  'uae-visual | local | on',
  'ux-design | local | on',
  'pdf | local | name-only',
  'docx | local | manual',
  'frontend-design | plugin | on',
];

// Escenario en una casa temporal: skills locales, settings.json y catálogo. Devuelve la salida del script.
function escenario(opc = {}) {
  const e = entornoTemporal();
  try {
    const skills = path.join(e.claudeHome, 'skills');
    for (const s of opc.locales || ['uae-visual', 'ux-design', 'pdf', 'docx']) {
      const marca = s === 'docx' && !opc.manualSinLinea ? 'disable-model-invocation: true\n' : '';
      escribir(path.join(skills, s, 'SKILL.md'), `---\nname: ${s}\n${marca}---\ncuerpo\n`);
    }
    if (opc.settingsRaw !== null) {
      escribir(path.join(e.claudeHome, 'settings.json'), opc.settingsRaw !== undefined ? opc.settingsRaw : JSON.stringify({ skillOverrides: opc.overrides || { pdf: 'name-only' } }));
    }
    const catalogo = path.join(e.tmp, 'catalogo.md');
    escribir(catalogo, opc.sinIndice ? '# Catálogo\n\nsin índice\n' : `# Catálogo\n\ntexto\n\n## Índice de skills\n\n\`\`\`text\n# comentario\n\n${(opc.indice || BASE).join('\n')}\n\`\`\`\n`);
    const args = opc.porDefecto ? [...(opc.extra || [])] : ['--catalogo', catalogo, ...(opc.extra || [])];
    if (opc.antes) opc.antes(e);
    const r = correr(SCRIPT, args, { env: e.env, cwd: e.proyecto });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json: r.json() };
  } finally { e.limpiar(); }
}

test('caso bueno: OK con el número de skills y de silenciadas', () => {
  const r = escenario();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK: 5 skills en el índice, 1 silenciadas \(/);
});

test('settings.json inválido es error; uno que no existe cuenta como vacío', () => {
  const malo = escenario({ settingsRaw: '{no json' });
  assert.equal(malo.code, 1);
  assert.match(malo.out, /no es JSON válido/);
  const ausente = escenario({ settingsRaw: null, indice: BASE.filter((l) => !l.startsWith('pdf')) });
  assert.equal(ausente.code, 0, ausente.out);
});

test('silenciado = completo: una name-only de settings fuera del índice es error, salvo si es ajena', () => {
  const completo = [...BASE, 'silenciado = completo'];
  const r = escenario({ indice: completo, overrides: { pdf: 'name-only', xlsx: 'name-only' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /"xlsx" está en name-only en settings pero no aparece en el índice/);
  assert.equal(escenario({ indice: [...completo, 'ajenas = xlsx, cyber-neo'], overrides: { pdf: 'name-only', xlsx: 'name-only', 'cyber-neo': 'name-only' } }).code, 0);
  // Sin la directiva (silenciado parcial, el valor por defecto) no se exige.
  assert.equal(escenario({ overrides: { pdf: 'name-only', xlsx: 'name-only' } }).code, 0);
});

test('indexada name-only pero settings la anuncia → error; «on» con settings off → error', () => {
  assert.match(escenario({ overrides: { pdf: 'on' } }).out, /"pdf" es name-only en el índice pero settings/);
  assert.match(escenario({ overrides: { pdf: 'name-only', 'uae-visual': 'off' } }).out, /"uae-visual" es "on" en el índice pero settings la tiene en "off"/);
});

test('familias-on: una familia silenciada o ausente del índice es error', () => {
  const silenciada = escenario({ indice: BASE.map((l) => (l.startsWith('ux-design') ? 'ux-design | local | name-only' : l)), overrides: { pdf: 'name-only', 'ux-design': 'name-only' } });
  assert.match(silenciada.out, /familia "ux-design" debe tener anuncio "on"/);
  const ausente = escenario({ indice: BASE.filter((l) => !l.startsWith('ux-design')) });
  assert.match(ausente.out, /familia "ux-design" debe estar en el índice/);
});

test('skill local inexistente, manual sin la marca y duplicados son errores', () => {
  assert.match(escenario({ indice: [...BASE, 'fantasma | local | on'] }).out, /"fantasma" no existe/);
  assert.match(escenario({ manualSinLinea: true }).out, /"docx" es manual pero/);
  assert.match(escenario({ indice: [...BASE, 'pdf | local | name-only'] }).out, /duplicado en el índice: pdf/);
});

test('origen plugin o sistema no exige carpeta; origen, anuncio o directiva inválidos son errores', () => {
  assert.equal(escenario({ indice: [...BASE, 'algo:de-plugin | plugin | on', 'del-sistema | sistema | on'] }).code, 0);
  assert.match(escenario({ indice: [...BASE, 'raro | nube | on'] }).out, /Origen inválido "nube"/);
  assert.match(escenario({ indice: [...BASE, 'raro | local | quizas'] }).out, /Anuncio inválido "quizas"/);
  assert.match(escenario({ indice: [...BASE, 'inventada = x'] }).out, /Directiva desconocida "inventada"/);
  assert.match(escenario({ indice: [...BASE, 'silenciado = a-medias'] }).out, /no es completo\|parcial/);
});

test('catálogo sin la sección del índice es error', () => {
  assert.match(escenario({ sinIndice: true }).out, /no tiene la sección/);
});

test('--json: forma estable en el caso bueno y con error', () => {
  const bueno = escenario({ extra: ['--json'] });
  assert.equal(bueno.code, 0);
  assert.equal(bueno.json.ok, true);
  assert.equal(bueno.json.skills, 5);
  assert.equal(bueno.json.silenciadas, 1);
  assert.deepEqual(bueno.json.errores, []);
  const malo = escenario({ overrides: { pdf: 'on' }, extra: ['--json'] });
  assert.equal(malo.code, 1);
  assert.equal(malo.json.ok, false);
  assert.equal(malo.json.errores.length, 1);
});

test('por defecto usa el catálogo genérico del plugin y sale OK; si existe el propio en la carpeta de estado, usa ese', () => {
  const generico = escenario({ porDefecto: true, extra: ['--json'] });
  assert.equal(generico.code, 0, JSON.stringify(generico.json));
  assert.equal(path.resolve(generico.json.catalogo), path.resolve(GENERICO));
  assert.equal(generico.json.skills, 1, 'el genérico solo indexa la puerta del plugin');
  const propio = escenario({
    porDefecto: true, extra: ['--json'],
    antes: (e) => escribir(path.join(e.uaehHome, 'catalogo-visual.md'), '# Mío\n\n## Índice de skills\n\n```text\nfantasma | local | on\n```\n'),
  });
  assert.equal(propio.code, 1);
  assert.match(propio.json.catalogo, /catalogo-visual\.md$/);
  assert.match(propio.json.errores[0], /"fantasma" no existe/);
});

test('uso incorrecto sale 2', () => {
  assert.equal(escenario({ extra: ['--inventada'] }).code, 2);
  assert.equal(escenario({ porDefecto: true, extra: ['--catalogo'] }).code, 2);
});

test('el script no trae nombres de skills del autor fijos: todo sale del catálogo', () => {
  const texto = fs.readFileSync(SCRIPT, 'utf8');
  for (const nombre of ['cyber-neo', 'checklist-seguridad', 'security-audit', 'hyperframes', 'threejs-builder', 'ux-design']) {
    assert.ok(!texto.includes(nombre), `comprobar-catalogo.cjs no debe fijar «${nombre}»`);
  }
});
