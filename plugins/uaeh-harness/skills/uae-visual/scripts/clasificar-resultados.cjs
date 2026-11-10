#!/usr/bin/env node
// Puerta visual UAEH (skill uae-visual): clasifica el reporte JSON de Playwright (sin gastar tokens).
// Uso: node clasificar-resultados.cjs <resultado.json> [--json]
// Estados por prueba: PASS | FAIL | BLOCKED | NOT_CHECKED
// Estado global: BLOCKED > FAIL > NOT_CHECKED > PASS; sin datos = UNKNOWN (codigo 3).
'use strict';
const fs = require('fs');

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const RE_SIN_BASELINE = /snapshot doesn't exist/i;
const RE_ENTORNO = /ERR_CONNECTION_REFUSED|net::ERR_|ECONNREFUSED|Timed out waiting .*from config\.webServer|config\.webServer/i;

function textoError(r) {
  const partes = [];
  if (r && r.error && r.error.message) partes.push(r.error.message);
  if (r && Array.isArray(r.errors)) for (const e of r.errors) if (e && e.message) partes.push(e.message);
  return partes.join('\n').replace(ANSI, '');
}

function clasificarUno(estadoFinal, texto) {
  if (estadoFinal === 'skipped') return 'NOT_CHECKED';
  if (estadoFinal === 'passed') return 'PASS';
  if (RE_SIN_BASELINE.test(texto)) return 'NOT_CHECKED';
  if (RE_ENTORNO.test(texto)) return 'BLOCKED';
  return 'FAIL';
}

function recorrer(suite, titulos, salida) {
  // El suite de archivo (titulo = nombre .ts) no aporta a la ruta.
  const esArchivo = suite.file && suite.title === suite.file || /\.(spec|test)\.[cm]?[jt]s$/.test(suite.title || '');
  const t = suite.title && !esArchivo ? titulos.concat(suite.title) : titulos;
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      const ultimo = results[results.length - 1] || {};
      let estado = ultimo.status;
      if (!estado) estado = test.status === 'skipped' ? 'skipped' : 'failed';
      const texto = textoError(ultimo) || (test.status === 'skipped' ? '' : '');
      salida.push({
        ruta: t.join(' > ') || '(sin ruta)',
        check: spec.title,
        proyecto: test.projectName || '(sin proyecto)',
        estado: clasificarUno(estado, texto),
        detalle: texto.split('\n').find((l) => l.trim()) || '',
        mensaje: texto,
      });
    }
  }
  for (const hijo of suite.suites || []) recorrer(hijo, t, salida);
}

function clasificar(reporte) {
  const pruebas = [];
  for (const s of (reporte && reporte.suites) || []) recorrer(s, [], pruebas);
  const erroresGlobales = ((reporte && reporte.errors) || [])
    .map((e) => (e && e.message ? String(e.message) : String(e)).replace(ANSI, ''));
  if (pruebas.length === 0) {
    // Sin pruebas: si el servidor no arranco es entorno (BLOCKED); si no, no hay datos.
    const entorno = erroresGlobales.some((m) => RE_ENTORNO.test(m));
    return { global: entorno ? 'BLOCKED' : 'UNKNOWN', pruebas, erroresGlobales };
  }
  const hay = (e) => pruebas.some((p) => p.estado === e);
  let global = 'PASS';
  if (hay('BLOCKED')) global = 'BLOCKED';
  else if (hay('FAIL')) global = 'FAIL';
  else if (hay('NOT_CHECKED')) global = 'NOT_CHECKED';
  return { global, pruebas, erroresGlobales };
}

function main(argv) {
  const json = argv.includes('--json');
  const archivo = argv.find((a) => !a.startsWith('--'));
  if (!archivo) {
    console.error('Uso: node clasificar-resultados.cjs <resultado.json> [--json]');
    return 2;
  }
  let reporte = null;
  if (fs.existsSync(archivo)) {
    try { reporte = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { reporte = null; }
  }
  const r = reporte ? clasificar(reporte) : { global: 'UNKNOWN', pruebas: [], erroresGlobales: [] };
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const p of r.pruebas) {
      console.log(`${p.estado.padEnd(11)} ${p.proyecto.padEnd(16)} ${p.ruta} :: ${p.check}`);
    }
    console.log(`ESTADO: ${r.global}`);
  }
  return r.global === 'UNKNOWN' ? 3 : 0;
}

module.exports = { clasificar, clasificarUno };

if (require.main === module) process.exit(main(process.argv.slice(2)));
