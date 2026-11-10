// Pruebas de plugins/uaeh-harness/scripts/doctor-puertas.cjs y de wsl/estado.sh.
// La máquina se simula por inyección (motor, WSL, programas externos): nunca se toca el /opt/uaeh real ni Codex.
// Las autopruebas que son del propio plugin (candado del verificador de navegador, huella y sello) corren de verdad.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, VARIABLES_A_VACIAR, entornoTemporal, requiereBash, requiereHerramienta } = require('../helpers/entorno.cjs');

const E = entornoTemporal('uaeh-doctor-puertas-');
process.on('exit', () => E.limpiar());
// El doctor corre en este proceso (para poder inyectar la máquina): el entorno del proceso es el temporal.
for (const k of VARIABLES_A_VACIAR) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^PLAYWRIGHT_MCP_|^PWTEST_CLI_GLOBAL_CONFIG$/i.test(k)) delete process.env[k];
Object.assign(process.env, E.env);

const DP = require(path.join(RAIZ_HARNESS, 'scripts', 'doctor-puertas.cjs'));
const uaehConfig = require(path.join(RAIZ_HARNESS, 'scripts', 'uaeh-config.cjs'));
const PINES = JSON.parse(fs.readFileSync(path.join(RAIZ_HARNESS, 'wsl', 'herramientas.json'), 'utf8'));
const WSL = path.join(RAIZ_HARNESS, 'wsl');
const CONFIG = path.join(E.uaehHome, 'uaeh.config.json');

function config(datos) {
  if (datos == null) { try { fs.unlinkSync(CONFIG); } catch { /* no existía */ } return; }
  fs.writeFileSync(CONFIG, JSON.stringify(datos));
}

// Salida de estado.sh de una máquina sana para ESTE plugin (plataforma linux: la ruta de corridas no se traduce).
function estadoSano(cambios = {}) {
  const lineas = [
    'estado_version 1', `arquitectura ${PINES.plataforma.arquitectura}`, `ubuntu ${PINES.plataforma.ubuntu}`, 'pid1 systemd',
    'usuario prueba', 'grupo_docker si', 'python3 Python 3.12.3',
    `gitleaks ${PINES.gitleaks.version}`, `osv osv-scanner version: ${PINES['osv-scanner'].version}`, `semgrep ${PINES.semgrep.version}`,
    'reglas_semgrep /opt/uaeh/reglas/semgrep/2026-10-15', 'docker 29.0.0',
    ...Object.values(PINES.imagenes).map((i) => `imagen ${i.etiqueta.split(':')[0]}@${i.digest}`),
    'conf si', `conf_base ${uaehConfig.runsDir()}`, 'conf_usuario prueba', 'instalado si', 'enlace_sandbox si',
  ];
  for (const d of ['bin', 'contenedor', 'pruebas']) {
    for (const n of fs.readdirSync(path.join(WSL, d)).sort()) lineas.push(`archivo ${d}/${n} igual root:root ${d === 'contenedor' ? '644' : '755'}`);
  }
  const val = /^VALIDADORES=\((.*)\)$/m.exec(fs.readFileSync(path.join(WSL, 'instalar-bin.sh'), 'utf8'))[1].split(/\s+/);
  for (const n of val) lineas.push(`archivo validadores/${n} igual root:root 644`);
  let texto = lineas.join('\n');
  for (const [de, a] of Object.entries(cambios)) {
    assert.ok(texto.includes(de), `la línea a cambiar no existe: ${de}`);
    texto = texto.replace(de, a);
  }
  return `${texto}\nESTADO_FIN\n`;
}

function maquina({ estado = estadoSano(), modo = 'linux', motor = true, codex = null, comando = null, node = null } = {}) {
  return {
    plataforma: () => ({ so: modo === 'wsl' ? 'win32' : modo === 'linux' ? 'linux' : 'darwin', modo }),
    motorListo: () => ({ listo: motor, detalle: motor ? 'motor simulado' : 'wsl.exe -d Ubuntu no responde: simulado' }),
    ejecutarLinux: () => ({ codigo: 0, stdout: estado, stderr: '', agotado: false }),
    listarWsl: () => 'NAME      STATE      VERSION\n* Ubuntu-24.04    Running    2\n',
    ejecutarComando: comando || ((p) => ({ codigo: 0, stdout: p === 'playwright-cli' ? `${PINES.visual['@playwright/cli']}\n` : 'Python 3.12.3\n', stderr: '', encontrado: true })),
    resolverCodex: codex || (() => { throw new Error('No se encontro Codex CLI'); }),
    ...(node ? { nodeScript: node } : {}),
  };
}

