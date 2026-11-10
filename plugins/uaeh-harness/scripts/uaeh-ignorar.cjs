#!/usr/bin/env node
// uaeh-ignorar.cjs — que la evidencia local de las puertas (capturas, reportes, estados de sesión del navegador) nunca
// entre a git por descuido. Es el mismo ritual que repetían la puerta de seguridad, la visual y el preflight.
//
//   node uaeh-ignorar.cjs [--repo <carpeta>] [--local] [--docs-harness] [--aplicar]
//
//   · Por defecto revisa el .gitignore de la raíz del repo; con --local, el archivo privado del clon
//     (.git/info/exclude: no se comparte, útil en repos ajenos o de clientes).
//   · --docs-harness suma docs/harness/ (los documentos del preflight). Se usa con --local en un repo ajeno o de un
//     cliente, para que esos documentos no entren a su repo; en un proyecto propio SÍ van al repo y no se usa.
//   · En seco por defecto: dice qué líneas faltan. Con --aplicar las agrega al final, bajo un comentario, una sola vez
//     (idempotente; respeta el fin de línea del archivo) y después confirma con `git check-ignore` que cada tipo de
//     evidencia queda ignorada.
//
// Códigos: 0 = todo ignorado · 1 = falta algo (en seco: líneas por agregar; con --aplicar: otra regla lo des-ignora)
//          2 = error (no es un repo git, no se pudo leer/escribir) · 64 = uso incorrecto.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const USO = 'uso: uaeh-ignorar.cjs [--repo <carpeta>] [--local] [--docs-harness] [--aplicar]';
const MARCA = '# UAEH: evidencia local de las puertas (uaeh-ignorar)';

// Línea del ignore → una ruta de muestra que esa línea debe ignorar (para `git check-ignore`).
const REGLAS = [
  ['.playwright-cli/', '.playwright-cli/sesion.json'],
  ['.playwright/', '.playwright/cli.config.json'],
  ['playwright-report/', 'playwright-report/index.html'],
  ['test-results/', 'test-results/resultado.json'],
  ['reports/visual-audit/', 'reports/visual-audit/20261103-1200/inicio-360.png'],
  ['reports/uae-security/', 'reports/uae-security/run-1/hallazgos.json'],
  ['**/*storage-state*.json', 'pruebas/visual/storage-state.json'],
  ['**/auth-state*.json', 'e2e/auth-state-admin.json'],
];
const LINEAS = REGLAS.map(([l]) => l);
// Solo con --docs-harness: los documentos del preflight de un repo ajeno se quedan en el clon.
const REGLA_DOCS_HARNESS = ['docs/harness/', 'docs/harness/AUDIT_REPORT.md'];

