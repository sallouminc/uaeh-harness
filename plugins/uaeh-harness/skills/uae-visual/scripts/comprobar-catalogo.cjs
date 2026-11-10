#!/usr/bin/env node
// comprobar-catalogo.cjs — coherencia del catálogo de la puerta visual con las skills instaladas y su silenciado.
//
// Uso: node comprobar-catalogo.cjs [--catalogo <ruta>] [--settings <ruta>] [--skills <carpeta>] [--json]
//   Por defecto: el catálogo vigente (el mismo que imprime «uaeh-config.cjs catalogo-visual»: el del usuario o el
//   genérico del plugin), <CLAUDE_HOME>/settings.json y <CLAUDE_HOME>/skills.
//
// Lee el bloque de código de la sección «## Índice de skills»: una skill por línea («nombre | origen | anuncio») y,
// opcionalmente, directivas «clave = valor» (ver referencias/catalogo.md):
//   familias-on = a, b     skills de entrada que deben estar en el índice con anuncio «on»
//   silenciado = completo  toda skill en name-only de settings.json debe estar en el índice como name-only
//   ajenas = x, y          silenciadas a propósito que no son de este catálogo (la regla anterior las salta)
// Comprueba además que cada skill «local» exista, que su anuncio coincida con skillOverrides de settings.json y que
// una «manual» lleve disable-model-invocation: true. Un settings.json que no existe cuenta como vacío.
// Salida: 0 sin errores · 1 con errores · 2 uso incorrecto. Sin dependencias; no escribe nada.
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ_PLUGIN = path.resolve(__dirname, '..', '..', '..');
const comun = require(path.join(RAIZ_PLUGIN, 'scripts', 'lib', 'comun.cjs'));

const ORIGENES = new Set(['local', 'plugin', 'sistema']);
const ANUNCIOS = new Set(['name-only', 'on', 'manual']);
const DIRECTIVAS = new Set(['familias-on', 'silenciado', 'ajenas']);
const SILENCIADO = new Set(['completo', 'parcial']);

function parsearArgumentos(argv) {
  const o = { catalogo: null, settings: null, skills: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--settings' || a === '--catalogo' || a === '--skills') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`falta el valor de ${a}`);
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`argumento desconocido: ${a}`);
  }
  if (!o.catalogo) o.catalogo = require(path.join(RAIZ_PLUGIN, 'scripts', 'uaeh-config.cjs')).catalogoVisual();
  if (!o.settings) o.settings = path.join(comun.claudeHome(), 'settings.json');
  if (!o.skills) o.skills = path.join(comun.claudeHome(), 'skills');
  return o;
}

const listaDe = (valor) => String(valor).split(',').map((s) => s.trim()).filter(Boolean);