const ids = (puerta) => Object.fromEntries(puerta.comprobaciones.map((c) => [c.id, c]));
const correr = (puertas, iny, extra = {}) => DP.ejecutar({ puertas, inyectar: iny, rapido: true, ...extra });

// ── argumentos y piezas puras ─────────────────────────────────────────────────────────────

test('parsearArgumentos · puertas repetidas o por comas, todas por defecto, combinaciones inválidas', () => {
  assert.deepEqual(DP.parsearArgumentos(['--puerta', 'seguridad,visual', '--puerta', 'seguridad']).opciones.puertas, ['seguridad', 'visual']);
  assert.deepEqual(DP.parsearArgumentos([]).opciones.puertas, []);
  assert.deepEqual(DP.parsearArgumentos(['--todas']).opciones.puertas, DP.PUERTAS);
  assert.match(DP.parsearArgumentos(['--puerta', 'otra']).error, /desconocida/);
  assert.match(DP.parsearArgumentos(['--rapido', '--vivo']).error, /no van juntas/);
  assert.match(DP.parsearArgumentos(['--nada']).error, /desconocido/);
  assert.match(DP.parsearArgumentos(['--puerta']).error, /falta el valor/);
});

test('parsearEstado y versionWslDe · claves repetidas, fin del informe y la marca de distro por defecto', () => {
  const e = DP.parsearEstado('a 1\narchivo x igual\narchivo y falta\nbasura\nESTADO_FIN\n');
  assert.equal(e.completo, true);
  assert.deepEqual(e.datos.get('archivo'), ['x igual', 'y falta']);
  assert.equal(DP.parsearEstado('a 1\n').completo, false);
  const lista = '  NAME            STATE           VERSION\n* Ubuntu          Running         2\n  Viejo           Stopped         1\n';
  assert.equal(DP.versionWslDe(lista, 'ubuntu'), '2');
  assert.equal(DP.versionWslDe(lista, 'Viejo'), '1');
  assert.equal(DP.versionWslDe(lista, 'Otra'), null);
});

test('verificarVendor · las copias de terceros del plugin están íntegras y un cambio se detecta', () => {
  for (const v of ['security-audit', 'web-interface-guidelines']) assert.equal(DP.verificarVendor(RAIZ_HARNESS, v).ok, true, v);
  const copia = path.join(E.dir, 'raiz-vendor');
  const origen = path.join(RAIZ_HARNESS, 'vendor', 'web-interface-guidelines');
  fs.mkdirSync(path.join(copia, 'vendor'), { recursive: true });
  require('../helpers/entorno.cjs').copiarCarpeta(origen, path.join(copia, 'vendor', 'web-interface-guidelines'));
  const archivo = path.join(copia, 'vendor', 'web-interface-guidelines', 'command.md');
  assert.equal(DP.verificarVendor(copia, 'web-interface-guidelines').ok, true, 'la copia sin tocar es íntegra');
  fs.appendFileSync(archivo, '\nregla sembrada\n');
  const v = DP.verificarVendor(copia, 'web-interface-guidelines');
  assert.equal(v.ok, false);
  assert.match(v.malos.join(' '), /command\.md \(cambió\)/);
});

// ── seguridad ─────────────────────────────────────────────────────────────────────────────

test('seguridad · máquina sana → LISTA, cada pieza en OK y las caras OMITIDA con --rapido', () => {
  config(null);
  const inf = correr(['seguridad'], maquina());
  const p = inf.puertas[0];
  assert.equal(p.estado, 'LISTA', JSON.stringify(p.comprobaciones.filter((c) => c.estado !== 'OK'), null, 1));
  const c = ids(p);
  for (const id of ['plataforma', 'motor', 'sistema', 'systemd', 'escaneres', 'reglas-semgrep', 'docker', 'imagenes', 'programas', 'validadores', 'uaeh-conf', 'python', 'parche-cyber-neo', 'vendor']) {
    assert.equal(c[id].estado, 'OK', `${id}: ${c[id].detalle}`);
  }
  assert.equal(c['wsl-version'].estado, 'NO_APLICA');
  assert.equal(c.corridas.estado, 'OMITIDA');
  assert.equal(inf.veredicto, 'LISTA');
  assert.equal(inf.codigo, 0);
});

