#!/usr/bin/env node
// Autoprueba de la puerta visual (skill uae-visual): ejercita las plantillas reales contra un sitio malo y uno bueno.
//
// Uso: node probar-visual.cjs [--instalar] [--modulos <carpeta node_modules>] [--sin-lighthouse] [--conservar]
//   --instalar        si faltan, instala las dependencias de pruebas/package.json (pines de wsl/herramientas.json) en
//                     <UAEH_HOME>/cache/visual-fixture con «npm ci --ignore-scripts» y el Chromium de Playwright
//   --modulos <dir>   usa esa carpeta node_modules (ya instalada, mismas versiones) en lugar de la caché; con --instalar
//                     solo se instala el navegador si falta (los módulos de esa carpeta nunca se tocan)
//   --sin-lighthouse  omite el paso de Lighthouse (necesita red la primera vez: npx lo descarga)
//   --conservar       no borra la copia temporal (para mirar la evidencia)
//
// Nunca escribe en la carpeta del plugin: copia el sitio de juguete a una carpeta temporal con su propio repo git.
// Salida: 0 todo OK · 1 algún control falló · 2 uso incorrecto · 3 sin dependencias o sin navegador (no se probó nada:
// UNKNOWN, nunca PASS).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const FIXTURE = __dirname;
const SKILL = path.resolve(__dirname, '..');
const RAIZ_PLUGIN = path.resolve(SKILL, '..', '..');
const PLANTILLAS = path.join(SKILL, 'plantillas');
const CLASIFICADOR = path.join(SKILL, 'scripts', 'clasificar-resultados.cjs');
const comun = require(path.join(RAIZ_PLUGIN, 'scripts', 'lib', 'comun.cjs'));
const { LINEAS: EXCLUSIONES } = require(path.join(RAIZ_PLUGIN, 'scripts', 'uaeh-ignorar.cjs'));
const PINES = JSON.parse(fs.readFileSync(path.join(RAIZ_PLUGIN, 'wsl', 'herramientas.json'), 'utf8')).visual;

const USO = 'uso: node probar-visual.cjs [--instalar] [--modulos <carpeta node_modules>] [--sin-lighthouse] [--conservar]';

function parsearArgumentos(argv) {
  const o = { instalar: false, modulos: null, sinLighthouse: false, conservar: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--instalar') o.instalar = true;
    else if (a === '--sin-lighthouse') o.sinLighthouse = true;
    else if (a === '--conservar') o.conservar = true;
    else if (a === '--modulos' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.modulos = path.resolve(argv[++i]);
    else throw new Error(`argumento desconocido o sin valor: ${a}`);
  }
  return o;
}

// ── Dependencias y navegador ────────────────────────────────────────────────────────────

const cacheDir = () => path.join(comun.uaehHome(), 'cache', 'visual-fixture');
const huellaLock = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURE, 'package-lock.json'))).digest('hex');

function versionInstalada(modulos, paquete) {
  try { return JSON.parse(fs.readFileSync(path.join(modulos, ...paquete.split('/'), 'package.json'), 'utf8')).version; } catch { return null; }
}

// Lo que falta en una carpeta node_modules para esta prueba: [] si está completa y con los pines exactos.
function faltantes(modulos) {
  const salida = [];
  for (const paquete of ['@playwright/test', '@axe-core/playwright']) {
    const v = versionInstalada(modulos, paquete);
    if (v !== PINES[paquete]) salida.push(`${paquete}@${PINES[paquete]} (${v ? 'hay ' + v : 'no instalado'})`);
  }
  return salida;
}

function rutaChromium(modulos) {
  try {
    const ruta = require(path.join(modulos, '@playwright', 'test')).chromium.executablePath();
    return ruta && fs.existsSync(ruta) ? ruta : null;
  } catch { return null; }
}

function instalarCache() {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(FIXTURE, n), path.join(dir, n));
  console.log(`Instalando dependencias en ${dir} (npm ci --ignore-scripts)…`);
  const r = spawnSync('npm ci --ignore-scripts --no-audit --no-fund', { cwd: dir, shell: true, encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) { console.log((r.stdout || '') + (r.stderr || '')); return false; }
  fs.writeFileSync(path.join(dir, 'instalado.json'), JSON.stringify({ lock: huellaLock(), fecha: comun.isoZona(comun.ahora()) }, null, 2) + '\n');
  return true;
}

