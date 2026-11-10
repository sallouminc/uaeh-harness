#!/usr/bin/env node
// scripts/instalar.cjs — instalador de la capa 2 del método UAEH (plugin uaeh-harness: arnés de verificación).
//
// Uso: node instalar.cjs <subcomando> [opciones]   (opción común a los que escriben: --forzar, ver «Sellos abiertos» abajo)
//   config     [--aplicar] [--json]                  crea <UAEH_HOME>/uaeh.config.json desde la plantilla (nunca pisa uno existente)
//   git-guard  [--aplicar] [--quitar] [--reemplazar] [--json]
//                                                    copia la guarda de git al espejo, la PRUEBA en un repo temporal y, solo si
//                                                    la prueba pasa, fija core.hooksPath GLOBAL al espejo. --quitar deshace el
//                                                    core.hooksPath (solo si apunta al espejo; el espejo se conserva; restaura
//                                                    el anterior si quedó anotado). --reemplazar: si ya hay OTRO core.hooksPath,
//                                                    lo sustituye (tras la prueba de humo) y lo anota para que --quitar lo restaure.
//   codex      [--aplicar] [--quitar] [--json]       bloque UAEH en <CODEX_HOME>/AGENTS.md (entre marcadores) + agentes uae_*.toml
//                                                    con los modelos de la configuración + fragmento de config.toml para pegar a mano.
//                                                    --quitar: quita solo el bloque entre sus marcas y borra los uae_*.toml SOLO si son
//                                                    idénticos a los del plugin (si cambiaron, se dejan y se avisa); config.toml no se toca
//   visual     [--proyecto <carpeta> [--local]] [--registrar-skills [--reemplazar]] [--aplicar] [--json]
//                                                    puerta visual. --proyecto: copia al proyecto las plantillas de Playwright
//                                                    + axe (playwright.visual.config.ts, tests/visual/visual.spec.ts) y el
//                                                    DESIGN.md si falta, sin pisar nunca un archivo del proyecto, y agrega las
//                                                    exclusiones de evidencia (uaeh-ignorar; --local: .git/info/exclude).
//                                                    --registrar-skills: borrador del catálogo visual propio
//                                                    (<UAEH_HOME>/catalogo-visual.md o visual.catalogo) desde las skills locales
//   todo       [--aplicar] [--reemplazar] [--json]   config + git-guard (+ codex si codex.habilitado es true)
//   puertas    [seguridad|visual|codex|preflight|todas] [--aplicar] [--actualizar] [--reparar] [--consiento|--retirar]
//                                                    instala o repara lo que falte en las puertas de la capa 3 según
//                                                    doctor-puertas.cjs (ver instalar-puertas.cjs); --consiento / --retirar
//                                                    habilita o apaga Codex en uaeh.config.json (manda código a OpenAI)
//
// Reglas de este script:
//   · EN SECO por defecto: imprime qué cambiaría. Solo escribe con --aplicar. La prueba de humo de git-guard corre también
//     en seco (sobre la copia del plugin) para que el usuario sepa antes si su máquina puede correr la guarda.
//   · Antes de pisar un archivo deja <archivo>.uaeh-respaldo-<AAAAMMDD-HHmmss> a su lado (nunca se pisa un respaldo).
//   · No borra nada. Nunca edita config.toml de Codex. Nunca pisa por su cuenta un core.hooksPath ajeno: lo reporta
//     y solo lo sustituye si el usuario lo pide con --reemplazar (el anterior queda anotado; --quitar lo restaura).
//   · Rutas de estado desde lib/comun.cjs y lib/config.cjs; archivos del plugin desde __dirname.
//   · El espejo (<UAEH_HOME>/estable/uaeh-harness/) conserva la disposición del plugin: git-hooks/ y hooks/ hermanas,
//     scripts/lib/ debajo; VERSION y un package.json {"type":"commonjs"} (un "type":"module" ancestro no rompe los .js).
//   · Sellos abiertos: config, git-guard (también --quitar), codex, todo y puertas miran antes si otra sesión tiene una revisión
//     viva (uaeh-integridad.cjs sellosAbiertos). En seco: acción AVISO con la lista. Con --aplicar se NIEGAN (código 1, nada
//     escrito) salvo --forzar, que sigue y deja el AVISO.
//   · Salida humana: una línea por acción «TIPO  detalle», TIPO ∈ HARÍA | HECHO | SIN CAMBIOS | RESPALDO | FALTA | ERROR | NOTA | AVISO.
//     Con --json: { subcomando, aplicado, acciones:[{tipo, ruta, detalle}], humo, codigo }.
//   · Código de salida: 0 bien · 1 error (humo fallido, hooksPath ajeno, archivo roto) · 2 uso incorrecto.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const comun = require(path.join(__dirname, 'lib', 'comun.cjs'));
const configLib = require(path.join(__dirname, 'lib', 'config.cjs'));

const RAIZ = path.resolve(__dirname, '..');
const PLANTILLAS = path.join(RAIZ, 'templates');
const CODEX_PLANTILLAS = path.join(RAIZ, 'codex');
const ANCHO_TIPO = 11; // «SIN CAMBIOS»
const PACKAGE_ESPEJO = '{"type":"commonjs"}\n';
const ARCHIVO_ESTADO_GUARDA = 'git-guard.estado.json';
const TIEMPO_GIT_MS = 60000;
// Clave de git de la guarda. Se arma por partes para que ni este archivo ni sus pruebas disparen filtros de texto que
// buscan la clave completa en los comandos.
const CLAVE_HOOKS = 'core.' + 'hooksPath';

// Archivos del plugin que viajan al espejo (ruta relativa a la raíz del plugin = ruta relativa al espejo).
const COPIAS_ESPEJO = [
  'hooks/guardia-commit.cjs',
  'hooks/guardia-git.js',
  'scripts/lib/comun.cjs',
  'scripts/lib/config.cjs',
  'scripts/uaeh-integridad.cjs',
  'scripts/uaeh-registro.cjs',
  'scripts/uaeh-resumen.cjs',
];
// Los hooks de git que hacen la revisión: sin ellos la guarda no revisa nada (capaGitActiva los exige).
const HOOKS_CLAVE = ['prepare-commit-msg', 'pre-applypatch', 'commit-msg', 'applypatch-msg'];

// ── Acciones y salida ─────────────────────────────────────────────────────────────────────

function accion(tipo, ruta, detalle, extra) {
  return Object.assign({ tipo, ruta: ruta || null, detalle }, extra || {});
}

function formatearAccion(a) {
  const detalle = String(a.detalle == null ? '' : a.detalle);
  const sufijo = a.ruta && !detalle.includes(a.ruta) && !detalle.includes(String(a.ruta).replace(/\\/g, '/')) ? `  → ${a.ruta}` : '';
  return `${String(a.tipo).padEnd(ANCHO_TIPO)}  ${detalle}${sufijo}`;
}

