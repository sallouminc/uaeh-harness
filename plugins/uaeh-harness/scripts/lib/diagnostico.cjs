#!/usr/bin/env node
// lib/diagnostico.cjs — forma común de los doctores del arnés UAEH (plugin uaeh-harness):
//   scripts/doctor.cjs (capa 2: guarda de git, espejo, candado, sello) y scripts/doctor-puertas.cjs (capa 3: puertas).
//
// Contrato (el mismo que el doctor del kit):
//   · Una comprobación = [id, fn]; fn(ctx) devuelve { estado, detalle, ...extra } con estado ∈ ESTADOS.
//   · Cada comprobación va aislada: si lanza o devuelve algo inválido queda FALLÓ con el mensaje y el resto sigue.
//   · Estados: OK | AVISO | FALLÓ | OMITIDA | NO_INSTALADA | NO_APLICA. Una OMITIDA nunca es un OK: no se midió.
//   · El detalle es UNA línea (los saltos de línea se aplanan).
// Sin dependencias; no escribe nada.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ESTADOS = Object.freeze(['OK', 'AVISO', 'FALLÓ', 'OMITIDA', 'NO_INSTALADA', 'NO_APLICA']);

function unaLinea(texto) {
  return String(texto == null ? '' : texto).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

// -1 | 0 | 1 comparando «x.y.z» numéricamente (lo que falte cuenta como 0).
function compararVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Primera versión «x.y.z» que aparezca en un texto, o null.
function versionDe(texto) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(texto || ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function sha256(datos) {
  return crypto.createHash('sha256').update(datos).digest('hex');
}

// sha256 de un archivo; con sinCR, sobre su contenido sin retornos de carro (así lo copian los instaladores de wsl/).
// null si no se puede leer.
function sha256Archivo(ruta, opciones = {}) {
  let datos;
  try { datos = fs.readFileSync(ruta); } catch { return null; }
  if (opciones.sinCR) datos = Buffer.from(datos.toString('latin1').replace(/\r/g, ''), 'latin1');
  return sha256(datos);
}

// Ejecuta un programa del PATH con un tope de tiempo. En Windows, los programas de npm son .cmd: con `shellWin` se
// lanza como una sola cadena con shell (solo para argumentos fijos y sin comillas, como «--version»).
// → { codigo, stdout, stderr, agotado, encontrado }
function ejecutarComando(programa, args = [], opciones = {}) {
  const segundos = Number(opciones.segundos) > 0 ? Number(opciones.segundos) : 15;
  const base = { encoding: 'utf8', timeout: segundos * 1000, windowsHide: true, env: opciones.env || process.env, cwd: opciones.cwd || undefined, input: opciones.input };
  const r = process.platform === 'win32' && opciones.shellWin
    ? spawnSync([programa, ...args].join(' '), { ...base, shell: true })
    : spawnSync(programa, args, base);
  const agotado = !!(r.error && r.error.code === 'ETIMEDOUT');
  const noEsta = !!(r.error && r.error.code === 'ENOENT')
    // con shell, «no se reconoce» (cmd) o 127 (sh) significan que no está en el PATH
    || (opciones.shellWin && process.platform === 'win32' && r.status !== 0 && /no se reconoce|not recognized/i.test(String(r.stderr || '')));
  return {
    codigo: r.status == null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    agotado,
    encontrado: !noEsta && !(r.status === 127 && !r.stdout),
  };
}

// Corre la lista de comprobaciones sobre un contexto. → [{ id, estado, detalle, ...extra }]
function correrComprobaciones(lista, ctx) {
  return lista.map(([id, comprobar]) => {
    try {
      const r = comprobar(ctx);
      if (!r || !ESTADOS.includes(r.estado)) throw new Error('la comprobación devolvió un resultado inválido');
      const { estado, detalle, ...extra } = r;
      return { id, estado, detalle: unaLinea(detalle), ...extra };
    } catch (e) {
      return { id, estado: 'FALLÓ', detalle: unaLinea(`error inesperado: ${e && e.message ? e.message : e}`) };
    }
  });
}

function resumir(comprobaciones) {
  const resumen = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
  for (const c of comprobaciones) resumen[c.estado]++;
  return resumen;
}

function lineaResumen(resumen) {
  return `Resumen: ${ESTADOS.map((e) => `${resumen[e] || 0} ${e}`).join(' · ')}`;
}

// Una línea por comprobación: «ESTADO  id — detalle», alineadas.
function formatearComprobaciones(comprobaciones, sangria = '') {
  if (!comprobaciones.length) return [];
  const ancho = Math.max(...comprobaciones.map((c) => c.id.length));
  const anchoEstado = Math.max(...ESTADOS.map((e) => e.length));
  return comprobaciones.map((c) => `${sangria}${c.estado.padEnd(anchoEstado)}  ${c.id.padEnd(ancho)} — ${c.detalle}`);
}

module.exports = {
  ESTADOS, unaLinea, compararVersion, versionDe, sha256, sha256Archivo, ejecutarComando,
  correrComprobaciones, resumir, lineaResumen, formatearComprobaciones,
};
