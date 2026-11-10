// Pruebas de plugins/uaeh-kit/statusline/: barra de estado y vigilante del estado oficial de Claude.
//
// Herméticas: casa temporal, hora fija (UAEH_AHORA) y sin red. El vigilante real nunca se lanza:
// las pruebas siembran cachés frescas o sustituyen child_process.spawn.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { entornoTemporal, correr, settingsBasico, RAIZ_KIT } = require('../helpers/entorno.cjs');

const BARRA = path.join(RAIZ_KIT, 'statusline', 'statusline.js');
const VIGILANTE = path.join(RAIZ_KIT, 'statusline', 'claude-status-fetch.js');
const COMUN = path.join(RAIZ_KIT, 'scripts', 'lib', 'comun.cjs');
const VENTANA = path.join(RAIZ_KIT, 'scripts', 'ventana-contexto.cjs');

const sinAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Ejecuta fn con process.env sustituido por `env`: las rutas de comun.cjs se resuelven al llamar.
function conEnv(env, fn) {
  const previo = { ...process.env };
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(require(COMUN)); } finally {
    for (const k of Object.keys(process.env)) if (!(k in previo)) delete process.env[k];
    Object.assign(process.env, previo);
  }
}

const dirCache = (e) => conEnv(e.env, (c) => c.cacheDir());
const ahoraMs = (e) => Date.parse(e.env.UAEH_AHORA);

// Entrada como la que manda Claude Code. Los reinicios de los límites se calculan sobre la hora fija
// de la prueba: 5h → «3h 25m»; 7d → «2d 3h 5m».
function entradaRealista(e) {
  const t = Math.floor(ahoraMs(e) / 1000);
  return {
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: e.proyecto },
    context_window: { used_percentage: 40, context_window_size: 1000000, total_input_tokens: 100, total_output_tokens: 50 },
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: t + 3 * 3600 + 25 * 60 },
      seven_day: { used_percentage: 70, resets_at: t + 2 * 86400 + 3 * 3600 + 5 * 60 },
    },
    cost: { total_duration_ms: 125000 },
    effort: { level: 'high' },
  };
}

function correrBarra(e, stdin, extra = {}) {
  return correr(extra.script || BARRA, [], { stdin, env: extra.env || e.env, cwd: e.proyecto });
}

function configurar(e, statusline) {
  e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ statusline }));
}

function sembrarEstado(e, objeto) {
  const dir = dirCache(e);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-status.json'), JSON.stringify(objeto));
}

// Copia el par de archivos con la forma de carpetas del espejo <uaehHome>/estable
// (statusline/, scripts/, scripts/lib/) y devuelve la ruta de la barra copiada.
function crearEspejo(e, { conVentana }) {
  const raiz = path.join(e.dir, 'espejo');
  const copiar = (...rel) => {
    const destino = path.join(raiz, ...rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.copyFileSync(path.join(RAIZ_KIT, ...rel), destino);
  };
  copiar('statusline', 'statusline.js');
  copiar('statusline', 'claude-status-fetch.js');
  copiar('scripts', 'lib', 'comun.cjs');
  if (conVentana) copiar('scripts', 'ventana-contexto.cjs');
  return path.join(raiz, 'statusline', 'statusline.js');
}

// ── La barra ──────────────────────────────────────────────────────────────────────────

test('la barra muestra modelo, esfuerzo, límites, sesión, contexto libre y carpeta', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const r = correrBarra(e, entradaRealista(e));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const texto = sinAnsi(r.stdout);
    assert.match(texto, /Opus 5\.5 · high/);
    assert.match(texto, /5h 20% → 3h 25m/);
    assert.match(texto, /sesión 2m/);
    assert.match(texto, /7d 70% → 2d 3h 5m/);
    assert.match(texto, /60% libre \(400k\/1M\)/, 'sin tope propio se mide contra la ventana completa del modelo');
    assert.match(texto, /📁 proyecto$/);
    assert.ok(!texto.includes('●'), 'sin estadoClaude no hay punto de estado');
  } finally { e.limpiar(); }
});

test('con autoCompactWindow la barra mide contra el tope de compactación', (t) => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    e.escribir(path.join(e.claudeHome, 'settings.json'), settingsBasico({ autoCompactWindow: 500000 }));
    const texto = sinAnsi(correrBarra(e, entradaRealista(e)).stdout);
    if (!fs.existsSync(VENTANA)) {
      t.diagnostic('scripts/ventana-contexto.cjs aún no existe: solo se comprueba que la barra degrada a «sin tope» (60% libre).');
      assert.match(texto, /60% libre \(400k\/1M\)/);
      return;
    }
    assert.match(texto, /20% libre \(400k\/500k\)/, '40 % de 1M = 400K gastados de un tope de 500K');
  } finally { e.limpiar(); }
});