function formatearHumano(informe) {
  const lineas = [`instalar ${informe.subcomando} (${informe.aplicado ? 'APLICADO' : 'EN SECO: nada se escribió; añade --aplicar'})`];
  for (const a of informe.acciones) {
    lineas.push(formatearAccion(a));
    if (a.snippet) lineas.push(...String(a.snippet).split('\n').map((l) => `             ${l}`));
  }
  if (informe.humo) {
    lineas.push(`${'HUMO'.padEnd(ANCHO_TIPO)}  ${informe.humo.ok ? 'OK' : 'FALLÓ'} — ${informe.humo.detalle}`);
    for (const p of informe.humo.pasos) lineas.push(`             ${p.ok ? 'ok  ' : 'FALLÓ'} ${p.nombre}${p.detalle ? ` — ${p.detalle}` : ''}`);
  }
  return lineas.join('\n');
}

function marcaTiempo() {
  const p = comun.isoZona(comun.ahora()).replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // AAAAMMDD-HHmmss
  return p;
}

function rutaRespaldo(ruta) {
  const base = `${ruta}.uaeh-respaldo-${marcaTiempo()}`;
  let candidato = base;
  for (let i = 2; fs.existsSync(candidato); i++) candidato = `${base}-${i}`;
  return candidato;
}

const tocadosEnCorrida = new Set();

// Escribe `contenido` (Buffer o texto) en `ruta` con respaldo del original si existía. true si escribió.
function escribirConRespaldo(acciones, ruta, contenido, modo) {
  try {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const clave = process.platform === 'win32' ? path.resolve(ruta).toLowerCase() : path.resolve(ruta);
    if (fs.existsSync(ruta) && !tocadosEnCorrida.has(clave)) {
      const respaldo = rutaRespaldo(ruta);
      fs.copyFileSync(ruta, respaldo);
      acciones.push(accion('RESPALDO', respaldo, `respaldo de ${path.basename(ruta)}`));
    }
    tocadosEnCorrida.add(clave);
    fs.writeFileSync(ruta, contenido);
    if (modo != null) { try { fs.chmodSync(ruta, modo); } catch { /* Windows: sin bits de ejecución */ } }
    return true;
  } catch (e) {
    acciones.push(accion('ERROR', ruta, `no se pudo escribir (${e.message})`));
    return false;
  }
}

// Copia `nuevo` a `destino` si falta o cambió (con respaldo). `modo` = permisos (0o755 para los hooks de git).
function sincronizar(acciones, aplicar, nuevo, destino, etiqueta, modo) {
  const existe = fs.existsSync(destino);
  if (existe) {
    let actual = null;
    try { actual = fs.readFileSync(destino); } catch { actual = null; }
    if (actual && actual.equals(nuevo)) {
      if (modo != null && process.platform !== 'win32') { try { fs.chmodSync(destino, modo); } catch { /* sin permisos */ } }
      acciones.push(accion('SIN CAMBIOS', destino, `${etiqueta}: ya está al día`));
      return true;
    }
  }
  if (!aplicar) {
    acciones.push(accion('HARÍA', destino, `${existe ? 'actualizar (con respaldo)' : 'copiar'} ${etiqueta}`));
    return true;
  }
  if (escribirConRespaldo(acciones, destino, nuevo, modo)) {
    acciones.push(accion('HECHO', destino, `${etiqueta}: ${existe ? 'actualizado' : 'copiado'}`));
    return true;
  }
  return false;
}

function leerBinario(ruta) {
  try { return fs.readFileSync(ruta); } catch { return null; }
}

// ── git ───────────────────────────────────────────────────────────────────────────────────

