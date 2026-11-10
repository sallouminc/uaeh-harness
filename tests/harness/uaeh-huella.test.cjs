// Pruebas de uaeh-huella.cjs (huella de la superficie de riesgo + sello de preflight) y de los contratos de
// uaeh-registro.cjs / uaeh-resumen.cjs que el flujo del preflight usa. Todo en una casa temporal (nunca el sistema real).
// Correr: node --test tests/harness/uaeh-huella.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../helpers/entorno.cjs');

const HUELLA = path.join(H.RAIZ_HARNESS, 'scripts', 'uaeh-huella.cjs');
const REGISTRO = path.join(H.RAIZ_HARNESS, 'scripts', 'uaeh-registro.cjs');
const RESUMEN = path.join(H.RAIZ_HARNESS, 'scripts', 'uaeh-resumen.cjs');
const MOD = require(HUELLA); // solo funciones puras (categoriasDe, alias, constantes): lo que toca git corre en procesos aparte

// Una etiqueta de zona cualquiera de un historial antiguo (la herramienta acepta la que sea al leer) y nombres de función que ya no existen.
const ZONA_VIEJA = 'Ciudad Ejemplo';
const NOMBRE_VIEJO_ISO = 'isoCiudadEjemplo';
const NOMBRE_VIEJO_LEGIBLE = 'legibleCiudadEjemplo';

// ---------------------------------------------------------------------------------------------------------- ayudas

// Casa temporal por prueba (UAEH_HOME, HOME, hora fija 2026-10-30T20:00:00Z y UAEH_TZ=UTC vienen de entornoTemporal()).
function casa(t, extra = {}) {
  const e = H.entornoTemporal('uaeh-huella-');
  H.gitConfigGlobal(e);
  t.after(() => e.limpiar());
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete e.env[k]; else e.env[k] = v; }
  return e;
}

// Corre un script y devuelve { code, out, err } recortados.
function node(script, args, e, extra) {
  const r = H.correr(script, args, { env: extra ? { ...e.env, ...extra } : e.env });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const huella = (e, args, extra) => node(HUELLA, args, e, extra);

function escribir(repo, rel, txt) {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, txt);
}

// El repo de demostración del origen: un manifiesto, auth, un .env de ejemplo y una ruta de API, con un commit.
function repoDemo(e, nombre = 'repo-demo') {
  const repo = H.repoTemporal(e, nombre, { inicial: false });
  escribir(repo, 'package.json', '{"name":"demo"}\n');
  escribir(repo, 'src/auth/login.ts', 'export const a = 1;\n');
  escribir(repo, '.env.example', 'API_KEY=abc\n');
  escribir(repo, 'app/api/x/route.ts', 'export async function GET() {}\n');
  H.git(repo, ['add', '-A'], e.env);
  H.git(repo, ['commit', '-q', '-m', 'inicial'], e.env);
  return repo;
}

const rutaSello = (repo) => path.join(repo, 'docs', 'harness', '.preflight.json');
const rutaInforme = (repo) => path.join(repo, 'docs', 'harness', 'AUDIT_REPORT.md');
const leerSello = (repo) => JSON.parse(fs.readFileSync(rutaSello(repo), 'utf8'));
const filasInforme = (repo) => fs.readFileSync(rutaInforme(repo), 'utf8').split('\n').filter((x) => /^\| \d{4}-/.test(x));
const vigia = (e, repo, extra) => huella(e, ['comparar', repo], extra).out;
const sellar = (e, repo, ...args) => huella(e, ['sellar', repo, ...args]);
const dias = (e, n) => new Date(Date.parse(e.env.UAEH_AHORA) + n * 86400000).toISOString();

// ---------------------------------------------------------------------------------------------------------- pruebas

test('1. sin sello: la línea del vigía dice «sin preflight» y no nombra a nadie ni una fecha', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  const l = vigia(e, repo);
  assert.match(l, /sin preflight/, l);
  assert.match(l, /solo se corre antes de lanzar o a pedido del usuario/, l);
  assert.doesNotMatch(l, /\d{4}-\d\d-\d\d/, 'sin fechas de calendario en el texto');
});