test('desde un espejo con la misma forma de carpetas funciona; sin ventana-contexto.cjs degrada a «sin tope»', (t) => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    e.escribir(path.join(e.claudeHome, 'settings.json'), settingsBasico({ autoCompactWindow: 500000 }));
    const sinModulo = crearEspejo(e, { conVentana: false });
    let r = correrBarra(e, entradaRealista(e), { script: sinModulo });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.match(sinAnsi(r.stdout), /Opus 5\.5 · high.*60% libre \(400k\/1M\)/,
      'sin el módulo no hay tope aunque settings.json lo declare: la barra no lee settings.json por su cuenta');
    if (!fs.existsSync(VENTANA)) {
      t.diagnostic('scripts/ventana-contexto.cjs aún no existe: se omite la mitad del espejo con el módulo copiado.');
      return;
    }
    const conModulo = crearEspejo(e, { conVentana: true });
    r = correrBarra(e, entradaRealista(e), { script: conModulo });
    assert.equal(r.status, 0, r.stderr);
    assert.match(sinAnsi(r.stdout), /20% libre \(400k\/500k\)/, 'con los tres archivos del espejo sí hay tope');
  } finally { e.limpiar(); }
});

test('el tope se busca en el proyecto de workspace.current_dir (o cwd), no en la carpeta desde donde se lanzó la barra', (t) => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    if (!fs.existsSync(VENTANA)) {
      t.diagnostic('scripts/ventana-contexto.cjs aún no existe: se omite la comprobación del tope por proyecto.');
      return;
    }
    e.escribir(path.join(e.proyecto, '.claude', 'settings.json'), settingsBasico({ autoCompactWindow: 800000 }));
    const fuera = e.dir; // la barra se ejecuta fuera del proyecto
    const entrada = entradaRealista(e);
    const verDesdeFuera = (stdin) => sinAnsi(correr(BARRA, [], { stdin, env: e.env, cwd: fuera }).stdout);

    assert.match(verDesdeFuera(entrada), /50% libre \(400k\/800k\)/, 'workspace.current_dir');

    const soloCwd = { ...entrada, cwd: e.proyecto };
    delete soloCwd.workspace;
    assert.match(verDesdeFuera(soloCwd), /50% libre \(400k\/800k\)/, 'cwd de la entrada cuando no hay workspace');

    const sinCarpeta = { ...entrada };
    delete sinCarpeta.workspace;
    assert.match(verDesdeFuera(sinCarpeta), /60% libre \(400k\/1M\)/, 'control: sin carpeta de proyecto en la entrada no se ve su tope');

    // Una carpeta que no es texto se ignora, y sigue valiendo el tope de los ajustes del usuario.
    e.escribir(path.join(e.claudeHome, 'settings.json'), settingsBasico({ autoCompactWindow: 500000 }));
    const rara = { ...entrada, workspace: { current_dir: 12345 } };
    assert.match(verDesdeFuera(rara), /20% libre \(400k\/500k\)/, 'current_dir que no es texto');
  } finally { e.limpiar(); }
});

test('stdin vacío, basura o que no es un objeto: sale 0 e imprime la línea mínima', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const entradas = [
      '', '   \n', '{no es json', 'null', '42', '[]', '"texto"',
      '{"model":5,"context_window":"x","rate_limits":[],"cost":7,"effort":"alto","workspace":null}',
    ];
    for (const stdin of entradas) {
      const r = correrBarra(e, stdin);
      assert.equal(r.status, 0, `stdin ${JSON.stringify(stdin)}: ${r.stderr}`);
      assert.equal(r.stderr, '', `stdin ${JSON.stringify(stdin)}`);
      const texto = sinAnsi(r.stdout);
      assert.match(texto, /Claude/, `stdin ${JSON.stringify(stdin)} debe imprimir algo razonable`);
      assert.match(texto, /100% libre/);
      assert.doesNotMatch(texto, /undefined|NaN|\[object/, `stdin ${JSON.stringify(stdin)}`);
      assert.doesNotMatch(texto, /5h|7d/, 'sin dato de límites no se inventa un 0 %');
    }
  } finally { e.limpiar(); }
});

test('si stdin nunca se cierra, la barra responde con lo recibido y termina (no se congela)', async () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const { codigo, salida, ms } = await new Promise((resolve, reject) => {
      const inicio = Date.now();
      const hijo = cp.spawn(process.execPath, [BARRA], { env: e.env, cwd: e.proyecto, stdio: ['pipe', 'pipe', 'pipe'] });
      let salida = '';
      hijo.stdout.setEncoding('utf8');
      hijo.stdout.on('data', (c) => { salida += c; });
      hijo.stdin.on('error', () => { /* el hijo ya terminó */ });
      const limite = setTimeout(() => { hijo.kill(); reject(new Error('la barra no terminó con stdin abierto')); }, 20000);
      hijo.on('close', (codigo) => { clearTimeout(limite); resolve({ codigo, salida, ms: Date.now() - inicio }); });
      hijo.stdin.write(JSON.stringify(entradaRealista(e))); // el JSON llega completo, pero stdin NO se cierra
    });
    assert.equal(codigo, 0);
    assert.match(sinAnsi(salida), /Opus 5\.5 · high/);
    assert.ok(ms < 15000, `tardó ${ms} ms`);
  } finally { e.limpiar(); }
});

