// Pruebas de plugins/uaeh-kit/scripts/ventana-contexto.cjs (fuente única del tope de compactación)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { entornoTemporal, correr, settingsBasico, RAIZ_KIT } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_KIT, 'scripts', 'ventana-contexto.cjs');
const V = require(SCRIPT);

// Los tres archivos de ajustes que lee el script, de mayor a menor prioridad.
const local = (e) => path.join(e.proyecto, '.claude', 'settings.local.json');
const delProyecto = (e) => path.join(e.proyecto, '.claude', 'settings.json');
const delUsuario = (e) => path.join(e.claudeHome, 'settings.json');
const ajustes = (e, ruta, extra) => e.escribir(ruta, settingsBasico(extra));

// Fija variables en process.env mientras corre fn y las restituye (undefined = borrar).
function conProceso(vars, fn) {
  const previo = {};
  for (const k of Object.keys(vars)) previo[k] = process.env[k];
  const poner = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  for (const [k, v] of Object.entries(vars)) poner(k, v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(previo)) poner(k, v); }
}

// topeCompactacion con la casa temporal como «usuario» y SIN las variables reales del entorno.
function tope(e, modelo, opciones = {}) {
  return conProceso({ CLAUDE_CONFIG_DIR: e.claudeHome }, () => V.topeCompactacion(modelo, { env: e.env, cwd: e.proyecto, ...opciones }));
}

test('aTokens: números, cadenas con k/M y todo lo demás → 0', () => {
  const casos = [
    [700000, 700000], ['700000', 700000], ['700k', 700000], ['700K', 700000], [' 700k ', 700000],
    ['1M', 1000000], ['1m', 1000000], ['1.5M', 1500000], [100000, 100000],
    [700, 700000], ['700', 700000], // hasta 1000 se lee como miles
    ['auto', 0], [-1, 0], ['x', 0], [0, 0], ['0', 0], ['', 0], ['700kb', 0], ['k', 0],
    [NaN, 0], [Infinity, 0], [null, 0], [undefined, 0], [true, 0], [{}, 0], [[], 0],
  ];
  for (const [entrada, esperado] of casos) assert.equal(V.aTokens(entrada), esperado, `aTokens(${JSON.stringify(entrada)})`);
});

test('exporta exactamente { topeCompactacion, aTokens, COMPACTA_SIN_TOPE } y el tope de 1M es 967000', () => {
  assert.deepEqual(Object.keys(V).sort(), ['COMPACTA_SIN_TOPE', 'aTokens', 'topeCompactacion']);
  assert.equal(V.COMPACTA_SIN_TOPE, 967000);
});

test('la variable CLAUDE_CODE_AUTO_COMPACT_WINDOW manda sobre todos los archivos; si no vale, se ignora', () => {
  const e = entornoTemporal();
  try {
    ajustes(e, local(e), { autoCompactWindow: 300000 });
    ajustes(e, delProyecto(e), { autoCompactWindow: 400000 });
    ajustes(e, delUsuario(e), { autoCompactWindow: 500000 });
    const conVar = (valor) => ({ ...e.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: valor });
    assert.equal(tope(e, 'm', { env: conVar('1M') }), 1000000);
    assert.equal(tope(e, 'm', { env: conVar('200k') }), 200000);
    assert.equal(tope(e, 'm', { env: conVar('700000') }), 700000);
    assert.equal(tope(e, 'm', { env: conVar('auto') }), 300000, '«auto» no cuenta: sigue con los archivos');
    assert.equal(tope(e, 'm', { env: conVar('') }), 300000);
    assert.equal(tope(e, 'm', { env: {} }), 300000);

    // Sin opciones.env se consulta process.env.
    const deProceso = conProceso({ CLAUDE_CONFIG_DIR: e.claudeHome, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123k' }, () => V.topeCompactacion('m', { cwd: e.proyecto }));
    assert.equal(deProceso, 123000);
  } finally { e.limpiar(); }
});

test('archivos: local del proyecto > proyecto > usuario; si ninguno aplica → 0', () => {
  const e = entornoTemporal();
  try {
    assert.equal(tope(e, 'claude-opus-5-5'), 0, 'sin nada configurado');
    ajustes(e, delUsuario(e), { autoCompactWindow: 500000 });
    assert.equal(tope(e, 'claude-opus-5-5'), 500000, 'solo el usuario');
    ajustes(e, delProyecto(e), { autoCompactWindow: 400000 });
    assert.equal(tope(e, 'claude-opus-5-5'), 400000, 'el proyecto gana al usuario');
    ajustes(e, local(e), { autoCompactWindow: 300000 });
    assert.equal(tope(e, 'claude-opus-5-5'), 300000, 'el local del proyecto gana al proyecto y al usuario');

    const otro = path.join(e.dir, 'otro-proyecto');
    fs.mkdirSync(otro);
    assert.equal(tope(e, 'claude-opus-5-5', { cwd: otro }), 500000, 'otro cwd no hereda los ajustes de este proyecto');
  } finally { e.limpiar(); }
});

test('un archivo de mayor prioridad manda aunque traiga solo el valor general y el de menor prioridad uno por modelo', () => {
  const e = entornoTemporal();
  try {
    ajustes(e, local(e), { autoCompactWindow: 300000 });
    ajustes(e, delUsuario(e), { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 800000 } } });
    assert.equal(tope(e, 'claude-opus-5-5'), 300000);
  } finally { e.limpiar(); }
});

