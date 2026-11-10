#!/usr/bin/env node
// tests/diferencial.opcional.cjs — comparación MANUAL entre dos versiones del candado de solo lectura. No es una prueba
// (no termina en .test.cjs): el CI no la corre, porque necesita una versión anterior que solo existe en la máquina de quien
// importó el candado.
//
// Qué hace: carga revisar() del hook del plugin (plugins/uaeh-harness/hooks/solo-lectura.js) y la de una versión anterior del
// mismo candado, y compara su decisión (niega o permite y, si ambas niegan, el motivo) sobre el mismo corpus:
//   · la tabla de tests/harness/solo-lectura.test.cjs (se lee de ese archivo: una sola fuente de verdad);
//   · las variantes generadas de esa misma prueba (miles de combinaciones de comillas, prefijos e intérpretes);
//   · unos pocos casos extra para las diferencias de diseño conocidas.
// Sirve para demostrar, después de importar o tocar el candado, que no se perdió ninguna negativa. Las diferencias de diseño
// conocidas se clasifican y se cuentan; cualquier otra es «inesperada» y hace salir con código 1.
//
// La versión anterior es <claudeHome>/hooks/solo-lectura.js (la carpeta de configuración de Claude Code, vía
// lib/comun.cjs) o la ruta de UAEH_SOLO_LECTURA_ORIGEN. Ese candado fijaba la distro de WSL («Ubuntu», o la que diga
// UAEH_SOLO_LECTURA_ORIGEN_DISTRO) y un único usuario: la tabla usa la distro de fábrica del plugin y el script traduce el
// nombre al llamar al origen.
// Sin esa versión imprime «sin origen: nada que comparar» y sale con código 0. Solo lee: no escribe nada ni toca la
// configuración del usuario (el hook del plugin se carga con un UAEH_HOME temporal y vacío).
//
// Uso: node tests/diferencial.opcional.cjs [--todas]     (--todas lista todas las diferencias, no solo las 30 primeras)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const RAIZ = path.resolve(__dirname, '..');
const RAIZ_PLUGIN = path.join(RAIZ, 'plugins', 'uaeh-harness');
const HOOK = path.join(RAIZ_PLUGIN, 'hooks', 'solo-lectura.js');
const PRUEBA = path.join(RAIZ, 'tests', 'harness', 'solo-lectura.test.cjs');
const comun = require(path.join(RAIZ_PLUGIN, 'scripts', 'lib', 'comun.cjs'));

const DISTRO_PLUGIN = 'Ubuntu-24.04';
const DISTRO_ORIGEN = (process.env.UAEH_SOLO_LECTURA_ORIGEN_DISTRO || 'Ubuntu').trim();

// Casos extra: una muestra de cada diferencia de diseño (usuario de WSL cualquiera, caja de arena llamada directo en Linux).
const EXTRAS = [
  `wsl -d ${DISTRO_PLUGIN} -u dev -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente a1 -- true`,
  `wsl -d ${DISTRO_PLUGIN} -u dev -e bash /opt/uaeh/pruebas/probar-sandbox.sh`,
  `wsl -d ${DISTRO_PLUGIN} -u root -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente a1 -- true`,
  '/opt/uaeh/bin/uaeh-sandbox ejecutar --run r --agente a -- ls',
  '/opt/uaeh/bin/uaeh-sandbox ejecutar --run r --agente a -- ls | cat',
  '/opt/uaeh/bin/uaeh-sandbox preparar-deps --run r',
];

function rutaOrigen() {
  const v = process.env.UAEH_SOLO_LECTURA_ORIGEN;
  return v && v.trim() ? path.resolve(v.trim()) : path.join(comun.claudeHome(), 'hooks', 'solo-lectura.js');
}