test('leerStdin: entrega al cerrarse stdin sin esperar el tope; si no se cierra, entrega lo recibido al agotarse', { timeout: 5000 }, async () => {
  const { PassThrough } = require('stream');
  const { leerStdin } = require(BARRA);
  const leer = (flujo, esperaMs) => new Promise((resolve) => leerStdin(resolve, { entrada: flujo, esperaMs }));

  // Cerrado: el tope es de un minuto, así que si la entrega dependiera de él la prueba caería por tiempo.
  const cerrado = new PassThrough();
  const a = leer(cerrado, 60000);
  cerrado.write('{"x":');
  cerrado.end('1}');
  assert.equal(await a, '{"x":1}');

  // Abierto para siempre: se entrega lo recibido cuando se agota la espera.
  const abierto = new PassThrough();
  const b = leer(abierto, 50);
  abierto.write('{"y":2}');
  assert.equal(await b, '{"y":2}');

  // Terminal interactivo: no espera nada.
  const terminal = Object.assign(new PassThrough(), { isTTY: true });
  assert.equal(await leer(terminal, 60000), '');
});

// ── Cachés y opciones (todo apagado por defecto) ──────────────────────────────────────

test('por defecto no escribe cachés; con guardarLimites crea rate-limits-cache.json y solo reescribe si cambia', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const dir = dirCache(e);
    const limites = path.join(dir, 'rate-limits-cache.json');
    const estado = path.join(dir, 'claude-status.json');
    const entrada = entradaRealista(e);

    let r = correrBarra(e, entrada);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(limites), 'sin guardarLimites no se escribe rate-limits-cache.json');
    assert.ok(!fs.existsSync(estado), 'sin estadoClaude no existe claude-status.json');

    configurar(e, { guardarLimites: true });
    r = correrBarra(e, {});
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(limites), 'sin rate_limits en la entrada no hay nada que guardar');

    r = correrBarra(e, entrada);
    assert.equal(r.status, 0, r.stderr);
    const guardado = JSON.parse(fs.readFileSync(limites, 'utf8'));
    assert.deepEqual(Object.keys(guardado).sort(), ['at', 'five_hour', 'seven_day', 'source']);
    assert.equal(guardado.source, 'statusline');
    assert.deepEqual(guardado.five_hour, entrada.rate_limits.five_hour);
    assert.deepEqual(guardado.seven_day, entrada.rate_limits.seven_day);
    assert.equal(guardado.at, ahoraMs(e), 'la hora sale del reloj del kit (UAEH_AHORA)');
    assert.ok(!fs.existsSync(estado), 'guardarLimites no activa el estado de Claude');

    // Mismos límites, otra hora: no se reescribe (at se queda en el valor anterior).
    const masTarde = { ...e.env, UAEH_AHORA: '2026-10-30T20:01:00Z' };
    correrBarra(e, entrada, { env: masTarde });
    assert.equal(JSON.parse(fs.readFileSync(limites, 'utf8')).at, ahoraMs(e), 'sin cambios no se reescribe');

    // Límites distintos: se reescribe con la hora nueva.
    const otra = entradaRealista(e);
    otra.rate_limits.five_hour.used_percentage = 35;
    correrBarra(e, otra, { env: masTarde });
    const nuevo = JSON.parse(fs.readFileSync(limites, 'utf8'));
    assert.equal(nuevo.five_hour.used_percentage, 35);
    assert.equal(nuevo.at, Date.parse(masTarde.UAEH_AHORA));

    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no quedan .tmp');

    // Si el destino no se puede reemplazar (aquí es una carpeta), la barra no falla y no deja su .tmp.
    fs.rmSync(limites);
    fs.mkdirSync(limites);
    const bloqueada = entradaRealista(e);
    bloqueada.rate_limits.seven_day.used_percentage = 99;
    r = correrBarra(e, bloqueada, { env: masTarde });
    assert.equal(r.status, 0, r.stderr);
    assert.match(sinAnsi(r.stdout), /7d 99%/);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'el intento fallido limpia su .tmp');
  } finally { e.limpiar(); }
});