test('2. sellar completa/alto: sello, índice global, historial, campos con la zona y categorías detectadas', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  const s = sellar(e, repo, '--tipo', 'completa', '--riesgo', 'alto', '--nuevos', '3', '--cerrados', '1');
  assert.equal(s.code, 0, s.err);
  assert.ok(fs.existsSync(rutaSello(repo)), 'existe el sello');
  const indF = path.join(e.uaehHome, 'preflights.json');
  assert.ok(fs.existsSync(indF), 'existe el índice global');
  assert.ok(fs.existsSync(rutaInforme(repo)) && filasInforme(repo).length === 1, 'AUDIT_REPORT.md con 1 fila: ' + (fs.existsSync(rutaInforme(repo)) ? fs.readFileSync(rutaInforme(repo), 'utf8') : ''));
  const sello = leerSello(repo);
  assert.equal(sello.version, 1);
  assert.equal(sello.riesgo, 'alto');
  assert.equal(sello.vigencia_dias, 60);
  assert.equal(sello.tipo, 'completa');
  assert.equal(sello.fecha, '2026-10-30T20:00:00+00:00', 'fecha con el desfase de la zona efectiva (UAEH_TZ=UTC)');
  assert.equal(sello.fecha_legible, '2026-10-30 20:00 (UTC)', 'fecha legible con la zona entre paréntesis');
  assert.equal(sello.vence, '2026-12-29T20:00:00+00:00', 'vence a los 60 días');
  assert.equal(Object.keys(sello.huella).length, 7, JSON.stringify(sello));
  assert.deepEqual(sello.categorias_auditadas, MOD.CATEGORIAS, 'una corrida completa audita todas las categorías');
  assert.ok(sello.huella.auth !== 'vacio' && sello.huella.env !== 'vacio' && sello.huella.rutas !== 'vacio' && sello.huella.manifiestos !== 'vacio'
    && sello.huella.esquema === 'vacio' && sello.huella.visual === 'vacio', 'categorías detectadas / vacías como se espera: ' + JSON.stringify(sello.huella));
  const indice = JSON.parse(fs.readFileSync(indF, 'utf8'));
  assert.equal(Object.values(indice)[0].fecha_legible, '2026-10-30 20:00 (UTC)');
  assert.equal(Object.values(indice)[0].abiertos, 0);
  const fila = filasInforme(repo)[0];
  assert.match(fila, /^\| 2026-10-30 20:00 \(UTC\) \| completa \| [0-9a-f]+ \| 3 \| 1 \| manifiestos, esquema, auth, env, despliegue, rutas, visual \|$/, fila);
  const l = vigia(e, repo);
  assert.ok(/vigente/.test(l) && /NO repetir/.test(l), 'después de sellar: «vigente»: ' + l);
  assert.match(l, /preflight vigente del 2026-10-30 20:00 \(UTC\)/, l);
  // Ni el sello, ni el índice ni el historial llevan el nombre histórico de la zona.
  for (const texto of [fs.readFileSync(rutaSello(repo), 'utf8'), fs.readFileSync(indF, 'utf8'), fs.readFileSync(rutaInforme(repo), 'utf8')]) {
    assert.ok(!texto.includes(ZONA_VIEJA), 'sin el nombre histórico de la zona');
  }
  assert.ok(fs.readFileSync(rutaInforme(repo), 'utf8').includes(MOD.CABECERA_TABLA), 'el historial nuevo usa la cabecera «(zona)»');
});

test('3/4. editar auth y agregar una variable a .env.example: la línea dice qué cambió y nunca aparece un valor', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  assert.equal(sellar(e, repo, '--tipo', 'completa', '--riesgo', 'alto', '--nuevos', '3', '--cerrados', '1').code, 0);
  escribir(repo, 'src/auth/login.ts', 'export const a = 2;\n');
  let l = vigia(e, repo);
  assert.ok(/cambió auth\b/.test(l) && !/env/.test(l), 'cambió auth: ' + l);
  fs.appendFileSync(path.join(repo, '.env.example'), 'NEW_SECRET=1\n');
  l = vigia(e, repo);
  assert.ok(/cambió auth, env/.test(l), 'cambió auth, env: ' + l);
  const textoSello = fs.readFileSync(rutaSello(repo), 'utf8') + fs.readFileSync(path.join(e.uaehHome, 'preflights.json'), 'utf8');
  assert.ok(!/abc/.test(textoSello) && !/"1"/.test(textoSello) && !/NEW_SECRET=1/.test(textoSello), 'ningún valor aparece en sello ni índice');
  const hj = huella(e, ['huella', repo]);
  assert.ok(!/abc|NEW_SECRET/.test(hj.out), 'la salida de huella no contiene valores ni nombres');
  const datos = JSON.parse(hj.out);
  assert.deepEqual(Object.keys(datos.huella), MOD.CATEGORIAS);
  assert.equal(datos.conteos.env, 2, 'nombres de variables contadas (API_KEY y NEW_SECRET), nunca sus valores');
});