test('modelSettings: modelo exacto, luego modelo sin sufijo [..], luego el valor de nivel superior', () => {
  const e = entornoTemporal();
  try {
    ajustes(e, delUsuario(e), {
      autoCompactWindow: '400k',
      modelSettings: {
        'claude-opus-5-5[1m]': { autoCompactWindow: '800k' },
        'claude-opus-5-5': { autoCompactWindow: 600000 },
        'claude-haiku-5': { autoCompactWindow: 'auto' },
      },
    });
    assert.equal(tope(e, 'claude-opus-5-5[1m]'), 800000, 'el id exacto va primero');
    assert.equal(tope(e, 'claude-opus-5-5'), 600000);
    assert.equal(tope(e, 'claude-sonnet-5-5[1m]'), 400000, 'modelo sin entrada → nivel superior');
    assert.equal(tope(e, 'claude-haiku-5'), 400000, '«auto» por modelo no cuenta: sigue con el nivel superior');
    assert.equal(tope(e), 400000, 'sin modelo → nivel superior');

    ajustes(e, delUsuario(e), { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 650000 } } });
    assert.equal(tope(e, 'claude-opus-5-5[1m]'), 650000, 'pide con sufijo y la entrada está sin él');
    assert.equal(tope(e, 'claude-opus-5-5[200k]'), 650000);
    assert.equal(tope(e, 'claude-otro'), 0, 'otro modelo y sin nivel superior → 0');
    assert.equal(tope(e, '__proto__'), 0, 'un nombre de modelo raro no recorre el prototipo');
  } finally { e.limpiar(); }
});

test('un archivo roto, de forma rara, ilegible o con «auto» no frena a los siguientes niveles; el BOM se tolera', () => {
  const e = entornoTemporal();
  try {
    e.escribir(local(e), '{ esto no es json');
    ajustes(e, delProyecto(e), { autoCompactWindow: 'auto' });
    ajustes(e, delUsuario(e), { autoCompactWindow: 450000 });
    assert.equal(tope(e, 'm'), 450000, 'local roto y proyecto en «auto» → usuario');

    for (const raro of ['[]', '5', 'null', '"texto"', '{"modelSettings":[],"autoCompactWindow":{}}', '{"modelSettings":{"m":"x"},"autoCompactWindow":-5}', '']) {
      e.escribir(local(e), raro);
      assert.equal(tope(e, 'm'), 450000, `forma rara: ${JSON.stringify(raro)}`);
    }

    e.escribir(local(e), '\uFEFF' + settingsBasico({ autoCompactWindow: 275000 }));
    assert.equal(tope(e, 'm'), 275000, 'un settings.json con BOM se lee');

    fs.rmSync(local(e));
    fs.mkdirSync(local(e)); // una carpeta donde se esperaba el archivo: ilegible
    assert.equal(tope(e, 'm'), 450000);

    ajustes(e, delProyecto(e), { autoCompactWindow: 0 });
    assert.equal(tope(e, 'm'), 450000, 'un 0 explícito tampoco frena');
  } finally { e.limpiar(); }
});

test('opciones.settings: se lee solo ese archivo (y el env sigue mandando)', () => {
  const e = entornoTemporal();
  try {
    ajustes(e, local(e), { autoCompactWindow: 111000 });
    ajustes(e, delUsuario(e), { autoCompactWindow: 222000 });
    const explicito = ajustes(e, path.join(e.dir, 'otros-ajustes.json'), { autoCompactWindow: 333000 });
    assert.equal(tope(e, 'm', { settings: explicito }), 333000);
    assert.equal(tope(e, 'm', { settings: path.join(e.dir, 'no-existe.json') }), 0, 'si se pasa, no se cae a los demás archivos');
    assert.equal(tope(e, 'm', { settings: explicito, env: { ...e.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1M' } }), 1000000);
  } finally { e.limpiar(); }
});

test('CLI: imprime el tope en tokens según el directorio actual, la configuración del usuario y el modelo', () => {
  const e = entornoTemporal();
  try {
    const cli = (args = [], env = e.env) => correr(SCRIPT, args, { env, cwd: e.proyecto });
    let r = cli();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '0\n', 'sin configuración: 0 = sin tope propio');

    ajustes(e, delUsuario(e), { autoCompactWindow: 700000, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: '900k' } } });
    assert.equal(cli().stdout, '700000\n');
    assert.equal(cli(['claude-opus-5-5[1m]']).stdout, '900000\n');

    ajustes(e, local(e), { autoCompactWindow: '300k' });
    assert.equal(cli().stdout, '300000\n', 'toma los ajustes del proyecto del directorio actual');

    r = cli([], { ...e.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1M' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '1000000\n');
  } finally { e.limpiar(); }
});

test('la ruta del usuario sale de comun.cjs, nunca de os.homedir() suelto', () => {
  const fuente = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(fuente, /comun\.cjs/);
  assert.doesNotMatch(fuente, /homedir/);
});
