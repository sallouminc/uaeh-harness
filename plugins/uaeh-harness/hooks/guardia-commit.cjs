#!/usr/bin/env node
// GUARDIA DE COMMITS EN GIT (UAEH F2, ciclo 6, B19/B25) — capa 2 de la guardia de commits.
//
// Uso (lo llaman los hooks de git-hooks/, la carpeta hermana de esta: es la guarda global, la que apunta core.hooksPath):
//   node guardia-commit.cjs contenido                 → revisa lo que se va a commitear (índice real de git) y que el
//                                                       COMMITTER no sea Claude (esto último, solo con la política
//                                                       `prohibir`). Lo llaman prepare-commit-msg y pre-applypatch.
//                                                       (`pre-commit` = alias de `contenido`.)
//   node guardia-commit.cjs commit-msg <archivo>      → mensaje FINAL sin crédito de Claude y AUTOR que no sea Claude
//                                                       (autor: GIT_AUTHOR_NAME/EMAIL que exporta git commit; si no
//                                                       vienen, como en un merge, `git var GIT_AUTHOR_IDENT`).
//   node guardia-commit.cjs applypatch-msg <archivo>  → lo mismo para `git am` (autor: rebase-apply/author-script).
//
// POLÍTICA DE COMMITS (lib/config.cjs: commits.credito en uaeh.config.json o UAEH_COMMIT_CREDITO): por defecto `permitir`.
// Solo con `prohibir` se revisan la IDENTIDAD de Claude (autor y committer) y el CRÉDITO de Claude en el mensaje
// (credito-local, revisarMensaje, la salida 3). Secretos, archivos sensibles y evidencias del navegador se revisan SIEMPRE.
// Si la política no se puede cargar → `permitir` (el valor por defecto).
//
// POR QUÉ prepare-commit-msg (medido con git 2.53): es el único hook que corre en commit normal, amend, `--no-verify`/-n,
// cherry-pick, revert, rebase (cada commit, también `--continue` tras conflicto y `rebase -i` edit) y merge; pre-commit y
// commit-msg NO corren en cherry-pick/revert/rebase ni con --no-verify. `git am` no corre ninguno de los tres: usa
// applypatch-msg + pre-applypatch. git ya fijó el árbol del commit ANTES de prepare-commit-msg (lo que un hook cambie en el
// índice después no se commitea; medido), por eso el despachador revisa ANTES del prepare-commit-msg local. En `am` el
// árbol se escribe DESPUÉS de pre-applypatch, por eso ahí se revisa DESPUÉS del local.
// El crédito de Claude se revisa en commit-msg y applypatch-msg (commits y parches nuevos). CICLO 7 (C2): como `commit -n`
// se salta commit-msg, prepare-commit-msg (`contenido <archivo> <fuente>`) también revisa AUTOR y CRÉDITO, pero SOLO si el
// mensaje es nuevo ($2 vacío, message o template) y no hay archivo de origen: un cherry-pick/rebase de historial con
// crédito (hay cientos así), un --amend/-c/-C ($2 = commit), un merge o un squash no se frenan ahí. Si hay crédito
// (salida 3), el despachador corre el commit-msg LOCAL del repo sobre una COPIA del mensaje (`credito-local`): si el
// local lo quita (la firma del proyecto), se quita ya del mensaje real (con -n el local no correría); si no, se niega.
// CICLO 7 (C4b): todo git de esta guarda corre con GIT_NO_REPLACE_OBJECTS=1 (`git replace` no oculta contenido).
// CICLO 7 (C4c): pre-applypatch revisa el contenido ANTES y DESPUÉS del hook local (si hay local).
// RESIDUALES del C2: crédito escrito en el editor o por GIT_EDITOR, heredado con -c/-C/--amend, o agregado por un
// prepare-commit-msg LOCAL, junto con -n; `git am -n` en un script (sin revisión: lo niega solo la capa de texto).
//
// REGLA DE ORIGEN: si existe MERGE_HEAD (uno o varios), CHERRY_PICK_HEAD, REBASE_HEAD o REVERT_HEAD en la carpeta git del
// árbol de trabajo, un hallazgo solo cuenta si está en el diff del índice contra HEAD Y TAMBIÉN contra cada origen (los
// MERGE_HEAD; el commit de CHERRY_PICK_HEAD/REBASE_HEAD; para REVERT_HEAD, su padre). Clave del hallazgo: ruta + texto de
// la línea añadida (sin número de línea) + tipo; archivos sensibles y evidencias: ruta presente en ambos diffs (= blob
// distinto). Lo que ya estaba en un origen es HISTORIAL (fuera de alcance, declarado); lo que sale de resolver un conflicto
// o de un `git add` durante `--continue` es nuevo y se niega. Sin esos archivos → contra HEAD (primer commit: todo).
//
// Corre DENTRO del proceso real de git: hereda su entorno (GIT_DIR, GIT_INDEX_FILE del índice temporal de -a/-o/rutas,
// GIT_WORK_TREE…) y su carpeta; NUNCA usa -C ni reescribe esas variables. Reutiliza las reglas de guardia-git.js
// (archivoSensible, evidenciaVisual, tiposEnTexto/parsearDiff, CREDITO): no se duplican.
// Hallazgos → stderr con ruta:línea y tipo (NUNCA el valor del secreto) y salida 1 (git cancela el commit).
// FALLA CERRADO: cualquier error (git falla, no se puede leer, no carga guardia-git.js, estado ilegible) → salida 1.
//
// B25 (contenido que git trata como binario): un archivo añadido/modificado que git marca como binario (numstat «-») se lee
// del índice y, si es UTF-16 (BOM FF FE / FE FF o NUL alternos: lo que escribe PowerShell 5.1 con `>`/Out-File) o texto
// sin NUL (marcado `-diff`/`binary` en .gitattributes), se DECODIFICA y se escanea por líneas (añadidas = las que no
// estaban en la versión base), hasta TOPE_BYTES.
// RESIDUALES declarados: binarios reales (con NUL, no UTF-16) o de más de TOPE_BYTES no se escanean por contenido
// (gitleaks/trufflehog en /uae-security; .env y llaves por NOMBRE sí se ven); el contenido real de Git LFS (al índice va
// solo el puntero); lo que ya estaba en un origen (historial) o en el commit que se enmienda (--amend); un archivo de
// estado (CHERRY_PICK_HEAD…) escrito a mano que apunte a un commit fabricado (stash o plomería); repos reftable (los
// pseudo-refs no son archivos → se aplica la regla normal, más estricta); diff de más de MAX_DIFF → «divide el commit».
//
// RECUPERACIÓN si los hooks de git se vuelven un estorbo (p. ej. Git Bash roto por el antivirus: los hooks no arrancan y
// TODO commit falla cerrado): en tu propia terminal, `git config --global --unset core.hooksPath`.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_DIFF = 64 * 1024 * 1024; // bytes de diff que se leen (más → «divide el commit»)
const TIEMPO_MS = 30000;
const ORIGENES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'REVERT_HEAD'];
const MOTIVO_IDENTIDAD = (quien, valor) =>
  'Guardia UAEH: el ' + quien + ' del commit es Claude (' + valor + ') y la política de commits de este usuario lo prohíbe. ' +
  'Quita --author / GIT_AUTHOR_* / GIT_COMMITTER_* o corrige user.name / user.email.';

