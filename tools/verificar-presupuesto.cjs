#!/usr/bin/env node
// tools/verificar-presupuesto.cjs — presupuesto de contexto propio del plugin.
//
// Claude Code carga el nombre y la descripción de CADA skill y de cada agente en el contexto de CADA
// sesión (el cuerpo solo se lee al invocarlo). Es la parte del kit que se paga siempre, así que se
// presupuesta: la descripción de cada skill y de cada agente no pasa de MAX_DESCRIPCION caracteres, no
// está vacía, y el `name` del frontmatter coincide con la carpeta (skills) o con el archivo sin «.md»
// (agentes).
//
// Uso: node tools/verificar-presupuesto.cjs [--json] [dirPlugin ...]
//   sin argumentos → recorre plugins/*  (cada carpeta de plugins/ es un plugin)
//   dirPlugin ...  → solo esas carpetas de plugin (pruebas): cada una con skills/*/SKILL.md y agents/*.md
//   --json         → salida de máquina
// Salida: una fila «caracteres  ruta  (OK|FALLÓ)» por archivo y el total de caracteres de descripciones.
// Los caracteres se cuentan como puntos de código; en una descripción plegada (>) las líneas se unen con
// un espacio y en una literal (|) con salto de línea; el espacio sobrante del final no cuenta.
// Frontmatter admitido: bloque entre líneas «---», claves en la primera columna; valor en una línea,
// entre comillas, en varias líneas, o en bloque con > o | (con o sin -, +, sangría numérica).
// Códigos de salida: 0 = todo en presupuesto (o aún no hay skills ni agentes) · 1 = alguno falla ·
//   2 = uso incorrecto.
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const MAX_DESCRIPCION = 350;

// Texto sin el BOM UTF-8 inicial, si lo tiene.
function quitarBom(texto) {
  return texto.charCodeAt(0) === 0xFEFF ? texto.slice(1) : texto;
}

// ── Frontmatter YAML simple ─────────────────────────────────────────────────────────────

// Une líneas como lo hace YAML al plegar: espacio entre líneas de texto, un salto por cada línea vacía.
function plegar(lineas) {
  let salida = '';
  let vacias = 0;
  let hayTexto = false;
  for (const cruda of lineas) {
    const linea = cruda.trim();
    if (!linea) { vacias++; continue; }
    if (hayTexto) salida += vacias ? '\n'.repeat(vacias) : ' ';
    salida += linea;
    hayTexto = true;
    vacias = 0;
  }
  return salida;
}

// Bloque con > (plegado) o | (literal). `lineas` son las de continuación, con su sangría.
function leerBloque(indicador, lineas) {
  const util = lineas.slice();
  while (util.length && !util[util.length - 1].trim()) util.pop();
  const primera = util.find((l) => l.trim());
  if (!primera) return '';
  const sangria = /^[ \t]*/.exec(primera)[0].length;
  const cuerpo = util.map((l) => (l.trim() ? l.slice(Math.min(sangria, /^[ \t]*/.exec(l)[0].length)) : ''));
  if (indicador === '|') return cuerpo.join('\n').trim();
  return plegar(cuerpo);
}

function leerEntreComillasDobles(texto) {
  let salida = '';
  for (let i = 1; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') return salida;
    if (c !== '\\') { salida += c; continue; }
    const n = texto[++i];
    if (n === undefined) break;
    const hex = n === 'x' ? texto.slice(i + 1, i + 3) : n === 'u' ? texto.slice(i + 1, i + 5) : null;
    if (hex !== null && new RegExp(`^[0-9a-fA-F]{${n === 'x' ? 2 : 4}}$`).test(hex)) { salida += String.fromCodePoint(parseInt(hex, 16)); i += hex.length; continue; }
    const simples = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', '/': '/' };
    salida += Object.prototype.hasOwnProperty.call(simples, n) ? simples[n] : '\\' + n;
  }
  return salida;
}

function leerEntreComillasSimples(texto) {
  let salida = '';
  for (let i = 1; i < texto.length; i++) {
    if (texto[i] !== "'") { salida += texto[i]; continue; }
    if (texto[i + 1] === "'") { salida += "'"; i++; continue; }
    return salida;
  }
  return salida;
}

