// Pruebas de uaeh-registro.cjs y uaeh-resumen.cjs sobre una casa temporal (nunca el registro real).
// Correr: node --test tests/harness/uaeh-registro.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../helpers/entorno.cjs');

const REGISTRO = path.join(H.RAIZ_HARNESS, 'scripts', 'uaeh-registro.cjs');
const RESUMEN = path.join(H.RAIZ_HARNESS, 'scripts', 'uaeh-resumen.cjs');
const BASE = ['--proyecto', 'demo', '--ruta', 'build', '--riesgo', 'alto', '--ciclos', '1', '--estado', 'PASS_TECHNICAL'];

// Una casa temporal por prueba (UAEH_HOME, HOME y la hora fija vienen de entornoTemporal()). `extra` pisa variables del entorno;
// un valor `undefined` la quita.
function casa(t, extra = {}) {
  const e = H.entornoTemporal('uaeh-registro-');
  t.after(() => e.limpiar());
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete e.env[k]; else e.env[k] = v; }
  return e;
}
const correr = (script, args, e, extra) => H.correr(script, args, { env: extra ? { ...e.env, ...extra } : e.env });
const archivo = (e) => path.join(e.uaehHome, 'registro.jsonl');
const filas = (e) => fs.readFileSync(archivo(e), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sinEscribir = (e) => !fs.existsSync(archivo(e));

test('guarda --minutos como entero', (t) => {
  const e = casa(t);
  const r = correr(REGISTRO, [...BASE, '--minutos', '27'], e);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(filas(e)[0].minutos, 27);
});

test('sin --minutos la fila no trae el campo (compatible con las filas viejas)', (t) => {
  const e = casa(t);
  assert.equal(correr(REGISTRO, BASE, e).status, 0);
  assert.equal('minutos' in filas(e)[0], false);
});

test('rechaza --minutos que no es entero y no escribe nada', (t) => {
  const e = casa(t);
  for (const malo of ['-3', '2.5', 'abc', '99999']) {
    const r = correr(REGISTRO, [...BASE, '--minutos', malo], e);
    assert.notEqual(r.status, 0, `debió rechazar ${malo}`);
    assert.match(r.stderr, /--minutos/);
  }
  assert.ok(sinEscribir(e), 'los inválidos no escribieron nada');
});

test('acepta riesgo en inglés (low, medium, high, critical) y lo guarda en español', (t) => {
  const e = casa(t);
  for (const r of ['low', 'medium', 'high', 'critical', 'crítico']) {
    const args = BASE.slice();
    args[args.indexOf('alto')] = r;
    assert.equal(correr(REGISTRO, args, e).status, 0, `riesgo ${r}`);
  }
  assert.deepEqual(filas(e).map((f) => f.riesgo), ['bajo', 'medio', 'alto', 'critico', 'critico']);
});

test('la fila lleva todos los campos del contrato y la ruta del archivo sale por stdout', (t) => {
  const e = casa(t);
  const r = correr(REGISTRO, [...BASE, '--minutos', '5', '--tarea', 'arreglar el login', '--visual', 'product-ui', '--escalamiento', 'a opus'], e);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), archivo(e), 'imprime la ruta de <UAEH_HOME>/registro.jsonl');
  const f = filas(e)[0];
  assert.deepEqual(Object.keys(f), ['fecha', 'proyecto', 'ruta', 'riesgo', 'ciclos', 'escalamiento', 'estado', 'visual', 'minutos', 'tarea']);
  assert.equal(f.proyecto, 'demo');
  assert.equal(f.ruta, 'build');
  assert.equal(f.riesgo, 'alto');
  assert.equal(f.ciclos, 1);
  assert.equal(f.escalamiento, 'a opus');
  assert.equal(f.estado, 'PASS_TECHNICAL');
  assert.equal(f.visual, 'product-ui');
  assert.equal(f.minutos, 5);
  assert.equal(f.tarea, 'arreglar el login');
  // Sin opciones opcionales: escalamiento «ninguno» y visual «none».
  const e2 = casa(t);
  correr(REGISTRO, BASE, e2);
  assert.equal(filas(e2)[0].escalamiento, 'ninguno');
  assert.equal(filas(e2)[0].visual, 'none');
});