test('el texto que llega de fuera (estado de Claude, tarea, carpeta, modelo) se imprime sin caracteres de control', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const ahora = ahoraMs(e);
    configurar(e, { estadoClaude: true });
    sembrarEstado(e, { indicator: 'major', level: 'major', message: 'Caída\x1b]0;titulo falso\x07 total', fetched_at: ahora - 1000, attempted_at: ahora - 1000 });
    e.escribir(path.join(e.claudeHome, 'task-progress.json'), JSON.stringify({ label: 'Mala\x1b[31m tarea', current: 1, total: 2, updated_at: ahora - 1000 }));
    const entrada = entradaRealista(e);
    entrada.workspace.current_dir = path.join(e.dir, 'carpeta\x1b[2Jrara');
    entrada.model.display_name = 'Opus\x1b[1;31m 5.5';
    entrada.effort.level = 'high\x1b[0m\x1b[41m';

    const r = correrBarra(e, entrada);
    assert.equal(r.status, 0, r.stderr);
    // Los únicos ESC de la salida son los colores de la propia barra: ESC [ 0|1|2 m y ESC [ 38;2;r;g;b m.
    assert.equal(r.stdout.match(/\x1b(?!\[(?:0|1|2|38;2;\d+;\d+;\d+)m)/g), null, 'ningún ESC ajeno a los colores de la barra');
    assert.ok(!r.stdout.includes('\x07'));
    const texto = sinAnsi(r.stdout);
    assert.match(texto, /Claude: Caída\]0;titulo falso total/);
    assert.match(texto, /▶ █{10} 1\/2 Mala\[31m tarea/);
    assert.match(texto, /Opus\[1;31m 5\.5 · high\[0m\[41m/);
    assert.match(texto, /📁 carpeta\[2Jrara$/);
  } finally { e.limpiar(); }
});

test('estadoClaude: apagado no hay punto; encendido pinta verde, de color con texto o gris sin dato fiable', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const ahora = ahoraMs(e);
    const reciente = { fetched_at: ahora - 30000, attempted_at: ahora - 30000 }; // dentro del TTL: no hay consulta nueva
    sembrarEstado(e, { ...reciente, indicator: 'minor', level: 'minor', message: 'Claude API' });

    let r = correrBarra(e, entradaRealista(e));
    let texto = sinAnsi(r.stdout);
    assert.ok(!texto.includes('●') && !texto.includes('Claude:'), 'apagado (por defecto): ni punto ni texto aunque haya caché');

    configurar(e, { estadoClaude: true });
    r = correrBarra(e, entradaRealista(e));
    assert.equal(r.status, 0, r.stderr);
    assert.match(sinAnsi(r.stdout), /^● Claude: Claude API │ Opus 5\.5 · high/);
    assert.ok(r.stdout.includes('\x1b[38;2;255;200;50m●'), 'incidente menor = amarillo');

    const largo = 'Un componente con un nombre larguísimo que no cabe';
    sembrarEstado(e, { ...reciente, indicator: 'minor', level: 'minor', message: largo });
    r = correrBarra(e, entradaRealista(e));
    assert.ok(sinAnsi(r.stdout).includes(`Claude: ${largo.slice(0, 29)}… │ `), 'el mensaje se recorta a 30 caracteres con «…»');

    sembrarEstado(e, { ...reciente, indicator: 'none', level: 'none', message: '' });
    r = correrBarra(e, entradaRealista(e));
    assert.match(sinAnsi(r.stdout), /^● │ Opus 5\.5 · high/, 'todo operativo: solo el punto');
    assert.ok(r.stdout.includes('\x1b[38;2;80;215;120m●'), 'operativo = verde');

    // Dato de hace más de 10 min (con un intento reciente: no se lanza el vigilante) → gris y sin texto.
    sembrarEstado(e, { indicator: 'minor', level: 'minor', message: 'Claude API', fetched_at: ahora - 11 * 60000, attempted_at: ahora - 10000 });
    r = correrBarra(e, entradaRealista(e));
    texto = sinAnsi(r.stdout);
    assert.match(texto, /^● │ Opus 5\.5/);
    assert.doesNotMatch(texto, /Claude:/, 'un dato viejo no se presenta como actual');
    assert.ok(r.stdout.includes('\x1b[38;2;120;120;130m●'), 'sin dato fiable = gris');
  } finally { e.limpiar(); }
});

test('el vigilante se lanza solo con estadoClaude activo, dato viejo y sin consulta reciente', () => {
  const e = entornoTemporal('uaeh-barra-');
  const llamadas = [];
  const spawnOriginal = cp.spawn;
  cp.spawn = (...args) => { llamadas.push(args); return { on() {}, unref() {} }; };
  try {
    conEnv(e.env, (c) => {
      const { render } = require(BARRA);
      const ahora = c.ahora().getTime();
      const archivo = path.join(c.cacheDir(), 'claude-status.json');
      const sembrar = (obj) => { fs.mkdirSync(path.dirname(archivo), { recursive: true }); fs.writeFileSync(archivo, JSON.stringify(obj)); };

      render({});
      assert.equal(llamadas.length, 0, 'apagado (por defecto): no se lanza nada');

      c.escribirJson(c.rutaConfig(), { statusline: { estadoClaude: true } });
      render({});
      assert.equal(llamadas.length, 1, 'encendido y sin caché: se lanza');
      const [ejecutable, argumentos, opciones] = llamadas[0];
      assert.equal(ejecutable, process.execPath);
      assert.deepEqual(argumentos, [VIGILANTE], 'el vigilante se localiza junto a la barra, por __dirname');
      assert.equal(opciones.detached, true);
      assert.equal(opciones.stdio, 'ignore');

      llamadas.length = 0;
      sembrar({ indicator: 'none', fetched_at: ahora - 30000, attempted_at: ahora - 30000 });
      render({});
      assert.equal(llamadas.length, 0, 'dato fresco: nada que hacer');

      sembrar({ indicator: 'none', fetched_at: ahora - 30000 });
      render({});
      assert.equal(llamadas.length, 0, 'dato fresco manda aunque la caché no traiga attempted_at');

      sembrar({ indicator: 'none', fetched_at: ahora - 200000, attempted_at: ahora - 10000 });
      render({});
      assert.equal(llamadas.length, 0, 'dato viejo pero con un intento reciente: ya hay una consulta en vuelo');

      sembrar({ indicator: 'none', fetched_at: ahora - 200000, attempted_at: ahora - 200000 });
      render({});
      assert.equal(llamadas.length, 1, 'dato viejo y sin intento reciente: se lanza');

      // Si la carpeta de caché no se puede crear (aquí su ruta es un archivo), el vigilante no podría
      // marcar su intento y se relanzaría en cada refresco: no se lanza y la barra no falla.
      llamadas.length = 0;
      const carpeta = path.dirname(archivo);
      fs.rmSync(carpeta, { recursive: true, force: true });
      fs.writeFileSync(carpeta, 'esto es un archivo, no una carpeta');
      assert.doesNotThrow(() => render({}));
      assert.equal(llamadas.length, 0, 'sin caché escribible no se lanza el vigilante');
    });
  } finally { cp.spawn = spawnOriginal; e.limpiar(); }
});

test('si el vigilante no se puede lanzar, el error asíncrono de spawn no tumba la barra', async () => {
  const e = entornoTemporal('uaeh-barra-');
  const ejecutable = process.execPath;
  let sinAtender = null;
  const alerta = (err) => { sinAtender = err; };
  process.on('uncaughtException', alerta);
  try {
    conEnv(e.env, (c) => {
      c.escribirJson(c.rutaConfig(), { statusline: { estadoClaude: true } });
      process.execPath = path.join(e.dir, 'no-existe', 'node'); // el vigilante se lanza con process.execPath
      const { render } = require(BARRA);
      assert.doesNotThrow(() => render({}));
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // el error de spawn llega en un turno posterior
    assert.equal(sinAtender, null, `error de spawn sin atender: ${sinAtender && sinAtender.message}`);
  } finally {
    process.execPath = ejecutable;
    process.removeListener('uncaughtException', alerta);
    e.limpiar();
  }
});

// ── Avance de tarea (contrato genérico) ───────────────────────────────────────────────

test('tarea: el segmento sale de task-progress.json y respeta la vigencia', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    const ahora = ahoraMs(e);
    const archivo = path.join(e.claudeHome, 'task-progress.json');
    const ver = () => {
      const r = correrBarra(e, entradaRealista(e));
      assert.equal(r.status, 0, r.stderr);
      return sinAnsi(r.stdout);
    };
    const escribirTarea = (obj) => e.escribir(archivo, JSON.stringify(obj));

    assert.doesNotMatch(ver(), /▶|✓/, 'sin archivo no hay segmento');

    escribirTarea({ label: 'Migración de esquema', current: 3, total: 10, updated_at: ahora - 5000 });
    assert.match(ver(), /5h 20% → 3h 25m │ ▶ █{10} 3\/10 Migración de esquema │ sesión 2m/, 'va entre los límites 5h y la sesión');

    escribirTarea({ label: 'Una etiqueta larguísima que no cabe en la barra', current: 1, total: 2, updated_at: ahora - 5000 });
    assert.match(ver(), /▶ █{10} 1\/2 Una etiqueta larguísima que…/, 'las etiquetas largas se recortan');

    escribirTarea({ label: 'Terminada', current: 10, total: 10, updated_at: ahora - 5000 });
    assert.match(ver(), /✓ █{10} 10\/10 Terminada/, 'recién terminada se ve con marca de listo');
    escribirTarea({ label: 'Terminada', current: 10, total: 10, updated_at: ahora - 40000 });
    assert.doesNotMatch(ver(), /✓|Terminada/, 'terminada hace más de 30 s se oculta');

    escribirTarea({ label: 'Abandonada', current: 3, total: 10, updated_at: ahora - 16 * 60000 });
    assert.doesNotMatch(ver(), /Abandonada/, 'sin actualizar en 15 min se oculta');

    escribirTarea({ label: 'Con ISO', current: 1, total: 4, updated_at: new Date(ahora - 5000).toISOString() });
    assert.match(ver(), /1\/4 Con ISO/, 'updated_at admite ISO 8601');
    escribirTarea({ label: 'En segundos', current: 1, total: 4, updated_at: Math.floor((ahora - 5000) / 1000) });
    assert.match(ver(), /1\/4 En segundos/, 'updated_at admite epoch en segundos');

    e.escribir(archivo, '{ roto');
    assert.doesNotMatch(ver(), /▶|✓/, 'un archivo roto no tumba la barra');
  } finally { e.limpiar(); }
});

// ── Funciones de formato ──────────────────────────────────────────────────────────────

test('formatNum, formatDuration, clampPct y formatModel', () => {
  const { formatNum, formatDuration, clampPct, formatModel } = require(BARRA);

  assert.equal(formatNum(999), '999');
  assert.equal(formatNum(12500), '12.5k');
  assert.equal(formatNum(1500000), '1.5M');
  assert.equal(formatNum(0), '0');
  assert.equal(formatNum(1000), '1k');
  assert.equal(formatNum(999949), '999.9k');
  assert.equal(formatNum(999950), '1M', 'no se imprime «1000k»');
  assert.equal(formatNum(NaN), '0');
  assert.equal(formatNum(-5), '0');

  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59999), '59s');
  assert.equal(formatDuration(125000), '2m');
  assert.equal(formatDuration(3725000), '1h 2m');
  assert.equal(formatDuration(7200000), '2h 0m');
  assert.equal(formatDuration('basura'), '0s');

  assert.equal(clampPct(150), 100);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(33.6), 34);
  assert.equal(clampPct('x'), 0);
  assert.equal(clampPct(null), 0);
  assert.equal(clampPct(undefined), 0);

  assert.equal(formatModel({ id: 'claude-sonnet-5-5' }), 'Sonnet 5.5');
  assert.equal(formatModel({ id: 'claude-opus-5-5', display_name: 'Opus 5.5' }), 'Opus 5.5');
  assert.equal(formatModel({ id: 'claude-opus-5-5', display_name: 'Nombre propio' }), 'Nombre propio', 'display_name manda sobre el id');
  assert.equal(formatModel({ id: 'claude-haiku-4-5' }), 'Haiku 4.5');
  assert.equal(formatModel({ id: 'claude-fable-1-0' }), 'Fable 1.0');
  assert.equal(formatModel({ id: 'claude-mythos-2-1' }), 'Mythos 2.1');
  assert.equal(formatModel({ id: 'claude-opus-4-1-20250805' }), 'Opus 4.1');
  assert.equal(formatModel({ id: 'claude-sonnet-4-20250514' }), 'Sonnet 4', 'una fecha no es una versión menor');
  assert.equal(formatModel({ id: 'otro-modelo' }), 'Claude');
  for (const raro of [null, undefined, {}, 5, [], { id: 7 }]) assert.equal(formatModel(raro), 'Claude');
});

