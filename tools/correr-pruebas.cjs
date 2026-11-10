#!/usr/bin/env node
// tools/correr-pruebas.cjs — corre todas las pruebas del repo con `node --test` y resume.
//
// Uso: node tools/correr-pruebas.cjs [--filtro <texto>] [--solo kit|harness|tools|integracion] [--lista]
//   · Busca tests/**/*.test.cjs (fuera de los plugins: no inflan la caché de instalación).
//   · tests/integracion/ queda FUERA de la batería normal: necesita la capa 3 instalada (motor de Linux con los
//     escáneres) y se corre aparte con --solo integracion (en CI, el trabajo linux-integracion con UAEH_INTEGRACION=1,
//     donde «sin motor» es fallo). Así la batería normal sigue sin omitidas esperadas: toda omitida es una señal.
//   · Imprime el reporte «spec» tal cual y, al final, una línea propia: «n pasaron, m fallaron,
//     k omitidas (motivos)». Omitida no es pasó: con UAEH_CI=1 un salto inesperado es fallo
//     (lo decide cada prueba vía tests/helpers/entorno.cjs).
//   · Código de salida: el de node --test (1 si algo falló), 2 si no hay pruebas o el uso es incorrecto.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const DIR_PRUEBAS = path.join(RAIZ, 'tests');

function listar(dir, acumulado = []) {
  if (!fs.existsSync(dir)) return acumulado;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listar(p, acumulado);
    else if (/\.test\.cjs$/.test(e.name)) acumulado.push(p);
  }
  return acumulado.sort();
}

function resumirTap(tap) {
  const num = (re) => { const m = re.exec(tap); return m ? Number(m[1]) : 0; };
  const motivos = [];
  for (const m of tap.matchAll(/^\s*ok \d+ - (.*?) # SKIP(?: (.*))?$/gm)) motivos.push(m[2] ? `${m[1]}: ${m[2]}` : m[1]);
  return { pasaron: num(/^# pass (\d+)/m), fallaron: num(/^# fail (\d+)/m), omitidas: num(/^# skipped (\d+)/m), motivos };
}

function main(argv) {
  const o = { filtro: null, solo: null, lista: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filtro') o.filtro = argv[++i];
    else if (a === '--solo') o.solo = argv[++i];
    else if (a === '--lista') o.lista = true;
    else { console.error(`argumento desconocido: ${a}`); return 2; }
  }
  const relPrueba = (f) => path.relative(DIR_PRUEBAS, f).replace(/\\/g, '/');
  let archivos = listar(DIR_PRUEBAS);
  if (o.solo) archivos = archivos.filter((f) => relPrueba(f).startsWith(o.solo + '/'));
  else archivos = archivos.filter((f) => !relPrueba(f).startsWith('integracion/'));
  if (o.filtro) archivos = archivos.filter((f) => f.includes(o.filtro));
  if (o.lista) { for (const f of archivos) console.log(path.relative(RAIZ, f).replace(/\\/g, '/')); return 0; }
  if (!archivos.length) { console.error('correr-pruebas: no hay pruebas que correr.'); return 2; }

  const tapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-tap-')), 'salida.tap');
  const args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapFile}`, ...archivos];
  const inicio = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: RAIZ, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR || '0' } });
  let resumen = { pasaron: 0, fallaron: 0, omitidas: 0, motivos: [] };
  try { resumen = resumirTap(fs.readFileSync(tapFile, 'utf8')); } catch { /* sin TAP: solo el código de salida */ }
  try { fs.rmSync(path.dirname(tapFile), { recursive: true, force: true }); } catch { /* nada */ }

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  const motivos = resumen.motivos.length ? ` (${[...new Set(resumen.motivos)].join('; ')})` : '';
  console.log(`\ncorrer-pruebas: ${archivos.length} archivo(s) · ${resumen.pasaron} pasaron, ${resumen.fallaron} fallaron, ${resumen.omitidas} omitidas${motivos} · ${seg} s`);
  if (resumen.omitidas && process.env.UAEH_CI === '1') console.log('correr-pruebas: hay pruebas omitidas en CI; revisa los motivos (omitida ≠ pasó).');
  return r.status == null ? 1 : r.status;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { listar, resumirTap };