test('seguridad · WSL 1 falla y WSL 2 pasa (Windows)', () => {
  const iny = { ...maquina({ modo: 'wsl' }), listarWsl: () => '  NAME    STATE    VERSION\n* Ubuntu-24.04    Running    1\n' };
  assert.equal(ids(correr(['seguridad'], iny).puertas[0])['wsl-version'].estado, 'FALLÓ');
  assert.equal(ids(correr(['seguridad'], maquina({ modo: 'wsl' })).puertas[0])['wsl-version'].estado, 'OK');
});

test('seguridad · programas: distinto → AVISO, falta → NO_INSTALADA, de otro dueño o escribible → FALLÓ', () => {
  const avisa = correr(['seguridad'], maquina({ estado: estadoSano({ 'archivo bin/uaeh-sandbox igual': 'archivo bin/uaeh-sandbox distinto' }) })).puertas[0];
  assert.equal(ids(avisa).programas.estado, 'AVISO');
  assert.match(ids(avisa).programas.detalle, /--actualizar/);
  assert.equal(avisa.estado, 'LISTA', 'un programa desactualizado avisa pero no tumba la puerta');
  const falta = correr(['seguridad'], maquina({ estado: estadoSano({ 'archivo bin/uaeh-sandbox igual root:root 755': 'archivo bin/uaeh-sandbox falta' }) })).puertas[0];
  assert.equal(ids(falta).programas.estado, 'NO_INSTALADA');
  assert.equal(falta.estado, 'NO_INSTALADA');
  const inseguro = correr(['seguridad'], maquina({ estado: estadoSano({ 'archivo bin/uaeh-sandbox igual root:root 755': 'archivo bin/uaeh-sandbox igual prueba:prueba 775' }) })).puertas[0];
  assert.equal(ids(inseguro).programas.estado, 'FALLÓ');
  assert.equal(inseguro.estado, 'NO_LISTA');
  const otros = correr(['seguridad'], maquina({ estado: estadoSano({ 'archivo contenedor/armar.sh igual root:root 644': 'archivo contenedor/armar.sh igual root:root 666' }) })).puertas[0];
  assert.equal(ids(otros).programas.estado, 'FALLÓ', 'un archivo escribible por todos es inseguro aunque sea de root');
});

test('seguridad · escáneres, Docker, imágenes y uaeh.conf', () => {
  const c = (cambios) => ids(correr(['seguridad'], maquina({ estado: estadoSano(cambios) })).puertas[0]);
  assert.equal(c({ [`gitleaks ${PINES.gitleaks.version}`]: 'gitleaks 1.0.0' }).escaneres.estado, 'AVISO');
  assert.equal(c({ [`semgrep ${PINES.semgrep.version}`]: 'semgrep no' }).escaneres.estado, 'NO_INSTALADA');
  const caido = c({ 'docker 29.0.0': 'docker no: permission denied while trying to connect', 'grupo_docker si': 'grupo_docker no' });
  assert.equal(caido.docker.estado, 'FALLÓ');
  assert.match(caido.docker.detalle, /grupo docker/);
  assert.equal(caido.imagenes.estado, 'OMITIDA');
  assert.equal(c({ 'docker 29.0.0': 'docker no: falta el programa docker' }).docker.estado, 'NO_INSTALADA');
  const img = Object.values(PINES.imagenes)[0];
  assert.equal(c({ [`imagen ${img.etiqueta.split(':')[0]}@${img.digest}`]: 'imagen otra@sha256:0' }).imagenes.estado, 'NO_INSTALADA');
  const conf = c({ [`conf_base ${uaehConfig.runsDir()}`]: 'conf_base /mnt/otra/carpeta' });
  assert.equal(conf['uaeh-conf'].estado, 'FALLÓ');
  assert.match(conf['uaeh-conf'].detalle, /solo acepta corridas bajo \/mnt\/otra\/carpeta/);
  assert.equal(c({ 'conf_usuario prueba': 'conf_usuario otro' })['uaeh-conf'].estado, 'FALLÓ');
  assert.equal(c({ 'conf si': 'conf no' })['uaeh-conf'].estado, 'NO_INSTALADA');
  assert.equal(c({ 'pid1 systemd': 'pid1 init' }).systemd.estado, 'AVISO');
});

