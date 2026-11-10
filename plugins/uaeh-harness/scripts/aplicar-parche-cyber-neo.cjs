#!/usr/bin/env node
// aplicar-parche-cyber-neo.cjs — el parche que impide que cyber-neo imprima el secreto que encontró.
//
// cyber-neo (MIT, copia parcial en vendor/cyber-neo/) guarda en `evidence` la línea donde halló un secreto, CON el
// secreto; esa salida llega a la transcripción del agente y al reporte. El parche (vendor/cyber-neo/PATCHES/0001-…)
// lo cambia por ***REDACTED*** antes de recortar la línea. La copia del plugin ya viene parchada: la puerta de seguridad
// la comprueba antes de usarla, y este script sirve además para parchar una instalación propia de cyber-neo.
//
//   node aplicar-parche-cyber-neo.cjs --verificar [--destino <carpeta>] [--json]
//        sin --destino: la copia del plugin, archivo por archivo contra UPSTREAM.json (cualquier cambio = DESCONOCIDO),
//                       y el bloque del parche 0001 presente (la copia lleva además el 0002, solo de este repositorio)
//        con --destino: solo el archivo que toca el parche, contra las variantes conocidas
//   node aplicar-parche-cyber-neo.cjs --aplicar  --destino <carpeta> [--json]   deja <archivo>.orig; idempotente
//   node aplicar-parche-cyber-neo.cjs --revertir --destino <carpeta> [--json]   idempotente
//
// <carpeta> = la de la skill cyber-neo (la que contiene scripts/scan_secrets.py).
// Un archivo se reconoce SOLO por su huella (sha256 del contenido con fines de línea LF): una versión que no está en
// la lista de variantes de UPSTREAM.json es DESCONOCIDO y no se toca (falla cerrado). Se respeta el fin de línea del
// archivo (LF o CRLF).
// Códigos: 0 = PARCHEADO (o, con --revertir, SIN_PARCHE al terminar) · 3 = SIN_PARCHE (solo --verificar)
//          4 = DESCONOCIDO (no se tocó nada) · 2 = uso incorrecto o archivo ausente.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR_VENDOR = path.resolve(__dirname, '..', 'vendor', 'cyber-neo');
const USO = 'uso: aplicar-parche-cyber-neo.cjs --verificar [--destino <carpeta>] | --aplicar --destino <carpeta> | --revertir --destino <carpeta>  [--json]';

class UsoIncorrecto extends Error {}

