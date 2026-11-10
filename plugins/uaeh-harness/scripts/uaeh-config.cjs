#!/usr/bin/env node
// uaeh-config.cjs — valores de la configuración del usuario que las skills necesitan sin escribir rutas de una máquina.
//
//   node uaeh-config.cjs runs-dir [--repo <carpeta>]   carpeta de corridas (puerta de seguridad, visual): datos.runs de
//                                                        uaeh.config.json, UAEH_RUNS_DIR o <UAEH_HOME>/runs; con --repo,
//                                                        la subcarpeta de ese repositorio (<base>/<nombre del repo>)
//   node uaeh-config.cjs ahora-local                     fecha y hora actuales en la zona configurada (ISO 8601 con desfase)
//   node uaeh-config.cjs prefijo-motor                   lo que va antes de un programa de Linux: en Windows
//                                                        «wsl.exe -d <distro> [-u <usuario>] -e»; en Linux, una línea vacía
//   node uaeh-config.cjs prefijo-caja                    la caja de arena: prefijo-motor + /opt/uaeh/bin/uaeh-sandbox ejecutar
//   node uaeh-config.cjs ruta-motor <ruta>               la ruta como la ve el motor de Linux (Windows: /mnt/<letra>/…; Linux: igual)
//   node uaeh-config.cjs catalogo-visual                 el catálogo vigente de la puerta visual: visual.catalogo de
//                                                        uaeh.config.json; si no, <UAEH_HOME>/catalogo-visual.md si existe;
//                                                        si no, el genérico del plugin (skills/uae-visual/referencias/catalogo.md)
//   node uaeh-config.cjs jurisdiccion                    la jurisdicción del preflight (preflight.jurisdiccion); una línea vacía
//                                                        si no está configurada
//
// Imprime UNA línea y sale 0. Uso incorrecto: mensaje en stderr y código 64. No crea carpetas ni escribe nada.
'use strict';

const fs = require('fs');
const path = require('path');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configLib = require(path.join(__dirname, 'lib', 'config.cjs'));
const runner = require(path.join(__dirname, 'lib', 'runner.cjs'));

const USO = 'uso: uaeh-config.cjs runs-dir [--repo <carpeta>] | ahora-local | prefijo-motor | prefijo-caja | ruta-motor <ruta> | catalogo-visual | jurisdiccion';
const CATALOGO_GENERICO = path.resolve(__dirname, '..', 'skills', 'uae-visual', 'referencias', 'catalogo.md');
const CATALOGO_USUARIO = 'catalogo-visual.md';

// Nombre de carpeta seguro para un repo: el nombre base, con todo lo que no sea [A-Za-z0-9._-] cambiado por «-»,
// hasta 80 caracteres (la caja de arena solo acepta <base>/<nombre>/run-N con esa forma). Nunca «.» ni «..».
function nombreRepo(carpeta) {
  const base = path.basename(path.resolve(String(carpeta)));
  let n = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  if (!n || /^\.+$/.test(n)) n = 'repo';
  return n;
}

// Carpeta base de corridas: datos.runs (o UAEH_RUNS_DIR, ya aplicado por cargarConfig) o <UAEH_HOME>/runs.
function runsDir({ config, repo } = {}) {
  const c = config || configLib.cargarConfig().config;
  const propia = c && c.datos && typeof c.datos.runs === 'string' && c.datos.runs.trim() ? path.resolve(c.datos.runs.trim()) : null;
  const base = propia || path.join(comun.uaehHome(), 'runs');
  return repo ? path.join(base, nombreRepo(repo)) : base;
}

function ahoraLocal({ config } = {}) {
  const c = config || configLib.cargarConfig().config;
  return comun.isoZona(comun.ahora(), comun.zonaHoraria(c));
}

// Prefijo de argv como UNA línea para escribir delante de un comando (distro y usuario ya validados por config.cjs).
function lineaPrefijo(tipo, { config, so } = {}) {
  const c = config || configLib.cargarConfig().config;
  return (tipo === 'caja' ? runner.prefijoCaja(c, so) : runner.prefijoMotor(c, so)).join(' ');
}

// Catálogo vigente de la puerta visual. visual.catalogo ya llega validado (absoluta o vacía) desde config.cjs: si el
// usuario lo fijó se respeta aunque aún no exista (la skill dirá que falta); el de la carpeta de estado solo si existe.
function catalogoVisual({ config } = {}) {
  const c = config || configLib.cargarConfig().config;
  const fijado = c && c.visual && typeof c.visual.catalogo === 'string' ? c.visual.catalogo.trim() : '';
  if (fijado) return path.resolve(fijado);
  const delUsuario = path.join(comun.uaehHome(), CATALOGO_USUARIO);
  return fs.existsSync(delUsuario) ? delUsuario : CATALOGO_GENERICO;
}

// Jurisdicción del preflight: texto libre del usuario, en una sola línea (los saltos se vuelven espacios). Vacía = sin configurar.
function jurisdiccion(config) {
  const c = config || configLib.cargarConfig().config;
  const v = c && c.preflight && typeof c.preflight.jurisdiccion === 'string' ? c.preflight.jurisdiccion : '';
  return v.replace(/\s+/g, ' ').trim();
}

function principal(argv) {
  const [orden, ...resto] = argv;
  if (orden === 'catalogo-visual') {
    if (resto.length) return { codigo: 64, error: USO };
    return { codigo: 0, salida: catalogoVisual() };
  }
  if (orden === 'jurisdiccion') {
    if (resto.length) return { codigo: 64, error: USO };
    return { codigo: 0, salida: jurisdiccion() };
  }
  if (orden === 'runs-dir') {
    let repo = null;
    for (let i = 0; i < resto.length; i++) {
      if (resto[i] === '--repo' && i + 1 < resto.length && !resto[i + 1].startsWith('--')) { repo = resto[++i]; continue; }
      return { codigo: 64, error: `opción desconocida o sin valor: ${resto[i]}\n${USO}` };
    }
    return { codigo: 0, salida: runsDir({ repo }) };
  }
  if (orden === 'ahora-local') {
    if (resto.length) return { codigo: 64, error: USO };
    return { codigo: 0, salida: ahoraLocal() };
  }
  if (orden === 'prefijo-motor' || orden === 'prefijo-caja') {
    if (resto.length) return { codigo: 64, error: USO };
    return { codigo: 0, salida: lineaPrefijo(orden === 'prefijo-caja' ? 'caja' : 'motor') };
  }
  if (orden === 'ruta-motor') {
    if (resto.length !== 1 || !resto[0] || resto[0].startsWith('--')) return { codigo: 64, error: USO };
    return { codigo: 0, salida: runner.aRutaMotor(path.resolve(resto[0])) };
  }
  return { codigo: 64, error: USO };
}

module.exports = { nombreRepo, runsDir, ahoraLocal, lineaPrefijo, catalogoVisual, jurisdiccion, CATALOGO_GENERICO, CATALOGO_USUARIO, principal };

if (require.main === module) {
  const r = principal(process.argv.slice(2));
  if (r.salida != null) process.stdout.write(r.salida + '\n');
  if (r.error) process.stderr.write(r.error + '\n');
  process.exitCode = r.codigo;
}