test('5/8. incremental: conserva o fija hallazgos, audita lo que cambió, suma filas y vence a los 60 días', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  sellar(e, repo, '--tipo', 'completa', '--riesgo', 'alto');
  escribir(repo, 'src/auth/login.ts', 'export const a = 2;\n');
  fs.appendFileSync(path.join(repo, '.env.example'), 'NEW_SECRET=1\n');
  const s2 = sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'alto', '--hallazgos', 'H1,H2');
  assert.equal(s2.code, 0, s2.err);
  assert.equal(filasInforme(repo).length, 2, '8. segunda fila en el historial');
  const sello2 = leerSello(repo);
  assert.ok(sello2.hallazgos_abiertos.join() === 'H1,H2' && sello2.categorias_auditadas.join() === 'auth,env', 'hallazgos y categorías auditadas: ' + JSON.stringify(sello2));
  // incremental sin --hallazgos conserva los previos
  sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'alto');
  assert.equal(leerSello(repo).hallazgos_abiertos.join(), 'H1,H2', 'incremental conserva hallazgos previos');
  assert.equal(filasInforme(repo).length, 3, 'tercera fila al sellar de nuevo');
  let l = vigia(e, repo, { UAEH_AHORA: dias(e, 61) });
  assert.match(l, /vencido \(riesgo alto, 60 días\)/, l);
  l = vigia(e, repo, { UAEH_AHORA: dias(e, 30) });
  assert.match(l, /vigente/, l);
  // vencido y con cambios
  escribir(repo, 'vercel.json', '{}\n');
  l = vigia(e, repo, { UAEH_AHORA: dias(e, 61) });
  assert.ok(/vencido/.test(l) && /despliegue/.test(l), 'vencido y con cambios combina ambos: ' + l);
});

test('vigencia por riesgo: crítico 30 días, alto 60, medio y bajo 90', (t) => {
  assert.deepEqual(MOD.VIGENCIA, { critico: 30, alto: 60, medio: 90, bajo: 90 });
  const e = casa(t);
  const repo = repoDemo(e);
  for (const [riesgo, d] of [['critico', 30], ['medio', 90], ['bajo', 90]]) {
    assert.equal(sellar(e, repo, '--tipo', 'completa', '--riesgo', riesgo).code, 0);
    const sello = leerSello(repo);
    assert.equal(sello.vigencia_dias, d, riesgo);
    assert.equal(sello.vence, MOD.isoZona(new Date(Date.parse(e.env.UAEH_AHORA) + d * 86400000), 'UTC'), riesgo);
  }
});