// Entradas y directivas del primer bloque cercado de la sección «## Índice de skills».
function leerIndice(texto, errores) {
  const lineas = texto.split(/\r?\n/);
  const ini = lineas.findIndex((l) => /^##\s+Índice de skills\s*$/i.test(l.trim()));
  if (ini < 0) { errores.push('El catálogo no tiene la sección "## Índice de skills".'); return null; }
  let i = ini + 1;
  while (i < lineas.length && !/^```/.test(lineas[i].trim())) {
    if (/^##\s/.test(lineas[i])) break;
    i++;
  }
  if (i >= lineas.length || !/^```/.test(lineas[i].trim())) {
    errores.push('La sección "Índice de skills" no contiene un bloque de código cercado.'); return null;
  }
  const entradas = [];
  const directivas = { 'familias-on': [], silenciado: 'parcial', ajenas: [] };
  for (i = i + 1; i < lineas.length && !/^```\s*$/.test(lineas[i].trim()); i++) {
    const t = lineas[i].trim();
    if (!t || t.startsWith('#')) continue;
    const directiva = /^([a-z-]+)\s*=\s*(.*)$/.exec(t);
    if (directiva && !t.includes('|')) {
      const [, clave, valor] = directiva;
      if (!DIRECTIVAS.has(clave)) { errores.push(`Directiva desconocida "${clave}" (válidas: ${[...DIRECTIVAS].join(', ')}).`); continue; }
      if (clave === 'silenciado') {
        if (!SILENCIADO.has(valor.trim())) { errores.push(`silenciado = "${valor.trim()}" no es completo|parcial.`); continue; }
        directivas.silenciado = valor.trim();
      } else directivas[clave].push(...listaDe(valor));
      continue;
    }
    const partes = t.split('|').map((x) => x.trim());
    if (partes.length < 3 || !partes[0]) {
      errores.push(`Línea del índice mal formada (se esperaba "nombre | origen | anuncio"): ${t}`); continue;
    }
    const [nombre, origen, anuncio] = partes;
    if (!ORIGENES.has(origen)) { errores.push(`Origen inválido "${origen}" en "${nombre}" (válidos: local, plugin, sistema).`); continue; }
    if (!ANUNCIOS.has(anuncio)) { errores.push(`Anuncio inválido "${anuncio}" en "${nombre}" (válidos: name-only, on, manual).`); continue; }
    entradas.push({ nombre, origen, anuncio });
  }
  return { entradas, directivas };
}

function tieneDisableModel(skillMd) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!m) return false;
  return m[1].split(/\r?\n/).some((l) => /^disable-model-invocation:\s*true\s*$/.test(l.trim()));
}

function comprobar(opts) {
  const errores = [];
  const resultado = (extra) => ({ ok: errores.length === 0, errores, catalogo: opts.catalogo, ...extra });
  let overrides = {};
  if (fs.existsSync(opts.settings)) {
    try {
      const s = JSON.parse(fs.readFileSync(opts.settings, 'utf8'));
      overrides = (s && typeof s.skillOverrides === 'object' && s.skillOverrides) || {};
    } catch (e) {
      errores.push(`settings.json no es JSON válido (${opts.settings}): ${e.message}`);
      return resultado({ skills: 0, silenciadas: 0 });
    }
  }
  let catalogo;
  try { catalogo = fs.readFileSync(opts.catalogo, 'utf8'); } catch (e) {
    errores.push(`No se pudo leer el catálogo (${opts.catalogo}): ${e.message}`);
    return resultado({ skills: 0, silenciadas: 0 });
  }
  const indice = leerIndice(catalogo, errores);
  if (!indice) return resultado({ skills: 0, silenciadas: 0 });
  const { entradas, directivas } = indice;

  const porNombre = new Map();
  for (const e of entradas) {
    if (porNombre.has(e.nombre)) errores.push(`Nombre duplicado en el índice: ${e.nombre}`);
    else porNombre.set(e.nombre, e);
  }

  // Con «silenciado = completo»: toda name-only de settings (salvo las ajenas) está indexada como name-only.
  if (directivas.silenciado === 'completo') {
    const ajenas = new Set(directivas.ajenas);
    for (const [nombre, valor] of Object.entries(overrides)) {
      if (valor !== 'name-only' || ajenas.has(nombre)) continue;
      const e = porNombre.get(nombre);
      if (!e) errores.push(`"${nombre}" está en name-only en settings pero no aparece en el índice (si no es de este catálogo, ponla en "ajenas").`);
      else if (e.anuncio !== 'name-only') errores.push(`"${nombre}" está en name-only en settings pero el índice dice "${e.anuncio}".`);
    }
  }

  for (const e of entradas) {
    if (e.origen !== 'local') continue;
    const md = path.join(opts.skills, e.nombre, 'SKILL.md');
    if (!fs.existsSync(md)) { errores.push(`La skill local "${e.nombre}" no existe (falta ${md}).`); continue; }
    const v = overrides[e.nombre];
    if (e.anuncio === 'name-only' && v !== 'name-only') errores.push(`"${e.nombre}" es name-only en el índice pero settings tiene ${v === undefined ? 'nada' : '"' + v + '"'}.`);
    if (e.anuncio === 'on' && (v === 'name-only' || v === 'off')) errores.push(`"${e.nombre}" es "on" en el índice pero settings la tiene en "${v}".`);
    if (e.anuncio === 'manual' && !tieneDisableModel(fs.readFileSync(md, 'utf8'))) errores.push(`"${e.nombre}" es manual pero su SKILL.md no tiene "disable-model-invocation: true" en el frontmatter.`);
  }

  for (const f of directivas['familias-on']) {
    const e = porNombre.get(f);
    if (!e) errores.push(`La familia "${f}" debe estar en el índice con anuncio "on" y no aparece.`);
    else if (e.anuncio !== 'on') errores.push(`La familia "${f}" debe tener anuncio "on" y tiene "${e.anuncio}".`);
  }

  return resultado({ skills: entradas.length, silenciadas: entradas.filter((e) => e.anuncio === 'name-only').length });
}

function main(argv) {
  let opts;
  try { opts = parsearArgumentos(argv); } catch (e) {
    process.stderr.write(`comprobar-catalogo: ${e.message}\nuso: node comprobar-catalogo.cjs [--catalogo <ruta>] [--settings <ruta>] [--skills <carpeta>] [--json]\n`);
    return 2;
  }
  const r = comprobar(opts);
  if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (r.ok) process.stdout.write(`OK: ${r.skills} skills en el índice, ${r.silenciadas} silenciadas (${r.catalogo})\n`);
  else process.stdout.write(`FALLO: ${r.errores.length} error(es) en ${r.catalogo}\n${r.errores.map((e) => ' - ' + e).join('\n')}\n`);
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { comprobar, leerIndice, parsearArgumentos };