// Valor de una clave: `resto` es lo que sigue a «clave:» en su línea y `continuacion` las líneas
// sangradas (o vacías) que le siguen.
function interpretarValor(resto, continuacion) {
  const valor = resto.trim();
  const bloque = /^([>|])(?:[+-]?[1-9]?|[1-9][+-])[ \t]*(?:#.*)?$/.exec(valor);
  if (bloque) return leerBloque(bloque[1], continuacion);
  if (valor.startsWith('"') || valor.startsWith("'")) {
    const unido = plegar([valor, ...continuacion]);
    return valor[0] === '"' ? leerEntreComillasDobles(unido) : leerEntreComillasSimples(unido);
  }
  // Plano: sin comentario final; puede seguir en las líneas sangradas hasta una línea de comentario.
  const quitarComentario = (l) => l.replace(/(^|[ \t])#.*$/, '');
  const lineas = [quitarComentario(valor)];
  for (const l of continuacion) {
    if (l.trim().startsWith('#')) break;
    lineas.push(quitarComentario(l));
  }
  return plegar(lineas);
}

// Texto de un archivo → { error, datos } con las claves de primer nivel como cadenas.
function parsearFrontmatter(texto) {
  const lineas = quitarBom(String(texto)).split(/\r\n|\r|\n/);
  if (lineas[0].trimEnd() !== '---') return { error: 'sin frontmatter: la primera línea debe ser «---»', datos: {} };
  let fin = -1;
  for (let i = 1; i < lineas.length; i++) if (lineas[i].trimEnd() === '---') { fin = i; break; }
  if (fin === -1) return { error: 'frontmatter sin cierre: falta la segunda línea «---»', datos: {} };
  const cuerpo = lineas.slice(1, fin);
  const datos = {};
  for (let i = 0; i < cuerpo.length; i++) {
    const clave = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(cuerpo[i]);
    if (!clave) continue;
    const continuacion = [];
    let j = i + 1;
    while (j < cuerpo.length && (cuerpo[j].trim() === '' || /^[ \t]/.test(cuerpo[j]))) continuacion.push(cuerpo[j++]);
    i = j - 1;
    if (!Object.prototype.hasOwnProperty.call(datos, clave[1])) datos[clave[1]] = interpretarValor(clave[2] || '', continuacion);
  }
  return { error: null, datos };
}

// ── Revisión ───────────────────────────────────────────────────────────────────────────

function contar(texto) {
  return Array.from(texto).length;
}

function esCarpeta(ruta) {
  try { return fs.statSync(ruta).isDirectory(); } catch { return false; }
}

function mostrarRuta(abs) {
  const rel = path.relative(RAIZ, abs);
  return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs).replace(/\\/g, '/');
}

// Un SKILL.md (tipo 'skill') o un agente (tipo 'agente') → { ruta, tipo, nombre, caracteres, estado, motivos }.
function revisarArchivo(abs, tipo) {
  const esperado = tipo === 'skill' ? path.basename(path.dirname(abs)) : path.basename(abs, '.md');
  const base = { ruta: mostrarRuta(abs), tipo, nombre: '', caracteres: 0, estado: 'FALLÓ', motivos: [] };
  let texto;
  try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) {
    return { ...base, motivos: [`no se pudo leer (${e.code || e.message})`] };
  }
  const { error, datos } = parsearFrontmatter(texto);
  const motivos = [];
  const nombre = typeof datos.name === 'string' ? datos.name : '';
  const descripcion = typeof datos.description === 'string' ? datos.description : '';
  const caracteres = contar(descripcion);
  if (error) motivos.push(error);
  else {
    if (!nombre) motivos.push('falta «name» en el frontmatter');
    else if (nombre !== esperado) motivos.push(`«name» es «${nombre}» pero ${tipo === 'skill' ? 'la carpeta' : 'el archivo'} se llama «${esperado}»`);
    if (!descripcion) motivos.push('falta «description» o está vacía');
  }
  if (caracteres > MAX_DESCRIPCION) motivos.push(`la descripción tiene ${caracteres} caracteres; el máximo es ${MAX_DESCRIPCION}`);
  return { ...base, nombre, caracteres, estado: motivos.length ? 'FALLÓ' : 'OK', motivos };
}