function instalarChromium(modulos) {
  console.log('Instalando el Chromium de Playwright (npx playwright install chromium)…');
  const r = spawnSync('npx --no-install playwright install chromium', { cwd: path.dirname(modulos), shell: true, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) console.log((r.stdout || '') + (r.stderr || ''));
  return r.status === 0;
}

// Devuelve la carpeta node_modules lista o null (ya explicó qué falta y cómo resolverlo).
function prepararModulos(o) {
  let modulos = o.modulos || path.join(cacheDir(), 'node_modules');
  let falta = faltantes(modulos);
  if (falta.length && !o.modulos && o.instalar) {
    if (!instalarCache()) { console.log('SIN DEPENDENCIAS: npm ci falló (arriba, su salida).'); return null; }
    falta = faltantes(modulos);
  }
  if (falta.length) {
    console.log(`SIN DEPENDENCIAS en ${modulos}: ${falta.join(' · ')}`);
    console.log(o.modulos ? 'Usa una carpeta con esas versiones exactas o corre con --instalar (sin --modulos).' : 'Corre de nuevo con --instalar (descarga unos MB de npm a la caché de UAEH).');
    return null;
  }
  if (!rutaChromium(modulos)) {
    if (o.instalar && instalarChromium(modulos) && rutaChromium(modulos)) return modulos;
    console.log('SIN NAVEGADOR: falta el Chromium de Playwright. Corre de nuevo con --instalar (o «npx playwright install chromium» junto a esa carpeta node_modules).');
    return null;
  }
  return modulos;
}

// ── La prueba ───────────────────────────────────────────────────────────────────────────

let total = 0;
let buenas = 0;
function check(ok, texto) {
  total++;
  if (ok) buenas++;
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${texto}`);
}

const todos = (lista, estado) => lista.length > 0 && lista.every((x) => x.estado === estado);
function listarPng(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
}

function probar(o, modulos, tmp, estado) {
  const resultadoJson = path.join(tmp, 'test-results', 'visual', 'resultado.json');
  const baselines = path.join(tmp, 'tests', 'visual', 'visual.spec.ts-snapshots');
  const sh = (cmd, env) => spawnSync(cmd, { cwd: tmp, shell: true, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 280000 });

  // Corre playwright y devuelve { global, pruebas, p(check, proyecto) }.
  function correr(args, env) {
    fs.rmSync(path.join(tmp, 'test-results'), { recursive: true, force: true });
    sh(`npx --no-install playwright test ${args || ''}`, { UAEH_VISUAL_SERVIDOR: 'node servidor.cjs', ...env });
    const c = spawnSync(process.execPath, [CLASIFICADOR, resultadoJson, '--json'], { encoding: 'utf8' });
    let datos = { global: 'UNKNOWN', pruebas: [] };
    try { datos = JSON.parse(c.stdout); } catch { /* queda UNKNOWN */ }
    return {
      global: datos.global,
      pruebas: datos.pruebas,
      p: (nombre, proyecto) => datos.pruebas.filter((x) => x.check === nombre && (!proyecto || x.proyecto === proyecto)),
    };
  }

  // --- Preparación de la copia temporal (repo git propio; node_modules enlazado, fuera de git) ---
  // Copia propia: la copia recursiva de `fs` falla sin avisar en Windows cuando la ruta lleva caracteres no ASCII.
  const copiar = (origen, destino) => {
    if (/[\\/]node_modules([\\/]|$)/.test(origen)) return;
    if (!fs.statSync(origen).isDirectory()) { fs.copyFileSync(origen, destino); return; }
    fs.mkdirSync(destino, { recursive: true });
    for (const n of fs.readdirSync(origen)) copiar(path.join(origen, n), path.join(destino, n));
  };
  copiar(FIXTURE, tmp);
  fs.copyFileSync(path.join(PLANTILLAS, 'playwright.visual.config.ts'), path.join(tmp, 'playwright.config.ts'));
  fs.mkdirSync(path.join(tmp, 'tests', 'visual'), { recursive: true });
  fs.copyFileSync(path.join(PLANTILLAS, 'visual.spec.ts'), path.join(tmp, 'tests', 'visual', 'visual.spec.ts'));
  fs.writeFileSync(path.join(tmp, '.gitignore'), '# Exclusiones de evidencia de uaeh-ignorar.cjs (la misma lista que usa la puerta)\n' + EXCLUSIONES.join('\n') + '\n');
  const g = (a) => sh(`git -c user.name=uaeh -c user.email=uaeh@local -c commit.gpgsign=false ${a}`);
  g('init -q');
  fs.appendFileSync(path.join(tmp, '.git', 'info', 'exclude'), 'node_modules/\n');
  fs.symlinkSync(modulos, path.join(tmp, 'node_modules'), 'junction');
  estado.enlace = path.join(tmp, 'node_modules');
  g('add -A');
  g('commit -q -m inicial');

  // --- 1. mala sin baselines ---
  let r = correr('', { SITIO: 'sitio-mala', PUERTO: '4181', UAEH_VISUAL_URL: 'http://127.0.0.1:4181' });
  console.log('Paso 1: sitio malo sin baselines');
  const ax = r.p('axe');
  check(ax.length === 2 && ax.every((x) => x.estado === 'FAIL' && /color-contrast/.test(x.mensaje)), '1a axe FAIL con color-contrast');
  check(r.p('desborde', 'movil-360').every((x) => x.estado === 'FAIL') && r.p('desborde', 'movil-360').length === 1, '1b desborde FAIL en movil-360');
  check(r.p('desborde', 'escritorio-1440').every((x) => x.estado === 'PASS'), '1c desborde PASS en escritorio-1440');
  check(r.p('fuente').length === 2 && r.p('fuente').every((x) => x.estado === 'FAIL' && /arial/i.test(x.mensaje)), '1d fuente FAIL (arial)');
  check(todos(r.p('captura'), 'NOT_CHECKED') && r.p('captura').length === 2, '1e captura NOT_CHECKED');
  check(todos(r.p('consola-y-red'), 'PASS') && r.p('consola-y-red').length === 2, '1f consola-y-red PASS');
  check(listarPng(baselines).length === 0, '1g no se creo ninguna baseline sola');

  // --- 2. buena sin baselines ---
  r = correr('', { SITIO: 'sitio-buena', PUERTO: '4182', UAEH_VISUAL_URL: 'http://127.0.0.1:4182' });
  console.log('Paso 2: sitio bueno sin baselines');
  const otros = r.pruebas.filter((x) => x.check !== 'captura');
  check(otros.length === 8 && otros.every((x) => x.estado === 'PASS'), '2a todo PASS salvo captura');
  check(todos(r.p('captura'), 'NOT_CHECKED'), '2b captura NOT_CHECKED');
  check(r.global === 'NOT_CHECKED', '2c global NOT_CHECKED');

  // --- 3. aprobación simulada ---
  correr('--update-snapshots=missing -g captura', { SITIO: 'sitio-buena', PUERTO: '4183', UAEH_VISUAL_URL: 'http://127.0.0.1:4183' });
  const pngs = listarPng(baselines);
  console.log('Paso 3: aprobacion simulada -> ' + pngs.join(', '));
  check(pngs.length === 2 && pngs.some((f) => /movil-360/.test(f)) && pngs.some((f) => /escritorio-1440/.test(f)), '3 existen las 2 baselines (movil-360 y escritorio-1440)');

  // --- 4. buena con baselines ---
  r = correr('', { SITIO: 'sitio-buena', PUERTO: '4184', UAEH_VISUAL_URL: 'http://127.0.0.1:4184' });
  console.log('Paso 4: sitio bueno con baselines');
  check(r.global === 'PASS' && r.pruebas.length === 10, '4 global PASS (10/10 pruebas)');

  // --- 5. regresión inofensiva ---
  const htmlBuena = path.join(tmp, 'sitio-buena', 'index.html');
  const antes = fs.readFileSync(htmlBuena, 'utf8');
  fs.writeFileSync(htmlBuena, antes.replace('h1 { color: #1a1a1a;', 'h1 { color: #c00000;'));
  check(fs.readFileSync(htmlBuena, 'utf8') !== antes, '5a el cambio de color del h1 se aplico');
  r = correr('', { SITIO: 'sitio-buena', PUERTO: '4185', UAEH_VISUAL_URL: 'http://127.0.0.1:4185' });
  console.log('Paso 5: regresion de color en h1');
  check(r.p('captura').length === 2 && r.p('captura').every((x) => x.estado === 'FAIL' && /pixel|differ/i.test(x.mensaje)), '5b captura FAIL por diferencia de pixeles');
  check(r.pruebas.filter((x) => x.check !== 'captura').every((x) => x.estado === 'PASS'), '5c los demas checks siguen PASS');

  // --- 6. servidor apagado ---
  r = correr('', { UAEH_VISUAL_SIN_SERVIDOR: '1', UAEH_VISUAL_URL: 'http://127.0.0.1:4199' });
  console.log('Paso 6: servidor apagado');
  check(r.global === 'BLOCKED', `6 global BLOCKED (obtenido ${r.global})`);

  // --- 7. git limpio de evidencias ---
  const st = g('status --porcelain --ignored=no -uall').stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  console.log('Paso 7: git status:\n  ' + st.join('\n  '));
  const evid = /(^|[\s/])(test-results|playwright-report|reports[\\/]visual-audit|\.playwright-cli)[\\/]/;
  check(!st.some((l) => evid.test(l)), '7a ninguna evidencia aparece en git status');
  const permitido = (l) => /visual\.spec\.ts-snapshots\/[^/]+\.png$/.test(l) || /^M\s+sitio-buena\/index\.html$/.test(l);
  check(st.every(permitido), '7b solo aparecen baselines PNG y el cambio de CSS');

  // --- 8. Lighthouse ---
  if (o.sinLighthouse) {
    console.log('Paso 8: Lighthouse omitido (--sin-lighthouse)');
  } else {
    console.log(`Paso 8: Lighthouse ${PINES.lighthouse}`);
    fs.writeFileSync(htmlBuena, antes);
    fs.mkdirSync(path.join(tmp, 'reports', 'visual-audit'), { recursive: true });
    const lh = path.join(tmp, 'reports', 'visual-audit', 'lh.json');
    estado.servidor = spawn(process.execPath, [path.join(FIXTURE, 'servidor.cjs')], { cwd: FIXTURE, env: { ...process.env, SITIO: path.join(tmp, 'sitio-buena'), PUERTO: '4190' }, stdio: 'ignore' });
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
    const chrome = rutaChromium(modulos);
    const l = sh(`npx --yes lighthouse@${PINES.lighthouse} http://127.0.0.1:4190/ --output=json --output-path="${lh}" --only-categories=performance,accessibility --chrome-flags="--headless=new" --quiet`, chrome ? { CHROME_PATH: chrome } : {});
    let j = null;
    try { j = JSON.parse(fs.readFileSync(lh, 'utf8')); } catch { /* sin json */ }
    if (!j) console.log((l.stdout || '') + (l.stderr || ''));
    check(!!j, '8a el JSON de Lighthouse existe');
    check(!!j && typeof j.categories.performance.score === 'number', '8b categories.performance.score es numero');
    check(!!j && j.audits['cumulative-layout-shift'] && typeof j.audits['cumulative-layout-shift'].numericValue === 'number', '8c existe audits.cumulative-layout-shift.numericValue');
  }

  // --- 9. el lector de DESIGN.md (comillas, comentarios, claves ajenas) ---
  console.log('Paso 9: lector de DESIGN.md');
  fs.writeFileSync(htmlBuena, antes);
  const dis = path.join(tmp, 'DESIGN.md');
  fs.writeFileSync(dis, fs.readFileSync(dis, 'utf8').replace("fuente_texto: 'Georgia'", 'fuente_texto: "Verdana"'));
  r = correr('-g fuente', { SITIO: 'sitio-buena', PUERTO: '4186', UAEH_VISUAL_URL: 'http://127.0.0.1:4186' });
  check(r.p('fuente').length === 2 && r.p('fuente').every((x) => x.estado === 'FAIL' && /fuente_texto/.test(x.mensaje) && /verdana/i.test(x.mensaje)), '9a fuente_texto "Verdana" (comillas dobles) se lee y se compara');
  fs.writeFileSync(dis, fs.readFileSync(dis, 'utf8').replace('fuente_texto: "Verdana"', "fuente_texto: 'Georgia'"));
  r = correr('-g fuente', { SITIO: 'sitio-buena', PUERTO: '4187', UAEH_VISUAL_URL: 'http://127.0.0.1:4187' });
  check(r.p('fuente').length === 2 && todos(r.p('fuente'), 'PASS'), '9b con comillas simples, comentarios y claves ajenas, fuente PASS');
}

function main(argv) {
  let o;
  try { o = parsearArgumentos(argv); } catch (e) { console.error(`probar-visual: ${e.message}\n${USO}`); return 2; }
  const modulos = prepararModulos(o);
  if (!modulos) return 3;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-visual-'));
  const estado = { enlace: null, servidor: null };
  try {
    probar(o, modulos, tmp, estado);
  } catch (e) {
    check(false, 'excepcion en la autoprueba: ' + (e && e.stack || e));
  } finally {
    if (estado.servidor) { try { estado.servidor.kill(); } catch { /* ya muerto */ } }
    if (!o.conservar) {
      // Primero se suelta el enlace para no tocar el node_modules real.
      if (estado.enlace) { try { fs.unlinkSync(estado.enlace); } catch { try { fs.rmdirSync(estado.enlace); } catch { /* sin enlace */ } } }
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log('Aviso: no se pudo borrar ' + tmp + ' (' + e.code + ')'); }
    } else {
      console.log('Carpeta conservada: ' + tmp);
    }
  }
  console.log(`${buenas}/${total}`);
  return buenas === total && total > 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parsearArgumentos, faltantes, PINES };
