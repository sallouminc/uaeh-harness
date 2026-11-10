#!/usr/bin/env node
// verificar-dieta-claudemd.cjs — comprueba que adelgazar un CLAUDE.md no hizo perder información.
//
// Un CLAUDE.md se relee en cada turno y en cada subagente: cuanto más pesa, más cuesta. La «dieta» mueve
// el detalle histórico a una bitácora que solo se lee cuando hace falta. Este script demuestra que en el
// camino no se perdió nada.
//
// Cómo se corre (desde la raíz del repositorio)
//   node verificar-dieta-claudemd.cjs [ruta/CLAUDE.md] [ruta/bitacora.md] [--original <ruta>]
//   Por defecto: CLAUDE.md y tasks/bitacora.md. Compara contra la versión de CLAUDE.md en HEAD (git show);
//   si el archivo no está en git, o no hay git, se pasa la copia previa a la dieta con --original <ruta>.
//
// Qué comprueba
//   1) Toda línea no vacía del original existe, textual, en el CLAUDE.md nuevo O en la bitácora. Es un
//      multiconjunto: si una línea aparecía 3 veces, tiene que aparecer 3 veces entre los dos archivos.
//   2) El CLAUDE.md nuevo pesa como máximo LIMITE_CLAUDE_MD caracteres (40,000; ver lib/comun.cjs).
//   3) El CLAUDE.md nuevo menciona la bitácora, para que una sesión sepa dónde buscar el detalle.
// Imprime las líneas que faltan (hasta 40) y termina con «RESULTADO: PASS» o «RESULTADO: FAIL».
//
// Códigos de salida: 0 = PASS · 1 = FAIL, o uso incorrecto (sin git ni --original, archivo ilegible).
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { LIMITE_CLAUDE_MD, leerTexto } = require('./lib/comun.cjs');

const MAX_FALTANTES_IMPRESAS = 40;

const norm = (l) => l.replace(/\r$/, '').replace(/^\uFEFF/, '');

// Líneas no vacías del original que no están (como multiconjunto) ni en el CLAUDE.md nuevo ni en la bitácora.
function lineasFaltantes(original, nuevo, bitacora) {
  const conteo = new Map();
  for (const l of `${nuevo}\n${bitacora}`.split('\n').map(norm)) conteo.set(l, (conteo.get(l) || 0) + 1);
  const faltan = [];
  for (const l of original.split('\n').map(norm)) {
    if (!l.trim()) continue;
    const n = conteo.get(l) || 0;
    if (n > 0) conteo.set(l, n - 1); else faltan.push(l);
  }
  return faltan;
}

function evaluar(original, nuevo, bitacora) {
  const faltan = lineasFaltantes(original, nuevo, bitacora);
  const dentroDelLimite = nuevo.length <= LIMITE_CLAUDE_MD;
  const mencionaBitacora = /bitacora\.md|bitácora/i.test(nuevo);
  return {
    faltan,
    caracteresOriginal: original.length,
    caracteres: nuevo.length,
    caracteresBitacora: bitacora.length,
    limite: LIMITE_CLAUDE_MD,
    dentroDelLimite,
    mencionaBitacora,
    ok: faltan.length === 0 && dentroDelLimite && mencionaBitacora,
  };
}

// Texto del informe (una cadena por línea), terminado en la línea RESULTADO.
function informe(ev) {
  const K = (n) => Math.round(n / 1000);
  const lineas = [`Original ${K(ev.caracteresOriginal)}K car · CLAUDE.md nuevo ${K(ev.caracteres)}K car (≈${Math.round(ev.caracteres / 3600)}K tokens) · bitácora ${K(ev.caracteresBitacora)}K car`];
  if (ev.faltan.length) {
    lineas.push(`FAIL: ${ev.faltan.length} línea(s) del original no aparecen en ninguno de los dos archivos:`);
    for (const l of ev.faltan.slice(0, MAX_FALTANTES_IMPRESAS)) lineas.push('  - ' + l.slice(0, 160));
    if (ev.faltan.length > MAX_FALTANTES_IMPRESAS) lineas.push(`  … y ${ev.faltan.length - MAX_FALTANTES_IMPRESAS} más`);
  } else lineas.push('OK: ninguna línea del original se perdió.');
  lineas.push(ev.dentroDelLimite
    ? `OK: CLAUDE.md dentro del límite (${ev.caracteres} ≤ ${ev.limite}).`
    : `FAIL: CLAUDE.md pesa ${ev.caracteres} caracteres (límite ${ev.limite}).`);
  lineas.push(ev.mencionaBitacora
    ? 'OK: CLAUDE.md apunta a la bitácora.'
    : 'FAIL: el CLAUDE.md nuevo no menciona la bitácora.');
  lineas.push(ev.ok ? 'RESULTADO: PASS' : 'RESULTADO: FAIL');
  return lineas;
}

// Versión de `claudeMd` en HEAD: { texto } o { error }. Necesita git y que el archivo esté versionado.
function originalDeGit(claudeMd) {
  let rel = '';
  try {
    rel = execFileSync('git', ['ls-files', '--full-name', '-z', '--', claudeMd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0')[0];
  } catch { /* sin git, o fuera de un repositorio */ }
  if (!rel) return { error: `${claudeMd} no está en git; pasa la copia original con --original <ruta>.` };
  try {
    return { texto: execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch {
    return { error: `no se pudo leer HEAD:${rel} (¿el repositorio tiene al menos un commit?); pasa la copia original con --original <ruta>.` };
  }
}

function parsearArgumentos(argv) {
  const rutas = [];
  let original = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--original') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error('--original necesita una ruta');
      original = v;
    } else if (a.startsWith('--')) throw new Error(`argumento desconocido: ${a}`);
    else rutas.push(a);
  }
  if (rutas.length > 2) throw new Error(`argumento de más: ${rutas[2]}`);
  return { claudeMd: rutas[0] || 'CLAUDE.md', bitacora: rutas[1] || path.join('tasks', 'bitacora.md'), original };
}

function main(argv) {
  let o;
  try { o = parsearArgumentos(argv); } catch (e) {
    process.stderr.write(`Error: ${e.message}\nUso: node verificar-dieta-claudemd.cjs [ruta/CLAUDE.md] [ruta/bitacora.md] [--original <ruta>]\n`);
    return 1;
  }
  let original;
  if (o.original) {
    original = leerTexto(o.original);
    if (original == null) { console.error(`FAIL: no se pudo leer la copia original ${o.original}.`); return 1; }
  } else {
    const g = originalDeGit(o.claudeMd);
    if (g.error) { console.error(`FAIL: ${g.error}`); return 1; }
    original = g.texto;
  }
  const nuevo = leerTexto(o.claudeMd);
  if (nuevo == null) { console.error(`FAIL: no se pudo leer ${o.claudeMd}.`); return 1; }
  const bitacora = leerTexto(o.bitacora) ?? '';
  const ev = evaluar(original, nuevo, bitacora);
  console.log(informe(ev).join('\n'));
  return ev.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { norm, lineasFaltantes, evaluar, informe, originalDeGit, parsearArgumentos, main };