// Política de commits (ver el encabezado): solo con `prohibir` se revisan la identidad y el crédito de Claude.
// Cualquier error al cargarla → permitir.
let PROHIBIR_CREDITO = false;
try {
  const configLib = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.cjs'));
  PROHIBIR_CREDITO = configLib.politicaCommits(configLib.cargarConfig().config).prohibir === true;
} catch { PROHIBIR_CREDITO = false; }

function fallar(motivo) {
  process.stderr.write(String(motivo).replace(/\s+$/, '') + '\n');
  process.exit(1);
}

let g;
try {
  g = require('./guardia-git.js');
} catch (e) {
  fallar('Guardia UAEH (git): no se pudo cargar guardia-git.js (hermano de este archivo) → commit negado (falla cerrado). Revisa ese archivo.');
}
const TOPE_BYTES = g.TOPE_BYTES;

// git con el entorno y la carpeta de git (heredados). Sin -C, sin tocar GIT_*. Asíncrono: las lecturas corren a la vez
// (cada proceso de git cuesta ~75 ms en Windows). `entrada` = texto para stdin; `binario` = devuelve Buffer.
function git(args, entrada, binario) {
  return new Promise((resolve, reject) => {
    // GIT_NO_REPLACE_OBJECTS (ciclo 7, C4b; uae-security c6 SEC-005): `git replace HEAD <commit con .env>` haría que el
    // diff contra HEAD no viera el .env nuevo; el árbol del commit sale del índice y sí lo llevaría.
    const hijo = execFile('git', ['-c', 'core.quotepath=false', ...args], {
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      encoding: binario ? 'buffer' : 'utf8', timeout: TIEMPO_MS, maxBuffer: MAX_DIFF, windowsHide: true,
    }, (e, stdout, stderr) => { if (e) { e.stderr = String(stderr || ''); reject(e); } else resolve(stdout); });
    hijo.stdin.end(entrada === undefined ? undefined : entrada);
  });
}