test('categoría visual: categoriasDe y cambios de DESIGN.md versionados', (t) => {
  assert.ok(MOD.categoriasDe('DESIGN.md').includes('visual'), 'DESIGN.md -> visual');
  assert.ok(MOD.categoriasDe('apps/web/DESIGN.md').includes('visual'), 'apps/web/DESIGN.md -> visual');
  assert.ok(MOD.categoriasDe('tests/visual/home.spec.ts-snapshots/home-movil-360-win32.png').includes('visual'), 'snapshot de Playwright -> visual');
  assert.ok(MOD.categoriasDe('tests/visual/home.spec.ts').includes('visual'), 'tests/visual/*.spec.ts -> visual');
  assert.ok(!MOD.categoriasDe('src/api/usuarios.ts').includes('visual'), 'src/api/usuarios.ts no es visual');
  assert.ok(!MOD.categoriasDe('reports/visual-audit/x.png').includes('visual'), 'reports/visual-audit/x.png no es visual');
  const e = casa(t);
  const repo = repoDemo(e);
  sellar(e, repo, '--tipo', 'completa', '--riesgo', 'alto');
  escribir(repo, 'DESIGN.md', '# Diseño\n');
  H.git(repo, ['add', 'DESIGN.md'], e.env);
  H.git(repo, ['commit', '-q', '-m', 'design'], e.env);
  let l = vigia(e, repo);
  assert.ok(/cambió visual/.test(l) && !/auth/.test(l), 'crear DESIGN.md y commitear: cambió visual, sin auth: ' + l);
  sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'alto');
  escribir(repo, 'DESIGN.md', '# Diseño\ncolor: hueso\n');
  H.git(repo, ['add', 'DESIGN.md'], e.env);
  H.git(repo, ['commit', '-q', '-m', 'design 2'], e.env);
  l = vigia(e, repo);
  assert.ok(/cambió visual/.test(l) && !/auth/.test(l), 'editar DESIGN.md y commitear: cambió visual, sin auth: ' + l);
});

test('sello ilegible: la línea lo dice y se trata como sin preflight', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  sellar(e, repo, '--tipo', 'completa', '--riesgo', 'alto');
  const respaldo = fs.readFileSync(rutaSello(repo), 'utf8');
  fs.writeFileSync(rutaSello(repo), '{no es json');
  assert.match(vigia(e, repo), /ilegible/);
  fs.writeFileSync(rutaSello(repo), JSON.stringify({ version: 1, huella: {} }));
  assert.match(vigia(e, repo), /ilegible/, 'un sello sin fecha ni vencimiento tampoco sirve');
  fs.writeFileSync(rutaSello(repo), respaldo);
  assert.match(vigia(e, repo), /vigente/);
});

test('6. sin git: el CLI imprime «sin git» y sale 0; lineaVigia da vacío, también en la carpeta de usuario', (t) => {
  const e = casa(t);
  const sinGit = path.join(e.dir, 'sin-git');
  fs.mkdirSync(sinGit, { recursive: true });
  const rs = huella(e, ['comparar', sinGit]);
  assert.ok(rs.code === 0 && /sin git/.test(rs.out), 'CLI sin git imprime "sin git" y sale 0: ' + rs.out);
  const linea = (dir, extra) => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).lineaVigia(process.argv[2])))', HUELLA, dir],
      { env: { ...e.env, ...extra }, encoding: 'utf8', cwd: e.dir });
    return JSON.parse(r.stdout);
  };
  assert.equal(linea(sinGit), '', 'lineaVigia(sin git) === ""');
  // La carpeta de usuario, aunque sea un repo (p. ej. con los archivos de configuración versionados), no lleva línea del vigía.
  const repoEnCasa = H.repoTemporal(e, 'otro-repo');
  assert.match(linea(repoEnCasa), /sin preflight/, 'control: un repo cualquiera sí lleva línea');
  H.git(e.home, ['init', '-q'], e.env);
  assert.equal(linea(e.home), '', 'lineaVigia(carpeta de usuario) === ""');
  // La excepción depende de cuál es la carpeta de usuario: con otra, ese mismo repo sí lleva línea.
  assert.match(linea(e.home, { HOME: e.dir, USERPROFILE: e.dir }), /sin preflight/, 'con otra carpeta de usuario, el repo de antes sí lleva línea');
});

test('argumentos inválidos: salida 1 con mensaje', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  assert.equal(huella(e, ['sellar', repo, '--tipo', 'x', '--riesgo', 'alto']).code, 1, 'tipo inválido -> 1');
  assert.equal(huella(e, ['sellar', repo, '--tipo', 'completa']).code, 1, 'falta riesgo -> 1');
  assert.equal(huella(e, ['sellar', repo, '--riesgo', 'alto']).code, 1, 'falta tipo -> 1');
  assert.equal(huella(e, ['sellar', repo, '--tipo', 'completa', '--riesgo', 'enorme']).code, 1, 'riesgo inválido -> 1');
  assert.equal(huella(e, ['sellar', repo, '--tipo', 'completa', '--riesgo', 'alto', '--categorias', 'auth,nada']).code, 1, 'categoría desconocida -> 1');
  assert.equal(huella(e, ['sellar', repo, '--tipo', 'completa', '--riesgo', 'alto', '--nuevos', 'x']).code, 1, '--nuevos no entero -> 1');
  assert.equal(huella(e, ['huella']).code, 1, 'falta dir -> 1');
  assert.equal(huella(e, ['bailar', repo]).code, 1, 'comando inválido -> 1');
  assert.equal(huella(e, ['huella', path.join(e.dir, 'no-existe')]).code, 1, 'carpeta inexistente -> 1');
  assert.ok(!fs.existsSync(rutaSello(repo)), 'los inválidos no sellaron nada');
});

