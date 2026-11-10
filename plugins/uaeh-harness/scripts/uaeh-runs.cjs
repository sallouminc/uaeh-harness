#!/usr/bin/env node
// uaeh-runs.cjs — retención de las corridas de la puerta de seguridad (<base>/<repo>/run-N/).
//
//   node uaeh-runs.cjs listar  [--base <carpeta>] [--json]
//   node uaeh-runs.cjs tamano  [--base <carpeta>] [--json]
//   node uaeh-runs.cjs limpiar [--base <carpeta>] [--aplicar] [--json]
//
// Cada corrida guarda una COPIA del código del usuario (fuente/, fuente-base/, cambiados/) más la evidencia. Crece sin
// límite. Política (datos.retencion de uaeh.config.json):
//   · las `mantenerUltimas` corridas más recientes de cada repo se conservan SIEMPRE completas;
//   · del resto, con edad >= `borrarDias` se borra la carpeta entera; con edad >= `completasDias` se compactan
//     (se borran SOLO las copias pesadas; findings.json, REPORT.md, codex/hallazgos.json, artifacts/… se conservan
//     y se deja compactado.json con la fecha original);
//   · estado-hallazgos.json, los .log y toda carpeta que no sea run-N nunca se tocan.
// En seco por defecto: sin --aplicar no cambia ni un byte. Nunca sigue enlaces simbólicos ni uniones de Windows.
// Códigos: 0 bien · 1 error (base peligrosa, fallo al borrar) · 2 uso incorrecto.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configLib = require(path.join(__dirname, 'lib', 'config.cjs'));
const { runsDir } = require(path.join(__dirname, 'uaeh-config.cjs'));

const USO = 'uso: uaeh-runs.cjs listar|tamano|limpiar [--base <carpeta>] [--aplicar (solo limpiar)] [--json]';
const RE_RUN = /^run-(\d+)(?:-[A-Za-z0-9._-]+)?$/;
const DIA_MS = 86400000;
const RETENCION_DEFECTO = { completasDias: 30, borrarDias: 365, mantenerUltimas: 3, avisoGB: 5 };
const PARTES_FIJAS = ['fuente', 'fuente-base', 'cambiados', path.join('codex', 'eventos.jsonl')];

// ── utilidades ─────────────────────────────────────────────────────────────────────────

function legibleBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${u[i]}`;
}

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function esDirReal(p) { const s = lstat(p); return !!s && s.isDirectory() && !s.isSymbolicLink(); }
function listar(p) { try { return fs.readdirSync(p); } catch { return []; } }
function norm(p) { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; }
function dentroDe(base, ruta) {
  const rel = path.relative(path.resolve(base), path.resolve(ruta));
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function retencionEfectiva(extra) {
  let r = {};
  try { r = (configLib.cargarConfig().config.datos || {}).retencion || {}; } catch { /* config ilegible: valores por defecto */ }
  const out = { ...RETENCION_DEFECTO };
  for (const k of Object.keys(RETENCION_DEFECTO)) {
    const v = extra && extra[k] != null ? extra[k] : r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

// ── seguridad de la base ───────────────────────────────────────────────────────────────

// Motivo por el que NO se debe operar sobre esta base, o null si es aceptable.
function basePeligrosa(base) {
  if (!base || typeof base !== 'string') return 'no se indicó una carpeta base';
  const abs = path.resolve(base);
  const candidatos = new Set([norm(abs)]);
  try { candidatos.add(norm(fs.realpathSync.native(abs))); } catch { /* no existe: se juzga la ruta tal cual */ }
  if (path.parse(abs).root === abs || [...candidatos].some((c) => path.parse(c).root === c)) return 'es la raíz de una unidad o del sistema';
  const prohibidas = [[os.homedir(), 'es la carpeta de usuario'], [comun.claudeHome(), 'es la carpeta de configuración de Claude'], [comun.uaehHome(), 'es la carpeta de estado de UAEH']];
  const sistema = ['/etc', '/usr', '/bin', '/sbin', '/var', '/lib', '/opt', '/boot', '/dev', '/proc', '/sys', '/root', '/home', '/Users', '/System', '/Library', '/Applications'];
  if (process.env.SystemRoot) sistema.push(process.env.SystemRoot);
  if (process.env.ProgramFiles) sistema.push(process.env.ProgramFiles);
  if (process.env['ProgramFiles(x86)']) sistema.push(process.env['ProgramFiles(x86)']);
  if (process.platform === 'win32') sistema.push(path.join(path.parse(abs).root, 'Users'));
  for (const [ruta, motivo] of prohibidas) {
    if (!ruta) continue;
    const n = norm(ruta);
    let r = n;
    try { r = norm(fs.realpathSync.native(ruta)); } catch { /* sin realpath */ }
    if (candidatos.has(n) || candidatos.has(r)) return motivo;
  }
  for (const s of sistema) if (candidatos.has(norm(s))) return 'es una carpeta del sistema';
  // Un ancestro de la carpeta de usuario o de la configuración contiene todo lo anterior: tampoco.
  for (const ruta of [os.homedir(), comun.claudeHome(), comun.uaehHome()]) {
    if (!ruta) continue;
    for (const c of candidatos) {
      const rel = path.relative(c, norm(ruta));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return 'contiene la carpeta de usuario o de configuración';
    }
  }
  return null;
}

// ── recorrido sin seguir enlaces ───────────────────────────────────────────────────────

function nuevoPresupuesto(ms) {
  return { fin: Number.isFinite(ms) ? Date.now() + ms : Infinity, cortado: false };
}
function agotado(pres) {
  if (pres.cortado) return true;
  if (Date.now() >= pres.fin) { pres.cortado = true; return true; }
  return false;
}

// Bytes de una ruta: lstat en cada entrada, sin entrar a enlaces ni uniones. `excluir`: rutas (normalizadas) que se saltan.
function medir(ruta, pres, excluir) {
  let total = 0;
  const pila = [ruta];
  while (pila.length) {
    if (agotado(pres)) return total;
    const p = pila.pop();
    if (excluir && excluir.has(norm(p))) continue;
    const s = lstat(p);
    if (!s) continue;
    if (s.isSymbolicLink() || !s.isDirectory()) { total += s.size || 0; continue; }
    for (const n of listar(p)) pila.push(path.join(p, n));
  }
  return total;
}

// Borrado recursivo propio: lstat en cada entrada; un enlace se quita sin entrar. Devuelve { borrados, errores }.
function borrarRecursivo(ruta, errores) {
  const s = lstat(ruta);
  if (!s) return;
  if (s.isSymbolicLink() || !s.isDirectory()) {
    try { fs.unlinkSync(ruta); } catch (e) {
      if (s.isSymbolicLink()) { try { fs.rmdirSync(ruta); return; } catch (e2) { errores.push(`${ruta}: ${e2.message}`); return; } }
      errores.push(`${ruta}: ${e.message}`);
    }
    return;
  }
  for (const n of listar(ruta)) borrarRecursivo(path.join(ruta, n), errores);
  try { fs.rmdirSync(ruta); } catch (e) { errores.push(`${ruta}: ${e.message}`); }
}

// ── inventario ─────────────────────────────────────────────────────────────────────────

function partesPesadas(dirRun) {
  const rels = [...PARTES_FIJAS];
  const agentes = path.join(dirRun, 'agents');
  if (esDirReal(agentes)) for (const a of listar(agentes)) rels.push(path.join('agents', a, 'scratch'));
  return rels.filter((rel) => lstat(path.join(dirRun, rel)));
}

function fechaDeRun(dirRun) {
  const leida = comun.leerJson ? comun.leerJson(path.join(dirRun, 'compactado.json')) : null;
  if (leida && typeof leida.fecha_corrida === 'string' && !Number.isNaN(Date.parse(leida.fecha_corrida))) return new Date(leida.fecha_corrida);
  const tiempos = [];
  const sd = lstat(dirRun);
  if (sd && sd.birthtimeMs > 0) tiempos.push(sd.birthtimeMs);
  for (const f of ['run-metadata.json', 'fuente.json', 'deterministico.json']) {
    const s = lstat(path.join(dirRun, f));
    if (s && s.isFile()) tiempos.push(s.mtimeMs);
  }
  if (tiempos.length) return new Date(Math.min(...tiempos));
  return new Date(sd ? sd.mtimeMs : 0);
}

// Inventario de la base: repos y corridas con fecha, estado y tamaño. Con presupuestoMs agotado devuelve lo medido (cortado:true).
function inventario(base, { presupuestoMs, retencion, ahora } = {}) {
  const pres = nuevoPresupuesto(presupuestoMs == null ? Infinity : presupuestoMs);
  const ret = retencionEfectiva(retencion);
  const inv = { base: path.resolve(base), retencion: ret, repos: [], bytes: 0, cortado: false, superaAviso: false };
  if (!esDirReal(inv.base)) return inv;
  const nombres = listar(inv.base).filter((n) => !n.startsWith('.')).sort();
  for (const nombre of nombres) {
    const dirRepo = path.join(inv.base, nombre);
    if (!esDirReal(dirRepo)) continue;
    const repo = { nombre, ruta: dirRepo, bytes: 0, runs: [] };
    for (const rn of listar(dirRepo).sort()) {
      const m = RE_RUN.exec(rn);
      const dirRun = path.join(dirRepo, rn);
      if (!m || !esDirReal(dirRun)) continue;
      const rels = partesPesadas(dirRun);
      const pesadas = [];
      for (const rel of rels) pesadas.push({ rel, bytes: medir(path.join(dirRun, rel), pres) });
      const excluir = new Set(rels.map((rel) => norm(path.join(dirRun, rel))));
      const resto = medir(dirRun, pres, excluir);
      const bytes = resto + pesadas.reduce((a, p) => a + p.bytes, 0);
      const compactadoJson = !!lstat(path.join(dirRun, 'compactado.json'));
      const fecha = fechaDeRun(dirRun);
      repo.runs.push({
        nombre: rn, numero: Number(m[1]), ruta: dirRun, fechaMs: fecha.getTime(), fecha: comun.isoZona(fecha, comun.zonaHoraria()),
        completa: pesadas.length > 0, compactada: compactadoJson && pesadas.length === 0, pesadas, bytes, accion: 'conservar',
      });
      repo.bytes += bytes;
    }
    inv.repos.push(repo);
    inv.bytes += repo.bytes;
  }
  inv.cortado = pres.cortado;
  inv.superaAviso = inv.bytes > ret.avisoGB * 1024 ** 3;
  planLimpieza(inv, ret, ahora);
  return inv;
}

// ── plan ───────────────────────────────────────────────────────────────────────────────

// Fija run.accion (conservar|compactar|borrar) y devuelve la lista de acciones a ejecutar.
function planLimpieza(inv, retencion, ahora) {
  const ret = retencionEfectiva(retencion || inv.retencion);
  const t = (ahora instanceof Date ? ahora : comun.ahora()).getTime();
  const acciones = [];
  for (const repo of inv.repos) {
    const orden = [...repo.runs].sort((a, b) => (b.fechaMs - a.fechaMs) || (b.numero - a.numero));
    orden.forEach((run, i) => {
      run.accion = 'conservar';
      if (i < ret.mantenerUltimas) return;
      const edad = (t - run.fechaMs) / DIA_MS;
      if (edad >= ret.borrarDias) {
        run.accion = 'borrar';
        acciones.push({ tipo: 'borrar', repo: repo.nombre, run: run.nombre, ruta: run.ruta, base: inv.base, detalle: `borrar ${repo.nombre}/${run.nombre} (libera ${legibleBytes(run.bytes)})`, bytes: run.bytes, fecha: run.fecha, fechaMs: run.fechaMs, partes: [] });
      } else if (edad >= ret.completasDias && run.completa) {
        run.accion = 'compactar';
        const liberados = run.pesadas.reduce((a, p) => a + p.bytes, 0);
        acciones.push({ tipo: 'compactar', repo: repo.nombre, run: run.nombre, ruta: run.ruta, base: inv.base, detalle: `compactar ${repo.nombre}/${run.nombre} (libera ${legibleBytes(liberados)})`, bytes: liberados, fecha: run.fecha, fechaMs: run.fechaMs, partes: run.pesadas.map((p) => p.rel) });
      }
    });
  }
  return acciones;
}

// ── aplicar ────────────────────────────────────────────────────────────────────────────

function aplicarPlan(plan) {
  const resultados = [];
  const errores = [];
  for (const a of plan) {
    const errs = [];
    const dirRun = path.resolve(a.ruta);
    const dirRepo = path.resolve(a.base, a.repo);
    if (!esDirReal(dirRun) || path.resolve(a.base, a.repo, a.run) !== dirRun || !dentroDe(a.base, dirRun) || !dentroDe(dirRepo, dirRun)) {
      errs.push(`${a.repo}/${a.run}: la ruta ya no es una corrida real dentro de la base; no se toca`);
    } else if (a.tipo === 'borrar') {
      borrarRecursivo(dirRun, errs);
    } else if (a.tipo === 'compactar') {
      const borrado = [];
      for (const rel of a.partes) {
        const destino = path.resolve(dirRun, rel);
        if (!dentroDe(dirRun, destino)) { errs.push(`${rel}: fuera de la corrida; no se toca`); continue; }
        const antes = errs.length;
        borrarRecursivo(destino, errs);
        if (errs.length === antes) borrado.push(rel.split(path.sep).join('/'));
      }
      if (borrado.length || !lstat(path.join(dirRun, 'compactado.json'))) {
        try {
          const previo = comun.leerJson(path.join(dirRun, 'compactado.json')) || {};
          const prevBorrado = Array.isArray(previo.borrado) ? previo.borrado : [];
          const fecha = typeof previo.fecha_corrida === 'string' ? previo.fecha_corrida : comun.isoZona(new Date(a.fechaMs), comun.zonaHoraria());
          const liberados = (Number(previo.bytes_liberados) || 0) + (errs.length ? 0 : a.bytes);
          fs.writeFileSync(path.join(dirRun, 'compactado.json'), JSON.stringify({
            fecha_corrida: fecha, compactado: comun.isoZona(comun.ahora(), comun.zonaHoraria()),
            borrado: [...new Set([...prevBorrado, ...borrado])], bytes_liberados: liberados,
          }, null, 2) + '\n', 'utf8');
        } catch (e) { errs.push(`compactado.json: ${e.message}`); }
      }
    }
    for (const e of errs) errores.push(e);
    resultados.push({ tipo: a.tipo, repo: a.repo, run: a.run, ok: errs.length === 0, bytes: a.bytes, errores: errs });
  }
  return { resultados, errores };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────

function leerArgs(argv) {
  const [orden, ...resto] = argv;
  if (!['listar', 'tamano', 'limpiar'].includes(orden)) return { error: orden ? `orden desconocida: ${orden}` : 'falta la orden' };
  const o = { orden, base: null, json: false, aplicar: false };
  for (let i = 0; i < resto.length; i++) {
    const a = resto[i];
    if (a === '--json') o.json = true;
    else if (a === '--aplicar' && orden === 'limpiar') o.aplicar = true;
    else if (a === '--base' && i + 1 < resto.length && !resto[i + 1].startsWith('--')) o.base = resto[++i];
    else return { error: `argumento desconocido o sin valor: ${a}` };
  }
  return o;
}

function main(argv, { out = (t) => process.stdout.write(t + '\n'), err = (t) => process.stderr.write(t + '\n') } = {}) {
  const o = leerArgs(argv);
  if (o.error) { err(o.error); err(USO); return 2; }
  let base;
  try { base = o.base ? path.resolve(o.base) : runsDir({ config: configLib.cargarConfig().config }); } catch (e) { err(`no se pudo determinar la base: ${e.message}`); return 1; }
  const res = { base, retencion: retencionEfectiva(), repos: [], bytes: 0, cortado: false, superaAviso: false, acciones: [], aplicado: false, codigo: 0 };
  const lineas = [];
  const emitir = () => {
    if (o.json) out(JSON.stringify(res, null, 2)); else for (const l of lineas) out(l);
  };

  const motivo = basePeligrosa(base);
  if (motivo) {
    res.codigo = 1; res.error = `base rechazada (${motivo}): ${base}`;
    if (o.json) out(JSON.stringify(res, null, 2)); else err(`ERROR ${res.error}`);
    return 1;
  }
  if (!fs.existsSync(base)) {
    lineas.push(`sin corridas: ${base} no existe`);
    emitir();
    return 0;
  }

  const inv = inventario(base);
  const acciones = planLimpieza(inv, inv.retencion);
  res.retencion = inv.retencion; res.bytes = inv.bytes; res.cortado = inv.cortado; res.superaAviso = inv.superaAviso;
  res.repos = inv.repos.map((r) => ({ nombre: r.nombre, bytes: r.bytes, runs: r.runs.map((x) => ({ nombre: x.nombre, fecha: x.fecha, completa: x.completa, bytes: x.bytes, accion: x.accion })) }));
  res.acciones = acciones.map((a) => ({ tipo: a.tipo, ruta: a.ruta, detalle: a.detalle }));
  const nRuns = inv.repos.reduce((a, r) => a + r.runs.length, 0);

  if (o.orden === 'listar') {
    if (!nRuns) lineas.push('sin corridas');
    for (const r of inv.repos) {
      lineas.push(`${r.nombre}  (${r.runs.length} corrida(s), ${legibleBytes(r.bytes)})`);
      for (const x of [...r.runs].sort((a, b) => (b.fechaMs - a.fechaMs) || (b.numero - a.numero))) {
        const f = comun.legibleZona(new Date(x.fechaMs), comun.zonaHoraria());
        lineas.push(`  ${x.nombre}  ${f}  ${x.completa ? 'completa' : (x.compactada ? 'compactada' : 'sin copias')}  ${legibleBytes(x.bytes)}  -> ${x.accion}`);
      }
    }
  } else if (o.orden === 'tamano') {
    if (!nRuns) lineas.push('sin corridas');
    for (const r of inv.repos) lineas.push(`${r.nombre}: ${legibleBytes(r.bytes)} (${r.runs.length} corrida(s))`);
    lineas.push(`TOTAL: ${legibleBytes(inv.bytes)} en ${inv.repos.length} repo(s)`);
    if (inv.superaAviso) lineas.push(`AVISO: el total pasa de ${inv.retencion.avisoGB} GB; conviene correr «limpiar».`);
  } else {
    let liberado = 0;
    if (!acciones.length) lineas.push('SIN CAMBIOS: no hay nada que compactar ni borrar');
    if (!o.aplicar) {
      for (const a of acciones) { lineas.push(`HARÍA ${a.detalle}`); liberado += a.bytes; }
      if (acciones.length) lineas.push(`En seco: liberaría ${legibleBytes(liberado)}. Con --aplicar se ejecuta.`);
    } else {
      const r = aplicarPlan(acciones);
      res.aplicado = true;
      for (const x of r.resultados) {
        const a = acciones.find((y) => y.repo === x.repo && y.run === x.run);
        if (x.ok) { lineas.push(`HECHO ${a.detalle}`); liberado += x.bytes; } else for (const e of x.errores) lineas.push(`ERROR ${e}`);
      }
      if (r.errores.length) res.codigo = 1;
      if (acciones.length) lineas.push(`Liberado: ${legibleBytes(liberado)}.`);
    }
    lineas.push('NOTA: los volúmenes de Docker de dependencias (docker volume ls --filter label=uaeh=deps) no los toca este script.');
  }
  if (inv.cortado) lineas.push('NOTA: la medición se cortó por tiempo; los tamaños son un mínimo.');
  emitir();
  return res.codigo;
}

module.exports = { inventario, planLimpieza, aplicarPlan, basePeligrosa, legibleBytes, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