// sha256 del texto con fines de línea LF (la misma huella en Windows con autocrlf y en Linux).
function huella(texto) {
  return crypto.createHash('sha256').update(String(texto).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function leerUpstream(dirVendor = DIR_VENDOR) {
  const ruta = path.join(dirVendor, 'UPSTREAM.json');
  let datos;
  try { datos = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { throw new UsoIncorrecto(`no se pudo leer ${ruta} (${e.code || e.message})`); }
  if (!datos || !Array.isArray(datos.parches) || !datos.parches.length || !datos.archivos) throw new UsoIncorrecto(`${ruta}: sin «parches» o «archivos»`);
  return datos;
}

// Texto de un parche unificado de UN archivo → { objetivo, hunks:[{ antes, despues }] } (antes/despues: texto LF).
// Lo que precede a la primera línea «--- » es la explicación del parche y se ignora.
function parsearParche(texto) {
  const lineas = String(texto).replace(/\r\n/g, '\n').split('\n');
  let i = lineas.findIndex((l) => l.startsWith('--- '));
  if (i < 0 || !lineas[i + 1] || !lineas[i + 1].startsWith('+++ ')) throw new Error('parche sin cabecera «--- / +++»');
  const objetivo = lineas[i + 1].slice(4).trim().replace(/^b\//, '');
  if (!objetivo || objetivo.split('/').includes('..') || path.isAbsolute(objetivo)) throw new Error(`parche con objetivo inseguro: ${objetivo}`);
  const hunks = [];
  for (i += 2; i < lineas.length; i++) {
    const l = lineas[i];
    if (l.startsWith('--- ')) throw new Error('el parche toca más de un archivo (no soportado)');
    if (!l.startsWith('@@ ')) { if (l === '' && i === lineas.length - 1) break; throw new Error(`línea fuera de un bloque: ${l.slice(0, 40)}`); }
    const antes = [];
    const despues = [];
    for (i++; i < lineas.length && !lineas[i].startsWith('@@ ') && !lineas[i].startsWith('--- '); i++) {
      const c = lineas[i];
      if (c === '' && i === lineas.length - 1) break; // salto final del archivo
      const tipo = c === '' ? ' ' : c[0];
      const resto = c.slice(1);
      if (tipo === ' ') { antes.push(resto); despues.push(resto); } else if (tipo === '-') antes.push(resto);
      else if (tipo === '+') despues.push(resto);
      else if (tipo !== '\\') throw new Error(`línea de bloque inválida: ${c.slice(0, 40)}`);
    }
    i--;
    if (!antes.length) throw new Error('bloque sin ancla');
    hunks.push({ antes: antes.join('\n'), despues: despues.join('\n') });
  }
  if (!hunks.length) throw new Error('parche sin bloques');
  return { objetivo, hunks };
}

function ocurrencias(texto, ancla) {
  let n = 0;
  for (let p = texto.indexOf(ancla); p >= 0; p = texto.indexOf(ancla, p + 1)) n++;
  return n;
}

// Aplica (o revierte) los bloques por ancla exacta: cada ancla debe aparecer UNA vez. Texto LF → texto LF.
function transformar(textoLf, hunks, revertir = false) {
  let t = textoLf;
  for (const h of hunks) {
    const [de, a] = revertir ? [h.despues, h.antes] : [h.antes, h.despues];
    const n = ocurrencias(t, de);
    if (n !== 1) throw new Error(`el ancla aparece ${n} vez/veces (se esperaba 1)`);
    t = t.replace(de, () => a);
  }
  return t;
}

// El parche 0 de UPSTREAM.json con su texto parseado y su lista de variantes.
function cargarParche(upstream, dirVendor = DIR_VENDOR) {
  const p = upstream.parches[0];
  const rutaParche = path.join(dirVendor, ...String(p.archivo).split('/'));
  const parseado = parsearParche(fs.readFileSync(rutaParche, 'utf8'));
  if (parseado.objetivo !== p.aplica_a) throw new UsoIncorrecto(`UPSTREAM.json dice que el parche aplica a ${p.aplica_a}, pero el parche toca ${parseado.objetivo}`);
  const variantes = (p.variantes || []).filter((v) => /^[0-9a-f]{64}$/.test(v.sha256_original) && /^[0-9a-f]{64}$/.test(v.sha256_parcheado));
  if (!variantes.length) throw new UsoIncorrecto('UPSTREAM.json sin variantes válidas del parche');
  return { ...parseado, variantes, archivo: p.archivo };
}

// Estado de un texto frente a las variantes: { estado: PARCHEADO|SIN_PARCHE|DESCONOCIDO, variante }.
function clasificar(texto, variantes) {
  const h = huella(texto);
  for (const v of variantes) {
    if (h === v.sha256_parcheado) return { estado: 'PARCHEADO', variante: v, huella: h };
    if (h === v.sha256_original) return { estado: 'SIN_PARCHE', variante: v, huella: h };
  }
  return { estado: 'DESCONOCIDO', variante: null, huella: h };
}

function nombreVariante(v) {
  return v && Array.isArray(v.commits) && v.commits.length ? String(v.commits[v.commits.length - 1]).slice(0, 7) : '?';
}

// Un antivirus puede tener bloqueado un instante un archivo recién escrito (EBUSY/EPERM/EACCES en Windows): se
// reintenta unas veces antes de darlo por ilegible. ENOENT no se reintenta.
function leerConReintento(ruta, intentos = 6) {
  for (let i = 1; ; i++) {
    try { return fs.readFileSync(ruta, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT' || i >= intentos || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
    }
  }
}

// Copia del plugin, archivo por archivo, contra UPSTREAM.json. → { estado, detalle, alterados:[] }
// `archivos`: solo esas rutas (la pasada determinista exige íntegros los scripts que ejecuta; las referencias las leen
// los agentes). Sin `archivos`: todos los declarados.
function verificarVendor(dirVendor = DIR_VENDOR, { archivos } = {}) {
  let upstream;
  let parche;
  try { upstream = leerUpstream(dirVendor); parche = cargarParche(upstream, dirVendor); } catch (e) {
    return { estado: 'DESCONOCIDO', detalle: e.message, alterados: [] };
  }
  const alterados = [];
  const revisar = archivos ? [...new Set([...archivos, parche.objetivo])] : Object.keys(upstream.archivos);
  for (const rel of revisar) {
    const info = upstream.archivos[rel];
    if (!info) { alterados.push(`${rel} (no declarado en UPSTREAM.json)`); continue; }
    let texto;
    try { texto = leerConReintento(path.join(dirVendor, ...rel.split('/'))); } catch (e) {
      alterados.push(`${rel} (${e.code === 'ENOENT' ? 'falta' : `ilegible: ${e.code || e.message}`})`);
      continue;
    }
    if (huella(texto) !== info.sha256) alterados.push(rel);
  }
  if (alterados.length) return { estado: 'DESCONOCIDO', detalle: `copia de cyber-neo alterada: ${alterados.join(', ')}`, alterados };
  // La copia del plugin puede llevar además parches propios del repositorio (PATCHES/0002…, sin cambio de
  // comportamiento y que no tocan el bloque del 0001): su integridad ya la dieron las huellas declaradas, y el 0001 se
  // comprueba por su bloque, que debe estar UNA vez, y el bloque viejo ninguna.
  const texto = leerConReintento(path.join(dirVendor, ...parche.objetivo.split('/'))).replace(/\r\n/g, '\n');
  const aplicado = parche.hunks.every((h) => ocurrencias(texto, h.despues) === 1 && ocurrencias(texto, h.antes) === (h.despues.includes(h.antes) ? 1 : 0));
  const sinAplicar = parche.hunks.every((h) => ocurrencias(texto, h.antes) === 1 && ocurrencias(texto, h.despues) === 0);
  const estado = aplicado ? 'PARCHEADO' : sinAplicar ? 'SIN_PARCHE' : 'DESCONOCIDO';
  const commit = String(upstream.commit || '').slice(0, 7) || '?';
  return { estado, detalle: `${parche.objetivo} (${upstream.nombre || 'cyber-neo'} ${commit}; ${revisar.length} archivos íntegros)`, alterados };
}

// Escribe sin dejar un archivo a medias: temporal en la misma carpeta + rename.
function escribirAtomico(ruta, texto) {
  const tmp = `${ruta}.uaeh-${process.pid}.tmp`;
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, ruta);
}

// Opera sobre una instalación del usuario. modo: 'verificar' | 'aplicar' | 'revertir'. → { estado, detalle, cambio }
function operarDestino(destino, modo, dirVendor = DIR_VENDOR) {
  const parche = cargarParche(leerUpstream(dirVendor), dirVendor);
  const ruta = path.join(path.resolve(destino), ...parche.objetivo.split('/'));
  let crudo;
  try { crudo = fs.readFileSync(ruta, 'utf8'); } catch { throw new UsoIncorrecto(`no existe ${ruta} (¿--destino es la carpeta de la skill cyber-neo?)`); }
  const crlf = /\r\n/.test(crudo);
  const lf = crudo.replace(/\r\n/g, '\n');
  const c = clasificar(lf, parche.variantes);
  const base = { ruta, variante: nombreVariante(c.variante), cambio: false };
  if (c.estado === 'DESCONOCIDO' || modo === 'verificar') return { ...base, estado: c.estado, detalle: c.estado === 'DESCONOCIDO' ? 'versión no reconocida: no se toca' : '' };
  const quiere = modo === 'aplicar' ? 'PARCHEADO' : 'SIN_PARCHE';
  if (c.estado === quiere) return { ...base, estado: quiere, detalle: 'ya estaba así' };
  let nuevo;
  try { nuevo = transformar(lf, parche.hunks, modo === 'revertir'); } catch (e) { return { ...base, estado: 'DESCONOCIDO', detalle: e.message }; }
  const esperada = modo === 'aplicar' ? c.variante.sha256_parcheado : c.variante.sha256_original;
  if (huella(nuevo) !== esperada) return { ...base, estado: 'DESCONOCIDO', detalle: 'el resultado no coincide con la huella esperada: no se escribió nada' };
  const salida = crlf ? nuevo.replace(/\n/g, '\r\n') : nuevo;
  const orig = `${ruta}.orig`;
  if (modo === 'aplicar' && !fs.existsSync(orig)) fs.writeFileSync(orig, crudo);
  escribirAtomico(ruta, salida);
  if (modo === 'revertir') {
    try { if (fs.readFileSync(orig, 'utf8') === salida) fs.unlinkSync(orig); } catch { /* sin respaldo previo */ }
  }
  return { ...base, estado: quiere, detalle: modo === 'aplicar' ? `parchado (respaldo: ${path.basename(orig)})` : 'revertido', cambio: true };
}

function parsearArgs(argv) {
  const o = { modo: null, destino: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verificar' || a === '--aplicar' || a === '--revertir') {
      if (o.modo) throw new UsoIncorrecto(USO);
      o.modo = a.slice(2);
    } else if (a === '--destino') {
      if (o.destino != null || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new UsoIncorrecto(USO);
      o.destino = argv[++i];
    } else if (a === '--json') o.json = true;
    else throw new UsoIncorrecto(USO);
  }
  if (!o.modo) throw new UsoIncorrecto(USO);
  if (o.modo !== 'verificar' && !o.destino) throw new UsoIncorrecto(`--${o.modo} exige --destino (la copia del plugin no se modifica)\n${USO}`);
  return o;
}

const CODIGO = { PARCHEADO: 0, SIN_PARCHE: 3, DESCONOCIDO: 4 };

function principal(argv) {
  let o;
  try { o = parsearArgs(argv); } catch (e) { return { codigo: 2, error: e.message }; }
  let r;
  try {
    r = o.destino ? operarDestino(o.destino, o.modo) : { ...verificarVendor(), ruta: DIR_VENDOR };
  } catch (e) {
    if (e instanceof UsoIncorrecto) return { codigo: 2, error: e.message };
    throw e;
  }
  let codigo = CODIGO[r.estado];
  if (o.modo === 'revertir' && r.estado === 'SIN_PARCHE') codigo = 0;
  const texto = o.json ? JSON.stringify(r) : `${r.estado} ${r.ruta}${r.detalle ? ` — ${r.detalle}` : ''}`;
  return { codigo, salida: texto };
}

module.exports = { DIR_VENDOR, huella, parsearParche, transformar, clasificar, leerUpstream, cargarParche, verificarVendor, operarDestino, principal };

if (require.main === module) {
  const r = principal(process.argv.slice(2));
  if (r.salida) process.stdout.write(r.salida + '\n');
  if (r.error) process.stderr.write(r.error + '\n');
  process.exitCode = r.codigo;
}