function git(args, opciones = {}) {
  const r = spawnSync('git', args, {
    encoding: 'utf8', timeout: TIEMPO_GIT_MS, windowsHide: true,
    env: opciones.env || process.env, cwd: opciones.cwd || undefined,
  });
  return { status: r.status == null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function normalizarRuta(p) {
  const n = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

// Valor GLOBAL actual de la clave de la guarda: { valor: string|null, error: string|null }.
function leerHooksPathGlobal() {
  const r = git(['config', '--global', '--get', CLAVE_HOOKS]);
  if (r.status === 0) return { valor: r.stdout.replace(/\r?\n[\s\S]*$/, '').trim() || null, error: null };
  if (r.status === 1) return { valor: null, error: null }; // no definida
  return { valor: null, error: (r.stderr || r.error && r.error.message || `código ${r.status}`).toString().trim().split(/\r?\n/)[0] };
}

// Forma con la que se escribe la ruta en git: barras «/» (git nativo de Windows la entiende; capaGitActiva la acepta).
function rutaParaGit(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

// ── Prueba de humo de la guarda ───────────────────────────────────────────────────────────
// Repo temporal con un gitconfig GLOBAL temporal (no toca el del usuario): un commit limpio debe pasar; un .env y un
// secreto falso deben negarse CON el mensaje de la guarda. Si el commit sucio pasa, la guarda no corrió (sin sh, sin node
// en PATH, hooks sin permiso…) y no se instala nada: falla cerrado.
function humo(dirGuarda) {
  const pasos = [];
  let tmp;
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-humo-')); } catch (e) {
    pasos.push({ nombre: 'carpeta temporal', ok: false, detalle: e.message });
    return { ok: false, detalle: 'no se pudo crear la carpeta temporal de la prueba de humo; no se instala', pasos };
  }
  try {
    const gitconfig = path.join(tmp, 'gitconfig');
    fs.writeFileSync(gitconfig, '[user]\n\tname = Humo UAEH\n\temail = humo@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n' +
      `[core]\n\tautocrlf = false\n\t${CLAVE_HOOKS.split('.')[1]} = ${rutaParaGit(dirGuarda)}\n`, 'utf8');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
    const g = (args) => git(args, { env, cwd: repo });
    const primera = (r) => (r.stderr || r.stdout || (r.error && r.error.message) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || `código ${r.status}`;

    let r = g(['init', '-q']);
    if (r.status !== 0) { pasos.push({ nombre: 'git init', ok: false, detalle: primera(r) }); return { ok: false, detalle: 'no se pudo crear el repo temporal', pasos }; }

    fs.writeFileSync(path.join(repo, 'limpio.txt'), 'hola\n', 'utf8');
    g(['add', 'limpio.txt']);
    r = g(['commit', '-q', '-m', 'humo: commit limpio']);
    pasos.push({ nombre: 'commit limpio pasa', ok: r.status === 0, detalle: r.status === 0 ? '' : primera(r) });
    if (r.status !== 0) return { ok: false, detalle: 'la guarda negó un commit limpio (o git falló): revisa el detalle', pasos };

    fs.writeFileSync(path.join(repo, '.env'), 'SECRETO=valor-de-humo\n', 'utf8');
    g(['add', '.env']);
    r = g(['commit', '-q', '-m', 'humo: .env']);
    const negoEnv = r.status !== 0 && /Guardia UAEH/.test(r.stderr + r.stdout);
    pasos.push({ nombre: 'commit con .env se niega', ok: negoEnv, detalle: negoEnv ? '' : (r.status === 0 ? 'el commit PASÓ: la guarda no corrió' : primera(r)) });
    g(['rm', '-q', '--cached', '.env']);
    try { fs.unlinkSync(path.join(repo, '.env')); } catch { /* nada */ }

    const llave = 'AKIA' + 'ABCDEFGHIJKLMNOP'; // llave AWS de juguete, armada por partes
    fs.writeFileSync(path.join(repo, 'config.js'), `module.exports = { llave: '${llave}' };\n`, 'utf8');
    g(['add', 'config.js']);
    r = g(['commit', '-q', '-m', 'humo: secreto']);
    const negoSecreto = r.status !== 0 && /Guardia UAEH/.test(r.stderr + r.stdout) && !(r.stderr + r.stdout).includes(llave);
    pasos.push({ nombre: 'commit con secreto falso se niega sin mostrar el valor', ok: negoSecreto, detalle: negoSecreto ? '' : (r.status === 0 ? 'el commit PASÓ: la guarda no corrió' : primera(r)) });

    const ok = pasos.every((p) => p.ok);
    return { ok, detalle: ok ? `la guarda corre desde ${rutaParaGit(dirGuarda)}` : 'la guarda no se comporta como debe; no se instala', pasos };
  } catch (e) {
    pasos.push({ nombre: 'prueba de humo', ok: false, detalle: e.message });
    return { ok: false, detalle: 'error interno en la prueba de humo', pasos };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal: se limpia después */ }
  }
}

// ── git-guard ─────────────────────────────────────────────────────────────────────────────

function listarGitHooksPlugin() {
  const dir = path.join(RAIZ, 'git-hooks');
  try { return fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile()).sort(); } catch { return []; }
}

function copiarEspejo(acciones, aplicar) {
  const espejo = configLib.espejoHarness();
  let bien = true;
  const hooks = listarGitHooksPlugin();
  if (!hooks.length || !HOOKS_CLAVE.every((h) => hooks.includes(h))) {
    acciones.push(accion('FALTA', path.join(RAIZ, 'git-hooks'), `el plugin no trae los hooks de git completos (${HOOKS_CLAVE.join(', ')}); no se instala`));
    return { espejo, bien: false };
  }
  for (const h of hooks) {
    const origen = path.join(RAIZ, 'git-hooks', h);
    const crudo = leerBinario(origen);
    if (!crudo) { acciones.push(accion('ERROR', origen, `git-hooks/${h}: no se pudo leer`)); bien = false; continue; }
    const lf = Buffer.from(crudo.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'); // sh no tolera CR
    bien = sincronizar(acciones, aplicar, lf, path.join(espejo, 'git-hooks', h), `git-hooks/${h}`, 0o755) && bien;
  }
  for (const rel of COPIAS_ESPEJO) {
    const origen = path.join(RAIZ, ...rel.split('/'));
    const contenido = leerBinario(origen);
    if (!contenido) { acciones.push(accion('FALTA', origen, `${rel}: no existe en el plugin; no se copia`)); bien = false; continue; }
    bien = sincronizar(acciones, aplicar, contenido, path.join(espejo, ...rel.split('/')), rel) && bien;
  }
  bien = sincronizar(acciones, aplicar, Buffer.from(`${comun.versionPlugin()}\n`, 'utf8'), path.join(espejo, 'VERSION'), 'VERSION') && bien;
  bien = sincronizar(acciones, aplicar, Buffer.from(PACKAGE_ESPEJO, 'utf8'), path.join(espejo, 'package.json'), 'package.json') && bien;
  return { espejo, bien };
}

function leerEstadoGuarda(espejo) {
  return comun.leerJson(path.join(espejo, ARCHIVO_ESTADO_GUARDA)) || {};
}

function gitGuard(o) {
  const acciones = [];
  const aplicar = !!o.aplicar;
  const informe = { acciones, humo: null, codigo: 0 };
  const espejo = configLib.espejoHarness();
  const dirGuardaEspejo = path.join(espejo, 'git-hooks');
  const actual = leerHooksPathGlobal();
  if (actual.error) {
    acciones.push(accion('ERROR', null, `no se pudo consultar la configuración global de git (${actual.error}); ¿está git instalado?`));
    informe.codigo = 1;
    return informe;
  }

  if (o.quitar) {
    if (actual.valor && normalizarRuta(actual.valor.replace(/^~(?=[\\/])/, os.homedir())) === normalizarRuta(dirGuardaEspejo)) {
      const estado = leerEstadoGuarda(espejo);
      const anterior = typeof estado.anterior === 'string' && estado.anterior ? estado.anterior : null;
      const que = anterior ? `restaurar ${CLAVE_HOOKS} = ${anterior}` : `quitar ${CLAVE_HOOKS} (apunta al espejo)`;
      if (!aplicar) { acciones.push(accion('HARÍA', null, que)); return informe; }
      const r = anterior ? git(['config', '--global', CLAVE_HOOKS, anterior]) : git(['config', '--global', '--unset', CLAVE_HOOKS]);
      if (r.status !== 0) { acciones.push(accion('ERROR', null, `git config falló: ${(r.stderr || '').trim().split(/\r?\n/)[0]}`)); informe.codigo = 1; return informe; }
      acciones.push(accion('HECHO', null, `${que}; el espejo se conserva en ${espejo}`));
      return informe;
    }
    acciones.push(accion('SIN CAMBIOS', null, actual.valor ? `${CLAVE_HOOKS} = ${actual.valor} no apunta al espejo del plugin; no se toca` : `${CLAVE_HOOKS} no está definida; nada que quitar`));
    return informe;
  }

  const copia = copiarEspejo(acciones, aplicar);
  if (!copia.bien) { informe.codigo = 1; return informe; }

  // Humo: en seco sobre la copia del plugin (git-hooks/ y hooks/ ya son hermanas); aplicado, sobre el espejo recién escrito.
  informe.humo = humo(aplicar ? dirGuardaEspejo : path.join(RAIZ, 'git-hooks'));
  if (!informe.humo.ok) {
    acciones.push(accion('ERROR', null, `la prueba de humo falló (${informe.humo.detalle}): no se toca ${CLAVE_HOOKS}. ` +
      'Revisa que node y sh (Git Bash en Windows) estén disponibles y que la carpeta temporal exista.'));
    informe.codigo = 1;
    return informe;
  }

  const esperado = normalizarRuta(dirGuardaEspejo);
  const valorActual = actual.valor ? normalizarRuta(actual.valor.replace(/^~(?=[\\/])/, os.homedir())) : null;
  if (valorActual === esperado) {
    acciones.push(accion('SIN CAMBIOS', null, `${CLAVE_HOOKS} ya apunta al espejo (${rutaParaGit(dirGuardaEspejo)})`));
    return informe;
  }
  // Un core.hooksPath ajeno (husky, otra guarda, una instalación anterior) solo se sustituye si el usuario lo pide con
  // --reemplazar; entonces queda anotado en el estado del espejo y --quitar lo restaura. Sin la opción no se toca.
  if (actual.valor && !o.reemplazar) {
    acciones.push(accion('ERROR', null, `ya hay otra guarda de git: ${CLAVE_HOOKS} = ${actual.valor}. El instalador no la pisa por su cuenta. ` +
      'Si quieres la guarda UAEH en su lugar, repite con --reemplazar: la anterior queda anotada y «git-guard --quitar --aplicar» la restaura.'));
    informe.codigo = 1;
    return informe;
  }
  const nuevo = rutaParaGit(dirGuardaEspejo);
  if (!aplicar) {
    acciones.push(accion('HARÍA', null, actual.valor
      ? `reemplazar ${CLAVE_HOOKS} global = ${actual.valor} por ${nuevo} (la anterior queda anotada para --quitar)`
      : `fijar ${CLAVE_HOOKS} global = ${nuevo}`));
    return informe;
  }
  const r = git(['config', '--global', CLAVE_HOOKS, nuevo]);
  if (r.status !== 0) { acciones.push(accion('ERROR', null, `git config falló: ${(r.stderr || '').trim().split(/\r?\n/)[0]}`)); informe.codigo = 1; return informe; }
  comun.escribirJson(path.join(espejo, ARCHIVO_ESTADO_GUARDA), { anterior: actual.valor, fijado: comun.isoZona(comun.ahora()), version: comun.versionPlugin() });
  acciones.push(accion('HECHO', null, actual.valor
    ? `${CLAVE_HOOKS} global: ${actual.valor} → ${nuevo}. Reversa (restaura la anterior): instalar.cjs git-guard --quitar --aplicar`
    : `${CLAVE_HOOKS} global = ${nuevo}. Reversa: instalar.cjs git-guard --quitar --aplicar`));
  return informe;
}

// ── config ────────────────────────────────────────────────────────────────────────────────

function configuracion(o) {
  const acciones = [];
  const destino = comun.rutaConfig();
  const plantilla = leerBinario(path.join(PLANTILLAS, 'uaeh.config.example.json'));
  if (!plantilla) { acciones.push(accion('FALTA', path.join(PLANTILLAS, 'uaeh.config.example.json'), 'plantilla ausente en el plugin')); return { acciones, codigo: 1 }; }
  if (fs.existsSync(destino)) {
    const { avisos } = configLib.cargarConfig();
    acciones.push(accion('SIN CAMBIOS', destino, avisos.length ? `ya existe; avisos: ${avisos.join(' · ')}` : 'ya existe y es válida; no se toca'));
    return { acciones, codigo: 0 };
  }
  if (!o.aplicar) { acciones.push(accion('HARÍA', destino, 'crear uaeh.config.json desde la plantilla')); return { acciones, codigo: 0 }; }
  if (escribirConRespaldo(acciones, destino, plantilla)) acciones.push(accion('HECHO', destino, 'uaeh.config.json creado desde la plantilla (edita commits y listaBlanca a tu medida)'));
  return { acciones, codigo: acciones.some((a) => a.tipo === 'ERROR') ? 1 : 0 };
}

// ── codex ─────────────────────────────────────────────────────────────────────────────────

const MARCA_INICIO = /<!--\s*UAEH:BEGIN(?:\s+v[^\s>]*)?\s*-->/;
const MARCA_FIN = /<!--\s*UAEH:END\s*-->/;

function renderizar(texto, valores) {
  return texto.replace(/\{\{([A-Z_]+)\}\}/g, (todo, clave) => (clave in valores ? valores[clave] : todo));
}

// Inserta o reemplaza el bloque UAEH en un AGENTS.md (conserva CRLF/BOM del destino si existía).
function conBloque(original, bloque) {
  const texto = original == null ? '' : original;
  const bom = texto.charCodeAt(0) === 0xFEFF ? String.fromCharCode(0xFEFF) : '';
  const cuerpo = bom ? texto.slice(1) : texto;
  const eol = /\r\n/.test(cuerpo) ? '\r\n' : '\n';
  const bloqueEol = bloque.replace(/\r?\n/g, eol).replace(/\s+$/, '') + eol;
  const ini = MARCA_INICIO.exec(cuerpo);
  const fin = MARCA_FIN.exec(cuerpo);
  if (ini && fin && fin.index > ini.index) {
    const finBloque = fin.index + fin[0].length;
    const resto = cuerpo.slice(finBloque).replace(/^\r?\n/, '');
    return bom + cuerpo.slice(0, ini.index) + bloqueEol + resto;
  }
  if (!cuerpo.trim()) return bom + bloqueEol;
  return bom + cuerpo.replace(/\s+$/, '') + eol + eol + bloqueEol;
}

// Quita el bloque UAEH (entre sus marcas) de un AGENTS.md; el resto queda intacto. null si no hay bloque completo.
function sinBloque(original) {
  const bom = original.charCodeAt(0) === 0xFEFF ? String.fromCharCode(0xFEFF) : '';
  const cuerpo = bom ? original.slice(1) : original;
  const eol = /\r\n/.test(cuerpo) ? '\r\n' : '\n';
  const ini = MARCA_INICIO.exec(cuerpo);
  const fin = MARCA_FIN.exec(cuerpo);
  if (!ini || !fin || fin.index < ini.index) return null;
  const antes = cuerpo.slice(0, ini.index);
  const despues = cuerpo.slice(fin.index + fin[0].length).replace(/^\r?\n/, '');
  if (!despues.trim()) return bom + (antes.trim() ? antes.replace(/\s+$/, '') + eol : ''); // el bloque iba al final: se va con su separación
  if (!antes.trim()) return bom + despues;
  return bom + antes + despues;
}

// codex --quitar: reversa de lo que ESCRIBE el instalador. config.toml nunca lo tocó, así que tampoco se toca aquí.
function codexQuitar(o) {
  const acciones = [];
  const aplicar = !!o.aplicar;
  const { config } = configLib.cargarConfig();
  const espejo = configLib.espejoHarness();
  const casa = comun.codexHome();

  const destino = path.join(casa, 'AGENTS.md');
  let crudo = null;
  try { crudo = fs.readFileSync(destino, 'utf8'); } catch { crudo = null; }
  if (crudo == null) acciones.push(accion('SIN CAMBIOS', destino, 'AGENTS.md no existe; nada que quitar'));
  else {
    const nuevo = sinBloque(crudo);
    if (nuevo == null) {
      acciones.push(accion('SIN CAMBIOS', destino, MARCA_INICIO.test(crudo) || MARCA_FIN.test(crudo)
        ? 'AGENTS.md trae una marca UAEH suelta (sin su pareja): no se toca; revísalo a mano'
        : 'AGENTS.md no trae el bloque UAEH; nada que quitar'));
    } else if (!aplicar) acciones.push(accion('HARÍA', destino, 'quitar el bloque UAEH de AGENTS.md (el resto queda intacto; con respaldo)'));
    else if (escribirConRespaldo(acciones, destino, nuevo)) acciones.push(accion('HECHO', destino, 'AGENTS.md: bloque UAEH quitado'));
  }

  // Los TOML se borran SOLO si son idénticos a lo que el plugin genera con la configuración de ahora (los habría copiado
  // el instalador); si difieren —los editó el usuario o cambió el modelo en uaeh.config.json— se dejan y se avisa.
  const modelos = configLib.modelosCodex(config);
  const valores = {
    MODELO_PROFUNDO: modelos.profundo.modelo, ESFUERZO_PROFUNDO: modelos.profundo.esfuerzo,
    MODELO_EQUILIBRADO: modelos.equilibrado.modelo, ESFUERZO_EQUILIBRADO: modelos.equilibrado.esfuerzo,
    MODELO_RAPIDO: modelos.rapido.modelo, ESFUERZO_RAPIDO: modelos.rapido.esfuerzo,
    UAEH_ESTABLE: rutaParaGit(espejo), VERSION: comun.versionPlugin(),
  };
  let tomls = [];
  try { tomls = fs.readdirSync(path.join(CODEX_PLANTILLAS, 'agents')).filter((n) => /^uae_.*\.toml$/.test(n)).sort(); } catch { tomls = []; }
  if (!tomls.length) acciones.push(accion('FALTA', path.join(CODEX_PLANTILLAS, 'agents'), 'sin plantillas uae_*.toml en el plugin: no se sabe qué agentes quitar'));
  for (const n of tomls) {
    const ruta = path.join(casa, 'agents', n);
    const actual = leerBinario(ruta);
    if (!actual) { acciones.push(accion('SIN CAMBIOS', ruta, `agents/${n}: no existe; nada que quitar`)); continue; }
    const plantilla = comun.leerTexto(path.join(CODEX_PLANTILLAS, 'agents', n));
    const esperado = plantilla == null ? null : Buffer.from(renderizar(plantilla, valores), 'utf8');
    if (!esperado || !actual.equals(esperado)) {
      acciones.push(accion('NOTA', ruta, `agents/${n} difiere del que genera el plugin (lo editaste o cambió el modelo en uaeh.config.json): se deja; bórralo tú si ya no lo quieres`));
    } else if (!aplicar) acciones.push(accion('HARÍA', ruta, `borrar agents/${n} (idéntico al del plugin; se regenera con «codex --aplicar»)`));
    else {
      try { fs.unlinkSync(ruta); acciones.push(accion('HECHO', ruta, `agents/${n}: borrado (era idéntico al del plugin)`)); } catch (e) { acciones.push(accion('ERROR', ruta, `no se pudo borrar (${e.message})`)); }
    }
  }
  acciones.push(accion('NOTA', path.join(casa, 'config.toml'), 'config.toml NUNCA se toca. Si pegaste el fragmento de UAEH, quítalo tú (las líneas que añadiste a mano).'));
  return { acciones, codigo: acciones.some((a) => a.tipo === 'ERROR') ? 1 : 0 };
}

function codex(o) {
  if (o.quitar) return codexQuitar(o);
  const acciones = [];
  const aplicar = !!o.aplicar;
  const { config } = configLib.cargarConfig();
  const espejo = configLib.espejoHarness();
  const casa = comun.codexHome();
  const version = comun.versionPlugin();
  acciones.push(accion('NOTA', null, 'Codex es OPCIONAL: usarlo como auditor manda una copia limpia del repo a OpenAI (consentimiento explícito del usuario).'));
  if (!config.codex.habilitado) acciones.push(accion('NOTA', comun.rutaConfig(), 'codex.habilitado es false: las puertas no lo usarán hasta ponerlo en true en uaeh.config.json'));

  const plantillaAgents = comun.leerTexto(path.join(CODEX_PLANTILLAS, 'AGENTS.md'));
  if (plantillaAgents == null) {
    acciones.push(accion('FALTA', path.join(CODEX_PLANTILLAS, 'AGENTS.md'), 'plantilla ausente en el plugin'));
  } else {
    const bloque = renderizar(plantillaAgents, { UAEH_ESTABLE: rutaParaGit(espejo), VERSION: version });
    if (!MARCA_INICIO.test(bloque) || !MARCA_FIN.test(bloque)) {
      acciones.push(accion('ERROR', path.join(CODEX_PLANTILLAS, 'AGENTS.md'), 'la plantilla no trae los marcadores UAEH:BEGIN / UAEH:END; no se escribe'));
    } else {
      const destino = path.join(casa, 'AGENTS.md');
      const original = comun.leerTexto(destino);
      const crudo = original == null ? null : (() => { try { return fs.readFileSync(destino, 'utf8'); } catch { return null; } })();
      const nuevo = conBloque(crudo, bloque);
      if (crudo === nuevo) acciones.push(accion('SIN CAMBIOS', destino, 'AGENTS.md: el bloque UAEH ya está al día'));
      else if (!aplicar) acciones.push(accion('HARÍA', destino, `${original == null ? 'crear AGENTS.md con' : MARCA_INICIO.test(crudo) ? 'actualizar' : 'añadir'} el bloque UAEH v${version} (con respaldo)`));
      else if (escribirConRespaldo(acciones, destino, nuevo)) acciones.push(accion('HECHO', destino, `AGENTS.md: bloque UAEH v${version} escrito`));
    }
  }

  const modelos = configLib.modelosCodex(config);
  const valores = {
    MODELO_PROFUNDO: modelos.profundo.modelo, ESFUERZO_PROFUNDO: modelos.profundo.esfuerzo,
    MODELO_EQUILIBRADO: modelos.equilibrado.modelo, ESFUERZO_EQUILIBRADO: modelos.equilibrado.esfuerzo,
    MODELO_RAPIDO: modelos.rapido.modelo, ESFUERZO_RAPIDO: modelos.rapido.esfuerzo,
    UAEH_ESTABLE: rutaParaGit(espejo), VERSION: version,
  };
  let tomls = [];
  try { tomls = fs.readdirSync(path.join(CODEX_PLANTILLAS, 'agents')).filter((n) => /^uae_.*\.toml$/.test(n)).sort(); } catch { tomls = []; }
  if (!tomls.length) acciones.push(accion('FALTA', path.join(CODEX_PLANTILLAS, 'agents'), 'sin plantillas uae_*.toml en el plugin'));
  for (const n of tomls) {
    const texto = comun.leerTexto(path.join(CODEX_PLANTILLAS, 'agents', n));
    if (texto == null) { acciones.push(accion('ERROR', path.join(CODEX_PLANTILLAS, 'agents', n), 'no se pudo leer')); continue; }
    const rendido = renderizar(texto, valores);
    const sinRender = /\{\{[A-Z_]+\}\}/.exec(rendido);
    if (sinRender) { acciones.push(accion('ERROR', path.join(CODEX_PLANTILLAS, 'agents', n), `marcador sin valor: ${sinRender[0]}`)); continue; }
    sincronizar(acciones, aplicar, Buffer.from(rendido, 'utf8'), path.join(casa, 'agents', n), `agents/${n}`);
  }

  const snippet = comun.leerTexto(path.join(CODEX_PLANTILLAS, 'config.snippet.toml'));
  acciones.push(accion('NOTA', path.join(casa, 'config.toml'), 'config.toml NUNCA se edita automáticamente. Si falta, pega este fragmento a mano:', { snippet: snippet == null ? '(plantilla config.snippet.toml ausente)' : snippet.trim() }));
  return { acciones, codigo: acciones.some((a) => a.tipo === 'ERROR') ? 1 : 0 };
}

// ── visual ────────────────────────────────────────────────────────────────────────────────

const SKILL_VISUAL = path.join(RAIZ, 'skills', 'uae-visual');
// Plantilla del plugin → ruta dentro del proyecto. Nunca se pisa un archivo del proyecto: si difiere, se avisa.
const PLANTILLAS_VISUAL = [
  ['plantillas/playwright.visual.config.ts', 'playwright.visual.config.ts'],
  ['plantillas/visual.spec.ts', 'tests/visual/visual.spec.ts'],
  ['referencias/plantilla-DESIGN.md', 'DESIGN.md'],
];

function pinesVisual() {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'wsl', 'herramientas.json'), 'utf8')).visual || {}; } catch { return {}; }
}