test('los colores siguen los umbrales: contexto libre <15 rojo y <35 amarillo; uso de límites >85 rojo y >60 amarillo', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    conEnv(e.env, () => {
      const { render } = require(BARRA);
      const ROJO = '38;2;255;80;80';
      const AMARILLO = '38;2;255;200;50';
      const VERDE = '38;2;80;220;120';
      // Color (SGR 38;2;r;g;b) que antecede inmediatamente a `texto` en la salida.
      const colorAntesDe = (salida, texto) => {
        const m = new RegExp('\\x1b\\[1m\\x1b\\[(38;2;\\d+;\\d+;\\d+)m' + texto).exec(salida);
        return m && m[1];
      };
      const salida = (usadoCtx, uso5h) => render({
        context_window: { used_percentage: usadoCtx, context_window_size: 200000 },
        rate_limits: { five_hour: { used_percentage: uso5h, resets_at: 0 } },
      });
      for (const [usado, libre, color] of [[40, 60, VERDE], [65, 35, VERDE], [66, 34, AMARILLO], [85, 15, AMARILLO], [86, 14, ROJO], [100, 0, ROJO]]) {
        assert.equal(colorAntesDe(salida(usado, 0), `${libre}% libre`), color, `contexto libre ${libre} %`);
      }
      for (const [uso, color] of [[0, VERDE], [60, VERDE], [61, AMARILLO], [85, AMARILLO], [86, ROJO], [100, ROJO]]) {
        assert.equal(colorAntesDe(salida(0, uso), `${uso}%`), color, `uso del límite ${uso} %`);
      }
    });
  } finally { e.limpiar(); }
});