test('seguridad · sin motor: el motor queda NO_INSTALADA y lo que depende de él OMITIDA (nunca OK)', () => {
  const p = correr(['seguridad'], maquina({ motor: false })).puertas[0];
  const c = ids(p);
  assert.equal(c.motor.estado, 'NO_INSTALADA');
  for (const id of ['sistema', 'escaneres', 'docker', 'programas', 'uaeh-conf']) assert.equal(c[id].estado, 'OMITIDA', id);
  assert.equal(p.estado, 'NO_INSTALADA');
  assert.equal(correr(['seguridad'], maquina()).puertas[0].estado, 'LISTA');
});

test('seguridad · un estado.sh que no termina es FALLÓ; una plataforma sin motor es NO_INSTALADA', () => {
  const corto = correr(['seguridad'], maquina({ estado: 'estado_version 1\n' })).puertas[0];
  assert.equal(ids(corto).escaneres.estado, 'FALLÓ');
  assert.equal(corto.estado, 'NO_LISTA');
  const mac = correr(['seguridad'], maquina({ modo: 'no-soportado' })).puertas[0];
  assert.equal(ids(mac).plataforma.estado, 'NO_INSTALADA');
  assert.equal(ids(mac).motor.estado, 'NO_APLICA');
});

test('seguridad · corridas sin --rapido: tamaño con el inventario de uaeh-runs', () => {
  const base = uaehConfig.runsDir();
  fs.mkdirSync(path.join(base, 'repo-x', 'run-1', 'fuente'), { recursive: true });
  fs.writeFileSync(path.join(base, 'repo-x', 'run-1', 'fuente', 'a.txt'), 'x'.repeat(1000));
  const c = ids(DP.ejecutar({ puertas: ['seguridad'], inyectar: maquina() }).puertas[0]);
  assert.equal(c.corridas.estado === 'OK' || c.corridas.estado === 'AVISO', true, c.corridas.detalle);
  assert.match(c.corridas.detalle, /1 corridas en 1 repos/);
});

// ── codex ─────────────────────────────────────────────────────────────────────────────────

function codexFalso({ version = '0.163.0', sesion = 0 } = {}) {
  const archivo = path.join(E.dir, `codex-falso-${version}-${sesion}.js`);
  fs.writeFileSync(archivo, `const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('codex-cli ${version}'); process.exit(0); }
if (a[0] === 'login' && a[1] === 'status') { console.log('Logged in using an API key - sk-proj-***'); process.exit(${sesion}); }
process.exit(9);\n`);
  return () => ({ cmd: process.execPath, prefijo: [archivo], origen: archivo });
}

test('codex · apagado por defecto: puerta APAGADA que no tumba el veredicto, y no se llama a Codex', () => {
  config(null);
  let llamado = false;
  const inf = correr(['codex'], maquina({ codex: () => { llamado = true; throw new Error('no'); } }));
  assert.equal(inf.puertas[0].estado, 'APAGADA');
  assert.equal(inf.veredicto, 'LISTA');
  assert.equal(llamado, false);
  for (const c of inf.puertas[0].comprobaciones) assert.equal(c.estado, 'NO_APLICA', c.id);
  assert.match(ids(inf.puertas[0]).consentimiento.detalle, /--consiento --aplicar/);
});