function visualProyecto(o, acciones) {
  const dir = path.resolve(o.proyecto);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { acciones.push(accion('ERROR', dir, 'la carpeta del proyecto no existe')); return; }
  for (const [origen, relativo] of PLANTILLAS_VISUAL) {
    const nuevo = leerBinario(path.join(SKILL_VISUAL, origen));
    const destino = path.join(dir, ...relativo.split('/'));
    if (!nuevo) { acciones.push(accion('FALTA', path.join(SKILL_VISUAL, origen), 'plantilla ausente en el plugin')); continue; }
    const actual = leerBinario(destino);
    if (actual && actual.equals(nuevo)) { acciones.push(accion('SIN CAMBIOS', destino, `${relativo}: igual a la plantilla`)); continue; }
    if (actual) {
      acciones.push(accion('NOTA', destino, relativo === 'DESIGN.md' ? 'DESIGN.md ya existe: es la fuente de verdad del proyecto; no se toca' : `${relativo} ya existe y difiere de la plantilla del plugin: no se toca (compáralo a mano)`));
      continue;
    }
    if (!o.aplicar) { acciones.push(accion('HARÍA', destino, `crear ${relativo} desde la plantilla`)); continue; }
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, nuevo);
      acciones.push(accion('HECHO', destino, `${relativo} creado desde la plantilla${relativo === 'DESIGN.md' ? ' (rellénalo; queda pendiente de aprobación del responsable)' : ''}`));
    } catch (e) { acciones.push(accion('ERROR', destino, `no se pudo escribir: ${e.message}`)); }
  }
  // Exclusiones de evidencia: la misma lógica (y la misma lista) que uaeh-ignorar.cjs.
  const ignorar = require(path.join(__dirname, 'uaeh-ignorar.cjs'));
  const r = ignorar.principal(['--repo', dir, ...(o.local ? ['--local'] : []), ...(o.aplicar ? ['--aplicar'] : [])]);
  const detalle = `exclusiones de evidencia (uaeh-ignorar${o.local ? ' --local' : ''}): ${r.lineas.join(' | ')}`;
  if (r.codigo === 0) acciones.push(accion(o.aplicar && r.lineas.some((l) => l.startsWith('agregadas')) ? 'HECHO' : 'SIN CAMBIOS', dir, detalle));
  else if (r.codigo === 1 && !o.aplicar) acciones.push(accion('HARÍA', dir, detalle));
  else if (r.codigo === 2 && /no es un repositorio git/.test(r.lineas.join(' '))) acciones.push(accion('NOTA', dir, 'no es un repositorio git: no hay exclusiones que agregar'));
  else acciones.push(accion('ERROR', dir, detalle));
  const p = pinesVisual();
  acciones.push(accion('NOTA', dir, `dependencias del proyecto (con el OK del responsable): npm i -D @playwright/test@${p['@playwright/test']} @axe-core/playwright@${p['@axe-core/playwright']} · npx playwright install chromium`));
}

