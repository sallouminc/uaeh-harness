#!/usr/bin/env node
// UAEH — resumen del registro de tareas (<UAEH_HOME>/registro.jsonl). Uso: node uaeh-resumen.cjs [dias=30]
'use strict';

const fs = require('fs');
const path = require('path');
const { ahora, uaehHome } = require(path.join(__dirname, 'lib', 'comun.cjs'));

const arg = process.argv[2];
let dias = 30;
if (arg !== undefined) {
  if (!/^\d+$/.test(arg) || parseInt(arg, 10) < 1) {
    process.stderr.write('uaeh-resumen: dias debe ser un entero >= 1\n');
    process.exit(1);
  }
  dias = parseInt(arg, 10);
}

const f = path.join(uaehHome(), 'registro.jsonl');
let filas = [];
try {
  const desde = ahora().getTime() - dias * 86400000;
  filas = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(r => r && !isNaN(new Date(r.fecha).getTime()) && new Date(r.fecha).getTime() >= desde);
} catch { /* sin registro todavía */ }

if (!filas.length) {
  console.log('sin tareas registradas');
  process.exit(0);
}

const cuenta = (campo) => filas.reduce((m, r) => { m[r[campo]] = (m[r[campo]] || 0) + 1; return m; }, {});
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '0.0') + ' %';
const total = filas.length;
const porRuta = cuenta('ruta');
const porEstado = cuenta('estado');
const pasan = (porEstado.PASS_TECHNICAL || 0) + (porEstado.PASS_RELEASE_READY || 0);
const escalan = filas.filter(r => r.escalamiento && r.escalamiento !== 'ninguno').length;

const out = [];
out.push(`Resumen de los últimos ${dias} días`);
out.push(`Total de tareas: ${total}`);
out.push('Por ruta: ' + Object.entries(porRuta).map(([k, v]) => `${k} ${v}`).join(', '));
out.push('Por estado: ' + Object.entries(porEstado).map(([k, v]) => `${k} ${v}`).join(', '));
out.push(`Tasa de PASS (técnico + listo para lanzar): ${pasan}/${total} = ${pct(pasan, total)}`);
out.push(`Con escalamiento: ${escalan}/${total} = ${pct(escalan, total)}`);
out.push(`Estado UNKNOWN: ${porEstado.UNKNOWN || 0}`);
out.push('Ciclos promedio por ruta:');
for (const ruta of Object.keys(porRuta)) {
  const rs = filas.filter(r => r.ruta === ruta);
  const prom = rs.reduce((s, r) => s + (Number(r.ciclos) || 0), 0) / rs.length;
  out.push(`  ${ruta}: ${prom.toFixed(2)}`);
}
// Minutos de sistema (campo opcional; las filas que no lo traen no cuentan).
const conMin = filas.filter(r => Number.isFinite(r.minutos));
if (conMin.length) {
  const prom = (rs) => (rs.reduce((s, r) => s + r.minutos, 0) / rs.length).toFixed(0);
  out.push(`Minutos por tarea (${conMin.length}/${total} con dato): promedio ${prom(conMin)}, máximo ${Math.max(...conMin.map(r => r.minutos))}`);
  const largas = conMin.filter(r => r.minutos > 60).length;
  out.push(`  más de 60 min: ${largas}/${conMin.length} = ${pct(largas, conMin.length)}`);
  for (const estado of Object.keys(porEstado)) {
    const rs = conMin.filter(r => r.estado === estado);
    if (rs.length) out.push(`  ${estado}: ${prom(rs)} min (${rs.length})`);
  }
} else {
  out.push('Minutos por tarea: sin dato todavía (se registran con --minutos)');
}
console.log(out.join('\n'));