// Carga revisar() de un archivo del candado SIN ejecutarlo: sin stdin ni salida real (la entrada vacía hace que el arranque
// no niegue nada) y, si es un hook en forma de módulo, con require.main distinto de module para que no arranque.
function cargarRevisarDe(ruta) {
  const src = fs.readFileSync(ruta, 'utf8').replace(/^#!.*\n/, '');
  const modulo = { exports: {} };
  const proceso = { stdout: { write() {} }, stderr: { write() {} }, exit() {}, env: process.env, argv: process.argv, platform: process.platform };
  const falso = (m) => (m === 'fs'
    ? { ...fs, readFileSync: (f, ...r) => (f === 0 ? '{"tool_input":{"command":""}}' : fs.readFileSync(f, ...r)), writeSync() {} }
    : require(m));
  falso.main = {};
  const cuerpo = `${src}\n;return typeof revisar === 'function' ? revisar : module.exports.revisar;`;
  return new Function('require', 'process', 'module', '__dirname', '__filename', cuerpo)(falso, proceso, modulo, path.dirname(ruta), ruta);
}

// Tabla y variantes generadas, tal como las define tests/harness/solo-lectura.test.cjs.
function leerCorpus() {
  const texto = fs.readFileSync(PRUEBA, 'utf8');
  const mt = /\nconst BLOQUES = (\{[\s\S]*?\n\});/.exec(texto);
  if (!mt) throw new Error(`no encuentro «const BLOQUES = { … };» en ${path.relative(RAIZ, PRUEBA)}`);
  const mg = /\nfunction generarVariantes\(\) \{[\s\S]*?\n\}\n/.exec(texto);
  if (!mg) throw new Error(`no encuentro generarVariantes() en ${path.relative(RAIZ, PRUEBA)}`);
  const tabla = Object.values(vm.runInNewContext(`(${mt[1]})`)).flat();
  const { generadas, verdad } = vm.runInNewContext(`${mg[0]}\ngenerarVariantes;`)();
  return { tabla, generadas, verdad };
}

// El plugin dice «Ubuntu-24.04»; el origen, la distro que tuviera fija.
const paraOrigen = (cmd) => cmd.split(`-d ${DISTRO_PLUGIN}`).join(`-d ${DISTRO_ORIGEN}`);

// Las pistas de WSL cambiaron a propósito (ya no nombran programas de una máquina): no cuentan como motivo distinto.
function sinPista(motivo) {
  return motivo == null ? motivo : String(motivo).replace(/ \(en WSL solo se permite:[\s\S]*$/, '').replace(/ \(la caja de arena se llama así:[\s\S]*$/, '');
}

// Diferencias de DISEÑO conocidas: devuelven el nombre de la clase, o null si la diferencia no está prevista.
function claseEsperada(cmd, plugin, origen) {
  if (/^\s*\/opt\/uaeh\/bin\/uaeh-sandbox(?=\s|$)/.test(cmd)) return 'caja de arena llamada directo en Linux (regla nueva)';
  const usuarioLibre = /\bwsl(?:\.exe)?\s+-d\s+\S+\s+-u\s+(?!root\s)[a-z_][a-z0-9_-]{0,31}\s+(?:-e|--exec)\s/.test(cmd);
  if (usuarioLibre && !plugin && origen) return 'usuario de WSL cualquiera salvo root (antes uno fijo)';
  return null;
}

function main(argv) {
  const todas = argv.includes('--todas');
  const origen = rutaOrigen();
  if (!fs.existsSync(origen)) {
    console.log('sin origen: nada que comparar');
    console.log(`(se buscó ${origen}; otra ruta con UAEH_SOLO_LECTURA_ORIGEN)`);
    return 0;
  }

  // El hook del plugin se carga con una casa vacía: no lee la configuración real y fija las reglas de WSL con la distro de fábrica.
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-diferencial-'));
  process.env.UAEH_HOME = casa;
  delete process.env.UAEH_WSL_DISTRO;
  try {
    const nuevo = require(HOOK).revisar;
    const viejo = cargarRevisarDe(origen);
    const { tabla, generadas } = leerCorpus();
    const corpus = [...new Set([...tabla.map((f) => f[1]), ...generadas, ...EXTRAS])];

    let iguales = 0;
    let permiten = 0;
    let niegan = 0;
    const esperadas = new Map();
    const inesperadas = [];
    const motivosDistintos = [];
    for (const cmd of corpus) {
      const a = nuevo(cmd);
      const b = viejo(paraOrigen(cmd));
      if (!!a === !!b) {
        iguales++;
        if (a) { niegan++; if (sinPista(a) !== sinPista(b)) motivosDistintos.push({ cmd, a, b }); } else permiten++;
        continue;
      }
      const clase = claseEsperada(cmd, a, b);
      if (clase) esperadas.set(clase, (esperadas.get(clase) || 0) + 1);
      else inesperadas.push({ cmd, plugin: a ? 'NIEGA' : 'permite', origen: b ? 'NIEGA' : 'permite' });
    }
    const tablaDesfasada = tabla.filter(([esperado, cmd]) => !!nuevo(cmd) !== (esperado === 'D'));

    const limite = todas ? Infinity : 30;
    console.log('solo-lectura · diferencial entre el hook del plugin y una versión anterior');
    console.log(`  plugin : ${path.relative(RAIZ, HOOK).replace(/\\/g, '/')}`);
    console.log(`  origen : ${origen}  (distro fija del origen: ${DISTRO_ORIGEN})`);
    console.log(`  corpus : ${corpus.length} comandos distintos (tabla ${tabla.length}, variantes generadas ${generadas.length}, extras ${EXTRAS.length})`);
    console.log(`  coinciden: ${iguales}  (permiten ${permiten}, niegan ${niegan})`);
    const totalEsperadas = [...esperadas.values()].reduce((s, n) => s + n, 0);
    console.log(`  diferencias esperadas (cambios de diseño): ${totalEsperadas}`);
    for (const [clase, n] of esperadas) console.log(`     - ${clase}: ${n}`);
    console.log(`  diferencias inesperadas: ${inesperadas.length}`);
    for (const d of inesperadas.slice(0, limite)) console.log(`     [plugin ${d.plugin}, origen ${d.origen}] ${JSON.stringify(d.cmd)}`);
    console.log(`  motivos distintos cuando ambos niegan (sin contar las pistas de WSL): ${motivosDistintos.length}`);
    for (const d of motivosDistintos.slice(0, limite)) console.log(`     ${JSON.stringify(d.cmd)}\n       plugin: ${sinPista(d.a)}\n       origen: ${sinPista(d.b)}`);
    console.log(`  la tabla de la prueba coincide con el plugin: ${tabla.length - tablaDesfasada.length} de ${tabla.length}`);
    for (const [esperado, cmd] of tablaDesfasada.slice(0, limite)) console.log(`     la tabla espera ${esperado === 'D' ? 'NEGAR' : 'PERMITIR'}: ${JSON.stringify(cmd)}`);
    const sinNovedad = inesperadas.length === 0 && motivosDistintos.length === 0 && tablaDesfasada.length === 0;
    console.log(sinNovedad ? 'RESULTADO: sin diferencias inesperadas' : 'RESULTADO: hay diferencias inesperadas (revisar arriba)');
    return sinNovedad ? 0 : 1;
  } finally {
    try { fs.rmSync(casa, { recursive: true, force: true }); } catch { /* en Windows puede quedar un instante bloqueado */ }
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
