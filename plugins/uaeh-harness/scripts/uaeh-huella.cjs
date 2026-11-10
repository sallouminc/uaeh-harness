#!/usr/bin/env node
// UAEH — huella de la superficie de riesgo de un repo + sello de preflight.
// CLI:  node uaeh-huella.cjs huella <dir> | comparar <dir> | sellar <dir> --tipo ... --riesgo ...
// Módulo: calcularHuella(dir), compararConSello(dir), lineaVigia(dir), sellar(dir, op)
// Sin dependencias (solo lib/comun.cjs, del propio plugin). Nunca lee, guarda ni imprime VALORES de variables de entorno:
// solo nombres. Las fechas que escribe (sello, índice, historial) usan la zona efectiva: UAEH_TZ > zonaHoraria de
// uaeh.config.json > la del sistema. El sello vive en docs/harness/.preflight.json del repo; el índice de todos los
// sellos, en <UAEH_HOME>/preflights.json.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));

const CATEGORIAS = ['manifiestos', 'esquema', 'auth', 'env', 'despliegue', 'rutas', 'visual'];
const VIGENCIA = { critico: 30, alto: 60, medio: 90, bajo: 90 };
const MAX_LINEA = 240;
const SELLO_REL = 'docs/harness/.preflight.json';
const ENCABEZADO_HISTORIAL = '## Historial de corridas';
const CABECERA_TABLA = '| Fecha y hora (zona) | Tipo | Commit | Nuevos | Cerrados | Categorías auditadas |';
// Al LEER un historial existente vale cualquier etiqueta de zona en la cabecera («| Fecha y hora (<lo que sea>) |»): los
// historiales escritos por versiones anteriores, con otra etiqueta, siguen siendo esta misma tabla.
const RE_CABECERA_TABLA = /^\|\s*Fecha y hora \([^)]*\)\s*\|/;
const SEPARADOR_TABLA = '|---|---|---|---|---|---|';

// ---------------------------------------------------------------- utilidades

const uaehHome = comun.uaehHome;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function git(raiz, args, opciones) {
  return execFileSync('git', ['-C', raiz, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...(opciones || {})
  });
}

function raizDelRepo(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return null;
    const r = git(path.resolve(dir), ['rev-parse', '--show-toplevel']).trim();
    return r ? path.resolve(r) : null;
  } catch { return null; }
}

function commitCorto(raiz) {
  try { return git(raiz, ['rev-parse', '--short', 'HEAD']).trim() || null; } catch { return null; }
}

// -------------------------------------------------------------- fecha y hora

// La hora y la zona salen de lib/comun.cjs (UAEH_AHORA fija la hora en pruebas). La zona efectiva se resuelve aquí con el
// archivo de configuración: comun.isoZona(fecha) a secas solo mira UAEH_TZ y la zona del sistema.
const ahora = comun.ahora;

function zonaEfectiva() {
  return comun.zonaHoraria(comun.cargarConfig().config);
}

// AAAA-MM-DDTHH:MM:SS±HH:MM (el desfase de la zona efectiva en ese instante)
function isoZona(fecha, tz) {
  return comun.isoZona(fecha, comun.zonaValida(tz) ? tz : zonaEfectiva());
}

// AAAA-MM-DD HH:MM (zona IANA)
function legibleZona(fecha, tz) {
  return comun.legibleZona(fecha, comun.zonaValida(tz) ? tz : zonaEfectiva());
}

// ------------------------------------------------------------- categorías

const MANIFIESTOS = new Set([
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb',
  'composer.json', 'composer.lock', 'pyproject.toml', 'poetry.lock', 'uv.lock',
  'Pipfile', 'Pipfile.lock', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'Gemfile', 'Gemfile.lock', 'pubspec.yaml', 'pubspec.lock',
  'build.gradle', 'build.gradle.kts', 'Podfile', 'Podfile.lock'
]);

const DESPLIEGUE_EXACTOS = new Set([
  'vercel.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'app.json', 'eas.json',
  'firebase.json', '.htaccess'
]);