function motivoDeError(e) {
  if (e && (e.code === 'ENOBUFS' || e.code === 'ETIMEDOUT' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e.killed || /maxBuffer/i.test(String(e.message)))) {
    return 'Guardia UAEH (git): el commit es demasiado grande para revisar secretos a tiempo: divide el commit en partes más pequeñas.';
  }
  const stderr = e && e.stderr ? String(e.stderr) : '';
  const primera = (stderr.split(/\r?\n/).find((l) => l.trim()) || (e && e.motivo) || (e && (e.code || e.signal)) || 'error desconocido').toString();
  return 'Guardia UAEH (git): no se pudo revisar el commit (' + primera.trim().slice(0, 80) + ') → negado (falla cerrado).';
}

// Carpeta git del árbol de trabajo (la de los worktrees es propia: MERGE_HEAD… viven ahí). Igual que los despachadores:
// GIT_DIR, o .git (carpeta o archivo «gitdir: »), o el propio repo desnudo; si no, se le pregunta a git.
async function carpetaGit() {
  if (process.env.GIT_DIR) return path.resolve(process.env.GIT_DIR);
  try {
    const st = fs.statSync('.git');
    if (st.isDirectory()) return path.resolve('.git');
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync('.git', 'utf8'));
    if (m) return path.resolve(m[1]);
  } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  return path.resolve((await git(['rev-parse', '--git-dir'])).trim());
}