test('codex · habilitado sin CLI → NO_INSTALADA; con CLI y sesión: aislamiento nunca probado → AVISO', () => {
  config({ codex: { habilitado: true, consentimiento: '2026-11-05' } });
  const sin = correr(['codex'], maquina()).puertas[0];
  assert.equal(ids(sin).cli.estado, 'NO_INSTALADA');
  assert.equal(sin.estado, 'NO_INSTALADA');
  const con = correr(['codex'], maquina({ codex: codexFalso() })).puertas[0];
  const c = ids(con);
  assert.equal(c.consentimiento.estado, 'OK');
  assert.match(c.consentimiento.detalle, /2026-11-05/);
  assert.equal(c.cli.estado, 'OK');
  assert.equal(c.sesion.estado, 'OK');
  assert.doesNotMatch(c.sesion.detalle, /sk-/, 'nunca repite la salida de login status');
  assert.equal(c.aislamiento.estado, 'AVISO');
  assert.equal(con.estado, 'LISTA');
  assert.equal(ids(correr(['codex'], maquina({ codex: codexFalso({ sesion: 1 }) })).puertas[0]).sesion.estado, 'FALLÓ');
  assert.equal(ids(correr(['codex'], maquina({ codex: codexFalso({ version: '0.150.0' }) })).puertas[0]).cli.estado, 'AVISO');
});

test('codex · --vivo guarda el resultado del aislamiento; sin --vivo se recuerda y se invalida si Codex cambia', () => {
  config({ codex: { habilitado: true } });
  const cache = path.join(E.uaehHome, 'cache', 'doctor-ultimo.json');
  try { fs.unlinkSync(cache); } catch { /* no había */ }
  const real = (s, a, o) => {
    const r = spawnSync(process.execPath, [s, ...a], { encoding: 'utf8', input: o && o.input, env: o && o.env });
    return { codigo: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  let probo = 0;
  const node = (s, a, o) => (a[0] === '--probar-sandbox' ? (probo++, { codigo: 0, stdout: 'Variante [x]: …\nSANDBOX_OK\n', stderr: '' }) : real(s, a, o));
  const vivo = DP.ejecutar({ puertas: ['codex'], vivo: true, inyectar: maquina({ codex: codexFalso(), node }) }).puertas[0];
  assert.equal(probo, 1);
  assert.equal(ids(vivo).aislamiento.estado, 'OK');
  assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).codex.version, '0.163.0');
  assert.equal(ids(correr(['codex'], maquina({ codex: codexFalso(), node })).puertas[0]).aislamiento.estado, 'OK');
  assert.equal(probo, 1, 'sin --vivo no se gasta cuota');
  assert.equal(ids(correr(['codex'], maquina({ codex: codexFalso({ version: '0.170.0' }), node })).puertas[0]).aislamiento.estado, 'AVISO');
  const falla = (s, a, o) => (a[0] === '--probar-sandbox' ? { codigo: 1, stdout: 'SANDBOX_FALLA\n', stderr: '' } : real(s, a, o));
  assert.equal(ids(DP.ejecutar({ puertas: ['codex'], vivo: true, inyectar: maquina({ codex: codexFalso(), node: falla }) }).puertas[0]).aislamiento.estado, 'FALLÓ');
  assert.equal(ids(correr(['codex'], maquina({ codex: codexFalso(), node })).puertas[0]).aislamiento.estado, 'FALLÓ', 'la última prueba fallida se recuerda');
  config(null);
});

test('codex · --vivo que falla muestra TODAS las variantes (la primera de Windows falla a propósito) y un tope de 25 min', () => {
  config({ codex: { habilitado: true } });
  let tope = null;
  const salida = 'Variante [sin aislamiento]: PRUEBA.txt no existe; shell pudo LEER: NO; 0 comando(s) de shell; codigo 0\n' +
    'Variante [la decisiva]: PRUEBA.txt no existe; shell pudo LEER: NO; 1 comando(s) de shell (códigos 1); codigo 0\n' +
    'Variante [la decisiva] (intento 2): PRUEBA.txt no existe; shell pudo LEER: NO; 0 comando(s) de shell; codigo 0\nSANDBOX_FALLA\n';
  const node = (s, a, o) => (a[0] === '--probar-sandbox' ? (tope = o.segundos, { codigo: 1, stdout: salida, stderr: '' }) : { codigo: 0, stdout: '', stderr: '' });
  const c = ids(DP.ejecutar({ puertas: ['codex'], vivo: true, inyectar: maquina({ codex: codexFalso(), node }) }).puertas[0]).aislamiento;
  assert.equal(c.estado, 'FALLÓ');
  assert.match(c.detalle, /\[sin aislamiento\].*\[la decisiva\]: .*\(códigos 1\).*\(intento 2\)/);
  assert.equal(tope, 1500);
  config(null);
});