test('valida cada opción: ruta, riesgo, estado, visual, ciclos, tarea, escalamiento y opciones desconocidas (salida 1, sin escribir)', (t) => {
  const e = casa(t);
  const con = (clave, valor) => { const a = BASE.slice(); a[a.indexOf(clave) + 1] = valor; return a; };
  const malos = [
    ['--ruta inválida', con('--ruta', 'mala')],
    ['--riesgo inválido', con('--riesgo', 'altisimo')],
    ['--estado inválido', con('--estado', 'NOPE')],
    ['--ciclos inválido', con('--ciclos', 'x')],
    ['--ciclos negativo', con('--ciclos', '-1')],
    ['--visual inválido', [...BASE, '--visual', 'zzz']],
    ['--tarea > 120', [...BASE, '--tarea', 'x'.repeat(121)]],
    ['--escalamiento vacío', [...BASE, '--escalamiento', ' ']],
    ['opción desconocida', [...BASE, '--nada', 'x']],
    ['argumento suelto', [...BASE, 'suelto']],
    ['falta el valor de una opción', [...BASE, '--minutos']],
    ['falta --proyecto', BASE.slice(2)],
    ['falta --estado', BASE.slice(0, -2)],
  ];
  for (const [nombre, args] of malos) {
    const r = correr(REGISTRO, args, e);
    assert.equal(r.status, 1, `${nombre}: debió salir 1 (salió ${r.status})`);
    assert.match(r.stderr, /^uaeh-registro: /, nombre);
  }
  assert.ok(sinEscribir(e), 'los inválidos no escribieron nada');
  // Los valores límite sí valen: ciclos 0, todas las rutas, todos los estados y todos los tipos visuales.
  for (const ruta of ['quick', 'build', 'deep']) assert.equal(correr(REGISTRO, con('--ruta', ruta), e).status, 0, ruta);
  for (const estado of ['PASS_TECHNICAL', 'PASS_RELEASE_READY', 'PENDING_HUMAN_REVIEW', 'BLOCKED_SECURITY', 'FAIL', 'UNKNOWN']) assert.equal(correr(REGISTRO, con('--estado', estado), e).status, 0, estado);
  for (const visual of ['none', 'create-public-ui', 'product-ui', 'redesign-existing', 'reference-to-code', 'audit-only', 'motion-3d', 'video']) assert.equal(correr(REGISTRO, [...BASE, '--visual', visual], e).status, 0, visual);
  assert.equal(correr(REGISTRO, con('--ciclos', '0'), e).status, 0);
  assert.equal(filas(e).length, 3 + 6 + 8 + 1);
});

// ------------------------------------------------------------------------------------------ la zona de la fecha

test('la fecha lleva el desfase de UAEH_TZ: Ciudad de México (-06:00 en noviembre, sin horario de verano) y UTC (+00:00)', (t) => {
  const ahora = '2026-11-15T18:00:00Z';
  const mx = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: 'America/Mexico_City' });
  assert.equal(correr(REGISTRO, BASE, mx).status, 0);
  assert.equal(filas(mx)[0].fecha, '2026-11-15T12:00:00-06:00');
  const utc = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: 'UTC' });
  assert.equal(correr(REGISTRO, BASE, utc).status, 0);
  assert.equal(filas(utc)[0].fecha, '2026-11-15T18:00:00+00:00');
});

test('la fecha respeta desfases positivos y el horario de verano de la zona elegida', (t) => {
  const tokio = casa(t, { UAEH_AHORA: '2026-11-15T18:00:00Z', UAEH_TZ: 'Asia/Tokyo' });
  correr(REGISTRO, BASE, tokio);
  assert.equal(filas(tokio)[0].fecha, '2026-11-16T03:00:00+09:00');
  // Nueva York: el 30 de octubre de 2026 aún rige el horario de verano (-04:00); el 15 de noviembre ya no (-05:00).
  const verano = casa(t, { UAEH_AHORA: '2026-10-30T20:00:00Z', UAEH_TZ: 'America/New_York' });
  correr(REGISTRO, BASE, verano);
  assert.equal(filas(verano)[0].fecha, '2026-10-30T16:00:00-04:00');
  const invierno = casa(t, { UAEH_AHORA: '2026-11-15T20:00:00Z', UAEH_TZ: 'America/New_York' });
  correr(REGISTRO, BASE, invierno);
  assert.equal(filas(invierno)[0].fecha, '2026-11-15T15:00:00-05:00');
});