test('7. longitud: todas las líneas del vigía miden como máximo 240 caracteres', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  const lineas = [vigia(e, repo)];
  sellar(e, repo, '--tipo', 'completa', '--riesgo', 'critico');
  lineas.push(vigia(e, repo));
  // Todas las categorías cambian y el sello está vencido: la línea más larga posible.
  for (const [rel, txt] of [['package.json', '{"name":"otro"}\n'], ['migrations/001.sql', 'x\n'], ['src/auth/login.ts', 'b\n'], ['vercel.json', '{}\n'], ['routes/a.ts', 'x\n'], ['DESIGN.md', 'x\n']]) escribir(repo, rel, txt);
  fs.appendFileSync(path.join(repo, '.env.example'), 'OTRA=1\n');
  lineas.push(vigia(e, repo, { UAEH_AHORA: dias(e, 61) }));
  // Nombre largo pero dentro del MAX_PATH de Windows (260) contando los ~60 caracteres de .git/objects/xx/<hash>:
  // lo que sobra tras la casa temporal, entre 40 y 130.
  const largo = H.repoTemporal(e, 'x'.repeat(Math.max(40, Math.min(130, 180 - e.dir.length))) + '-repo');
  lineas.push(vigia(e, largo));
  assert.ok(lineas.length >= 4 && lineas.every((x) => x.length > 0 && x.length <= 240), 'todas las líneas <= 240: ' + lineas.map((x) => x.length).join(','));
  assert.ok(/cambió manifiestos, esquema, auth, env, despliegue, rutas, visual/.test(lineas[2]) || lineas[2].endsWith('…'), lineas[2]);
});