// ── visual ────────────────────────────────────────────────────────────────────────────────

test('visual · sin playwright-cli → NO_INSTALADA; otra versión → AVISO; config global → FALLÓ', () => {
  const sin = (p) => (p === 'playwright-cli' ? { codigo: 1, stdout: '', stderr: '', encontrado: false } : { codigo: 0, stdout: '', stderr: '', encontrado: true });
  const p = correr(['visual'], maquina({ comando: sin })).puertas[0];
  assert.equal(ids(p)['playwright-cli'].estado, 'NO_INSTALADA');
  assert.match(ids(p)['playwright-cli'].detalle, new RegExp(`@playwright/cli@${PINES.visual['@playwright/cli'].replace(/\./g, '\\.')}`));
  const otra = (q) => ({ codigo: 0, stdout: q === 'playwright-cli' ? '0.0.1\n' : '', stderr: '', encontrado: true });
  assert.equal(ids(correr(['visual'], maquina({ comando: otra })).puertas[0])['playwright-cli'].estado, 'AVISO');
  process.env.PLAYWRIGHT_MCP_PRUEBA = '1';
  try {
    const g = correr(['visual'], maquina()).puertas[0];
    assert.equal(ids(g)['config-global'].estado, 'FALLÓ');
    assert.equal(g.estado, 'NO_LISTA');
  } finally { delete process.env.PLAYWRIGHT_MCP_PRUEBA; }
  fs.mkdirSync(path.join(E.home, '.playwright'), { recursive: true });
  fs.writeFileSync(path.join(E.home, '.playwright', 'cli.config.json'), '{}');
  try { assert.equal(ids(correr(['visual'], maquina()).puertas[0])['config-global'].estado, 'FALLÓ'); }
  finally { fs.rmSync(path.join(E.home, '.playwright'), { recursive: true, force: true }); }
});

test('visual · el candado real del verificador de navegador niega «click» y deja «snapshot»; las guías íntegras', () => {
  const c = ids(DP.ejecutar({ puertas: ['visual'], inyectar: maquina() }).puertas[0]);
  assert.equal(c['candado-navegador'].estado, 'OK', c['candado-navegador'].detalle);
  assert.equal(c.guias.estado, 'OK');
  assert.ok(['OMITIDA', 'AVISO'].includes(c.autoprueba.estado), 'sin --vivo la autoprueba nunca es OK');
});

// ── preflight ─────────────────────────────────────────────────────────────────────────────

test('preflight · la autoprueba real de huella y sello pasa en un repo temporal y no toca la casa del usuario', (t) => {
  if (!requiereHerramienta(t, 'git')) return;
  config({ preflight: { jurisdiccion: 'Unión Europea' } });
  const antes = fs.readdirSync(E.uaehHome).sort();
  const p = DP.ejecutar({ puertas: ['preflight'], inyectar: maquina() }).puertas[0];
  const c = ids(p);
  assert.equal(c.huella.estado, 'OK', c.huella.detalle);
  assert.equal(c.skill.estado, 'OK');
  assert.equal(c.plantillas.estado, 'OK');
  assert.match(c.jurisdiccion.detalle, /Unión Europea/);
  assert.equal(p.estado, 'LISTA');
  assert.deepEqual(fs.readdirSync(E.uaehHome).sort(), antes, 'la autoprueba no escribe preflights.json en la casa');
  config(null);
});

test('CLI · --json parsea, código 0 con veredicto LISTA y 2 con uso incorrecto', () => {
  const script = path.join(RAIZ_HARNESS, 'scripts', 'doctor-puertas.cjs');
  const r = spawnSync(process.execPath, [script, '--puerta', 'preflight', '--rapido', '--json'], { encoding: 'utf8', env: E.env });
  assert.equal(r.status, 0, r.stderr);
  const inf = JSON.parse(r.stdout);
  assert.equal(inf.veredicto, 'LISTA');
  assert.deepEqual(inf.puertas.map((p) => p.puerta), ['preflight']);
  assert.equal(spawnSync(process.execPath, [script, '--puerta', 'nada'], { encoding: 'utf8', env: E.env }).status, 2);
  const humano = spawnSync(process.execPath, [script, '--puerta', 'preflight', '--rapido'], { encoding: 'utf8', env: E.env });
  assert.match(humano.stdout, /== preflight: LISTA/);
  assert.match(humano.stdout, /Veredicto: LISTA/);
});