test('formatReset y renderBar', () => {
  const { formatReset, renderBar } = require(BARRA);
  const t = 1793390400; // segundos Unix; las funciones reciben «ahora» en milisegundos
  const reset = (falta) => sinAnsi(formatReset(t + falta, t * 1000));

  assert.equal(sinAnsi(formatReset(0, t * 1000)), '—');
  assert.equal(sinAnsi(formatReset(undefined, t * 1000)), '—');
  assert.equal(sinAnsi(formatReset('x', t * 1000)), '—');
  assert.equal(reset(-5), 'ahora');
  assert.equal(reset(30), '<1m');
  assert.equal(reset(5 * 60 + 10), '5m');
  assert.equal(reset(3 * 3600 + 25 * 60), '3h 25m');
  assert.equal(reset(2 * 86400 + 3 * 3600 + 5 * 60), '2d 3h 5m');
  assert.equal(reset(2 * 86400 + 7 * 60), '2d 7m');

  const bloques = (s, color) => (s.match(new RegExp(`\\x1b\\[${color}m█`, 'g')) || []).length;
  const medio = renderBar(50, 10);
  assert.equal(sinAnsi(medio), '█'.repeat(10));
  assert.equal(bloques(medio, '38;2;255;220;0'), 5, 'la mitad llena (amarillo)');
  assert.equal(bloques(medio, '38;2;55;55;60'), 5, 'la mitad vacía (gris oscuro)');
  const lleno = renderBar(100, 12);
  assert.equal(bloques(lleno, '38;2;0;220;0'), 12);
  assert.equal(bloques(lleno, '38;2;55;55;60'), 0);
  assert.equal(bloques(renderBar(0, 12), '38;2;55;55;60'), 12);
  assert.equal(bloques(renderBar(500, 12), '38;2;0;220;0'), 12, 'valores fuera de rango se acotan');
});