test('9. registro y resumen: validaciones, filas JSON y resumen', (t) => {
  const e = casa(t);
  const R = (ruta, riesgo, ciclos, estado, extra) => node(REGISTRO, ['--proyecto', 'p', '--ruta', ruta, '--riesgo', riesgo, '--ciclos', String(ciclos), '--estado', estado, ...(extra || [])], e);
  assert.equal(R('mala', 'alto', 1, 'FAIL').code, 1, 'ruta inválida -> 1');
  assert.equal(R('quick', 'alto', 1, 'NOPE').code, 1, 'estado inválido -> 1');
  assert.equal(R('quick', 'alto', 'x', 'FAIL').code, 1, 'ciclos inválido -> 1');
  assert.equal(R('quick', 'alto', 1, 'FAIL', ['--tarea', 'x'.repeat(121)]).code, 1, 'tarea > 120 -> 1');
  assert.equal(R('quick', 'alto', 1, 'FAIL', ['--visual', 'zzz']).code, 1, 'visual inválido -> 1');
  const regF = path.join(e.uaehHome, 'registro.jsonl');
  assert.equal(node(RESUMEN, ['30'], e).out, 'sin tareas registradas', 'resumen sin registro');
  assert.ok(!fs.existsSync(regF), 'los inválidos no escribieron nada');
  assert.equal(R('quick', 'bajo', 1, 'PASS_TECHNICAL', ['--escalamiento', 'ninguno']).code, 0, 'registro válido 1');
  assert.equal(R('build', 'medio', 3, 'FAIL', ['--escalamiento', 'a opus', '--visual', 'product-ui', '--tarea', 'arreglar login']).code, 0, 'registro válido 2');
  assert.equal(R('build', 'alto', 2, 'PASS_RELEASE_READY', ['--escalamiento', 'ninguno']).code, 0, 'registro válido 3');
  assert.equal(R('deep', 'critico', 4, 'UNKNOWN', ['--escalamiento', 'ninguno']).code, 0, 'registro válido 4');
  const reg = fs.readFileSync(regF, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.ok(reg.length === 4 && /\+00:00$/.test(reg[0].fecha) && reg[0].escalamiento === 'ninguno' && reg[1].tarea === 'arreglar login', 'el registro tiene 4 líneas JSON correctas');
  const res = node(RESUMEN, ['30'], e).out;
  assert.ok(/Total de tareas: 4/.test(res) && /quick 1/.test(res) && /build 2/.test(res) && /deep 1/.test(res), 'resumen: total y por ruta: ' + res);
  assert.ok(/2\/4 = 50\.0 %/.test(res) && /1\/4 = 25\.0 %/.test(res) && /UNKNOWN: 1/.test(res) && /build: 2\.50/.test(res), 'resumen: PASS, escalamiento, UNKNOWN y ciclos: ' + res);
  assert.equal(node(RESUMEN, ['abc'], e).code, 1, 'resumen con días inválido -> 1');
  assert.equal(node(RESUMEN, ['1'], e, { UAEH_AHORA: dias(e, 5) }).out, 'sin tareas registradas', 'resumen respeta la ventana de días');
});

// ------------------------------------------------------------------------------ la zona, el alias y los sellos viejos

test('las fechas del sello usan la zona efectiva: UAEH_TZ, zonaHoraria de la configuración o la del sistema', (t) => {
  const ahora = '2026-11-15T18:00:00Z';
  const mx = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: 'America/Mexico_City' });
  const repo = repoDemo(mx);
  assert.equal(sellar(mx, repo, '--tipo', 'completa', '--riesgo', 'alto').code, 0);
  const sello = leerSello(repo);
  assert.equal(sello.fecha, '2026-11-15T12:00:00-06:00');
  assert.equal(sello.fecha_legible, '2026-11-15 12:00 (America/Mexico_City)');
  assert.equal(sello.vence, '2027-01-14T12:00:00-06:00', 'el vencimiento lleva el mismo desfase');
  assert.match(filasInforme(repo)[0], /^\| 2026-11-15 12:00 \(America\/Mexico_City\) \| completa \|/);
  assert.match(vigia(mx, repo), /preflight vigente del 2026-11-15 12:00 \(America\/Mexico_City\)/);
  // Solo la configuración (sin UAEH_TZ).
  const cfg = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: undefined });
  cfg.escribir(path.join(cfg.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'Asia/Tokyo' }));
  const repo2 = repoDemo(cfg);
  assert.equal(sellar(cfg, repo2, '--tipo', 'completa', '--riesgo', 'bajo').code, 0);
  assert.equal(leerSello(repo2).fecha, '2026-11-16T03:00:00+09:00', 'zonaHoraria de uaeh.config.json');
  assert.equal(leerSello(repo2).fecha_legible, '2026-11-16 03:00 (Asia/Tokyo)');
  // UAEH_TZ gana a la configuración.
  const ambas = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: 'UTC' });
  ambas.escribir(path.join(ambas.uaehHome, 'uaeh.config.json'), JSON.stringify({ zonaHoraria: 'Asia/Tokyo' }));
  const repo3 = repoDemo(ambas);
  sellar(ambas, repo3, '--tipo', 'completa', '--riesgo', 'bajo');
  assert.equal(leerSello(repo3).fecha, '2026-11-15T18:00:00+00:00', 'UAEH_TZ gana');
  // Sin ninguna: la zona del sistema, con algún desfase.
  const sis = casa(t, { UAEH_AHORA: ahora, UAEH_TZ: undefined });
  const repo4 = repoDemo(sis);
  sellar(sis, repo4, '--tipo', 'completa', '--riesgo', 'bajo');
  assert.match(leerSello(repo4).fecha, /^2026-11-1[56]T\d\d:00:00[+-]\d\d:\d\d$/);
  assert.match(leerSello(repo4).fecha_legible, /^2026-11-1[56] \d\d:00 \(.+\)$/);
});

