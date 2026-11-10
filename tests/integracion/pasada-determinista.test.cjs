// Integración de pasada-determinista.cjs con los escáneres REALES (gitleaks, semgrep, osv-scanner en el motor de
// Linux, cyber-neo con Python, npm audit). Fuera de la batería normal:
//
//   node tools/correr-pruebas.cjs --solo integracion
//
// Necesita la capa 3 instalada: el motor de Linux (WSL2 en Windows, directo en Linux) con los escáneres en
// /usr/local/bin y las reglas en /opt/uaeh/reglas. En Windows, si la distro no se llama como la de fábrica de
// lib/config.cjs, exporta UAEH_WSL_DISTRO (y UAEH_WSL_USER si hace falta) antes de correrla.
// Sin motor: todo el grupo se omite con «SIN MOTOR: <motivo>»; con UAEH_INTEGRACION=1 (el trabajo linux-integracion
// de CI) es FALLO. osv-scanner y npm audit necesitan red: sin red esas dos comprobaciones se omiten con el motivo.
'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal } = require('../helpers/entorno.cjs');

const SCRIPT = path.join(RAIZ_HARNESS, 'skills', 'uae-security', 'scripts', 'pasada-determinista.cjs');
const configLib = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'config.cjs'));
const runner = require(path.join(RAIZ_HARNESS, 'scripts', 'lib', 'runner.cjs'));

const E = entornoTemporal('uaeh-pasada-int-');
process.on('exit', () => E.limpiar());
// La distro y el usuario de WSL de quien corre la prueba (la casa temporal no tiene configuración).
const ENV = { ...E.env };
for (const k of ['UAEH_WSL_DISTRO', 'UAEH_WSL_USER']) if (process.env[k]) ENV[k] = process.env[k];