// ── El vigilante ──────────────────────────────────────────────────────────────────────

const resumenSintetico = (extra = {}) => ({
  page: { name: 'Claude' },
  status: { indicator: 'minor', description: 'Minor Service Outage' },
  components: [
    { name: 'claude.ai', status: 'operational', group: false },
    { name: 'Claude API', status: 'degraded_performance', group: false },
    { name: 'Grupo de servicios', status: 'partial_outage', group: true },
  ],
  incidents: [{ name: 'Elevated errors on Claude API', status: 'investigating', impact: 'minor' }],
  scheduled_maintenances: [],
  ...extra,
});

test('buildResult resume una respuesta de Statuspage: el componente caído es el mensaje', () => {
  const { buildResult } = require(VIGILANTE);
  const t = 1793390400000;

  assert.deepEqual(buildResult(resumenSintetico(), t), {
    indicator: 'minor', level: 'minor', message: 'Claude API', description: 'Minor Service Outage',
    fetched_at: t, attempted_at: t, source: 'summary',
  });

  const operativo = buildResult(resumenSintetico({ status: { indicator: 'none', description: 'All Systems Operational' } }), t);
  assert.equal(operativo.indicator, 'none');
  assert.equal(operativo.level, 'none');
  assert.equal(operativo.message, '', 'todo operativo: sin mensaje');
  assert.equal(operativo.description, 'All Systems Operational');
  assert.equal(operativo.fetched_at, t);

  const tres = buildResult(resumenSintetico({
    components: ['A', 'B', 'C'].map((name) => ({ name, status: 'major_outage', group: false })),
  }), t);
  assert.equal(tres.message, 'A, B…', 'se nombran dos y se elide el resto');

  const soloIncidente = buildResult(resumenSintetico({
    status: { indicator: 'major', description: 'Major Service Outage' },
    components: [{ name: 'claude.ai', status: 'operational' }],
    incidents: [{ name: 'Login failures', status: 'identified', impact: 'major' }],
  }), t);
  assert.equal(soloIncidente.message, 'Login failures');
  assert.equal(soloIncidente.level, 'major', 'el color sigue el impacto del incidente');

  const resuelto = buildResult(resumenSintetico({
    components: [],
    incidents: [{ name: 'Ya pasó', status: 'resolved', impact: 'critical' }],
  }), t);
  assert.equal(resuelto.message, 'Minor Service Outage', 'un incidente resuelto no cuenta; se cae a la descripción');
  assert.equal(resuelto.level, 'minor');

  const mantenimiento = buildResult({
    status: { indicator: 'maintenance', description: 'Scheduled Maintenance' },
    scheduled_maintenances: [{ name: 'Database upgrade', status: 'in_progress' }],
  }, t);
  assert.equal(mantenimiento.message, 'Database upgrade');
  assert.equal(buildResult({ status: { indicator: 'maintenance' } }, t).message, 'Mantenimiento en curso');
  assert.equal(buildResult({ status: { indicator: 'minor' } }, t).message, 'Problema en el servicio');

  for (const raro of [null, undefined, {}, [], 'x']) {
    const r = buildResult(raro, t);
    assert.equal(r.indicator, 'none');
    assert.equal(r.message, '');
  }
});

