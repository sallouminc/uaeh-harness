// Pruebas de plugins/uaeh-harness/scripts/instalar-puertas.cjs (subcomando «puertas» de instalar.cjs).
// El diagnóstico y todo lo que ejecutaría (WSL como root, npm, la autoprueba visual) se inyectan: ninguna prueba toca
// /opt/uaeh, instala paquetes ni llama a Codex.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, VARIABLES_A_VACIAR, entornoTemporal } = require('../helpers/entorno.cjs');

const E = entornoTemporal('uaeh-instalar-puertas-');
process.on('exit', () => E.limpiar());
for (const k of VARIABLES_A_VACIAR) delete process.env[k];
Object.assign(process.env, E.env);

const IP = require(path.join(RAIZ_HARNESS, 'scripts', 'instalar-puertas.cjs'));
const instalar = require(path.join(RAIZ_HARNESS, 'scripts', 'instalar.cjs'));
const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
const runner = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'runner.cjs'));
const uaehConfig = require(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs'));
const PINES = JSON.parse(fs.readFileSync(path.join(RAIZ_HARNESS, 'wsl', 'herramientas.json'), 'utf8'));
const CONFIG = path.join(E.uaehHome, 'uaeh.config.json');
const SCRIPT = path.join(RAIZ_HARNESS, 'scripts', 'instalar.cjs');

const SEGURIDAD_SANA = ['plataforma', 'motor', 'sistema', 'escaneres', 'reglas-semgrep', 'docker', 'imagenes', 'programas', 'validadores', 'uaeh-conf'];
function puerta(nombre, estado, cambios = {}, base = SEGURIDAD_SANA) {
  const comprobaciones = base.map((id) => ({ id, estado: 'OK', detalle: id === 'sistema' ? 'Ubuntu noble x86_64 · Python 3.12.3 · usuario prueba' : 'bien' }));
  for (const [id, [est, det]] of Object.entries(cambios)) {
    const c = comprobaciones.find((x) => x.id === id);
    if (c) Object.assign(c, { estado: est, detalle: det || est }); else comprobaciones.push({ id, estado: est, detalle: det || est });
  }
  return { puerta: nombre, estado, comprobaciones };
}

// h de prueba: diagnóstico fijo y registro de lo que se ejecutaría.
function ayudas({ diag, so = 'win32', motor = () => ({ codigo: 0, stdout: 'INSTALAR_OK\nINSTALAR_BIN_OK\n/opt/uaeh-respaldo/x\n', stderr: '' }), comando, node } = {}) {
  const llamadas = { diagnostico: 0, motor: [], comando: [], node: [] };
  return {
    llamadas,
    h: {
      accion: instalar.accion, escribirConRespaldo: instalar.escribirConRespaldo, so,
      diagnostico: (ps) => { llamadas.diagnostico++; return { puertas: ps.map((p) => diag[p]) }; },
      ejecutarMotor: (argv, segundos) => { llamadas.motor.push({ argv, segundos }); return motor(argv); },
      ejecutarComando: (c, s) => { llamadas.comando.push(c); return comando ? comando(c, s) : { codigo: 0, stdout: '', stderr: '' }; },
      nodeScript: (s, a, seg) => { llamadas.node.push([s, ...a]); return node ? node(s, a, seg) : { codigo: 0, stdout: '', stderr: '' }; },
    },
  };
}
const tipos = (r) => r.acciones.map((a) => a.tipo);
const textos = (r) => r.acciones.map((a) => `${a.tipo} ${a.detalle} ${a.snippet || ''}`).join('\n');

function config(datos) {
  if (datos == null) { try { fs.unlinkSync(CONFIG); } catch { /* no existía */ } return; }
  fs.writeFileSync(CONFIG, typeof datos === 'string' ? datos : JSON.stringify(datos, null, 2));
}

// ── argumentos ────────────────────────────────────────────────────────────────────────────

test('parsearArgumentos · puerta posicional y combinaciones inválidas', () => {
  const o = instalar.parsearArgumentos(['puertas', 'seguridad', '--actualizar', '--aplicar']);
  assert.equal(o.puerta, 'seguridad');
  assert.equal(o.actualizar, true);
  assert.equal(instalar.parsearArgumentos(['puertas']).puerta, null);
  assert.equal(instalar.parsearArgumentos(['puertas', 'codex', '--consiento']).consiento, true);
  const malos = [
    [['puertas', 'otra'], /desconocida/], [['puertas', 'seguridad', '--consiento'], /solo aplican a la puerta codex/],
    [['puertas', 'codex', '--consiento', '--retirar'], /no van juntas/], [['puertas', 'codex', '--reparar'], /seguridad o visual/],
    [['git-guard', '--actualizar'], /solo aplican a puertas/], [['puertas', 'codex', 'visual'], /inesperado/],
  ];
  for (const [argv, re] of malos) assert.throws(() => instalar.parsearArgumentos(argv), re, argv.join(' '));
});

// ── seguridad ─────────────────────────────────────────────────────────────────────────────

test('seguridad · instalada y al día: SIN CAMBIOS y no se ejecuta nada', () => {
  config(null);
  const { h, llamadas } = ayudas({ diag: { seguridad: puerta('seguridad', 'LISTA') } });
  const r = IP.puertas({ puerta: 'seguridad', aplicar: true }, h);
  assert.ok(tipos(r).includes('SIN CAMBIOS'));
  assert.equal(llamadas.motor.length, 0);
  assert.equal(r.codigo, 0);
});

test('seguridad · programas desactualizados, en seco: respaldo + instalar-bin.sh como root con la base y el usuario de la puerta', () => {
  config({ wsl: { distro: 'Ubuntu-24.04', usuario: 'usuario1' } });
  const { h, llamadas } = ayudas({ diag: { seguridad: puerta('seguridad', 'LISTA', { programas: ['AVISO', 'desactualizados'] }) } });
  const r = IP.puertas({ puerta: 'seguridad' }, h);
  assert.equal(llamadas.motor.length, 0, 'en seco no se ejecuta nada');
  const t = textos(r);
  assert.match(t, /HARÍA respaldo de \/opt\/uaeh en \/opt\/uaeh-respaldo\//);
  assert.match(t, /wsl\.exe -d Ubuntu-24\.04 -u root -e env UAEH_USER=usuario1 '?UAEH_BASE=.+? bash .+?instalar-bin\.sh/);
  assert.ok(t.includes(`UAEH_BASE=${runner.aRutaMotor(uaehConfig.runsDir(), 'win32')}`));
  assert.doesNotMatch(t, /instalar\.sh \(/, 'instalar.sh no hace falta: solo los programas');
});

test('seguridad · --aplicar: respaldo primero, luego instalar-bin.sh, y el diagnóstico se repite', () => {
  config({ wsl: { distro: 'Ubuntu-24.04', usuario: 'usuario1' } });
  const { h, llamadas } = ayudas({ diag: { seguridad: puerta('seguridad', 'LISTA', { 'uaeh-conf': ['FALLÓ', 'base distinta'] }) } });
  const r = IP.puertas({ puerta: 'seguridad', aplicar: true }, h);
  assert.equal(llamadas.motor.length, 2, textos(r));
  assert.match(llamadas.motor[0].argv.join(' '), /-u root -e bash -c set -e; if \[ -d \/opt\/uaeh \]; then mkdir -p \/opt\/uaeh-respaldo\/\d{8}-\d{6}; cp -a/);
  assert.match(llamadas.motor[1].argv.join(' '), /-u root -e env UAEH_USER=usuario1 UAEH_BASE=.* bash .*instalar-bin\.sh$/);
  assert.ok(tipos(r).includes('RESPALDO') && tipos(r).includes('HECHO'));
  assert.equal(llamadas.diagnostico, 2, 'tras instalar se vuelve a diagnosticar');
  assert.deepEqual(r.diagnostico.despues, [{ puerta: 'seguridad', estado: 'LISTA' }]);
  assert.equal(r.codigo, 0);
});

test('seguridad · si el respaldo falla no se instala nada; si instalar.sh falla, instalar-bin.sh no corre', () => {
  config(null);
  const sinRespaldo = ayudas({ diag: { seguridad: puerta('seguridad', 'LISTA', { programas: ['AVISO'] }) }, motor: () => ({ codigo: 1, stdout: '', stderr: 'cp: sin espacio' }) });
  const r1 = IP.puertas({ puerta: 'seguridad', aplicar: true }, sinRespaldo.h);
  assert.equal(sinRespaldo.llamadas.motor.length, 1);
  assert.match(textos(r1), /no se pudo respaldar \/opt\/uaeh: cp: sin espacio; no se instala nada/);
  assert.equal(r1.codigo, 1);
  const falla = ayudas({
    diag: { seguridad: puerta('seguridad', 'NO_INSTALADA', { escaneres: ['NO_INSTALADA'] }) },
    motor: (argv) => (argv.join(' ').includes('instalar.sh') && !argv.join(' ').includes('instalar-bin') ? { codigo: 1, stdout: 'descargando…', stderr: 'sha256 no coincide' } : { codigo: 0, stdout: '/opt/uaeh-respaldo/x', stderr: '' }),
  });
  const r2 = IP.puertas({ puerta: 'seguridad', aplicar: true }, falla.h);
  assert.equal(falla.llamadas.motor.length, 2, 'respaldo + instalar.sh, y se detiene');
  assert.match(textos(r2), /instalar\.sh .* falló .*sha256 no coincide.*Reversa: el respaldo de \/opt\/uaeh está en/);
  assert.equal(r2.codigo, 1);
});

test('seguridad · --reparar fuerza los dos instaladores aunque todo esté al día; --actualizar solo instalar-bin.sh', () => {
  config(null);
  const a = ayudas({ diag: { seguridad: puerta('seguridad', 'LISTA') } });
  IP.puertas({ puerta: 'seguridad', aplicar: true, reparar: true }, a.h);
  assert.equal(a.llamadas.motor.length, 3);
  assert.match(a.llamadas.motor[1].argv.join(' '), /instalar\.sh$/);
  assert.match(a.llamadas.motor[2].argv.join(' '), /instalar-bin\.sh$/);
  const b = ayudas({ diag: { seguridad: puerta('seguridad', 'LISTA') } });
  IP.puertas({ puerta: 'seguridad', aplicar: true, actualizar: true }, b.h);
  assert.equal(b.llamadas.motor.length, 2);
  assert.match(b.llamadas.motor[1].argv.join(' '), /instalar-bin\.sh$/);
});

test('seguridad · en Linux imprime los comandos con sudo y nunca los ejecuta; sin motor en Windows da la guía de WSL', () => {
  config(null);
  const linux = ayudas({ so: 'linux', diag: { seguridad: puerta('seguridad', 'NO_INSTALADA', { escaneres: ['NO_INSTALADA'] }) } });
  const r = IP.puertas({ puerta: 'seguridad', aplicar: true }, linux.h);
  assert.equal(linux.llamadas.motor.length, 0);
  assert.match(textos(r), /sudo env UAEH_USER=prueba bash .+?instalar\.sh/);
  assert.match(textos(r), /sudo env UAEH_USER=prueba '?UAEH_BASE=.+? bash .+?instalar-bin\.sh/); // con «\» (Windows simulando Linux) va entre comillas
  const sinWsl = ayudas({ diag: { seguridad: puerta('seguridad', 'NO_INSTALADA', { motor: ['NO_INSTALADA', 'wsl.exe no responde'] }) } });
  const r2 = IP.puertas({ puerta: 'seguridad', aplicar: true }, sinWsl.h);
  assert.equal(sinWsl.llamadas.motor.length, 0);
  assert.match(textos(r2), /wsl --install -d Ubuntu-24\.04/);
  assert.match(textos(r2), /systemd=true/);
});

// ── visual ────────────────────────────────────────────────────────────────────────────────

test('visual · instala playwright-cli con el pin exacto y la caché de la autoprueba solo con --aplicar', () => {
  const diag = { visual: puerta('visual', 'NO_INSTALADA', { 'playwright-cli': ['NO_INSTALADA'], autoprueba: ['AVISO', 'faltan'] }, ['node', 'playwright-cli', 'chrome', 'config-global', 'autoprueba']) };
  const seco = ayudas({ diag });
  const r = IP.puertas({ puerta: 'visual' }, seco.h);
  assert.equal(seco.llamadas.comando.length + seco.llamadas.node.length, 0);
  assert.match(textos(r), new RegExp(`npm i -g @playwright/cli@${PINES.visual['@playwright/cli'].replace(/\./g, '\\.')} --ignore-scripts`));
  const real = ayudas({ diag });
  IP.puertas({ puerta: 'visual', aplicar: true }, real.h);
  assert.deepEqual(real.llamadas.comando, [`npm i -g @playwright/cli@${PINES.visual['@playwright/cli']} --ignore-scripts`]);
  assert.equal(real.llamadas.node.length, 1);
  assert.deepEqual(real.llamadas.node[0].slice(1), ['--instalar', '--sin-lighthouse']);
});

test('visual · Chrome o una config global se indican, nunca se tocan', () => {
  const diag = { visual: puerta('visual', 'NO_LISTA', { chrome: ['NO_INSTALADA', 'sin Google Chrome'], 'config-global': ['FALLÓ', 'existe ~/.playwright/cli.config.json'] }, ['node', 'playwright-cli', 'chrome', 'config-global', 'autoprueba']) };
  const a = ayudas({ diag });
  const r = IP.puertas({ puerta: 'visual', aplicar: true }, a.h);
  assert.equal(a.llamadas.comando.length + a.llamadas.node.length, 0);
  assert.match(textos(r), /sin Google Chrome \(lo instalas tú\)/);
  assert.match(textos(r), /No se borra nada por ti/);
});

// ── codex: consentimiento ─────────────────────────────────────────────────────────────────

const DIAG_CODEX = { codex: puerta('codex', 'APAGADA', {}, ['consentimiento']) };

test('codex · apagado y sin --consiento: solo informa, la config no se toca', () => {
  config({ version: 1 });
  const antes = fs.readFileSync(CONFIG, 'utf8');
  const r = IP.puertas({ puerta: 'codex', aplicar: true }, ayudas({ diag: DIAG_CODEX }).h);
  assert.match(textos(r), /Privacidad: el auditor Codex manda a OpenAI/);
  assert.match(textos(r), /--consiento --aplicar/);
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), antes);
  assert.equal(configLib.cargarConfig().config.codex.habilitado, false);
});

test('codex · --consiento en seco no escribe; con --aplicar habilita con fecha, respalda, y --retirar lo apaga', () => {
  config({ version: 1, codex: { modelos: { rapido: { modelo: 'propio', esfuerzo: 'low' } } } });
  const seco = IP.puertas({ puerta: 'codex', consiento: true }, ayudas({ diag: DIAG_CODEX }).h);
  assert.ok(tipos(seco).includes('HARÍA'));
  assert.equal(configLib.cargarConfig().config.codex.habilitado, false);
  const r = IP.puertas({ puerta: 'codex', consiento: true, aplicar: true }, ayudas({ diag: DIAG_CODEX }).h);
  assert.ok(tipos(r).includes('HECHO') && tipos(r).includes('RESPALDO'), textos(r));
  const c = configLib.cargarConfig();
  assert.equal(c.config.codex.habilitado, true);
  assert.equal(c.config.codex.consentimiento, '2026-10-30');
  assert.equal(c.config.codex.modelos.rapido.modelo, 'propio', 'lo demás de la config se conserva');
  assert.deepEqual(c.avisos, []);
  assert.ok(fs.readdirSync(E.uaehHome).some((n) => n.startsWith('uaeh.config.json.uaeh-respaldo-')));
  const otra = IP.puertas({ puerta: 'codex', consiento: true, aplicar: true }, ayudas({ diag: DIAG_CODEX }).h);
  assert.ok(tipos(otra).includes('SIN CAMBIOS'));
  IP.puertas({ puerta: 'codex', retirar: true, aplicar: true }, ayudas({ diag: DIAG_CODEX }).h);
  assert.equal(configLib.cargarConfig().config.codex.habilitado, false);
  assert.equal(configLib.cargarConfig().config.codex.consentimiento, '');
});

test('codex · --consiento sin uaeh.config.json la crea desde la plantilla; con una config rota no escribe', () => {
  config(null);
  IP.puertas({ puerta: 'codex', consiento: true, aplicar: true }, ayudas({ diag: DIAG_CODEX }).h);
  const c = configLib.cargarConfig();
  assert.equal(c.existe, true);
  assert.equal(c.config.codex.habilitado, true);
  assert.deepEqual(c.avisos, []);
  config('{ roto');
  const r = IP.puertas({ puerta: 'codex', consiento: true, aplicar: true }, ayudas({ diag: DIAG_CODEX }).h);
  assert.equal(fs.readFileSync(CONFIG, 'utf8'), '{ roto');
  assert.equal(r.codigo, 1);
  config(null);
});

test('codex · habilitado: señala CLI, sesión y aislamiento pendientes', () => {
  config({ codex: { habilitado: true } });
  const diag = { codex: puerta('codex', 'NO_INSTALADA', { cli: ['NO_INSTALADA'], aislamiento: ['AVISO'] }, ['consentimiento']) };
  const t = textos(IP.puertas({ puerta: 'codex' }, ayudas({ diag }).h));
  assert.match(t, /npm i -g @openai\/codex/);
  assert.match(t, /--puerta codex --vivo/);
  config(null);
});

// ── CLI de punta a punta (solo preflight: no toca nada de la máquina) ─────────────────────

test('CLI · instalar.cjs puertas preflight --json', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'puertas', 'preflight', '--json'], { encoding: 'utf8', env: E.env, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const inf = JSON.parse(r.stdout);
  assert.equal(inf.subcomando, 'puertas');
  assert.deepEqual(inf.diagnostico.antes, [{ puerta: 'preflight', estado: 'LISTA' }]);
  assert.equal(spawnSync(process.execPath, [SCRIPT, 'puertas', 'nada'], { encoding: 'utf8', env: E.env }).status, 2);
});