test('estadoPuerta · FALLÓ gana a NO_INSTALADA, y AVISO u OMITIDA no impiden LISTA', () => {
  const ctx = DP.crearContexto({ inyectar: maquina() });
  const c = (...estados) => estados.map((estado, i) => ({ id: `c${i}`, estado, detalle: '' }));
  assert.equal(DP.estadoPuerta('seguridad', c('OK', 'AVISO', 'OMITIDA', 'NO_APLICA'), ctx), 'LISTA');
  assert.equal(DP.estadoPuerta('seguridad', c('OK', 'NO_INSTALADA'), ctx), 'NO_INSTALADA');
  assert.equal(DP.estadoPuerta('seguridad', c('NO_INSTALADA', 'FALLÓ'), ctx), 'NO_LISTA');
});

// ── wsl/estado.sh con un /opt/uaeh falso ──────────────────────────────────────────────────

test('estado.sh · compara lo instalado con el plugin (sin CR), lee uaeh.conf y las versiones, y termina con ESTADO_FIN', (t) => {
  const bash = requiereBash(t);
  if (!bash) return;
  const opt = path.join(E.dir, 'opt-uaeh');
  const bin = path.join(E.dir, 'bin-escaneres');
  for (const d of ['bin', 'contenedor', 'pruebas', 'validadores']) fs.mkdirSync(path.join(opt, d), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const copiarSinCR = (de, a) => fs.writeFileSync(a, fs.readFileSync(de, 'latin1').replace(/\r/g, ''), 'latin1');
  for (const d of ['bin', 'contenedor', 'pruebas']) for (const n of fs.readdirSync(path.join(WSL, d))) copiarSinCR(path.join(WSL, d, n), path.join(opt, d, n));
  fs.appendFileSync(path.join(opt, 'bin', 'uaeh-validar'), '\n# cambiado\n');
  fs.unlinkSync(path.join(opt, 'pruebas', fs.readdirSync(path.join(opt, 'pruebas'))[0]));
  fs.writeFileSync(path.join(opt, 'uaeh.conf'), '# conf\nUAEH_BASE=/mnt/x/runs\nUAEH_USER=alguien\n');
  fs.writeFileSync(path.join(bin, 'gitleaks'), '#!/bin/bash\necho 9.9.9\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'semgrep'), '#!/bin/bash\necho 1.2.3\n', { mode: 0o755 });
  const r = spawnSync(bash, [path.join(WSL, 'estado.sh').replace(/\\/g, '/')], { encoding: 'utf8', env: { ...E.env, UAEH_OPT: opt.replace(/\\/g, '/'), UAEH_BIN_ESCANERES: bin.replace(/\\/g, '/') }, timeout: 60000 });
  const e = DP.parsearEstado(r.stdout);
  assert.equal(e.completo, true, r.stdout + r.stderr);
  assert.equal(e.datos.get('gitleaks')[0], '9.9.9');
  assert.equal(e.datos.get('semgrep')[0], '1.2.3');
  assert.equal(e.datos.get('osv')[0], 'no');
  assert.equal(e.datos.get('conf_base')[0], '/mnt/x/runs');
  assert.equal(e.datos.get('conf_usuario')[0], 'alguien');
  assert.equal(e.datos.get('instalado')[0], 'no');
  const archivos = Object.fromEntries(e.datos.get('archivo').map((l) => { const [rel, est] = l.split(' '); return [rel, est]; }));
  assert.equal(archivos['bin/uaeh-sandbox'], 'igual');
  assert.equal(archivos['bin/uaeh-validar'], 'distinto');
  assert.equal(archivos[`pruebas/${fs.readdirSync(path.join(WSL, 'pruebas'))[0]}`], 'falta');
  assert.equal(archivos['validadores/validate-findings.cjs'], 'falta');
  assert.equal(Object.keys(archivos).filter((k) => k.startsWith('validadores/')).length, 5, 'la lista de validadores sale de instalar-bin.sh');
});