function reglasDe(o) {
  return o && o.docsHarness ? [...REGLAS, REGLA_DOCS_HARNESS] : REGLAS;
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { codigo: r.status == null ? -1 : r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function leerOpciones(argv) {
  const o = { repo: process.cwd(), local: false, aplicar: false, docsHarness: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') o.local = true;
    else if (a === '--aplicar') o.aplicar = true;
    else if (a === '--docs-harness') o.docsHarness = true;
    else if (a === '--repo' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.repo = argv[++i];
    else return { error: `opción desconocida o sin valor: ${a}` };
  }
  o.repo = path.resolve(o.repo);
  return o;
}

// Archivo de ignores que corresponde: <raíz>/.gitignore o la ruta real de info/exclude de este clon.
function archivoDestino(raiz, local) {
  if (!local) return path.join(raiz, '.gitignore');
  const r = git(raiz, ['rev-parse', '--git-path', 'info/exclude']);
  if (r.codigo !== 0 || !r.stdout) throw new Error(`no se pudo ubicar info/exclude: ${r.stderr}`);
  return path.resolve(raiz, r.stdout);
}

// Líneas que faltan en el texto (comparación exacta tras quitar espacios de los extremos).
function faltantes(texto, lineas = LINEAS) {
  const hay = new Set(String(texto).split(/\r?\n/).map((l) => l.trim()));
  return lineas.filter((l) => !hay.has(l));
}

// Texto con las líneas que faltan agregadas al final bajo MARCA; respeta CRLF si el archivo ya lo usa.
function agregar(texto, lineas) {
  if (!lineas.length) return texto;
  const eol = /\r\n/.test(texto) ? '\r\n' : '\n';
  let t = texto;
  if (t && !t.endsWith('\n')) t += eol;
  if (t && !/(\r?\n){2}$/.test(t)) t += eol;
  const bloque = (t.includes(MARCA) ? [] : [MARCA]).concat(lineas);
  return t + bloque.join(eol) + eol;
}

// Muestras que git todavía NO ignora (con --no-index: cuenta la regla aunque el archivo esté rastreado).
function sinIgnorar(raiz, reglas = REGLAS) {
  const r = spawnSync('git', ['-C', raiz, 'check-ignore', '--no-index', '--stdin', '-z'], {
    input: reglas.map(([, muestra]) => muestra).join('\0') + '\0', encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore falló: ${(r.stderr || '').trim()}`);
  const ignoradas = new Set((r.stdout || '').split('\0').filter(Boolean));
  return reglas.filter(([, muestra]) => !ignoradas.has(muestra)).map(([linea, muestra]) => ({ linea, muestra }));
}

function principal(argv) {
  const o = leerOpciones(argv);
  if (o.error) return { codigo: 64, lineas: [o.error, USO] };
  const raizR = git(o.repo, ['rev-parse', '--show-toplevel']);
  if (raizR.codigo !== 0 || !raizR.stdout) return { codigo: 2, lineas: [`${o.repo} no es un repositorio git: ${raizR.stderr}`] };
  const raiz = path.resolve(raizR.stdout);
  let destino;
  try { destino = archivoDestino(raiz, o.local); } catch (e) { return { codigo: 2, lineas: [e.message] }; }
  let texto = '';
  try { texto = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : ''; } catch (e) { return { codigo: 2, lineas: [`no se pudo leer ${destino}: ${e.message}`] }; }
  const reglas = reglasDe(o);
  const faltan = faltantes(texto, reglas.map(([l]) => l));
  const salida = [`archivo: ${destino}`];

  if (!o.aplicar) {
    if (faltan.length) {
      salida.push(`faltan ${faltan.length} línea(s) (en seco; --aplicar las agrega):`, ...faltan.map((l) => `  + ${l}`));
      return { codigo: 1, lineas: salida };
    }
  } else if (faltan.length) {
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, agregar(texto, faltan), 'utf8');
    } catch (e) { return { codigo: 2, lineas: [`no se pudo escribir ${destino}: ${e.message}`] }; }
    salida.push(`agregadas ${faltan.length} línea(s):`, ...faltan.map((l) => `  + ${l}`));
  } else {
    salida.push('sin cambios: ya estaban todas las líneas');
  }

  let pendientes;
  try { pendientes = sinIgnorar(raiz, reglas); } catch (e) { return { codigo: 2, lineas: [...salida, e.message] }; }
  if (pendientes.length) {
    salida.push('git todavía NO ignora (otra regla lo des-ignora o el archivo de ignores no aplica):', ...pendientes.map((p) => `  - ${p.muestra} (regla ${p.linea})`));
    return { codigo: 1, lineas: salida };
  }
  salida.push(`OK: git ignora los ${reglas.length} tipos de evidencia`);
  return { codigo: 0, lineas: salida };
}

module.exports = { REGLAS, LINEAS, REGLA_DOCS_HARNESS, MARCA, faltantes, agregar, sinIgnorar, principal };

if (require.main === module) {
  const r = principal(process.argv.slice(2));
  const flujo = r.codigo === 0 || r.codigo === 1 ? process.stdout : process.stderr;
  flujo.write(r.lineas.join('\n') + '\n');
  process.exitCode = r.codigo;
}