function motivoSinMotor() {
  const cfg = configLib.cargarConfig({ env: ENV }).config;
  const m = runner.motorListo(cfg);
  if (!m.listo) return `SIN MOTOR: ${m.detalle}`;
  for (const [bin, args] of [['/usr/local/bin/gitleaks', ['version']], ['/usr/local/bin/semgrep', ['--version']], ['/usr/local/bin/osv-scanner', ['--version']],
    ['/usr/bin/test', ['-d', '/opt/uaeh/reglas/semgrep/vigente']], ['/usr/bin/test', ['-f', '/opt/uaeh/reglas/gitleaks/vigente.toml']]]) {
    const r = runner.ejecutarEnLinux([bin, ...args], { segundos: 90 }, cfg);
    if (r.codigo !== 0) {
      const ultima = `${r.stderr || ''}\n${r.stdout || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
      return `SIN MOTOR: ${bin} ${args.join(' ')} falló (código ${r.codigo}) en ${m.detalle}${ultima ? ` — ${ultima.slice(0, 300)}` : ''}`;
    }
  }
  if (!runner.comandoPython()) return 'SIN MOTOR: falta Python 3 en el equipo';
  return null;
}
const MOTIVO = motivoSinMotor();

if (MOTIVO && process.env.UAEH_INTEGRACION === '1') {
  test('integración obligatoria (UAEH_INTEGRACION=1): el motor de Linux y los escáneres responden', () => assert.fail(MOTIVO));
}

function aleatorio(n) {
  const abc = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', shell: false, env: ENV });
  assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout;
}
function hayRed() {
  return new Promise((res) => {
    const req = https.get('https://api.osv.dev/v1/vulns/GHSA-29mw-wpgm-hmr9', { timeout: 6000 }, (r) => { r.resume(); res(r.statusCode > 0); });
    req.on('timeout', () => { req.destroy(); res(false); });
    req.on('error', () => res(false));
  });
}
function correr(repo, run, extra = [], envExtra = {}) {
  return spawnSync(process.execPath, [SCRIPT, repo, run, ...extra], { encoding: 'utf8', shell: false, env: { ...ENV, ...envExtra }, timeout: 20 * 60 * 1000 });
}

describe('pasada completa sobre un repo de juguete (escáneres reales)', { skip: MOTIVO || false }, () => {
  let repo, runA, runB, token, commit1, salidaA, jsonA, jsonB, red, salidaB;

  before(async () => {
    red = await hayRed();
    if (!red) console.error('AVISO: SIN RED. Las comprobaciones de osv-scanner y npm audit NO se pueden verificar.');
    repo = path.join(E.dir, 'repo');
    runA = path.join(E.dir, 'corridas', 'run-A');
    runB = path.join(E.dir, 'corridas', 'run-B');
    fs.mkdirSync(repo, { recursive: true });
    token = 'gh' + 'p_' + aleatorio(36);
    fs.writeFileSync(path.join(repo, 'server.js'),
      "const express = require('express');\nconst { exec } = require('child_process');\nconst app = express();\n" +
      "app.get('/a', (req, res) => { res.send(String(eval(req.query.x))); });\n" +
      "app.get('/b', (req, res) => { exec(req.query.cmd, (e, out) => res.send(out)); });\napp.listen(3000);\n");
    fs.writeFileSync(path.join(repo, 'config.js'), "module.exports = { githubToken: '" + token + "' };\n");
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'juguete', version: '1.0.0', dependencies: { express: '^4.18.0', lodash: '4.17.15' } }, null, 2));
    fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
      name: 'juguete', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'juguete', version: '1.0.0', dependencies: { lodash: '4.17.15' } },
        'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz', license: 'MIT' },
      },
    }, null, 2));
    fs.writeFileSync(path.join(repo, '.env.example'), 'SECRETO=ejemplo\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignorado.log\n');
    // Configs hostiles del repo: intentan apagar los escáneres. Deben ignorarse.
    fs.writeFileSync(path.join(repo, '.gitleaks.toml'), "[allowlist]\npaths = ['''.*''']\n");
    fs.writeFileSync(path.join(repo, '.semgrepignore'), 'server.js\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'inicial');
    commit1 = git(repo, 'rev-parse', 'HEAD').trim();
    // Sin comitear: .env real y archivo ignorado.
    fs.writeFileSync(path.join(repo, '.gitleaksignore'), commit1 + ':config.js:github-pat:1\nconfig.js:github-pat:1\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=xyz\n');
    fs.writeFileSync(path.join(repo, 'ignorado.log'), 'no debe copiarse\n');

    const r = correr(repo, runA, [], { UAEH_TZ: 'America/Bogota' });
    salidaA = r.stdout + r.stderr;
    assert.ok([0, 3].includes(r.status), 'código inesperado ' + r.status + ': ' + salidaA);
    jsonA = JSON.parse(fs.readFileSync(path.join(runA, 'deterministico.json'), 'utf8'));
  });

  after(() => { /* E.limpiar() al salir */ });

  const herr = (j, n) => j.herramientas.find((h) => h.nombre === n);

  test('la copia no contiene .env ni archivos ignorados, y sí .env.example; hora en la zona configurada', () => {
    const f = path.join(runA, 'fuente');
    assert.ok(!fs.existsSync(path.join(f, '.env')));
    assert.ok(!fs.existsSync(path.join(f, 'ignorado.log')));
    assert.ok(fs.existsSync(path.join(f, '.env.example')));
    assert.ok(fs.existsSync(path.join(f, 'server.js')));
    const meta = JSON.parse(fs.readFileSync(path.join(runA, 'fuente.json'), 'utf8'));
    assert.equal(meta.commit, commit1);
    assert.equal(meta.sucio, true);
    assert.ok(meta.omitidos.some((o) => o.ruta === '.env'));
    assert.match(meta.sha256_lista, /^[0-9a-f]{64}$/);
    assert.match(meta.generado, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-05:00$/);
  });

  test('las configs de escáner del repo no se copian y quedan registradas', () => {
    const f = path.join(runA, 'fuente');
    for (const c of ['.gitleaks.toml', '.gitleaksignore', '.semgrepignore']) assert.ok(!fs.existsSync(path.join(f, c)), c + ' se copió');
    const meta = JSON.parse(fs.readFileSync(path.join(runA, 'fuente.json'), 'utf8'));
    assert.deepEqual(meta.configs_escaner_del_repo, ['.gitleaks.toml', '.gitleaksignore', '.semgrepignore']);
    assert.match(salidaA, /AVISO configs de escáner del repo ignoradas: 3/);
  });

  test('deterministico.json es válido y coherente', () => {
    assert.equal(jsonA.modo, 'completa');
    assert.equal(jsonA.commit, commit1);
    assert.equal(jsonA.motor.listo, true);
    assert.ok(['OK', 'UNKNOWN'].includes(jsonA.estado_global));
    let suma = 0;
    for (const h of jsonA.herramientas) {
      assert.ok(['OK', 'FALLÓ', 'NO_INSTALADA', 'OMITIDA'].includes(h.estado), h.nombre);
      assert.equal(typeof h.duracion_ms, 'number');
      suma += h.hallazgos.length;
      for (const x of h.hallazgos) assert.ok('regla' in x && 'archivo' in x && 'linea' in x && 'gravedad_herramienta' in x && 'mensaje' in x);
    }
    assert.equal(jsonA.resumen.total, suma);
    for (const n of ['gitleaks-historial', 'gitleaks-dir', 'semgrep', 'osv-scanner', 'cyber-neo-secretos', 'cyber-neo-lockfiles']) assert.ok(herr(jsonA, n), n);
  });

  test('gitleaks (historial y carpeta) encuentra el token', () => {
    for (const n of ['gitleaks-historial', 'gitleaks-dir']) {
      const h = herr(jsonA, n);
      assert.equal(h.estado, 'OK', n + ' ' + h.motivo);
      assert.ok(h.hallazgos.some((x) => x.archivo === 'config.js'), n + ' no halló el token en config.js');
    }
  });

  test('semgrep encuentra hallazgos en server.js', () => {
    const h = herr(jsonA, 'semgrep');
    assert.equal(h.estado, 'OK', h.motivo);
    assert.ok(h.hallazgos.some((x) => x.archivo === 'server.js'), 'semgrep sin hallazgos en server.js');
  });

  test('semgrep.json crudo no guarda extra.lines ni el token', () => {
    const txt = fs.readFileSync(path.join(runA, 'deterministico', 'semgrep.json'), 'utf8');
    const j = JSON.parse(txt);
    assert.ok(j.results.length > 0);
    for (const x of j.results) { assert.ok(!('lines' in x.extra)); assert.ok(!('metavars' in x.extra)); }
    assert.ok(!txt.includes(token));
  });

  test('ningún crudo conserva el token', () => {
    for (const f of fs.readdirSync(path.join(runA, 'deterministico'))) {
      const txt = fs.readFileSync(path.join(runA, 'deterministico', f), 'utf8');
      assert.ok(!txt.includes(token), f + ' contiene el token');
    }
  });

  test('osv-scanner encuentra vulnerabilidades de lodash (requiere red)', (t) => {
    if (!red) { t.skip('SIN RED: osv-scanner no verificable'); return; }
    const h = herr(jsonA, 'osv-scanner');
    assert.equal(h.estado, 'OK', h.motivo);
    assert.ok(h.hallazgos.some((x) => /lodash/.test(x.mensaje)), 'sin hallazgos de lodash');
  });

  test('cyber-neo corre desde el vendor parchado y npm audit corre (requiere red)', (t) => {
    const cn = herr(jsonA, 'cyber-neo-secretos');
    assert.equal(cn.estado, 'OK', cn.motivo);
    assert.ok(cn.hallazgos.some((x) => x.archivo === 'config.js'));
    const n = herr(jsonA, 'npm audit');
    if (!red) { t.skip('SIN RED: npm audit no verificable'); return; }
    assert.equal(n.estado, 'OK', n.motivo);
    assert.ok(n.hallazgos.some((x) => /lodash/.test(x.mensaje)));
  });

  test('el clon del historial se borra siempre', () => {
    assert.equal(jsonA.historial_clon_borrado, true);
    assert.ok(!fs.existsSync(path.join(runA, 'historial.git')));
  });

  test('stdout/stderr no contienen el token ni SECRETO=xyz', () => {
    assert.ok(!salidaA.includes(token));
    assert.ok(!salidaA.includes('SECRETO=xyz'));
    assert.match(salidaA, /ESTADO_GLOBAL (OK|UNKNOWN)/);
  });

  test('no sobrescribe una fuente existente', () => {
    const r = correr(repo, runA);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no se sobrescribe/);
  });

  test('no escribe nada en el repo auditado', () => {
    const st = git(repo, 'status', '--porcelain');
    assert.deepEqual(st.split('\n').filter(Boolean), ['?? .env', '?? .gitleaksignore']);
  });

  test('modo --base solo analiza lo cambiado', () => {
    fs.writeFileSync(path.join(repo, 'nuevo.js'),
      "const express = require('express');\nconst app = express();\napp.get('/c', (req, res) => { res.send(String(eval(req.query.y))); });\n");
    git(repo, 'add', 'nuevo.js');
    git(repo, 'commit', '-q', '-m', 'agrega nuevo');
    const r = correr(repo, runB, ['--base', commit1]);
    salidaB = r.stdout + r.stderr;
    assert.ok([0, 3].includes(r.status), salidaB);
    jsonB = JSON.parse(fs.readFileSync(path.join(runB, 'deterministico.json'), 'utf8'));
    assert.equal(jsonB.modo, 'diff');
    assert.equal(jsonB.base, commit1);
    assert.equal(jsonB.archivos_cambiados, 1);
    const sg = herr(jsonB, 'semgrep');
    assert.equal(sg.estado, 'OK', sg.motivo);
    assert.ok(sg.hallazgos.length > 0);
    assert.ok(sg.hallazgos.every((x) => x.archivo === 'nuevo.js'), 'semgrep analizó archivos no cambiados');
    // el token se comiteó en commit1: ni el historial en rango ni la carpeta de cambiados lo ven
    assert.equal(herr(jsonB, 'gitleaks-historial').hallazgos.length, 0);
    assert.equal(herr(jsonB, 'gitleaks-dir').hallazgos.length, 0);
    // ningún manifiesto cambió
    assert.equal(herr(jsonB, 'osv-scanner').estado, 'OMITIDA');
    assert.equal(herr(jsonB, 'npm audit').estado, 'OMITIDA');
    assert.ok(!salidaB.includes(token));
    assert.deepEqual(fs.readdirSync(path.join(runB, 'cambiados')), ['nuevo.js']);
  });
});