test('isoZona y legibleZona se exportan con zona explícita, y los nombres históricos con zona fija ya no existen', () => {
  const d = new Date('2026-11-15T18:00:00Z');
  assert.equal(MOD.isoZona(d, 'UTC'), '2026-11-15T18:00:00+00:00');
  assert.equal(MOD.isoZona(d, 'America/Mexico_City'), '2026-11-15T12:00:00-06:00');
  assert.equal(MOD.legibleZona(d, 'UTC'), '2026-11-15 18:00 (UTC)');
  assert.equal(MOD.legibleZona(d, 'Asia/Tokyo'), '2026-11-16 03:00 (Asia/Tokyo)');
  // Los nombres históricos (con la zona fija del autor) ya no se exportan: nada en el plugin los importa y el nombre
  // dispara la lista negra de publicación. Lo que se exporta es isoZona/legibleZona con la zona configurable.
  assert.equal(MOD[NOMBRE_VIEJO_ISO], undefined, 'el nombre histórico de isoZona ya no se exporta');
  assert.equal(MOD[NOMBRE_VIEJO_LEGIBLE], undefined, 'el nombre histórico de legibleZona ya no se exporta');
  assert.equal(typeof MOD.isoZona, 'function');
  assert.equal(typeof MOD.legibleZona, 'function');
  assert.equal(MOD.isoZona(d, 'Asia/Tokyo'), MOD.isoZona(d, 'Asia/Tokyo'));
  assert.equal(typeof MOD.ahora, 'function');
  assert.equal(typeof MOD.uaehHome, 'function');
});

test('un historial con la cabecera vieja «(zona histórica)» se lee: la fila nueva entra en SU tabla', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  const cabeceraVieja = `| Fecha y hora (${ZONA_VIEJA}) | Tipo | Commit | Nuevos | Cerrados | Categorías auditadas |`;
  assert.match(cabeceraVieja, MOD.RE_CABECERA_TABLA, 'la expresión acepta la cabecera vieja');
  assert.match(MOD.CABECERA_TABLA, MOD.RE_CABECERA_TABLA, 'y la cabecera nueva');
  assert.doesNotMatch('| Fecha | Tipo |', MOD.RE_CABECERA_TABLA, 'pero no cualquier tabla');
  assert.doesNotMatch('| Otra cosa (zona) | Tipo |', MOD.RE_CABECERA_TABLA);
  fs.mkdirSync(path.dirname(rutaInforme(repo)), { recursive: true });
  fs.writeFileSync(rutaInforme(repo), [
    '# Informe de auditoría', '', '## Historial de corridas', '', cabeceraVieja, '|---|---|---|---|---|---|',
    '| 2026-10-17 12:00 | completa | abc1234 | 3 | 0 | manifiestos, esquema, auth, env, despliegue, rutas, visual |', '', '## Otra sección', '', 'texto', '',
  ].join('\n'));
  assert.equal(sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'alto').code, 0);
  const lineas = fs.readFileSync(rutaInforme(repo), 'utf8').split('\n');
  assert.equal(lineas.filter((l) => MOD.RE_CABECERA_TABLA.test(l)).length, 1, 'no se creó una segunda tabla: sigue habiendo una sola cabecera');
  const iVieja = lineas.findIndex((l) => l.startsWith('| 2026-10-17 12:00'));
  assert.ok(iVieja > 0, 'la fila vieja sigue');
  assert.match(lineas[iVieja + 1], /^\| 2026-10-30 20:00 \(UTC\) \| incremental \|/, 'la fila nueva queda justo después, en la misma tabla');
  assert.ok(lineas.includes('## Otra sección') && lineas.includes('texto'), 'el resto del informe queda intacto');
  assert.equal(filasInforme(repo).length, 2);
});