// Orígenes del commit en curso (regla de origen). Archivo ausente → no cuenta; presente e ilegible → error (falla cerrado).
function leerOrigenes(gd) {
  const revs = [];
  for (const f of ORIGENES) {
    let txt;
    try { txt = fs.readFileSync(path.join(gd, f), 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
    const lista = txt.split(/\r?\n/).map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
    if (!lista.length || lista.some((s) => !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(s))) {
      const e = new Error('estado ilegible'); e.motivo = f + ' ilegible'; throw e;
    }
    for (const s of lista) revs.push(f === 'REVERT_HEAD' ? s + '^' : s);
  }
  return revs;
}

// UTF-16 (BOM o NUL alternos) → texto; sin NUL → texto UTF-8; binario real → null (residual).
function decodificar(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const muestra = buf.subarray(0, Math.min(buf.length, 4096) & ~1);
  if (muestra.length >= 4) {
    let par = 0, impar = 0;
    for (let i = 0; i < muestra.length; i++) if (muestra[i] === 0) { if (i & 1) impar++; else par++; }
    const mitad = muestra.length / 2;
    if (impar >= mitad * 0.9 && par === 0) return buf.subarray(0, buf.length & ~1).toString('utf16le');
    if (par >= mitad * 0.9 && impar === 0) return Buffer.from(buf.subarray(0, buf.length & ~1)).swap16().toString('utf16le');
  }
  if (!buf.subarray(0, 8192).includes(0)) return buf.toString('utf8');
  return null;
}

// Lee objetos («:ruta» del índice, «rev:ruta») con cat-file. Ausentes → null; más de TOPE_BYTES → 'grande'.
async function leerObjetos(specs) {
  const res = new Map();
  if (!specs.length) return res;
  const chk = (await git(['cat-file', '--batch-check'], specs.join('\n') + '\n')).split('\n');
  const pedir = [];
  specs.forEach((s, i) => {
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(chk[i] || '');
    if (!m || m[1] !== 'blob') res.set(s, null);
    else if (Number(m[2]) > TOPE_BYTES) res.set(s, 'grande');
    else pedir.push(s);
  });
  if (!pedir.length) return res;
  const out = await git(['cat-file', '--batch'], pedir.join('\n') + '\n', true);
  let pos = 0;
  for (const s of pedir) {
    const fin = out.indexOf(10, pos);
    const cab = out.subarray(pos, fin).toString('utf8');
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(cab);
    if (!m) { const e = new Error('cat-file'); e.motivo = 'no se pudo leer ' + s; throw e; }
    const tam = Number(m[1]);
    res.set(s, out.subarray(fin + 1, fin + 1 + tam));
    pos = fin + 1 + tam + 1;
  }
  return res;
}

// Hallazgos del índice contra `base` (null = HEAD, o el árbol vacío en el primer commit). Cada hallazgo: { texto, clave }.
async function hallazgosContra(base) {
  const comun = ['diff', '--cached', '--src-prefix=a/', '--dst-prefix=b/', ...(base ? [base] : [])];
  const [numstat, diff] = await Promise.all([
    git([...comun, '--numstat', '-z', '--diff-filter=d']),
    git([...comun, ...g.DIFF_BASE]),
  ]);
  const lista = [];
  const visto = new Set();
  const anotar = (texto, clave) => { const k = clave || texto; if (!visto.has(k)) { visto.add(k); lista.push({ texto, clave: k }); } };
  const binarios = [];
  const partes = numstat.split('\0');
  for (let i = 0; i < partes.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(partes[i]);
    if (!m) continue;
    let nom = m[3];
    if (nom === '') { nom = partes[i + 2]; i += 2; } // renombre/copia: «a\td\t\0viejo\0nuevo»
    if (!nom) continue;
    if (g.archivoSensible(nom)) anotar(nom + ' (archivo sensible)', 'F\0' + nom);
    if (g.evidenciaVisual(nom)) anotar(nom + g.MARCA_EVIDENCIA, 'E\0' + nom);
    if (m[1] === '-') binarios.push(nom);
  }
  g.parsearDiff(diff, anotar);
  if (binarios.length) {
    if (binarios.some((b) => /[\r\n]/.test(b))) { const e = new Error('ruta'); e.motivo = 'ruta binaria con salto de línea'; throw e; }
    const viejo = (nom) => (base || 'HEAD') + ':' + nom;
    const objs = await leerObjetos([...binarios.map((b) => ':' + b), ...binarios.map(viejo)]);
    for (const nom of binarios) {
      const nuevo = objs.get(':' + nom);
      if (!nuevo || nuevo === 'grande') continue; // binario > TOPE_BYTES: residual declarado
      const texto = decodificar(nuevo);
      if (texto === null) continue; // binario real: residual declarado
      const ant = objs.get(viejo(nom));
      const previas = new Set(ant && ant !== 'grande' ? (decodificar(ant) || '').split('\n').map((l) => l.replace(/\r$/, '')) : []);
      texto.split('\n').forEach((l, i) => {
        const lin = l.replace(/\r$/, '');
        if (previas.has(lin)) return;
        for (const tipo of g.tiposEnTexto(lin)) anotar(nom + ':' + (i + 1) + ' (' + tipo + ')', nom + '\0' + lin + '\0' + tipo);
      });
    }
  }
  return lista;
}

function identidadClaude(nombre, correo) {
  return /(?<![\w-])claude(?![\w-])/i.test(nombre || '') || /noreply@anthropic\.com/i.test(correo || '');
}
// «Nombre <correo> fecha zona» (git var)
function partirIdent(id) {
  const m = /^(.*?)\s*<([^>]*)>/.exec(String(id || '').trim());
  return m ? { nombre: m[1], correo: m[2] } : { nombre: String(id || ''), correo: '' };
}

// `archivo`/`fuente` = $1/$2 de prepare-commit-msg (pre-applypatch no los pasa).
async function contenido(archivo, fuente) {
  const gd = await carpetaGit();
  const origenes = leerOrigenes(gd);
  // El COMMITTER que es Claude solo se niega con la política `prohibir` (sin ella no se consulta la identidad).
  const [hallados, committer] = await Promise.all([hallazgosContra(null), PROHIBIR_CREDITO ? git(['var', 'GIT_COMMITTER_IDENT']) : '']);
  if (PROHIBIR_CREDITO) {
    const c = partirIdent(committer);
    if (identidadClaude(c.nombre, c.correo)) fallar(MOTIVO_IDENTIDAD('committer', c.nombre + ' <' + c.correo + '>'));
  }
  let lista = hallados;
  for (const o of origenes) {
    if (!lista.length) break;
    const claves = new Set((await hallazgosContra(o)).map((h) => h.clave));
    lista = lista.filter((h) => claves.has(h.clave)); // lo que ya estaba en el origen es historial
  }
  const motivo = g.motivoHallazgos(lista.map((h) => h.texto));
  if (motivo) fallar(motivo);
  // CICLO 7 (C2, verificador B c6 V-B03): `git commit -n` (que la capa de texto no vea: script, npm script) se salta
  // commit-msg. Si el mensaje es NUEVO ($2 vacío, message o template) y no hay archivo de origen, aquí se revisan también
  // el AUTOR y el crédito. Con $2 = commit (--amend, -c/-C), merge o squash el mensaje viene del historial: no se revisa
  // aquí (sigue commit-msg). Solo con la política `prohibir`.
  if (PROHIBIR_CREDITO && archivo && (!fuente || fuente === 'message' || fuente === 'template') && !origenes.length) {
    await revisarAutor();
    const texto = fs.readFileSync(archivo, 'utf8');
    // Crédito → SALIDA_CREDITO: el despachador prueba si el commit-msg LOCAL del repo lo quita (credito-local).
    if (g.CREDITO.some((re) => re.test(texto))) process.exit(SALIDA_CREDITO);
  }
}
const SALIDA_CREDITO = 3;

// CICLO 7 (C2): mensaje nuevo con crédito. `simulado` = copia del mensaje tras correr el commit-msg LOCAL del repo (o el
// propio mensaje si no hay local). Si el local NO quita el crédito → se niega. Si lo quita (la firma del proyecto), se
// quita YA del mensaje real: con -n el commit-msg no correría y el crédito entraría.
function creditoLocal(archivo, simulado) {
  if (!archivo || !simulado) fallar('Guardia UAEH (git): credito-local sin archivos → commit negado (falla cerrado).');
  if (!PROHIBIR_CREDITO) return; // sin la política `prohibir` no hay crédito que quitar ni que negar
  if (g.CREDITO.some((re) => re.test(fs.readFileSync(simulado, 'utf8')))) fallar(g.MOTIVO_CREDITO);
  const limpio = fs.readFileSync(archivo, 'utf8').split('\n').filter((l) => !g.CREDITO.some((re) => re.test(l))).join('\n');
  if (g.CREDITO.some((re) => re.test(limpio))) fallar(g.MOTIVO_CREDITO); // crédito partido en dos líneas
  fs.writeFileSync(archivo, limpio);
}

function revisarMensaje(archivo) {
  if (!archivo) fallar('Guardia UAEH (git): hook de mensaje sin archivo de mensaje → commit negado (falla cerrado).');
  if (!PROHIBIR_CREDITO) return;
  const texto = fs.readFileSync(archivo, 'utf8');
  if (g.CREDITO.some((re) => re.test(texto))) fallar(g.MOTIVO_CREDITO);
}

async function revisarAutor() {
  if (!PROHIBIR_CREDITO) return;
  let nombre = process.env.GIT_AUTHOR_NAME, correo = process.env.GIT_AUTHOR_EMAIL;
  if (nombre === undefined && correo === undefined) ({ nombre, correo } = partirIdent(await git(['var', 'GIT_AUTHOR_IDENT'])));
  if (identidadClaude(nombre, correo)) fallar(MOTIVO_IDENTIDAD('autor', nombre + ' <' + correo + '>'));
}

async function commitMsg(archivo) {
  revisarMensaje(archivo);
  await revisarAutor();
}

async function applypatchMsg(archivo) {
  revisarMensaje(archivo);
  if (!PROHIBIR_CREDITO) return; // la identidad del autor del parche solo importa con la política `prohibir`
  const gd = await carpetaGit();
  const guion = fs.readFileSync(path.join(gd, 'rebase-apply', 'author-script'), 'utf8');
  const valor = (k) => { const m = new RegExp('^' + k + "='((?:[^']|'\\\\'')*)'", 'm').exec(guion); return m ? m[1].replace(/'\\''/g, "'") : ''; };
  const nombre = valor('GIT_AUTHOR_NAME'), correo = valor('GIT_AUTHOR_EMAIL');
  if (identidadClaude(nombre, correo)) fallar(MOTIVO_IDENTIDAD('autor', nombre + ' <' + correo + '>'));
}

(async () => {
  try {
    const modo = process.argv[2];
    if (modo === 'contenido' || modo === 'pre-commit') await contenido(process.argv[3], process.argv[4]);
    else if (modo === 'commit-msg') await commitMsg(process.argv[3]);
    else if (modo === 'applypatch-msg') await applypatchMsg(process.argv[3]);
    else if (modo === 'credito-local') creditoLocal(process.argv[3], process.argv[4]);
    else fallar('Guardia UAEH (git): uso: guardia-commit.cjs contenido [<archivo> <fuente>] | commit-msg <archivo> | applypatch-msg <archivo> | credito-local <archivo> <simulado> → negado (falla cerrado).');
    process.exit(0);
  } catch (e) {
    fallar(motivoDeError(e));
  }
})();