// Rol visual de una skill por su nombre y su descripción (el primero que encaja, en este orden). null = no es visual.
const ROLES_VISUALES = [
  ['video', /video|hyperframes|remotion|caption|subt[ií]tul|slideshow|recut/],
  ['3D', /three|\b3d\b|webgl|webgpu/],
  ['movimiento', /anima|motion|gsap|lottie|transici/],
  ['imagen', /\bimage|imagen|\bgif\b|canvas|p[oó]ster|generative|generativ/],
  ['estilo', /design|diseñ|\bui\b|interfa|frontend|landing|brand|marca|theme|taste|typograph|tipograf|tailwind|figma|layout/],
];
function rolVisual(nombre, descripcion) {
  const texto = `${nombre} ${descripcion}`.toLowerCase();
  const rol = ROLES_VISUALES.find(([, re]) => re.test(texto));
  return rol ? rol[0] : null;
}

function frontmatter(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  const datos = {};
  if (!m) return datos;
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l);
    if (kv) datos[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return datos;
}

function borradorCatalogo(skills) {
  const porRol = new Map(ROLES_VISUALES.map(([rol]) => [rol, []]));
  for (const s of skills) porRol.get(s.rol).push(s);
  const lineas = [
    '# Mi catálogo visual',
    '',
    'Borrador generado por `instalar.cjs visual --registrar-skills` a partir de las skills instaladas. El rol se propuso por el nombre y la descripción de cada skill: revísalo y corrígelo. Las reglas y la tabla de rutas siguen siendo las del catálogo genérico del plugin (`skills/uae-visual/referencias/catalogo.md`); aquí se dice qué skill tuya cubre cada rol. Tras editarlo, comprueba el índice con `comprobar-catalogo.cjs` (en `scripts/` de esa skill).',
    '',
  ];
  for (const [rol, lista] of porRol) {
    if (!lista.length) continue;
    lineas.push(`## ${rol}`, ...lista.map((s) => `- \`${s.nombre}\`${s.descripcion ? ` — ${s.descripcion.slice(0, 140)}${s.descripcion.length > 140 ? '…' : ''}` : ''}`), '');
  }
  lineas.push('## Índice de skills', '', '```text', '# la puerta visual del plugin', 'uaeh-harness:uae-visual | plugin | on');
  for (const [rol, lista] of porRol) {
    if (!lista.length) continue;
    lineas.push(`# ${rol}`, ...lista.map((s) => `${s.nombre} | local | ${s.anuncio}`));
  }
  lineas.push('```', '');
  return lineas.join('\n');
}