function entradasOrdenadas(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// plugins/* de este repo.
function pluginsDelRepo() {
  const dir = path.join(RAIZ, 'plugins');
  return esCarpeta(dir) ? entradasOrdenadas(dir).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)) : [];
}

// Recorre cada plugin: skills/*/SKILL.md y agents/*.md.
function listarArchivos(dirsPlugin) {
  const archivos = [];
  const avisos = [];
  for (const dir of dirsPlugin) {
    const skills = path.join(dir, 'skills');
    if (esCarpeta(skills)) {
      for (const e of entradasOrdenadas(skills)) {
        if (!e.isDirectory()) continue;
        const archivo = path.join(skills, e.name, 'SKILL.md');
        if (fs.existsSync(archivo)) archivos.push({ abs: archivo, tipo: 'skill' });
        else avisos.push(`${mostrarRuta(path.join(skills, e.name))}: carpeta sin SKILL.md (Claude Code no la verá como skill)`);
      }
    }
    const agentes = path.join(dir, 'agents');
    if (esCarpeta(agentes)) {
      for (const e of entradasOrdenadas(agentes)) if (e.isFile() && /\.md$/i.test(e.name)) archivos.push({ abs: path.join(agentes, e.name), tipo: 'agente' });
    }
  }
  return { archivos, avisos };
}

// → { maximo, archivos:[...], total, fallaron, avisos:[...] }
function verificar(dirsPlugin) {
  const { archivos, avisos } = listarArchivos(dirsPlugin);
  const revisados = archivos.map((a) => revisarArchivo(a.abs, a.tipo));
  if (!revisados.length) avisos.push('sin skills ni agentes: nada que medir todavía');
  return {
    maximo: MAX_DESCRIPCION,
    archivos: revisados,
    total: revisados.reduce((suma, r) => suma + r.caracteres, 0),
    fallaron: revisados.filter((r) => r.estado === 'FALLÓ').length,
    avisos,
  };
}

// ── Línea de comandos ──────────────────────────────────────────────────────────────────

function main(argv) {
  let json = false;
  const dirs = [];
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a.startsWith('--')) { console.error(`argumento desconocido: ${a}`); return 2; }
    else dirs.push(path.resolve(a));
  }
  for (const d of dirs) {
    if (!esCarpeta(d)) { console.error(`verificar-presupuesto: no existe la carpeta de plugin «${d}»`); return 2; }
  }
  const r = verificar(dirs.length ? dirs : pluginsDelRepo());
  if (json) { console.log(JSON.stringify(r, null, 2)); return r.fallaron ? 1 : 0; }

  if (r.archivos.length) {
    const ancho = Math.max('caracteres'.length, ...r.archivos.map((a) => String(a.caracteres).length));
    console.log(`${'caracteres'.padStart(ancho)}  ruta  (estado)`);
    for (const a of r.archivos) {
      console.log(`${String(a.caracteres).padStart(ancho)}  ${a.ruta}  (${a.estado})`);
      for (const m of a.motivos) console.log(`${' '.repeat(ancho)}  · ${m}`);
    }
    console.log(`total: ${r.total} caracteres de descripciones en ${r.archivos.length} archivo(s); máximo por descripción: ${r.maximo}.`);
  }
  for (const aviso of r.avisos) console.log(`AVISO: ${aviso}`);
  if (r.fallaron) console.log(`verificar-presupuesto: FALLÓ — ${r.fallaron} de ${r.archivos.length} archivo(s) fuera de presupuesto.`);
  else if (r.archivos.length) console.log(`verificar-presupuesto: OK (${r.archivos.length} archivo(s), ${r.total} caracteres de descripciones).`);
  else console.log('verificar-presupuesto: OK — sin skills ni agentes todavía.');
  return r.fallaron ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { MAX_DESCRIPCION, parsearFrontmatter, revisarArchivo, listarArchivos, verificar, contar, main };