test('zona efectiva: UAEH_TZ gana a zonaHoraria de uaeh.config.json, y esta a la del sistema', (t) => {
  const ahora = '2026-11-15T18:00:00Z';
  // Solo la configuración (sin UAEH_TZ).
  const soloConfig = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: undefined });
  soloConfig.escribir(path.join(soloConfig.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'America/Mexico_City' }));
  assert.equal(correr(REGISTRO, BASE, soloConfig).status, 0);
  assert.equal(filas(soloConfig)[0].fecha, '2026-11-15T12:00:00-06:00', 'zonaHoraria de la configuración');
  // UAEH_TZ gana.
  const ambas = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: 'UTC' });
  ambas.escribir(path.join(ambas.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'America/Mexico_City' }));
  correr(REGISTRO, BASE, ambas);
  assert.equal(filas(ambas)[0].fecha, '2026-11-15T18:00:00+00:00', 'UAEH_TZ gana a la configuración');
  // Un UAEH_TZ que no es una zona IANA se ignora y vale la configuración.
  const mala = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: 'No/Existe' });
  mala.escribir(path.join(mala.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'America/Mexico_City' }));
  correr(REGISTRO, BASE, mala);
  assert.equal(filas(mala)[0].fecha, '2026-11-15T12:00:00-06:00', 'UAEH_TZ inválida: vale la configuración');
  // Sin ninguna de las dos: la zona del sistema (cualquiera) con su desfase.
  const sistema = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: undefined });
  correr(REGISTRO, BASE, sistema);
  assert.match(filas(sistema)[0].fecha, /^2026-11-1[56]T\d\d:00:00[+-]\d\d:\d\d$/, 'zona del sistema');
  // Una configuración ilegible no rompe el registro.
  const rota = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: undefined });
  rota.escribir(path.join(rota.uaehHome, 'uaeh.config.json'), '{no es json');
  assert.equal(correr(REGISTRO, BASE, rota).status, 0, 'configuración ilegible: se registra igual');
});

// -------------------------------------------------------------------------------------------------------- el resumen

test('el resumen promedia los minutos y cuenta las de más de 60', (t) => {
  const e = casa(t);
  correr(REGISTRO, [...BASE, '--minutos', '20'], e);
  correr(REGISTRO, [...BASE, '--minutos', '90'], e);
  correr(REGISTRO, BASE, e); // fila sin dato
  const r = correr(RESUMEN, ['30'], e);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Minutos por tarea \(2\/3 con dato\): promedio 55, máximo 90/);
  assert.match(r.stdout, /más de 60 min: 1\/2 = 50\.0 %/);
  assert.match(r.stdout, /PASS_TECHNICAL: 55 min \(2\)/);
});

test('el resumen avisa cuando ninguna fila trae minutos (sin fechas de calendario en el texto)', (t) => {
  const e = casa(t);
  correr(REGISTRO, BASE, e);
  const r = correr(RESUMEN, ['30'], e);
  assert.match(r.stdout, /Minutos por tarea: sin dato todavía \(se registran con --minutos\)/);
  assert.doesNotMatch(r.stdout, /\d\d-oct/i);
});

test('el resumen: sin registro, ventana de días y argumento inválido', (t) => {
  const e = casa(t);
  let r = correr(RESUMEN, [], e);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'sin tareas registradas');
  correr(REGISTRO, BASE, e);
  r = correr(RESUMEN, [], e);
  assert.match(r.stdout, /Resumen de los últimos 30 días/);
  assert.match(r.stdout, /Total de tareas: 1/);
  // Cinco días después, el día de ventana 1 ya no incluye la fila.
  const luego = new Date(Date.parse(e.env.UAEH_AHORA) + 5 * 86400000).toISOString();
  assert.equal(correr(RESUMEN, ['1'], e, { UAEH_AHORA: luego }).stdout.trim(), 'sin tareas registradas');
  assert.match(correr(RESUMEN, ['30'], e, { UAEH_AHORA: luego }).stdout, /Total de tareas: 1/);
  for (const malo of ['abc', '0', '-2', '1.5']) {
    const x = correr(RESUMEN, [malo], e);
    assert.equal(x.status, 1, `dias=${malo}`);
    assert.match(x.stderr, /dias debe ser un entero >= 1/);
  }
});

test('el resumen ignora las líneas dañadas y las de fecha ilegible', (t) => {
  const e = casa(t);
  correr(REGISTRO, BASE, e);
  fs.appendFileSync(archivo(e), 'esto no es json\n{"fecha":"no es fecha","ruta":"quick","estado":"FAIL"}\n');
  const r = correr(RESUMEN, ['30'], e);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Total de tareas: 1\b/);
});