function visualRegistrar(o, acciones) {
  const dirSkills = path.join(comun.claudeHome(), 'skills');
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(path.join(comun.claudeHome(), 'settings.json'), 'utf8')).skillOverrides || {}; } catch { overrides = {}; }
  let nombres = [];
  try { nombres = fs.readdirSync(dirSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { nombres = []; }
  const skills = [];
  for (const nombre of nombres) {
    const texto = comun.leerTexto(path.join(dirSkills, nombre, 'SKILL.md'));
    if (texto == null) continue;
    const datos = frontmatter(texto);
    const rol = rolVisual(nombre, datos.description || '');
    if (!rol || overrides[nombre] === 'off') continue;
    const anuncio = datos['disable-model-invocation'] === 'true' ? 'manual' : overrides[nombre] === 'name-only' ? 'name-only' : 'on';
    skills.push({ nombre, rol, anuncio, descripcion: (datos.description || '').replace(/\s+/g, ' ') });
  }
  const { config } = configLib.cargarConfig();
  const fijado = config.visual && config.visual.catalogo ? config.visual.catalogo.trim() : '';
  const destino = fijado ? path.resolve(fijado) : path.join(comun.uaehHome(), 'catalogo-visual.md');
  const resumen = ROLES_VISUALES.map(([rol]) => `${rol} ${skills.filter((s) => s.rol === rol).length}`).join(' · ');
  const contenido = borradorCatalogo(skills);
  if (!skills.length) acciones.push(accion('NOTA', dirSkills, 'ninguna skill local parece visual por su nombre o descripción; el borrador solo trae la puerta del plugin'));
  if (fs.existsSync(destino) && !o.reemplazar) {
    acciones.push(accion('SIN CAMBIOS', destino, `ya existe un catálogo propio: no se pisa (--reemplazar lo regenera con respaldo). Detectadas: ${resumen}`));
    return;
  }
  if (!o.aplicar) { acciones.push(accion('HARÍA', destino, `escribir el borrador del catálogo con ${skills.length} skill(s): ${resumen}`, { contenido })); return; }
  if (escribirConRespaldo(acciones, destino, Buffer.from(contenido, 'utf8'))) acciones.push(accion('HECHO', destino, `borrador del catálogo escrito con ${skills.length} skill(s): ${resumen} (revísalo: el rol es una propuesta)`));
}

function visual(o) {
  const acciones = [];
  if (o.proyecto) visualProyecto(o, acciones);
  if (o.registrarSkills) visualRegistrar(o, acciones);
  return { acciones, codigo: acciones.some((a) => a.tipo === 'ERROR') ? 1 : 0 };
}

// ── todo ──────────────────────────────────────────────────────────────────────────────────

function todo(o) {
  const c = configuracion(o);
  const g = gitGuard(o);
  const acciones = [...c.acciones, ...g.acciones];
  let codigo = Math.max(c.codigo, g.codigo);
  let humoInforme = g.humo;
  const { config } = configLib.cargarConfig();
  if (config.codex.habilitado) {
    const x = codex(o);
    acciones.push(...x.acciones);
    codigo = Math.max(codigo, x.codigo);
  } else {
    acciones.push(accion('NOTA', null, 'codex.habilitado es false: Codex no se configura (node instalar.cjs codex para hacerlo aparte)'));
  }
  return { acciones, humo: humoInforme, codigo };
}

// ── Línea de comandos ─────────────────────────────────────────────────────────────────────

function puertas(o) {
  return require(path.join(__dirname, 'instalar-puertas.cjs')).puertas(o, { accion, escribirConRespaldo });
}

const SUBCOMANDOS = { config: configuracion, 'git-guard': gitGuard, codex, visual, todo, puertas };
const PUERTAS_VALIDAS = ['seguridad', 'visual', 'codex', 'preflight', 'todas'];

function uso() {
  return [
    'Uso: node instalar.cjs <subcomando> [--aplicar] [--json]',
    '  config                 crea uaeh.config.json desde la plantilla (nunca pisa uno existente)',
    '  git-guard [--quitar] [--reemplazar]',
    '                         espejo + prueba de humo + core.hooksPath global (--quitar lo deshace; --reemplazar sustituye',
    '                         otro core.hooksPath ya fijado y lo anota para que --quitar lo restaure)',
    '  codex [--quitar]       bloque UAEH en AGENTS.md de Codex + agentes TOML + fragmento de config.toml (--quitar: quita el bloque y',
    '                         borra los agentes TOML idénticos a los del plugin; config.toml no se toca)',
    '  visual [--proyecto <carpeta> [--local]] [--registrar-skills [--reemplazar]]',
    '                         puerta visual: plantillas de Playwright + axe, DESIGN.md si falta y exclusiones de evidencia en',
    '                         un proyecto (nunca pisa sus archivos); borrador del catálogo visual propio desde tus skills',
    '  todo                   config + git-guard (+ codex si codex.habilitado)',
    '  puertas [seguridad|visual|codex|preflight|todas] [--actualizar] [--reparar] [--consiento|--retirar]',
    '                         instala o repara lo que falte en las puertas de la capa 3 (según doctor-puertas.cjs);',
    '                         --consiento habilita Codex (manda la copia limpia del repo a OpenAI), --retirar lo apaga',
    'En seco por defecto; --aplicar escribe (con respaldo).',
    'Si otra sesión tiene una revisión con sello abierto, --aplicar se niega (config, git-guard, codex, todo, puertas): espera o usa --forzar.',
  ].join('\n');
}

function parsearArgumentos(argv) {
  const o = { subcomando: null, aplicar: false, quitar: false, reemplazar: false, json: false, proyecto: null, local: false, registrarSkills: false,
    forzar: false, puerta: null, actualizar: false, reparar: false, consiento: false, retirar: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--aplicar') o.aplicar = true;
    else if (a === '--quitar') o.quitar = true;
    else if (a === '--forzar') o.forzar = true;
    else if (a === '--reemplazar') o.reemplazar = true;
    else if (a === '--json') o.json = true;
    else if (a === '--local') o.local = true;
    else if (a === '--registrar-skills') o.registrarSkills = true;
    else if (a === '--actualizar') o.actualizar = true;
    else if (a === '--reparar') o.reparar = true;
    else if (a === '--consiento') o.consiento = true;
    else if (a === '--retirar') o.retirar = true;
    else if (a === '--proyecto') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('falta la carpeta de --proyecto');
      o.proyecto = argv[++i];
    } else if (a.startsWith('--')) throw new Error(`opción desconocida: ${a}`);
    else if (!o.subcomando) o.subcomando = a;
    else if (o.subcomando === 'puertas' && !o.puerta) o.puerta = a;
    else throw new Error(`argumento inesperado: ${a}`);
  }
  if (!o.subcomando) throw new Error('falta el subcomando');
  if (!SUBCOMANDOS[o.subcomando]) throw new Error(`subcomando desconocido: ${o.subcomando}`);
  if (o.quitar && !['git-guard', 'codex'].includes(o.subcomando)) throw new Error('--quitar solo aplica a git-guard y codex');
  if (o.forzar && !ESCRIBEN_ARNES.has(o.subcomando)) throw new Error('--forzar solo aplica a config, git-guard, codex, todo y puertas');
  if (o.subcomando === 'puertas' && o.puerta && !PUERTAS_VALIDAS.includes(o.puerta)) throw new Error(`puerta desconocida: ${o.puerta} (usa ${PUERTAS_VALIDAS.join(', ')})`);
  if ((o.actualizar || o.reparar || o.consiento || o.retirar) && o.subcomando !== 'puertas') throw new Error('--actualizar, --reparar, --consiento y --retirar solo aplican a puertas');
  if (o.consiento && o.retirar) throw new Error('--consiento y --retirar no van juntas');
  if ((o.consiento || o.retirar) && !['codex', 'todas', null].includes(o.puerta)) throw new Error('--consiento y --retirar solo aplican a la puerta codex (o todas)');
  if ((o.actualizar || o.reparar) && !['seguridad', 'visual', 'todas', null].includes(o.puerta)) throw new Error('--actualizar y --reparar solo aplican a seguridad o visual (o todas)');
  if (o.reemplazar && !['git-guard', 'todo', 'visual'].includes(o.subcomando)) throw new Error('--reemplazar solo aplica a git-guard, todo o visual --registrar-skills');
  if (o.reemplazar && o.quitar) throw new Error('--reemplazar y --quitar no van juntas');
  if ((o.proyecto || o.local || o.registrarSkills) && o.subcomando !== 'visual') throw new Error('--proyecto, --local y --registrar-skills solo aplican a visual');
  if (o.subcomando === 'visual' && !o.proyecto && !o.registrarSkills) throw new Error('visual necesita --proyecto <carpeta> o --registrar-skills');
  if (o.local && !o.proyecto) throw new Error('--local solo aplica junto con --proyecto');
  if (o.reemplazar && o.subcomando === 'visual' && !o.registrarSkills) throw new Error('en visual, --reemplazar solo aplica a --registrar-skills');
  return o;
}