test('consultar: marca el intento antes de pedir, guarda solo respuestas válidas y barre .tmp viejos (sin red)', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    conEnv(e.env, (c) => {
      const { consultar } = require(VIGILANTE);
      const ahora = c.ahora().getTime();
      const dir = c.cacheDir();
      const archivo = path.join(dir, 'claude-status.json');
      const leer = () => JSON.parse(fs.readFileSync(archivo, 'utf8'));

      // Primera consulta con la carpeta de caché aún inexistente: el vigilante la crea y marca el intento
      // aunque no haya respuesta (sin red).
      assert.ok(!fs.existsSync(dir));
      consultar((alTerminar) => alTerminar(null));
      assert.equal(leer().attempted_at, ahora);
      assert.equal(leer().fetched_at, undefined);

      // Un .tmp de hace 2 h (residuo) y otro recién creado (otra consulta en curso).
      const viejo = path.join(dir, 'claude-status.json.4242.tmp');
      const nuevo = path.join(dir, 'claude-status.json.4343.tmp');
      fs.writeFileSync(viejo, '{}');
      fs.writeFileSync(nuevo, '{}');
      const haceDosHoras = new Date(Date.now() - 2 * 3600 * 1000);
      fs.utimesSync(viejo, haceDosHoras, haceDosHoras);

      let antesDeLaRed = null;
      consultar((alTerminar) => {
        antesDeLaRed = leer(); // la «red» aún no ha respondido
        alTerminar(resumenSintetico());
      });
      assert.equal(antesDeLaRed.attempted_at, ahora, 'attempted_at se escribe ANTES de abrir la conexión');
      assert.equal(antesDeLaRed.fetched_at, undefined);
      const guardado = leer();
      assert.equal(guardado.indicator, 'minor');
      assert.equal(guardado.message, 'Claude API');
      assert.equal(guardado.fetched_at, ahora);
      assert.ok(!fs.existsSync(viejo), 'el .tmp huérfano (>1 h) se barre');
      assert.ok(fs.existsSync(nuevo), 'el .tmp reciente se respeta');
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [path.basename(nuevo)], 'la consulta no deja su propio .tmp');

      // Sin red o con una respuesta que no es de Statuspage: se conserva el dato anterior.
      const antes = leer();
      consultar((alTerminar) => alTerminar(null));
      consultar((alTerminar) => alTerminar({ ok: true }));
      consultar((alTerminar) => alTerminar('texto'));
      const despues = leer();
      assert.equal(despues.indicator, 'minor');
      assert.equal(despues.message, antes.message);
      assert.equal(despues.fetched_at, antes.fetched_at, 'una respuesta ajena no renueva el «dato fresco»');
    });
  } finally { e.limpiar(); }
});

// ── Higiene del módulo ────────────────────────────────────────────────────────────────

test('cargar los módulos no imprime ni escribe nada: solo actúan al ejecutarse como script', () => {
  const e = entornoTemporal('uaeh-barra-');
  try {
    for (const modulo of [BARRA, VIGILANTE]) {
      const r = cp.spawnSync(process.execPath, ['-e', 'require(process.argv[1])', modulo], {
        encoding: 'utf8', env: e.env, cwd: e.proyecto, input: '', timeout: 30000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '', `${path.basename(modulo)} no debe imprimir al cargarse`);
      assert.equal(r.stderr, '');
    }
    assert.ok(!fs.existsSync(dirCache(e)), 'cargar los módulos no crea la carpeta de caché');
  } finally { e.limpiar(); }
});

test('los scripts no arman rutas de estado a mano: todo sale de comun.cjs', () => {
  for (const archivo of [BARRA, VIGILANTE]) {
    const fuente = fs.readFileSync(archivo, 'utf8');
    assert.doesNotMatch(fuente, /['"`]\.claude['"`/\\]/, `${path.basename(archivo)} no debe nombrar la carpeta de Claude Code`);
    assert.doesNotMatch(fuente, /USERPROFILE|process\.env\.HOME/, `${path.basename(archivo)} no debe leer la casa del usuario del entorno`);
    assert.ok(fuente.includes('scripts') && fuente.includes('comun.cjs'), `${path.basename(archivo)} carga comun.cjs`);
    assert.ok(!fuente.includes('\r'), `${path.basename(archivo)} usa saltos de línea LF`);
    assert.notEqual(fuente.charCodeAt(0), 0xFEFF, `${path.basename(archivo)} sin BOM`);
  }
});