// ¿los segmentos `seq` aparecen consecutivos dentro de `dirs`?
function tieneSecuencia(dirs, seq) {
  for (let i = 0; i + seq.length <= dirs.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) if (dirs[i + j] !== seq[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// Devuelve los nombres de categoría (sin env, que no usa rutas) a los que pertenece una ruta posix.
function categoriasDe(ruta) {
  const partes = ruta.split('/');
  const base = partes[partes.length - 1];
  const dirs = partes.slice(0, -1);
  const baseMin = base.toLowerCase();
  const ext = path.posix.extname(base).slice(1).toLowerCase();
  const res = [];

  // manifiestos
  if (MANIFIESTOS.has(base) || /^requirements.*\.txt$/.test(base) || /\.csproj$/i.test(base)) res.push('manifiestos');

  // esquema
  if (base === 'schema.prisma' || dirs.includes('migrations') || dirs.includes('Migrations') ||
      /\.sql$/i.test(base) || dirs.includes('drizzle') || /^drizzle\.config\./.test(base)) res.push('esquema');

  // auth
  if (/^middleware\.(ts|js|mjs)$/.test(base) || /^proxy\.(ts|js)$/.test(base) ||
      dirs.includes('auth') || base.startsWith('auth.') ||
      /(session|login|jwt|rls|polic)/.test(baseMin) ||
      (dirs.includes('Filters') && base.includes('Auth')) ||
      ruta === 'supabase/config.toml' || ruta.endsWith('/supabase/config.toml')) res.push('auth');

  // despliegue
  if (tieneSecuencia(dirs, ['.github', 'workflows']) || DESPLIEGUE_EXACTOS.has(base) ||
      /^Dockerfile/.test(base) || /^docker-compose/.test(base) || /^capacitor\.config\./.test(base) ||
      (dirs.includes('scripts') && /(publicar|deploy|upload_backend)/.test(baseMin))) res.push('despliegue');

  // rutas (inventario: solo la lista de rutas)
  if ((/^route\.(ts|js)$/.test(base) && dirs.includes('app')) ||
      tieneSecuencia(dirs, ['pages', 'api']) ||
      ruta === 'app/Config/Routes.php' || ruta.endsWith('/app/Config/Routes.php') ||
      dirs.includes('routes') ||
      tieneSecuencia(dirs, ['supabase', 'functions']) ||
      (dirs.includes('api') && ['ts', 'js', 'php', 'py'].includes(ext)) ||
      tieneSecuencia(dirs, ['app', 'Controllers']) ||
      /^actions\.(ts|js)$/.test(base) || dirs.includes('actions')) res.push('rutas');

  // visual
  if (base === 'DESIGN.md' || dirs.some(d => d.endsWith('-snapshots')) ||
      tieneSecuencia(dirs, ['tests', 'visual'])) res.push('visual');

  return res;
}

function hashCategoria(lineas) {
  if (!lineas.length) return 'vacio';
  const ordenadas = [...lineas].sort();
  return crypto.createHash('sha256').update(ordenadas.join('\n')).digest('hex').slice(0, 12);
}

// ----------------------------------------------------------------- env

const DIRS_SALTAR = new Set(['node_modules', '.git', 'vendor', 'dist', '.next']);
const RE_VAR = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Devuelve líneas "relpath NOMBRE" (nunca valores). Raíz + 2 niveles.
function nombresEnv(raiz) {
  const lineas = new Set();
  function visitar(dir, rel, nivel) {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      if (e.isDirectory()) {
        if (nivel < 2 && !DIRS_SALTAR.has(e.name)) visitar(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, nivel + 1);
      } else if (e.isFile() && e.name.startsWith('.env')) {
        let txt;
        try { txt = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
        const relArchivo = rel ? `${rel}/${e.name}` : e.name;
        for (const l of txt.split(/\r?\n/)) {
          const m = RE_VAR.exec(l);
          if (m) lineas.add(`${relArchivo} ${m[1]}`);
        }
        txt = null;
      }
    }
  }
  visitar(raiz, '', 0);
  return [...lineas];
}

// ------------------------------------------------------------- huella

function calcularHuella(dir) {
  const t0 = Date.now();
  const raiz = raizDelRepo(dir);
  if (!raiz) return null;

  // tracked: ruta -> hash de blob del índice (sin leer archivos)
  const indice = new Map();
  for (const ent of git(raiz, ['ls-files', '-s', '-z']).split('\0')) {
    if (!ent) continue;
    const tab = ent.indexOf('\t');
    if (tab < 0) continue;
    const campos = ent.slice(0, tab).split(' ');
    indice.set(ent.slice(tab + 1), campos[1]);
  }
  const nuevos = new Set(git(raiz, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  const modificados = new Set(git(raiz, ['diff', '--name-only', '-z']).split('\0').filter(Boolean));

  const todos = new Set([...indice.keys(), ...nuevos]);
  const grupos = {};
  for (const c of CATEGORIAS) grupos[c] = [];

  for (const ruta of todos) {
    const cats = categoriasDe(ruta);
    for (const c of cats) {
      if (c === 'rutas') { grupos.rutas.push(ruta); continue; }
      let h;
      if (nuevos.has(ruta) || modificados.has(ruta) || !indice.has(ruta)) {
        try { h = sha256(fs.readFileSync(path.join(raiz, ruta))); } catch { h = 'ausente'; }
      } else {
        h = indice.get(ruta);
      }
      grupos[c].push(`${ruta} ${h}`);
    }
  }
  grupos.env = nombresEnv(raiz);

  const huella = {};
  const conteos = {};
  for (const c of CATEGORIAS) {
    huella[c] = hashCategoria(grupos[c]);
    conteos[c] = grupos[c].length;
  }
  return { raiz, commit: commitCorto(raiz), huella, conteos, ms: Date.now() - t0 };
}

// ------------------------------------------------------------- sello

function rutaSello(raiz) { return path.join(raiz, ...SELLO_REL.split('/')); }

// null = no hay sello; { ilegible:true } = existe pero no sirve; si no, el objeto del sello.
function leerSello(raiz) {
  const f = rutaSello(raiz);
  if (!fs.existsSync(f)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!s || typeof s !== 'object' || !s.huella || typeof s.huella !== 'object' || !s.fecha_legible || !s.vence) return { ilegible: true };
    return s;
  } catch { return { ilegible: true }; }
}

function compararConSello(dir) {
  const h = calcularHuella(dir);
  if (!h) return null;
  const sello = leerSello(h.raiz);
  const proyecto = path.basename(h.raiz);
  if (!sello) return { raiz: h.raiz, proyecto, estado: 'sin_sello', cambiadas: [], vencido: false };
  if (sello.ilegible) return { raiz: h.raiz, proyecto, estado: 'ilegible', cambiadas: [], vencido: false };
  const cambiadas = CATEGORIAS.filter(c => sello.huella[c] !== h.huella[c]);
  const venceMs = new Date(sello.vence).getTime();
  const vencido = !isNaN(venceMs) && ahora().getTime() > venceMs;
  return { raiz: h.raiz, proyecto, estado: 'con_sello', sello, cambiadas, vencido, actual: h };
}

function recortar(s) {
  return s.length <= MAX_LINEA ? s : s.slice(0, MAX_LINEA - 1) + '…';
}

// opciones.sinSello === false → un repo sin sello da '' (la línea al abrir sesión calla: el preflight es bajo pedido).
function lineaVigia(dir, opciones = {}) {
  try {
    const raiz = raizDelRepo(dir);
    if (!raiz) return '';
    // Comparación por ruta REAL: la carpeta de usuario puede venir con nombre corto 8.3 (RUNNER~1) y git da la larga.
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
    if (real(raiz).toLowerCase() === real(os.homedir()).toLowerCase()) return '';
    const c = compararConSello(raiz);
    if (!c) return '';
    if (c.estado === 'sin_sello') {
      if (opciones && opciones.sinSello === false) return '';
      return recortar(`UAEH: ${c.proyecto} sin preflight (informativo: solo se corre antes de lanzar o a pedido del usuario).`);
    }
    if (c.estado === 'ilegible') {
      return recortar(`UAEH: sello de preflight ilegible en ${c.proyecto}; tratar como sin preflight.`);
    }
    const s = c.sello;
    const cambio = c.cambiadas.join(', ');
    const rango = `git diff ${s.commit || '<sello>'}..HEAD`;
    if (c.vencido) {
      const base = `UAEH: preflight del ${s.fecha_legible} vencido (riesgo ${s.riesgo}, ${s.vigencia_dias} días)`;
      return recortar(c.cambiadas.length
        ? `${base} y cambió ${cambio} → refrescar INCREMENTAL (${rango}).`
        : `${base} → refrescar INCREMENTAL.`);
    }
    if (c.cambiadas.length) {
      return recortar(`UAEH: desde el preflight del ${s.fecha_legible} cambió ${cambio} → preflight INCREMENTAL solo de eso (${rango}).`);
    }
    return recortar(`UAEH: preflight vigente del ${s.fecha_legible} (commit ${s.commit || 'sin commit'}) en ${c.proyecto}. NO repetir.`);
  } catch { return ''; }
}

// ------------------------------------------------------------- sellar

function agregarFilaHistorial(raiz, fila) {
  const f = path.join(raiz, 'docs', 'harness', 'AUDIT_REPORT.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, ['# Informe de auditoría', '', ENCABEZADO_HISTORIAL, '', CABECERA_TABLA, SEPARADOR_TABLA, fila, ''].join('\n'));
    return f;
  }
  const txt = fs.readFileSync(f, 'utf8');
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  const lineas = txt.split(/\r?\n/);
  const idx = lineas.findIndex(l => l.trim() === ENCABEZADO_HISTORIAL);
  if (idx < 0) {
    let base = txt;
    if (base.length && !base.endsWith('\n')) base += eol;
    base += (base.length ? eol : '') + [ENCABEZADO_HISTORIAL, '', CABECERA_TABLA, SEPARADOR_TABLA, fila, ''].join(eol);
    fs.writeFileSync(f, base);
    return f;
  }
  let j = idx + 1;
  while (j < lineas.length && lineas[j].trim() === '') j++;
  // Solo se escribe bajo una tabla con NUESTRA cabecera. Si bajo el título hay una tabla ajena (otras columnas: la
  // escribió a mano quien redactó el informe) o texto, se deja intacto y la nuestra va primero: una fila nuestra bajo
  // otras columnas quedaría desalineada (medido en la prueba en vivo del preflight, F2). Una línea en blanco la separa
  // de lo que siga: en Markdown, una línea de texto pegada a una tabla se lee como otra fila.
  if (j < lineas.length && RE_CABECERA_TABLA.test(lineas[j].trim())) {
    let k = j;
    while (k < lineas.length && lineas[k].trim().startsWith('|')) k++;
    lineas.splice(k, 0, fila);
  } else {
    const bloque = ['', CABECERA_TABLA, SEPARADOR_TABLA, fila];
    if (lineas[idx + 1] !== undefined && lineas[idx + 1].trim() !== '') bloque.push('');
    lineas.splice(idx + 1, 0, ...bloque);
  }
  fs.writeFileSync(f, lineas.join(eol));
  return f;
}

function sellar(dir, op) {
  const h = calcularHuella(dir);
  if (!h) return null;
  const raiz = h.raiz;
  const previo = leerSello(raiz);
  const previoOk = previo && !previo.ilegible ? previo : null;
  const t = ahora();

  let hallazgos;
  if (op.hallazgos) hallazgos = op.hallazgos;
  else if (op.tipo === 'incremental' && previoOk && Array.isArray(previoOk.hallazgos_abiertos)) hallazgos = previoOk.hallazgos_abiertos;
  else hallazgos = [];

  let auditadas;
  if (op.categorias) auditadas = op.categorias;
  else if (op.tipo === 'completa') auditadas = [...CATEGORIAS];
  else auditadas = previoOk ? CATEGORIAS.filter(c => previoOk.huella[c] !== h.huella[c]) : [...CATEGORIAS];

  const dias = VIGENCIA[op.riesgo];
  const sello = {
    version: 1,
    proyecto: path.basename(raiz),
    fecha: isoZona(t),
    fecha_legible: legibleZona(t),
    commit: h.commit,
    tipo: op.tipo,
    riesgo: op.riesgo,
    vigencia_dias: dias,
    vence: isoZona(new Date(t.getTime() + dias * 86400000)),
    huella: h.huella,
    hallazgos_abiertos: hallazgos,
    categorias_auditadas: auditadas
  };
  const f = rutaSello(raiz);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(sello, null, 2) + '\n');

  // índice global
  const home = uaehHome();
  fs.mkdirSync(home, { recursive: true });
  const fi = path.join(home, 'preflights.json');
  let indice = {};
  try { indice = JSON.parse(fs.readFileSync(fi, 'utf8')) || {}; } catch {}
  indice[raiz] = {
    proyecto: sello.proyecto, fecha_legible: sello.fecha_legible, commit: sello.commit,
    tipo: sello.tipo, riesgo: sello.riesgo, vence: sello.vence, abiertos: hallazgos.length
  };
  fs.writeFileSync(fi, JSON.stringify(indice, null, 2) + '\n');

  // historial
  const fila = `| ${sello.fecha_legible} | ${sello.tipo} | ${sello.commit || '-'} | ${op.nuevos} | ${op.cerrados} | ${auditadas.length ? auditadas.join(', ') : '-'} |`;
  agregarFilaHistorial(raiz, fila);
  return f;
}

// ------------------------------------------------------------------ CLI

function falla(msg) {
  process.stderr.write(`uaeh-huella: ${msg}\n`);
  process.exit(1);
}

function parsearSellar(args) {
  const op = { tipo: null, riesgo: null, hallazgos: null, nuevos: 0, cerrados: 0, categorias: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (!a.startsWith('--')) falla(`argumento inesperado: ${a}`);
    if (v === undefined || v.startsWith('--')) falla(`falta el valor de ${a}`);
    i++;
    switch (a) {
      case '--tipo':
        if (!['completa', 'incremental'].includes(v)) falla('--tipo debe ser completa o incremental');
        op.tipo = v; break;
      case '--riesgo':
        if (!Object.prototype.hasOwnProperty.call(VIGENCIA, v)) falla('--riesgo debe ser critico, alto, medio o bajo');
        op.riesgo = v; break;
      case '--hallazgos': op.hallazgos = v.split(',').map(x => x.trim()).filter(Boolean); break;
      case '--nuevos':
      case '--cerrados': {
        if (!/^\d+$/.test(v)) falla(`${a} debe ser un entero >= 0`);
        op[a.slice(2)] = parseInt(v, 10); break;
      }
      case '--categorias': {
        const lista = v.split(',').map(x => x.trim()).filter(Boolean);
        const mala = lista.find(x => !CATEGORIAS.includes(x));
        if (mala) falla(`categoría desconocida: ${mala} (válidas: ${CATEGORIAS.join(', ')})`);
        op.categorias = lista; break;
      }
      default: falla(`opción desconocida: ${a}`);
    }
  }
  if (!op.tipo) falla('falta --tipo completa|incremental');
  if (!op.riesgo) falla('falta --riesgo critico|alto|medio|bajo');
  return op;
}

function main(argv) {
  const [cmd, dir, ...resto] = argv;
  if (!['huella', 'comparar', 'sellar'].includes(cmd)) {
    falla('uso: uaeh-huella.cjs huella <dir> | comparar <dir> | sellar <dir> --tipo completa|incremental --riesgo critico|alto|medio|bajo [--hallazgos ID,ID] [--nuevos N] [--cerrados M] [--categorias a,b]');
  }
  if (!dir) falla(`falta <dir> para ${cmd}`);
  if (cmd !== 'sellar' && resto.length) falla(`argumento inesperado: ${resto[0]}`);
  const op = cmd === 'sellar' ? parsearSellar(resto) : null;
  if (!fs.existsSync(dir)) falla(`no existe la carpeta: ${dir}`);

  if (cmd === 'huella') {
    const h = calcularHuella(dir);
    if (!h) { console.log('sin git'); return; }
    console.log(JSON.stringify({ raiz: h.raiz, commit: h.commit, huella: h.huella, conteos: h.conteos, ms: h.ms }, null, 2));
  } else if (cmd === 'comparar') {
    if (!raizDelRepo(dir)) { console.log('sin git'); return; }
    console.log(lineaVigia(dir));
  } else {
    const f = sellar(dir, op);
    if (!f) { console.log('sin git'); return; }
    console.log(f);
  }
}

module.exports = {
  calcularHuella, compararConSello, lineaVigia, sellar,
  CATEGORIAS, VIGENCIA, ahora, isoZona, legibleZona, uaehHome, categoriasDe, CABECERA_TABLA, RE_CABECERA_TABLA,
};

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { falla(e && e.message ? e.message : String(e)); }
}