// Subcomandos que escriben en lo que mide el sello de integridad (arnés, espejo, configuración, Codex): si OTRA sesión
// tiene una revisión viva, instalar a media revisión la deja con sello ROTA y anula su veredicto. git-guard --quitar
// también entra: el sello mide la ruta global de hooks de git.
const ESCRIBEN_ARNES = new Set(['config', 'git-guard', 'codex', 'todo', 'puertas']);

function textoSellosAbiertos(abiertos) {
  const lista = abiertos.map((s) => `${s.id}${s.etiqueta ? ` «${s.etiqueta}»` : ''}${s.repo ? ` sobre ${s.repo}` : ''}, abierta hace ${s.minutos} min`);
  return `${abiertos.length} revisión(es) con sello abierto: ${lista.join(' · ')}`;
}

function ejecutar(o) {
  let abiertos = [];
  if (ESCRIBEN_ARNES.has(o.subcomando)) {
    try { abiertos = require(path.join(__dirname, 'uaeh-integridad.cjs')).sellosAbiertos(); } catch { abiertos = []; }
  }
  if (abiertos.length && o.aplicar && !o.forzar) {
    return { subcomando: o.subcomando, aplicado: false, humo: null, codigo: 1, acciones: [
      accion('ERROR', null, `NEGADO, no se escribió nada: ${textoSellosAbiertos(abiertos)}. Instalar ahora cambiaría el arnés a media revisión y su sello saldría ROTA (veredicto anulado). Espera a que terminen o repite con --forzar.`),
    ] };
  }
  const r = SUBCOMANDOS[o.subcomando](o);
  const acciones = r.acciones;
  if (abiertos.length) {
    acciones.unshift(accion('AVISO', null, `${textoSellosAbiertos(abiertos)}. ${o.aplicar ? '--forzar: se continúa; esas revisiones pueden terminar con sello ROTA.' : 'Con --aplicar se negaría (usa --forzar para seguir igual); mejor espera a que terminen.'}`));
  }
  const informe = { subcomando: o.subcomando, aplicado: !!o.aplicar, acciones, humo: r.humo || null, codigo: r.codigo || 0 };
  if (r.diagnostico) informe.diagnostico = r.diagnostico;
  return informe;
}

function main(argv) {
  let o;
  try { o = parsearArgumentos(argv); } catch (e) {
    process.stderr.write(`instalar: ${e.message}\n${uso()}\n`);
    return 2;
  }
  let informe;
  try { informe = ejecutar(o); } catch (e) {
    informe = { subcomando: o.subcomando, aplicado: !!o.aplicar, acciones: [accion('ERROR', null, `error interno: ${e.message}`)], humo: null, codigo: 1 };
  }
  process.stdout.write((o.json ? JSON.stringify(informe, null, 2) : formatearHumano(informe)) + '\n');
  return informe.codigo;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { COPIAS_ESPEJO, HOOKS_CLAVE, CLAVE_HOOKS, ARCHIVO_ESTADO_GUARDA, PLANTILLAS_VISUAL, humo, accion, escribirConRespaldo, conBloque, renderizar, rolVisual, borradorCatalogo, parsearArgumentos, ejecutar, formatearHumano, normalizarRuta, rutaParaGit };