test('una tabla AJENA bajo «Historial de corridas» (otras columnas) queda intacta: la nuestra va primero y la siguiente fila entra en la nuestra', (t) => {
  // Caso medido en la prueba en vivo del preflight (F2): el modelo redactó su propia tabla con «Riesgo» y la fila del sello
  // quedó debajo, con las columnas corridas.
  const e = casa(t);
  const repo = repoDemo(e);
  const ajena = ['| Fecha | Tipo | Riesgo | Hallazgos abiertos | Nuevos | Cerrados |', '|---|---|---|---|---|---|', '| 2026-11-04 | completa | alto | 8 | 8 | 0 |'];
  for (const pegada of [false, true]) {
    fs.mkdirSync(path.dirname(rutaInforme(repo)), { recursive: true });
    fs.writeFileSync(rutaInforme(repo), ['# Informe de auditoría', '', '## Historial de corridas', ...(pegada ? [] : ['']), ...ajena, '', '## Otra sección', 'texto', ''].join('\n'));
    assert.equal(sellar(e, repo, '--tipo', 'completa', '--riesgo', 'alto').code, 0);
    assert.equal(sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'alto').code, 0);
    const lineas = fs.readFileSync(rutaInforme(repo), 'utf8').split('\n');
    const iNuestra = lineas.findIndex((l) => MOD.RE_CABECERA_TABLA.test(l));
    const iAjena = lineas.indexOf(ajena[0]);
    assert.ok(iNuestra > lineas.indexOf('## Historial de corridas') && iNuestra < iAjena, `pegada=${pegada}: nuestra tabla va antes que la ajena`);
    assert.match(lineas[iNuestra + 2], /^\| 2026-10-30 20:00 \(UTC\) \| completa \|/);
    assert.match(lineas[iNuestra + 3], /^\| 2026-10-30 20:00 \(UTC\) \| incremental \|/, `pegada=${pegada}: la segunda fila entra en nuestra tabla`);
    assert.equal(lineas[iNuestra + 4], '', `pegada=${pegada}: una línea en blanco separa las dos tablas`);
    assert.deepEqual(lineas.slice(iAjena, iAjena + 3), ajena, 'la tabla ajena queda intacta');
    assert.ok(lineas.includes('## Otra sección') && lineas.includes('texto'));
  }
});

test('texto bajo «Historial de corridas» (un marcador escrito a mano) · la tabla va primero, separada por una línea en blanco', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  fs.mkdirSync(path.dirname(rutaInforme(repo)), { recursive: true });
  fs.writeFileSync(rutaInforme(repo), ['# Informe', '', '## Historial de corridas', '(la escribe el sello)', ''].join('\n'));
  assert.equal(sellar(e, repo, '--tipo', 'completa', '--riesgo', 'medio').code, 0);
  assert.equal(sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'medio').code, 0);
  const lineas = fs.readFileSync(rutaInforme(repo), 'utf8').split('\n');
  const i = lineas.findIndex((l) => MOD.RE_CABECERA_TABLA.test(l));
  assert.equal(lineas[i - 1], '');
  assert.match(lineas[i + 2], /\| completa \|/);
  assert.match(lineas[i + 3], /\| incremental \|/);
  assert.equal(lineas[i + 4], '', 'una línea en blanco antes del texto: si no, Markdown lo lee como otra fila');
  assert.equal(lineas[i + 5], '(la escribe el sello)');
});

test('un sello escrito por una versión anterior (fecha sin zona, desfase fijo) sigue leyéndose', (t) => {
  const e = casa(t);
  const repo = repoDemo(e);
  const h = JSON.parse(huella(e, ['huella', repo]).out);
  fs.mkdirSync(path.dirname(rutaSello(repo)), { recursive: true });
  fs.writeFileSync(rutaSello(repo), JSON.stringify({
    version: 1, proyecto: 'repo-demo', fecha: '2026-10-17T12:00:00-05:00', fecha_legible: '2026-10-17 12:00', commit: h.commit, tipo: 'completa',
    riesgo: 'alto', vigencia_dias: 60, vence: '2026-12-16T12:00:00-05:00', huella: h.huella, hallazgos_abiertos: ['H9'], categorias_auditadas: MOD.CATEGORIAS,
  }, null, 2));
  assert.match(vigia(e, repo), /preflight vigente del 2026-10-17 12:00 \(commit [0-9a-f]+\)/, 'se lee tal cual');
  escribir(repo, 'src/auth/login.ts', 'export const a = 3;\n');
  assert.match(vigia(e, repo), /desde el preflight del 2026-10-17 12:00 cambió auth/);
  // Un sello incremental encima conserva los hallazgos abiertos del viejo.
  assert.equal(sellar(e, repo, '--tipo', 'incremental', '--riesgo', 'alto').code, 0);
  assert.deepEqual(leerSello(repo).hallazgos_abiertos, ['H9']);
  assert.equal(leerSello(repo).fecha_legible, '2026-10-30 20:00 (UTC)');
});
