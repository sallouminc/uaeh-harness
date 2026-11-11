#!/usr/bin/env node
// GUARDIA GIT — guardia del plugin uaeh-harness (PreToolUse, Bash|PowerShell, todas las sesiones).
//
// Niega lo que destruye trabajo o salta controles:
//   1. git reset --hard
//   2. git push --force / -f / --force-with-lease / --force-if-includes / +refspec / --mirror, y el push forzado por
//      configuración (-c remote.<x>.push=+… o remote.<x>.mirror, y `git config` que los deja escritos).
//      RESIDUAL: borrar una rama remota (`push --delete`, `push origin :rama`) NO se niega (es limpieza normal de ramas
//      ya unidas); tampoco `git remote add --mirror=push` ni un refspec con «+» escrito en .git/config con herramientas
//      de archivo o por --config-env.
//   3. --no-verify en cualquier git, y git commit -n
//   4. git clean -f / --force
// Y en `git commit` (solo ahí) revisa lo que se va a commitear:
//   - archivos sensibles (.env, *.pem, *.key, id_rsa*, *.p12, *.pfx)
//   - llaves/secretos en las líneas añadidas (SOLO ruta:línea y tipo; NUNCA el valor)
//   - crédito de Claude en el mensaje, SOLO si la política de commits del usuario lo prohíbe (commits.credito =
//     "prohibir" en uaeh.config.json o UAEH_COMMIT_CREDITO=prohibir; por defecto se permite)
//
// Escaneo de contenido: líneas largas por ventanas solapadas (8 KiB con 512 de solape); archivos nuevos de
// texto hasta 20 MiB. RESIDUAL: nuevos > 20 MiB o binarios no se escanean por contenido (lo cubre
// gitleaks en /uae-security).
// Y en `git add`/`git commit` se niega --pathspec-from-file / --pathspec-file-nul (lista de rutas fuera del comando).
// CICLO 4 (B8/B9), principio «el commit usa el MISMO contexto git que el guardia revisa; lo que no se puede analizar, se niega»:
//   - git commit con --git-dir/--work-tree/--bare/--namespace/--exec-path/--config-env, -c core.worktree|bare|hooksPath|
//     excludesFile|attributesFile|fsmonitor, -c include.*, variables GIT_* (salvo autor/editor/trazas), env -C/--chdir,
//     -i/--include, -p/--patch, --interactive → NIEGA. (-o/--only y -a se modelan: `diff HEAD -- <rutas>`.)
//   - cambios de carpeta no seguibles antes de un commit (popd, Pop-Location, cd -, cd sin argumento) → NIEGA (como B5).
//   - envoltorios con opciones con valor (env -u/-C/-S, sudo -u, timeout N, nice -n…) ya no toman el valor como programa.
//   - eval/iex/source/., shell sin -c (script, stdin, heredoc), programa por variable ($g commit) o anidamiento >3 niveles
//     con git+commit en el texto → NIEGA (falla cerrado); -EncodedCommand de PowerShell se decodifica y se analiza.
//   RESIDUAL declarado: git escrito por partes que el texto no delata ("g""it", $('gi'+'t')) o ejecutado dentro de un
//   script que ya existe en disco sin que su ejecución aparezca junto a «commit» en el comando; la garantía de los
//   revisores es el sello de integridad, no este filtro.
//
// CICLO 5 (B13-B16): DOS CAPAS. Emular Bash y PowerShell por texto no converge (cuatro rondas
// hallaron otra forma normal de que el filtro revisara un contexto distinto del que usa git). La revisión del CONTENIDO
// del commit (secretos, .env, evidencias del navegador, crédito de Claude si la política lo prohíbe) pasa a donde git
// hace el commit:
//   CAPA 2 (git): core.hooksPath GLOBAL → la carpeta de la guarda (espejo del plugin: <uaehHome>/estable/uaeh-harness/
//     git-hooks, o la que fije UAEH_GIT_HOOKS). Corre dentro del proceso real de git, con su repo, índice
//     (también el temporal de -a/-o/rutas) y árbol, sin importar cómo se escribió el comando. Detalle en CICLO 6 (abajo).
//   CAPA 1 (este filtro de texto): mensajes tempranos y lo que git no ve: reset --hard, push --force, clean -f,
//     saltarse la guarda (ver CICLO 6, B20), crédito de Claude en el comando (si la política lo prohíbe).
// Si la capa 2 está ACTIVA (capaGitActiva(), ver B21), lo que el texto no puede analizar (shell sin -c, eval, programa
// por variable, -i/-p, carpeta dudosa, GIT_DIR/-C…) ya NO se niega: lo revisa git. Los hallazgos que el texto SÍ ve
// (secreto, crédito, evidencia) siguen negando. Si la capa 2 está INACTIVA (nadie la configuró o alguien la quitó) rige la
// conducta ESTRICTA de arriba. Un comando con `wsl` NUNCA se relaja (el git de WSL no usa la guarda).
//
// CICLO 6 (B19-B22):
//   - Qué hace cada hook de la carpeta de la guarda (git-hooks/; medido con git 2.53, ver guardia-commit.cjs):
//       prepare-commit-msg → revisión del CONTENIDO (guardia-commit.cjs contenido) y LUEGO el hook local. Es el único que
//         corre en commit normal, amend, --no-verify/-n, cherry-pick, revert, rebase (también --continue y rebase -i edit)
//         y merge. git fija el árbol del commit ANTES de este hook (medido): por eso se revisa antes del local.
//       pre-applypatch → hook local y LUEGO la revisión del contenido (git am escribe el árbol después de este hook).
//       commit-msg / applypatch-msg → hook local (puede quitar el crédito y firmar) y LUEGO el mensaje FINAL sin crédito
//         de Claude y el AUTOR que no sea Claude (ambas comprobaciones, solo con la política `prohibir`). El COMMITTER se
//         revisa en prepare-commit-msg/pre-applypatch.
//       pre-commit, pre-merge-commit y los demás → SOLO encadenan el hook local (sin node).
//     Regla de origen (MERGE_HEAD, CHERRY_PICK_HEAD, REBASE_HEAD, REVERT_HEAD): un hallazgo solo cuenta si es nuevo
//     contra HEAD Y contra cada origen; lo que ya estaba en un origen es historial (ver guardia-commit.cjs).
//   - B20, en el texto CRUDO, en ambos modos y antes de analizar (si el texto trae la palabra git): `no-verify` en
//     cualquier parte; `commit` seguido en el mismo segmento de un racimo corto con n (-n, '-n', "-nm", -anm, ,-n);
//     `hooksPath` (salvo una lectura con `git config --get`/clave sola en su segmento); `GIT_CONFIG_`; `-c alias.`;
//     `git config alias.<x>` con «commit»; escribir MERGE_HEAD/CHERRY_PICK_HEAD/REBASE_HEAD/REVERT_HEAD; y junto a
//     «commit»: asignar HOME/USERPROFILE/XDG_CONFIG_HOME, `-c include.`/`-c includeIf.`/`--config-env`. Sin la palabra
//     git: setx / SetEnvironmentVariable / HKCU\Environment de GIT_CONFIG_*/HOME/USERPROFILE/XDG_CONFIG_HOME (B20b).
//     Falsos positivos aceptados: un mensaje o un texto que hable literalmente de --no-verify, hooksPath, GIT_CONFIG_
//     o «commit … -n».
//   - B21: capaGitActiva() lee el core.hooksPath (ciclo 7: el EFECTIVO de la carpeta del comando, ver C4d); solo lo
//     acepta si resuelve a la carpeta de la guarda (lib/config.cjs rutaGitHooks(): UAEH_GIT_HOOKS o <espejo>/git-hooks) y
//     viene escrito como C:/…, C:\… o ~/… en Windows (la forma /c/… → INACTIVA: el git nativo no la entiende) o como /… o
//     ~/… en POSIX; exige ahí prepare-commit-msg, pre-applypatch, commit-msg y applypatch-msg.
//   - B22: NO hay despachador de push-to-checkout, proc-receive (cambian la conducta de git), reference-transaction,
//     post-index-change (corren a cada rato: si sh falla amplían el daño) ni fsmonitor-watchman (git no lo usa desde
//     hooksPath) ni p4-* (solo git-p4). Un repo con esos hooks LOCALES (hoy ninguno) no los correría con la guarda.
// CICLO 7 (C1-C4):
//   - C1: `git am -n` salta pre-applypatch y applypatch-msg (los únicos hooks de am): en el texto CRUDO, `am` seguido en
//     su segmento de un racimo corto con n (-n, -qn, -3n, '-n') se niega como `commit -n`; y en cualquier subcomando los
//     prefijos de --no-verify desde --no-v. En merge/rebase/pull/cherry-pick `-n` NO es no-verify: no se niegan por -n.
//     El análisis también niega `git am -n`. Un `git am -n` que el texto no vea (script) SÍ commitea: residual de la capa
//     de git (medido en guardia-commit.test.cjs).
//   - C2 (guardia-commit.cjs): prepare-commit-msg revisa también AUTOR y CRÉDITO cuando el mensaje es nuevo.
//   - C3: lecturas puras fuera de B20 (lecturaPura(): lista CERRADA de lectores, corte ingenuo, sin ejecutar ni escribir);
//     `commit`/`am` pegados a `=` (`--grep=commit`) no son el subcomando; una mención de hooksPath en un segmento de
//     lector o impresor (echo, printf, Write-Host, Write-Output) de un texto inerte y sin tuberías no cuenta como
//     escritura. Además (prueba del encargo `cat x > .git/config`): escribir .git/config, ~/.gitconfig o
//     ~/.config/git/config desde el shell (>, >>, Out-File/Set-Content/Add-Content/Tee-Object/tee, cp/mv/ln/Copy-Item/
//     Move-Item hacia ellos) se niega en ambos modos. Fricción que queda (lado seguro): un patrón entre comillas con | ; &
//     (`rg -n "no-verify|hooksPath"`: el corte ingenuo lo parte → usar -e … -e …), con paréntesis/llaves/$variables o
//     comodines en rg, y el heredoc de documentación con esas palabras; `cp .git/config <respaldo>` también se niega.
//   - C4a: en PowerShell `bash`/`sh` sin la ruta de Git Bash es el lanzador de WSL: nunca se relaja y se niega git
//     commit/merge/rebase/cherry-pick/revert/am/pull dentro.
//   - C4b/C4c (guardia-commit.cjs y pre-applypatch): GIT_NO_REPLACE_OBJECTS=1; revisión antes Y después del local.
//   - C4d: capaGitActiva(dir) usa el core.hooksPath EFECTIVO de la carpeta del comando (`git -C <dir> config --get`,
//     con include.path/includeIf evaluados en ese repo): un hooksPath LOCAL (husky) o un includeIf que lo cambie →
//     estricto. Carpeta no resoluble (variable, inexistente, env -C, GIT_DIR, --git-dir) → se acredita en la carpeta de
//     la sesión (como en c6).
// RESIDUALES EXACTOS: plomería (commit-tree, update-ref, mktree, fast-import…) no corre hooks; un core.hooksPath LOCAL del
// repo (husky; hoy ninguno) gana a la guarda global: el texto lo detecta en la carpeta del comando (C4d), pero no dentro
// de un script ni con carpeta no resoluble (cd $X, env -C, GIT_DIR/--git-dir); `git am -n` / `git commit -n` dentro de un
// script que el texto no ve (am: sin revisión; commit: contenido, autor y crédito sí, por prepare-commit-msg); un
// prepare-commit-msg LOCAL que agregue crédito (se revisa antes de él), crédito escrito en el editor (GIT_EDITOR) o
// heredado con -c/-C/--amend junto con -n; stash y replace como origen deliberado (refs/stash; replace ya no oculta
// contenido: GIT_NO_REPLACE_OBJECTS); perfiles de shell (~/.bashrc, $PROFILE) que cambien GIT_CONFIG_*/HOME o
// alias de lectores; gestores de hooks (simple-git-hooks, lefthook…) que escriban en la carpeta de core.hooksPath
// GLOBAL (la carpeta de la guarda) si se ejecutan; rg con RIPGREP_CONFIG_PATH ya en el entorno (podría traer --pre); binarios reales (con NUL, no UTF-16) y archivos de más de
// 20 MiB no se escanean por contenido (sí por nombre: .env, *.pem, *.key…); el contenido real de Git LFS (git solo ve el
// puntero); editar ~/.gitconfig o .git/config con herramientas de archivo (Write/Edit) o con `echo >>` sin la palabra
// hooksPath en el comando; contenido que ya estaba en un origen (historial) o en el commit que se enmienda; un archivo de
// origen escrito con herramientas de archivo que apunte a un commit fabricado; `git stash` (crea commits en refs/stash sin
// hooks; no es un commit de rama). Si Git Bash se rompe (p. ej. por un antivirus) los hooks no arrancan y TODO
// commit falla cerrado → recuperación: `git config --global --unset core.hooksPath` (lo corre el usuario en su terminal:
// este filtro lo niega al agente a propósito).
//
// CICLO 7b (arreglo mínimo; V-001 del verificador B = SEC-008/009 de uae-security, ciclo 7): PowerShell 5.1
//   separa sentencias con un CR suelto (`\r` no seguido de `\n`). Medido con powershell.exe 5.1.26100 (Parser::ParseInput
//   y ejecución): `Write-Output uno<CR>Write-Output dos` → 2 sentencias (uno / dos); `# nota<CR>Write-Output dos` → imprime
//   «dos» (el comentario TERMINA en el CR); `"uno<CR>dos"` y `'uno<CR>dos'` → 1 sentencia (en comillas no separa);
//   `<# … <CR> … #>` no termina en el CR. Antes el filtro trataba el CR como espacio: `cat f<CR>git commit --no-verify`
//   entraba por la excepción C3 (lecturaPura) y saltaba B20, y `git status<CR>git reset --hard` escondía el destructivo.
//   Arreglo de CLASE: crSuelto() convierte todo CR suelto en `\n` a la entrada (texto del hook, texto decodificado de
//   -EncodedCommand, saltoGuarda y el tokenizador dividir), así cada frontera de línea (segmentos de B20/B20b/C3,
//   lecturaPura, `[^\n…]`, el fin del comentario `#`) también corta en él. `\r\n` sigue siendo un salto normal. (Lo de
//   «en Bash cortar de más solo niega de más» resultó FALSO: ver CICLO 7c.) Un CR dentro de comillas se vuelve `\n` en el token
//   (no separa en el tokenizador; sí en los cortes ingenuos de B20, que ya eran ingenuos con `\n`).
//   RESIDUALES QUE SE DECLARAN (no se arreglan en 7b):
//   - Guarda: `git am -n` corrido DIRECTO o dentro de un script en archivo (la capa de git no corre en `am -n`; el texto
//     lo niega a la vista); splatting de PowerShell `$a='am','-n'; git @a …` (SEC-012); subcomando en variable
//     `x=commit; git $x -n` (V-005); racimo de 4+ letras en envoltorio (V-004); autor/crédito con `-n` en `--amend` o con
//     origen en curso, y SQUASH_MSG/MERGE_MSG sembrados (SEC-013, V-007); estado de carpeta compartido con un shell hijo
//     (Codex SEC-005c6); `cherry-pick --edit` con crédito nuevo (Codex SEC-006c6, por validar); escrituras a .git/config
//     por `>|`, `dd of=`, `> .git/./config`, `[IO.File]::WriteAllText` (V-006); husky/gestores que escriben en la carpeta
//     global; stash como origen; perfiles de shell; plomería; LFS; binarios reales.
//   - Candado solo-lectura.js (CONGELADO en c7, «mejor esfuerzo»; la garantía real es el sello de integridad): `}` entre
//     intérprete y `-c` (SEC-010), `${HOME}`/token largo antes de `&&` (SEC-011, Codex SEC-007), intérprete con control
//     dentro de `"$(…)"` (V-002), `$"…"`, `bash -s <<<`, `perl/ruby -e` (V-009), `$'…'` dentro de `bash -c "…"`.
//
// CICLO 7c (V7B-001 del verificador del 7b): crSuelto() también vuelve `\n` el CR que va DENTRO de comillas, y
//   las reglas de B20 que cortan de forma ingenua por `\n` quedaban partidas: `Set-Content -Value "a<CR>b" -Path
//   .git/config`, `Out-File -InputObject "a<CR>b" -FilePath .git/config`, `git config alias.ci "<CR>commit"` pasaban
//   (con LF ya pasaban antes del 7b). Arreglo: SEGUNDA lectura (juntarComillas: saltos DENTRO de comillas → espacio, los
//   de fuera se quedan) sobre la que se evalúan TODAS las reglas que niegan de saltoGuarda (reglasSalto) y marcasCrudas;
//   se niega si cualquiera de las lecturas coincide. La primera lectura queda intacta y ningún camino que PERMITE usa
//   las otras: la excepción de lecturas puras (C3) se decide solo con la primera. Un error del escaneo de comillas solo
//   puede negar de más.
//   Corrección del 7b (medido con Git Bash 5.2.37 MSYS): en Git Bash un CR literal NO separa comandos (se BORRA al leer el
//   comando, también entre comillas: `ec<CR>ho hola` imprime «hola»). Con solo el corte del 7b, `git -c x.y=z<CR> reset
//   --hard` (un reset real en Bash), `cp evil<CR> .git/config`, `git commit -m x<CR> -n` pasaban; c7 los negaba. Por eso
//   saltoGuarda también evalúa el texto CRUDO (y su juntarComillas), y el análisis corre sobre el texto con el corte Y
//   sobre el crudo (también el de -EncodedCommand): niega si cualquiera niega → nunca menos que c7 ni que el 7b.
//   CLASE «el guarda no ve el CR como lo ve el shell real» → lecturasCR() da TODAS las interpretaciones reales del CR, y
//   saltoGuarda (cada una + su juntarComillas), el análisis y el texto de -EncodedCommand niegan si CUALQUIERA niega:
//     | lectura          | qué hace con el CR                       | quién lo ejecuta así (medido)                     |
//     | 1 corte          | CR suelto → `\n` (fuera y dentro de "…") | PowerShell 5.1: separa sentencias; `#` termina    |
//     | 2 borrado        | todo CR → nada                           | Git Bash 5.2.37 MSYS: se borra en '…', "…", $'…', |
//     |                  |                                          | script en archivo y heredoc; `ec<CR>ho` = echo     |
//     | 3 tal cual (c7)  | CR = espacio en el tokenizador           | lo que veía c7 (para no negar menos que c7)       |
//   Solo si el texto trae `\r` (sin CR: una sola lectura, costo igual). La excepción C3 exige que TODAS las lecturas sean
//   lecturas puras. `git re<CR>set --hard`, `git commit --no-<CR>verify`, `hooks<CR>Path` partido ya no pasan.
//   RESIDUAL declarado (V7B-003, igual en c7): `` powershell -c "cat f`rgit reset --hard" `` — las secuencias `` `r ``/`` `n ``
//   de PowerShell dentro de comillas dobles que se pasan a otro PowerShell: el texto no contiene la palabra git (`\bgit\b`
//   falla en `` f`rgit ``) y el hook sale temprano; el PowerShell externo las vuelve CR/LF reales. Es una forma barata del
//   residual del ciclo 4 «git escrito por partes que el texto no delata».
//   FRICCIÓN aceptada (V7B-002): `rg -n "no-verify<CR>" f` se niega (el corte ingenuo de C3 lo parte; lado seguro).
//
// Debe ser rápida: si el comando no contiene la palabra "git" sale de inmediato.
// FALLA CERRADO (UAEH F2): entrada ilegible o sin `command` de texto → NIEGA (el matcher es solo Bash|PowerShell,
// que siempre traen `command`; el texto vacío "" sí pasa). Si un `git commit` no se pudo escanear, también NIEGA.
//
// Variable de entorno UAEH_GUARDIA_PRESUPUESTO_MS (solo pruebas): puede BAJAR el presupuesto total (9000 ms); nunca subirlo;
// un valor inválido se ignora. Sirve para probar el mensaje de tiempo (MOTIVO_TIEMPO) con un commit real.
//
// RECUPERACIÓN: el hook está en hooks/hooks.json del plugin con `onFailure: "block"`. Si node falla, el archivo se
// rompe o el hook vence (timeout 10 s), TODOS los comandos Bash/PowerShell quedan bloqueados en TODAS las sesiones. Para
// recuperar, desactiva el plugin con el comando de Claude Code `/plugin disable uaeh-harness` (NO con Bash/PowerShell:
// estarían bloqueados) o repara el hook guardia-git.js con la herramienta Edit.
'use strict';

const fs = require('fs');
const path = require('path');
const T0 = Date.now(); // arranque del hook: de aquí cuentan los presupuestos de tiempo

// Política de commits del usuario y carpeta de la guarda de git: salen de scripts/lib/config.cjs (hooks/ y scripts/ son
// carpetas hermanas en el plugin y en su espejo estable). Una sola carga, al arrancar (una lectura de JSON). Si la
// biblioteca no carga, la política es la de defecto (el crédito de Claude se permite) y la guarda de git se da por
// inactiva (capaGitActiva → false: rige la conducta estricta del texto).
let configLib = null;
try { configLib = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.cjs')); } catch { configLib = null; }
let POLITICA = { credito: 'permitir', prohibir: false, firma: '' };
try { if (configLib) POLITICA = configLib.politicaCommits(configLib.cargarConfig().config); } catch { /* política por defecto */ }

function salir() { process.exit(0); }

function negar(motivo) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo },
  }));
  process.exit(0);
}

const MOTIVO_PROHIBIDO = (regla) =>
  `Guardia UAEH: «${regla}» está prohibido para el agente (destruye trabajo o salta controles). ` +
  'Si el usuario lo autoriza, lo ejecuta en su propia terminal, fuera de Claude Code.';
// Solo se usa con la política `prohibir` (ver POLITICA). Con firma configurada, el mensaje la indica.
const MOTIVO_CREDITO = 'Guardia UAEH: la política de commits de este usuario prohíbe el crédito de Claude. Quita esa línea' +
  (POLITICA.firma ? ' y termina el mensaje con «' + POLITICA.firma + '».' : '.');

// ---------------------------------------------------------------- tokenizador
// Parte el comando en segmentos (por && || ; | & y saltos de línea fuera de comillas)
// y cada segmento en tokens (comillas simples/dobles y escapes ya resueltos).
// Los cuerpos de heredoc (<<EOF … EOF) se saltan: son texto, no comandos.
// CICLO 7b: un CR suelto (`\r` no seguido de `\n`) separa sentencias en PowerShell 5.1 → se vuelve `\n` ANTES de
// cualquier corte, así toda frontera de línea (tokenizador, comentario `#`, segmentos de B20, lecturaPura, [^\n…]) lo ve.
// `\r\n` queda igual (un salto normal). En Git Bash el CR NO separa (se borra): ver lecturasCR (7c).
function crSuelto(texto) { return texto.replace(/\r(?!\n)/g, '\n'); }
// CICLO 7c: las interpretaciones REALES del CR, en orden (la primera es la principal). Sin CR → solo el texto.
//   PowerShell: CR suelto = separador · Git Bash (MSYS): todo CR se BORRA (también entre comillas) · c7: texto tal cual.
function lecturasCR(crudo) {
  if (!/\r/.test(crudo)) return [crudo];
  return [...new Set([crSuelto(crudo), crudo.replace(/\r/g, ''), crudo])];
}
// (7c: dividir ya no normaliza; lo hacen sus llamadas de entrada, que además analizan el texto crudo = lectura de c7)
function dividir(cmd, ps) {
  const segs = [];
  let toks = [];
  let cur = '';
  let has = false;
  let i = 0;
  const n = cmd.length;
  let pend = [];
  const pushTok = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const pushSeg = () => { pushTok(); if (toks.length) segs.push(toks); toks = []; };

  while (i < n) {
    const c = cmd[i];
    if (c === "'") {
      has = true; i++;
      while (i < n && cmd[i] !== "'") { cur += cmd[i]; i++; }
      i++; continue;
    }
    if (c === '"') {
      has = true; i++;
      while (i < n && cmd[i] !== '"') {
        const d = cmd[i];
        if (ps) {
          if (d === '`' && i + 1 < n) { cur += cmd[i + 1]; i += 2; continue; }
          if (d === '"' && cmd[i + 1] === '"') { cur += '"'; i += 2; continue; }
        } else if (d === '\\' && i + 1 < n && '"\\$`'.includes(cmd[i + 1])) {
          cur += cmd[i + 1]; i += 2; continue;
        }
        cur += d; i++;
      }
      i++; continue;
    }
    if (ps && c === '`' && i + 1 < n) { // escape de PowerShell
      if (cmd[i + 1] === '\n') { i += 2; continue; }
      has = true; cur += cmd[i + 1]; i += 2; continue;
    }
    if (!ps && c === '\\' && i + 1 < n) {
      const d = cmd[i + 1];
      if (d === '\n') { i += 2; continue; }
      if (' \t"\'\\$;&|()<>'.includes(d)) { has = true; cur += d; i += 2; continue; }
    }
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([\w.-]+))/.exec(cmd.slice(i));
      if (m) {
        pend.push({ dash: m[1] === '-', delim: m[2] || m[3] || m[4] });
        i += m[0].length;
        continue;
      }
    }
    if (c === '\n' || c === ';') {
      pushSeg(); i++;
      if (c === '\n' && pend.length) {
        for (const h of pend) {
          while (i < n) {
            let fin = cmd.indexOf('\n', i);
            if (fin < 0) fin = n;
            let linea = cmd.slice(i, fin).replace(/\r$/, '');
            i = Math.min(fin + 1, n);
            if ((h.dash ? linea.replace(/^\t+/, '') : linea) === h.delim) break;
          }
        }
        pend = [];
      }
      continue;
    }
    if (c === '|') { pushSeg(); i += cmd[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '&') {
      const prev = cmd[i - 1], next = cmd[i + 1];
      if (prev === '>' || prev === '<' || next === '>') { has = true; cur += c; i++; continue; }
      pushSeg(); i += next === '&' ? 2 : 1; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushTok(); i++; continue; }
    // comentario (`# nota`): sin comillas y al inicio de una palabra, hasta el fin de la línea (Bash y PowerShell)
    if (c === '#' && !has) { while (i < n && cmd[i] !== '\n') i++; continue; }
    has = true; cur += c; i++;
  }
  pushSeg();
  return segs;
}

// ---------------------------------------------------------------- utilidades
const WRAP = new Set(['sudo', 'env', 'command', 'time', 'exec', 'nohup', 'builtin', 'xargs', 'then', 'do', 'else', 'elif', 'if', '!', 'while', 'until', 'nice', 'timeout', 'setsid']);
// Opciones de cada envoltorio que llevan VALOR (el valor no es el programa). B8: antes `env -C dir git commit` o
// `sudo -u x git commit` tomaban el valor como programa y el commit no se revisaba.
const WRAP_VALOR = {
  env: /^(?:-[uCS]|--(?:unset|chdir|split-string))$/,
  sudo: /^(?:-[ughpCDrtUTR]|--(?:user|group|host|prompt|chdir|chroot|role|type|other-user|command-timeout))$/,
  xargs: /^(?:-[IndEPLsa]|--(?:replace|max-args|max-procs|delimiter|eof|max-lines|max-chars|arg-file))$/,
  nice: /^(?:-n|--adjustment)$/,
  timeout: /^(?:-[sk]|--(?:signal|kill-after))$/,
};
// Opciones de envoltorio que cambian de carpeta o de raíz (el guardia no las sigue → un commit se niega)
const WRAP_CAMBIA_DIR = /^(?:-[CDR]|--(?:chdir|chroot))/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'push-location', 'pushd']);
const CD_VUELVE = new Set(['popd', 'pop-location']); // vuelven a una carpeta anterior que el guardia no recuerda
const EVAL_PROGS = new Set(['eval', 'iex', 'invoke-expression']);
const SOURCE_PROGS = new Set(['source', '.']);
const OPT_GLOBAL_CON_ARG = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
// B8: ajustes de git que redirigen el repo/árbol, saltan hooks o excluyen archivos: con `git commit` se niegan
const CFG_REDIRIGE = /^(?:core\.(?:worktree|bare|hookspath|excludesfile|attributesfile|fsmonitor)|include\.path|includeif\.)/i;
// B8: variables GIT_* que NO cambian qué se commitea (autor, editor, trazas…); cualquier otra asignada en el comando se niega
const GIT_ENV_BENIGNO = /^(?:AUTHOR_(?:NAME|EMAIL|DATE)|COMMITTER_(?:NAME|EMAIL|DATE)|EDITOR|SEQUENCE_EDITOR|PAGER|TERMINAL_PROMPT|ASKPASS|SSH|SSH_COMMAND|TRACE\w*|MERGE_\w+|REDIRECT_STDERR)$/i;
function entornoGitPeligroso(texto) {
  for (const re of [/(?:^|[^A-Za-z0-9_])GIT_([A-Za-z0-9_]+)\s*=/gi, /\benv:GIT_([A-Za-z0-9_]+)/gi, /SetEnvironmentVariable\(\s*['"]GIT_([A-Za-z0-9_]+)/gi]) {
    let m;
    while ((m = re.exec(texto))) if (!GIT_ENV_BENIGNO.test(m[1])) return true;
  }
  return false;
}
const MOTIVO_REDIRIGIDO =
  'Guardia UAEH: para commits no se admite redirigir el repo/índice/árbol (--git-dir, --work-tree, --bare, -c core.worktree/hooksPath/excludesFile, variables GIT_*, env -C…); haz el commit desde la carpeta del repo.';
const MOTIVO_NO_ANALIZABLE =
  'Guardia UAEH: el comando ejecuta texto que el guardia no puede analizar (anidamiento muy profundo, eval/iex, un script, un archivo o la entrada estándar) y menciona git → negado (falla cerrado). Escribe el comando de git directamente, sin envolverlo, y en un comando aparte.';
const MOTIVO_OPCION_COMMIT = (op) =>
  'Guardia UAEH: «git commit ' + op + '» cambia lo que se commitea de una forma que el guardia no revisa (agrega o elige contenido aparte del índice): stagea con git add <ruta> y haz «git commit -m …» a secas, o pasa las rutas con -o/-a.';
const LARGAS_CON_VALOR = new Set([
  '--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message', '--fixup', '--squash',
  '--template', '--cleanup', '--repo', '--receive-pack', '--exec', '--push-option', '--exclude', '--pathspec-from-file',
  // `git commit -h` del git 2.53: opciones con valor que antes se tomaban como rutas (--trailer "X: y", -U3…)
  '--trailer', '--unified', '--inter-hunk-context',
]);
const VALOR_CORTAS = { commit: 'mFCctU', push: 'o', clean: 'e', reset: '' };

// ---------------------------------------------------------------- CAPA DE GIT (ciclo 5, B15)
// La revisión del CONTENIDO del commit vive en la guarda global de git (core.hooksPath → la carpeta de la guarda, ver
// guardia-commit.cjs): corre dentro del proceso real de git, con su repo/índice/árbol, sin importar cómo se escribió el
// comando. Este filtro de texto es la primera capa. Si la capa de git está ACTIVA, lo que el texto no puede analizar
// ya no se niega (git lo revisará); si está INACTIVA se conserva la conducta estricta de siempre.
const _capaGit = new Map(); // carpeta → activa (una consulta a git por carpeta y por comando)
let _dirCapa = null; // carpeta del comando que se está analizando (ciclo 7, C4d): ahí se acredita la capa
let _cwdBase = null; // carpeta de la sesión (entrada.cwd)
// Windows y macOS comparan rutas sin distinguir mayúsculas; Linux sí (dos carpetas que solo difieren en mayúsculas son dos).
const RUTAS_SIN_MAYUSCULAS = process.platform === 'win32' || process.platform === 'darwin';
function normalizarRuta(p) {
  const r = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return RUTAS_SIN_MAYUSCULAS ? r.toLowerCase() : r;
}
// CICLO 7 (C4d; uae-security c6 SEC-002a, Codex c6 SEC-005): el core.hooksPath EFECTIVO de la carpeta del comando
// (`git -C <dir> config --get core.hooksPath`: local > global > sistema, con include.path e includeIf gitdir:/onbranch:
// evaluados en ESE repo). Un hooksPath LOCAL (husky) o un includeIf que apunte a otra carpeta → INACTIVA (estricto).
// Carpeta no resoluble (variable, inexistente) → se acredita en la carpeta de la sesión (como en c6; residual declarado).
function capaGitActiva(dir) {
  let d = dir || _dirCapa || _cwdBase || process.cwd();
  try { if (!fs.statSync(d).isDirectory()) d = _cwdBase || process.cwd(); } catch { d = _cwdBase || process.cwd(); }
  const clave = normalizarRuta(d);
  if (_capaGit.has(clave)) return _capaGit.get(clave);
  let activa = false;
  try {
    const restante = tiempoRestante(T0, Date.now());
    if (restante >= MARGEN_MIN_MS) {
      const valor = require('child_process').execFileSync('git', ['-C', d, 'config', '--get', 'core.hooksPath'], {
        encoding: 'utf8', timeout: Math.min(restante, 3000), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }).replace(/\r?\n[\s\S]*$/, '').trim();
      // Windows: solo C:/…, C:\… o ~/… (B21); la forma Git Bash /c/… NO: el git nativo de Windows no la entiende y no
      // correría la guarda. POSIX: solo /… o ~/…. Una ruta relativa depende de cada repo. La guarda esperada es la de
      // lib/config.cjs (UAEH_GIT_HOOKS o <espejo>/git-hooks); sin esa biblioteca no hay con qué comparar → inactiva.
      const global = configLib ? configLib.rutaGitHooks() : null;
      const forma = process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|~[\\/])/ : /^(?:\/|~\/)/;
      activa = !!global && !!valor && forma.test(valor) && normalizarRuta(resolver(d, valor)) === normalizarRuta(global) &&
        // los hooks que hacen la revisión (ciclo 6): contenido en prepare-commit-msg/pre-applypatch, mensaje y autor en
        // commit-msg/applypatch-msg
        ['prepare-commit-msg', 'pre-applypatch', 'commit-msg', 'applypatch-msg'].every((h) => fs.existsSync(path.join(global, h)));
    }
  } catch { activa = false; }
  _capaGit.set(clave, activa);
  return activa;
}
const CONFIG_GUARDA_VAR = /GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\w*|VALUE_\w*|PARAMETERS)/;
// Marcas de «saltarse la guarda» que se niegan SIEMPRE (ambos modos), buscadas en el texto crudo sin depender del análisis.
function marcasConfig(texto) {
  const asigna = new RegExp('(?:^|[^A-Za-z0-9_])' + CONFIG_GUARDA_VAR.source + '\\s*=', 'i');
  const entorno = new RegExp('\\benv:' + CONFIG_GUARDA_VAR.source, 'i');
  const dotnet = new RegExp("SetEnvironmentVariable\\(\\s*['\"]" + CONFIG_GUARDA_VAR.source, 'i');
  if (asigna.test(texto) || entorno.test(texto) || dotnet.test(texto)) {
    return MOTIVO_PROHIBIDO('variables GIT_CONFIG_* junto a un commit (pueden quitar la guarda de git)');
  }
  return null;
}
// Marcas que solo se buscan en texto que NO se pudo analizar (lo analizable ya pasó por las reglas de arriba).
function marcasCrudas(texto) {
  if (/--no-verify/i.test(texto)) return MOTIVO_PROHIBIDO('--no-verify');
  if (/(?:^|\s)(?:-c|--config-env)[\s=]*['"]?core\.hookspath/i.test(texto) ||
      (/\bconfig\b[^\n;&|]*core\.hookspath/i.test(texto) && !/--get|--list|\s-l(?:\s|$)|\bget\s|\blist\b/i.test(texto))) {
    return MOTIVO_PROHIBIDO('core.hooksPath (quita o cambia la guarda de git, igual que --no-verify)');
  }
  if (/\bcommit\b[^\n;&|]*?\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)/.test(texto)) return MOTIVO_PROHIBIDO('git commit -n (--no-verify)');
  if (/\breset\b[^\n;&|]*--hard/i.test(texto)) return MOTIVO_PROHIBIDO('git reset --hard');
  if (/\bpush\b[^\n;&|]*?(?:--force|\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|\s\+\S)/i.test(texto)) return MOTIVO_PROHIBIDO('git push --force');
  if (/\bclean\b[^\n;&|]*?(?:--force|\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$))/i.test(texto)) return MOTIVO_PROHIBIDO('git clean -f');
  return null;
}
// ¿Se niega este motivo de «no pude analizar»? Capa de git inactiva → sí (estricto). Activa → solo si el texto trae marcas
// de saltarse la guarda (`crudo`: texto sin analizar, también --no-verify/-n y lo destructivo que git no ve).
function relajar(motivo, completo, crudo) {
  if (/(?<![\w.-])wsl(?:\.exe)?(?![\w.-])/i.test(completo)) return motivo; // B20: el git de WSL no usa la guarda → nunca se relaja
  if (!capaGitActiva()) return motivo;
  // CICLO 7c: marcasCrudas también sobre la segunda lectura (saltos dentro de comillas → espacio); solo suma negaciones
  return marcasConfig(completo) || (crudo ? marcasCrudas(completo) || marcasCrudas(juntarComillas(completo)) : null) || null;
}

// ---------------------------------------------------------------- B20 (ciclo 6): saltarse la guarda, en el texto CRUDO
// Se busca en el texto tal cual, en AMBOS modos y ANTES de cualquier análisis: así no importa dentro de qué construcción
// vaya (python -c, node -e, Write-Host (…), ForEach-Object { }, alias…). Falsos positivos aceptados y declarados: un
// mensaje de commit que hable literalmente de --no-verify / hooksPath / GIT_CONFIG_ / -n.
// Todo en recorridos LINEALES (segmentos + «primera de A antes que la última de B»): sin búsquedas perezosas que crezcan
// al cuadrado con un comando largo (el hook tiene 10 s y onFailure block).
const PALABRA_COMMIT = /(?<![\w.-])commit(?![\w.-])/i;
const VAR_HOME = '(?:HOME|USERPROFILE|XDG_CONFIG_HOME)';
const VAR_GUARDA = new RegExp('(?<![\\w$])(?:GIT_CONFIG_\\w*|' + VAR_HOME + ')\\b', 'gi');
const ASIGNA_HOME = new RegExp(
  '(?:^|[^\\w$:.-])' + VAR_HOME + '\\s*=(?!=)' +
  '|\\bexport\\s+(?:-\\w+\\s+)*' + VAR_HOME + '\\b' +
  '|\\$env:' + VAR_HOME + '\\s*=(?!=)' +
  "|\\b(?:Set-Item|New-Item|si|ni)\\s+(?:-Path\\s+)?['\"]?env:" + VAR_HOME + '\\b', 'i');
// racimo corto con n tras `commit` en el mismo segmento: -n, '-n', "-nm", -anm, ,-n
const RACIMO_N = /[\s,'"(\[]['"]?-[a-zA-Z]{0,3}n[a-zA-Z]{0,3}['"]?(?=[\s,'")\]]|$)/i;
const ESCRIBE = /(?:>|\b(?:update-ref|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|cp|copy|mv|move|tee|ln)\b)/i;
const ESTADO_ORIGEN = /(?:MERGE|CHERRY_PICK|REBASE|REVERT)_HEAD\b/gi;
// Segmentos del texto cortados por los caracteres de `seps` (un recorrido).
function segmentos(texto, seps) {
  const out = [];
  let ini = 0;
  for (let i = 0; i <= texto.length; i++) {
    if (i === texto.length || seps.includes(texto[i])) { if (i > ini) out.push(texto.slice(ini, i)); ini = i + 1; }
  }
  return out;
}
// ¿La PRIMERA coincidencia de `a` (no global) está antes que la ÚLTIMA de `b` (global)? Lineal.
function antesQue(seg, a, b) {
  const ma = a.exec(seg);
  if (!ma) return false;
  let ultimo = -1;
  for (const m of seg.matchAll(b)) ultimo = m.index;
  return ultimo > ma.index;
}
function persistente(texto) {
  if (/SetEnvironmentVariable\s*\(\s*['"](?:GIT_CONFIG_\w*|HOME|USERPROFILE|XDG_CONFIG_HOME)['"]/i.test(texto)) return true;
  if (/setx/i.test(texto) && segmentos(texto, '\n;&|').some((s) => antesQue(s, /\bsetx(?:\.exe)?\b/i, VAR_GUARDA))) return true;
  return /HKCU/i.test(texto) && segmentos(texto, '\n').some((s) => antesQue(s, /HKCU:?\\+Environment\b/i, VAR_GUARDA));
}
function hooksPathEscrito(texto) {
  // Cada mención de hooksPath se niega salvo una LECTURA con `git config` en su propio segmento (c5: el inventario
  // `git -C "$r" config --local --get core.hooksPath` debe pasar). Más de 20 menciones → se niega sin analizar.
  const menciones = [...texto.matchAll(/hookspath/gi)];
  if (menciones.length > 20) return true;
  // CICLO 7 (C3): una mención dentro de un segmento que empieza por un lector o un impresor (echo, printf, Write-Host,
  // Write-Output) no escribe nada si el texto es inerte (textoInerte) y no tiene tuberías `|` (la salida de un impresor
  // podría ir a un shell). `git config --global --get core.hooksPath; echo "hooksPath revisado"` pasa.
  const inerte = textoInerte(texto) !== null && !/(?<!\|)\|(?!\|)/.test(texto);
  for (const m of menciones) {
    const fin0 = m.index + m[0].length;
    const ini = Math.max(texto.lastIndexOf(';', m.index), texto.lastIndexOf('&', m.index), texto.lastIndexOf('|', m.index),
      texto.lastIndexOf('\n', m.index), texto.lastIndexOf('}', m.index)) + 1;
    const antes = texto.slice(ini, m.index);
    let g = -1;
    for (const x of antes.matchAll(/\bgit\b/gi)) g = x.index; // el ÚLTIMO git del segmento antes de la mención
    if (g < 0) {
      const prog = primeraPalabra(antes);
      if (inerte && (LECTORES.has(prog) || IMPRESORES.has(prog))) continue;
      return true;
    }
    const pre = antes.slice(g);
    const finRel = texto.slice(fin0).search(/[;&|\n}]/);
    const post = finRel < 0 ? texto.slice(fin0) : texto.slice(fin0, fin0 + finRel);
    const lectura = /\bconfig\b/i.test(pre) && !/(?:^|\s)(?:-c|--config-env)\b/.test(pre) &&
      !/(?:^|\s)(?:--add|--replace-all|--unset|--unset-all|--remove-section|--rename-section|-e|--edit|set|unset)(?=\s|$)/i.test(pre) &&
      (/(?:^|\s)(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list)(?=\s|$)/i.test(pre) || !/\S/.test(post.replace(/^['"]/, '')));
    if (!lectura) return true;
  }
  return false;
}
// CICLO 7 (C3b): `commit`/`am` pegados a `=` (`--grep=commit`, `--format="commit %H"`) no son el subcomando.
const SUB_COMMIT = /(?<![\w.=-]|=['"])commit(?![\w.-])/i;
// CICLO 7 (C1): `git am -n` salta pre-applypatch y applypatch-msg (git-am.html:645-650) → igual que `commit -n`. En am
// el racimo admite dígitos (`-3n`). En merge/rebase/pull/cherry-pick `-n` NO es no-verify: no se miran.
const SUB_AM = /(?<![\w.=-]|=['"])am(?![\w.-])/i;
const RACIMO_N_AM = /[\s,'"(\[]['"]?-[a-zA-Z0-9]{0,3}n[a-zA-Z0-9]{0,3}['"]?(?=[\s,'")\]]|$)/i;
// Devuelve 'commit' / 'am' si alguno va seguido, en el mismo segmento, de un racimo corto con n.
function commitN(texto) {
  for (const s of segmentos(texto, ';&|\n}')) {
    const m = SUB_COMMIT.exec(s);
    if (m && RACIMO_N.test(s.slice(m.index + m[0].length))) return 'commit';
    const a = SUB_AM.exec(s);
    if (a && RACIMO_N_AM.test(s.slice(a.index + a[0].length))) return 'am';
  }
  return null;
}
// CICLO 7 (C1b): prefijos de --no-verify desde --no-v (git acepta prefijos únicos). Sobre-negar `--no-verb` abreviado
// (--no-verbose) es fricción rara aceptada por el encargo.
const PREFIJO_NO_VERIFY = /--no-v(?:e(?:r(?:i(?:fy?)?)?)?)?(?![\w-])/i;

// ---------------------------------------------------------------- C3 (ciclo 7): lecturas puras fuera de la regla cruda B20
// Si TODOS los segmentos (corte INGENUO por ; & | y salto de línea: un corte equivocado deja un segmento que no empieza
// por un lector y la excepción no aplica = lado seguro) empiezan por un lector de esta lista cerrada, y el texto no
// ejecuta ni escribe nada, la regla cruda B20 no aplica (`rg -n 'no-verify' hooks/guardia-git.js`).
const LECTORES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls', 'cat', 'type', 'get-content',
  'gc', 'head', 'tail', 'wc', 'ls', 'test-path']);
const IMPRESORES = new Set(['echo', 'printf', 'write-host', 'write-output']);
// redirecciones permitidas (no escriben archivos): 2>&1, >/dev/null, 2>/dev/null, >$null, 2>$null (y *>$null, &>/dev/null)
const REDIR_NULA = /[12*&]?>[ \t]*(?:\/dev\/null|\$null)(?![\w\/.$-])|2>&1/gi;
// Texto que no ejecuta ni escribe: sin $( ` <( >( -exec xargs eval iex Invoke-Expression; sin paréntesis ni llaves (en
// PowerShell `(…)` y los scriptblocks de enlace diferido `{…}` ejecutan); sin $variables (podrían meter opciones como
// --pre); sin redirecciones de escritura ni Out-File/Set-Content/Add-Content/Tee-Object. Devuelve el texto sin las
// redirecciones permitidas, o null.
function textoInerte(texto) {
  if (/\$\(|`|<\(|>\(|-exec|xargs|eval|iex|invoke-expression|[(){}]/i.test(texto)) return null;
  const sin = texto.replace(REDIR_NULA, ' ');
  if (/>|out-file|set-content|add-content|tee-object|\$[\w{]/i.test(sin)) return null;
  return sin;
}
function primeraPalabra(seg) { return seg.trim().split(/\s+/)[0].toLowerCase(); }
function lecturaPura(texto) {
  const sin = textoInerte(texto);
  if (sin === null) return false;
  let rg = false;
  for (const s of sin.split(/[;&|\n]/)) {
    if (!s.trim()) continue;
    const prog = primeraPalabra(s);
    if (!LECTORES.has(prog)) return false;
    if (prog === 'rg') rg = true;
  }
  // rg --pre/--pre-glob/--hostname-bin ejecutan programas; un comodín podría expandirse a un archivo llamado --pre=…
  if (rg && /--pre|--hostname-bin|[*?[]/i.test(sin)) return false;
  return true;
}
// CICLO 7 (C3, prueba del encargo `cat x > .git/config`): escribir el archivo de configuración de git desde el shell
// (redirección, Out-File/Set-Content/Add-Content/Tee-Object/tee, o cp/mv/ln/Copy-Item/Move-Item hacia él) → se niega:
// puede poner core.hooksPath sin que la palabra aparezca. Con Write/Edit sigue siendo residual declarado.
const RUTA_CONFIG = /(?:\.git[\\/]+config(?:\.worktree)?|\.gitconfig|[\\/]git[\\/]+config)(?![\w-])/i;
const COPIA = new Set(['cp', 'mv', 'ln', 'copy', 'move', 'copy-item', 'move-item', 'cpi', 'mi', 'install']);
function escribeConfigGit(texto) {
  if (!/config/i.test(texto) || !/git/i.test(texto)) return false;
  for (const s of segmentos(texto, ';&|\n')) {
    if (/>[ \t]*['"]?[^\s'";&|<>]*(?:\.git[\\/]+config(?:\.worktree)?|\.gitconfig|[\\/]git[\\/]+config)(?![\w-])/i.test(s)) return true;
    if (antesQue(s, /\b(?:Out-File|Set-Content|Add-Content|Tee-Object|tee)\b/i, new RegExp(RUTA_CONFIG.source, 'gi'))) return true;
    if (COPIA.has(primeraPalabra(s)) && (RUTA_CONFIG.test(s) || (/\.git[\\/]*(?=['"\s]|$)/i.test(s) && /config/i.test(s)))) return true;
  }
  return false;
}
function aliasConCommit(texto) {
  for (const s of segmentos(texto, ';&|\n')) {
    const c = /\bconfig\b/i.exec(s);
    if (!c) continue;
    const resto = s.slice(c.index);
    const a = /\balias\.[\w.-]+/i.exec(resto);
    if (a && PALABRA_COMMIT.test(resto.slice(a.index + a[0].length))) return true;
  }
  return false;
}
// CICLO 7c: SEGUNDA lectura del texto con cada salto de línea DENTRO de comillas cambiado por un espacio (los de FUERA
// se quedan: siguen separando comandos). Escaneo CONSERVADOR: '…' (con '' de PowerShell), "…" (con \x, `x y ""), here-
// strings @"…"@ / @'…'@ hasta su cierre en inicio de línea; fuera de comillas no hay escapes (un \" o `" abre: así sobra
// «dentro», nunca falta); una comilla sin cerrar deja DENTRO todo lo que sigue. Solo alimenta reglas que NIEGAN.
function juntarComillas(t) {
  let out = '';
  let i = 0;
  const n = t.length;
  const dentro = (a, b) => t.slice(a, b).replace(/[\r\n]/g, ' ');
  while (i < n) {
    const c = t[i];
    if (c === '@' && (t[i + 1] === '"' || t[i + 1] === "'")) {
      const q = t[i + 1];
      const fin = t.indexOf('\n' + q + '@', i + 2);
      const hasta = fin < 0 ? n : fin + 3;
      out += dentro(i, hasta); i = hasta; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { if (t[j] === "'") { if (t[j + 1] === "'") { j += 2; continue; } break; } j++; }
      const hasta = Math.min(j + 1, n);
      out += dentro(i, hasta); i = hasta; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if ((t[j] === '\\' || t[j] === '`') && j + 1 < n) { j += 2; continue; }
        if (t[j] === '"') { if (t[j + 1] === '"') { j += 2; continue; } break; }
        j++;
      }
      const hasta = Math.min(j + 1, n);
      out += dentro(i, hasta); i = hasta; continue;
    }
    out += c; i++;
  }
  return out;
}
function saltoGuarda(crudo) {
  const base = lecturasCR(crudo); // CICLO 7b/7c: cada interpretación real del CR (ver lecturasCR)
  const texto = base[0]; // CICLO 7b: el CR suelto de PowerShell corta segmento (B20, B20b, C3)
  // CICLO 7c: la excepción de lecturas puras (C3) exige que TODAS las lecturas del CR sean lecturas puras (si una no lo
  // es, no hay excepción: solo puede negar de más); las copias con comillas unidas nunca la deciden. Las reglas se evalúan
  // sobre cada lectura del CR y su copia con los saltos dentro de comillas → espacio; niega si cualquiera niega.
  const pura = /\bgit\b/i.test(texto) && base.every((b) => lecturaPura(b));
  const vistas = new Set(); // la primera va primero
  for (const b of base) { vistas.add(b); vistas.add(juntarComillas(b)); }
  for (const v of vistas) { const r = reglasSalto(v, pura); if (r) return r; }
  return null;
}
function reglasSalto(texto, pura) {
  if (persistente(texto)) return MOTIVO_PROHIBIDO('cambiar de forma persistente GIT_CONFIG_* / HOME / USERPROFILE / XDG_CONFIG_HOME (setx, SetEnvironmentVariable, HKCU\\Environment): puede quitar la guarda de git');
  if (escribeConfigGit(texto)) return MOTIVO_PROHIBIDO('escribir .git/config, ~/.gitconfig o ~/.config/git/config desde el shell (puede poner core.hooksPath y quitar la guarda de git)');
  if (!/\bgit\b/i.test(texto)) return null;
  if (pura) return null; // C3 (ciclo 7): solo lectores puros, sin ejecutar ni escribir (7c: calculado en la primera lectura)
  if (/no-verify/i.test(texto) || PREFIJO_NO_VERIFY.test(texto)) return MOTIVO_PROHIBIDO('--no-verify');
  if (hooksPathEscrito(texto)) return MOTIVO_PROHIBIDO('core.hooksPath (quita o cambia la guarda de git, igual que --no-verify)');
  if (/GIT_CONFIG_/i.test(texto)) return MOTIVO_PROHIBIDO('variables GIT_CONFIG_* junto a git (pueden quitar la guarda de git)');
  { const cn = commitN(texto); if (cn) return MOTIVO_PROHIBIDO('git ' + cn + ' -n (--no-verify)'); }
  // `-c <sección>.…` (la c es minúscula: `-C` es la carpeta; la sección de git no distingue mayúsculas)
  const secciones = [...texto.matchAll(/(?:^|[\s'",\[(])-c['",\s]*([A-Za-z]+)\./g)].map((m) => m[1].toLowerCase());
  if (secciones.includes('alias')) return MOTIVO_PROHIBIDO('git -c alias.<x>=… (un alias oculta el subcomando real y el guardia no puede revisarlo)');
  if (aliasConCommit(texto)) return MOTIVO_PROHIBIDO('git config alias.<x> con «commit» (un alias oculta el commit y sus opciones)');
  if (/_HEAD/i.test(texto) && segmentos(texto, ';&|\n').some((s) => antesQue(s, ESCRIBE, ESTADO_ORIGEN))) {
    return MOTIVO_PROHIBIDO('escribir MERGE_HEAD / CHERRY_PICK_HEAD / REBASE_HEAD / REVERT_HEAD a mano (la guarda de git trataría como historial lo que no lo es)');
  }
  if (PALABRA_COMMIT.test(texto)) {
    if (ASIGNA_HOME.test(texto)) return MOTIVO_PROHIBIDO('asignar HOME / USERPROFILE / XDG_CONFIG_HOME junto a un commit (cambia el ~/.gitconfig que lee git y puede quitar la guarda)');
    if (secciones.includes('include') || secciones.includes('includeif') || /--config-env/i.test(texto)) {
      return MOTIVO_PROHIBIDO('git -c include.* / includeIf.* / --config-env junto a un commit (puede quitar la guarda de git)');
    }
  }
  return null;
}

function nombrePrograma(t) {
  return path.basename(String(t).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

function esPrefijo(nombre, completo, min) {
  return nombre.length >= min && completo.startsWith(nombre);
}

function resolver(base, destino) {
  if (typeof destino !== 'string' || !destino) return base;
  let d = destino;
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])(?:\/|$)(.*)$/.exec(d); // /c/carpeta/x (Git Bash) → C:\carpeta\x
    if (m) d = m[1].toUpperCase() + ':\\' + m[2];
  }
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(require('os').homedir(), d.slice(1));
  return path.resolve(base, d);
}

// Separa banderas de posicionales de un subcomando, sin analizar como bandera el
// texto de -m/--message ni otros valores.
function analizarBanderas(rest, valorCortas) {
  const f = { largas: [], cortas: new Set(), pos: [], archivos: [] };
  let dd = false;
  for (let i = 0; i < rest.length; i++) {
    let a = rest[i];
    if (/^[-+]/.test(a)) a = a.replace(/[)`]+$/, '');
    // Redirecciones y llaves/paréntesis sueltos NUNCA son rutas ni opciones del comando (`2>&1`, `>/dev/null`, `> f`,
    // `*> $null`, `<<< "x"`, `}`, `)`): el destino de `> f` es el SIGUIENTE token.
    if (/^(?:\d+|\*|&)?>>?$|^\d*<{1,3}$/.test(a)) { i++; continue; }
    if (/^(?:\d+|\*|&)?>>?\S|^\d*<\S/.test(a) || /^[})]+$/.test(a)) continue;
    if (dd) { f.pos.push(a); continue; }
    if (a === '--') { dd = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const nombre = eq < 0 ? a : a.slice(0, eq);
      f.largas.push(nombre);
      if (eq >= 0) { if (nombre === '--file') f.archivos.push(a.slice(eq + 1)); }
      else if (LARGAS_CON_VALOR.has(nombre)) {
        const v = rest[++i];
        if (nombre === '--file' && v !== undefined) f.archivos.push(v);
      }
      continue;
    }
    if (a.length > 1 && a[0] === '-') {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        f.cortas.add(ch);
        if (valorCortas.includes(ch)) {
          const val = a.slice(j + 1);
          if (ch === 'F') { const v = val || rest[i + 1]; if (v !== undefined) f.archivos.push(v); }
          if (!val) i++;
          break;
        }
      }
      continue;
    }
    f.pos.push(a);
  }
  return f;
}

// ---------------------------------------------------------------- análisis
function analizar(cmd, ps, estado, completo, profundidad) {
  // B9: más allá de la profundidad que se sabe analizar, si el texto menciona git se NIEGA (antes se dejaba pasar)
  if (profundidad > 3) {
    if (!/\bgit\b/i.test(cmd)) return null;
    return /(?<![\w.-])commit(?![\w.-])/i.test(completo) ? relajar(MOTIVO_NO_ANALIZABLE, completo, true) : MOTIVO_NO_ANALIZABLE;
  }
  for (const seg of dividir(cmd, ps)) {
    const r = analizarSeg(seg.slice(), ps, estado, completo, profundidad);
    if (r) return r;
  }
  return null;
}

function analizarSeg(t, ps, estado, completo, profundidad) {
  // ¿hay algo que commitear y git en el comando completo? (para lo que el guardia no puede analizar)
  // (`commit` como palabra suelta: `.pre-commit-config.yaml` o `git-commit-x` no son un commit)
  const mencionaCommit = () => /\bgit\b/i.test(completo) && /(?<![\w.-])commit(?![\w.-])/i.test(completo);
  const noAnalizable = () => relajar(MOTIVO_NO_ANALIZABLE, completo, true);
  _dirCapa = estado.dirDudosa ? null : estado.dir; // C4d: la capa se acredita en la carpeta del comando
  let k = 0;
  let envuelto = false;
  let wrap = '';
  let durSaltada = false;
  let redirLocal = false;
  while (k < t.length) {
    let x = t[k];
    if (k === 0) x = x.replace(/^(?:\$\(|[({`]+)+/, '');
    if (x === '') { k++; continue; }
    if (x === '{' || x === '(' || /^[A-Za-z_][\w-]*\(\)$/.test(x)) { k++; continue; } // `f() { git commit; }`, `{ git commit; }`
    if (/^[A-Za-z_]\w*=/.test(x)) {
      // `out=$(git commit …)` / out=`git commit`: lo que sigue a la sustitución ES el comando
      const sust = /^[A-Za-z_]\w*="?(?:\$\(|`)(.*)$/.exec(x);
      if (!sust) { k++; continue; }
      x = sust[1];
      if (x === '') { k++; continue; }
    }
    // PowerShell `$o = git commit …`: la asignación (= += -= *= /=) no es el programa; lo que sigue sí
    if (/^\$[\w:]+$/.test(x) && /^[+\-*\/]?=$/.test(t[k + 1] || '') && k + 2 < t.length) { k += 2; continue; }
    if (WRAP.has(x.toLowerCase())) { envuelto = true; wrap = x.toLowerCase(); durSaltada = false; k++; continue; }
    if (envuelto && x.startsWith('-')) {
      const conValor = WRAP_VALOR[wrap];
      if (conValor && conValor.test(x)) {
        if (WRAP_CAMBIA_DIR.test(x)) redirLocal = true;
        if (wrap === 'env' && /^(?:-S|--split-string)$/.test(x)) {
          // env -S "git commit …": el texto se vuelve a cortar como comando → se analiza como tal
          return analizar(t.slice(k + 1).join(' '), ps, estado, completo, profundidad + 1);
        }
        k += 2; continue; // la opción y su valor
      }
      if (wrap === 'env' && /^-[CS]./.test(x)) {
        if (x[1] === 'C') redirLocal = true; else return analizar(x.slice(2) + ' ' + t.slice(k + 1).join(' '), ps, estado, completo, profundidad + 1);
      }
      if (wrap === 'env' && /^--(?:chdir)=/.test(x)) redirLocal = true;
      if (wrap === 'env' && /^--split-string=/.test(x)) return analizar(x.slice(15) + ' ' + t.slice(k + 1).join(' '), ps, estado, completo, profundidad + 1);
      k++; continue;
    }
    if (envuelto && wrap === 'timeout' && !durSaltada && /^[\d.]/.test(x)) { durSaltada = true; k++; continue; } // timeout <duración> cmd
    t[k] = x;
    break;
  }
  if (k >= t.length) return null;
  const prog = nombrePrograma(t[k]);

  if (CD_VUELVE.has(prog)) { estado.dirDudosa = true; return null; } // B8: popd / Pop-Location → carpeta no seguible
  if (CD.has(prog)) {
    let destino;
    for (let i = k + 1; i < t.length; i++) {
      const a = t[i];
      if (/^-(literalpath|path)$/i.test(a)) { destino = t[i + 1]; break; }
      if (a === '-') { destino = a; break; } // cd - / Set-Location - (carpeta anterior)
      if (a.startsWith('-') || /^\/[dD]$/.test(a)) continue;
      destino = a; break;
    }
    // B8: `cd -`, `cd` sin argumento (va a HOME) o sin destino reconocible: carpeta que el guardia no puede seguir
    if (!destino || destino === '-') { estado.dirDudosa = true; return null; }
    // carpeta con variable/expansión ($ % `): no se puede resolver aquí → un git commit posterior se niega (B5)
    const dudoso = /[$%`]/.test(destino);
    const absoluto = path.isAbsolute(destino) || /^\/[a-zA-Z](?:\/|$)/.test(destino) || /^~(?:[\\/]|$)/.test(destino);
    estado.dirDudosa = dudoso || (!absoluto && !!estado.dirDudosa);
    estado.dir = resolver(estado.dir, destino);
    return null;
  }

  if (SHELLS.has(prog)) {
    // CICLO 7 (C4a; uae-security c6 SEC-003): en PowerShell, `bash`/`sh` sin la ruta de Git Bash es el lanzador de WSL
    // (Get-Command bash → …\WindowsApps\bash.exe): su git no usa la guarda → nunca se relaja y se niega todo subcomando que
    // cree commits (commit, merge, rebase, cherry-pick, revert, am, pull).
    if (ps && (prog === 'bash' || prog === 'sh') && !/[\\/]git[\\/]/i.test(t[k])) {
      const resto = t.slice(k + 1).join(' ');
      if (/\bgit\b/i.test(resto) && /(?<![\w.-])(?:commit|merge|rebase|cherry-pick|revert|am|pull)(?![\w.-])/i.test(resto)) {
        return MOTIVO_PROHIBIDO('git commit/merge/rebase/cherry-pick/revert/am/pull dentro de `' + prog + '` en PowerShell (es el de WSL: su git no usa la guarda de git)');
      }
      if (!/^(-[a-z]*c|-command|\/[ck])$/i.test(t[k + 1] || '') && mencionaCommit()) return MOTIVO_NO_ANALIZABLE;
    }
    let conC = false;
    for (let i = k + 1; i < t.length; i++) {
      // B9: PowerShell -EncodedCommand (-e, -ec, -enc…): base64 UTF-16LE → se decodifica y analiza
      if (/^(powershell|pwsh)$/.test(prog) && /^-e(?:c|nc|ncodedcommand)?$/i.test(t[i]) && i + 1 < t.length) {
        let interno = '';
        try { interno = Buffer.from(t[i + 1], 'base64').toString('utf16le'); } catch { /* ilegible */ }
        if (!interno) { if (mencionaCommit()) return noAnalizable(); break; }
        const salto = saltoGuarda(interno); // B20: también en el texto decodificado (saltoGuarda hace sus lecturas)
        if (salto) return salto;
        // CICLO 7c: se analiza con el CR suelto como salto (7b) Y tal cual (c7); niega si cualquiera niega
        // (y con el CR borrado, como Git Bash: lecturasCR)
        const previo = { ...estado, adds: [...(estado.adds || [])] };
        let r = null;
        lecturasCR(interno).some((v, j) => (r = analizar(v, true, j ? { ...previo, adds: [...previo.adds] } : estado,
          completo + '\n' + v, profundidad + 1))); // el texto decodificado también cuenta (crédito, GIT_*)
        if (r) return r;
        conC = true; break;
      }
      if (/^(-[a-z]*c|-command|\/[ck])$/i.test(t[i]) && i + 1 < t.length) {
        const interno = t.slice(i + 1).join(' ');
        const r = analizar(interno, /^(powershell|pwsh)$/.test(prog) || ps, estado, completo, profundidad + 1);
        if (r) return r;
        conC = true; break;
      }
    }
    // B9: shell SIN -c (script, archivo, entrada estándar/heredoc, wsl …): el texto que ejecuta no se ve
    if (!conC && mencionaCommit()) return noAnalizable();
    return null;
  }

  // B9: eval / iex / Invoke-Expression: se analiza su argumento; si trae expansiones no se puede → se niega
  if (EVAL_PROGS.has(prog)) {
    const texto = t.slice(k + 1).join(' ');
    if (/[$`%]/.test(texto) && mencionaCommit()) return noAnalizable();
    return analizar(texto, ps || prog !== 'eval', estado, completo, profundidad + 1);
  }
  // B9: source / . de un script, o un programa dado por variable ($g commit): no se ve qué ejecutan
  if (SOURCE_PROGS.has(prog) && mencionaCommit()) return noAnalizable();
  if (/^\$/.test(t[k]) && !/=/.test(t[k]) && !/^[+*\/-]?=$/.test(t[k + 1] || '') && mencionaCommit()) return noAnalizable();

  // find -exec/-execdir/-ok/-okdir <cmd> ;|+ : el comando interno se analiza como un segmento más
  if (prog === 'find') {
    for (let i = k + 1; i < t.length; i++) {
      if (/^-(?:exec|execdir|ok|okdir)$/.test(t[i])) {
        let fin = t.length;
        for (let j = i + 1; j < t.length; j++) if (t[j] === ';' || t[j] === '+') { fin = j; break; }
        const r = analizarSeg(t.slice(i + 1, fin), ps, estado, completo, profundidad + 1);
        if (r) return r;
      }
    }
    return null;
  }

  if (prog === 'git') {
    const guardada = estado.redirLocal;
    if (redirLocal) estado.redirLocal = true;
    try { return analizarGit(t.slice(k + 1), estado, completo); } finally { estado.redirLocal = guardada; }
  }
  return null;
}

// `git config` con ESCRITURA sobre core.hooksPath / include.path / secciones enteras (--remove-section core…).
// Lecturas (--get, --get-all, --get-regexp, --list, get, list, o la clave sola) pasan.
function configEscribeGuarda(rest) {
  const toks = rest.map((x) => String(x).replace(/^['"]|['"]$/g, ''));
  const LECTURA = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list)$/;
  const ESCRITURA = /^(?:--add|--replace-all|--unset|--unset-all|--remove-section|--rename-section|-e|--edit|set|unset)$/;
  const pos = [];
  for (let j = 0; j < toks.length; j++) {
    const a = toks[j];
    if (/^(?:--file|-f|--type|--default)$/.test(a)) { j++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const clave = (x) => /^(?:core\.hookspath|include\.path|includeif\..*\.path)$/i.test(x);
  const secCore = /^core$/i; // --remove-section core / --rename-section core x
  const hayClave = pos.some(clave) || (toks.some((a) => /^--(?:remove|rename)-section$/.test(a)) && pos.some((x) => secCore.test(x)));
  if (!hayClave) return false;
  if (toks.some((a) => ESCRITURA.test(a))) return true;
  if (toks.some((a) => LECTURA.test(a))) return false;
  const idx = pos.findIndex(clave);
  return idx >= 0 && pos.length > idx + 1; // `git config core.hooksPath <valor>`
}

// Push forzado por configuración: un refspec de push con «+» o un remoto espejo (mirror sin valor = true).
const CFG_PUSH_FORZADO = /^remote\..*\.(?:push\s*=\s*['"]?\+|mirror\s*(?:$|=\s*['"]?(?:true|yes|on|1)\b))/i;

// `git config [--add|set…] remote.<x>.push +<refspec>` o `remote.<x>.mirror true`. Lecturas y borrados pasan.
function configEscribePushForzado(rest) {
  const toks = rest.map((x) => String(x).replace(/^['"]|['"]$/g, ''));
  if (toks.some((a) => /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--unset|--unset-all)$/.test(a))) return false;
  const pos = [];
  for (let j = 0; j < toks.length; j++) {
    const a = toks[j];
    if (/^(?:--file|-f|--type|--default)$/.test(a)) { j++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  for (let j = 0; j < pos.length - 1; j++) {
    if (/^remote\..*\.push$/i.test(pos[j]) && pos[j + 1].startsWith('+')) return true;
    if (/^remote\..*\.mirror$/i.test(pos[j]) && /^(?:true|yes|on|1)$/i.test(pos[j + 1])) return true;
  }
  return false;
}

function analizarGit(args, estado, completo) {
  let dir = estado.dir;
  let dudosa = !!estado.dirDudosa;
  let redirigido = !!estado.redirLocal; // env -C / sudo -D… delante de git (B8)
  let pushForzadoCfg = false; // -c remote.<x>.push=+… / -c remote.<x>.mirror=true
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      const d = String(args[i + 1] === undefined ? '' : args[i + 1]);
      const absoluto = path.isAbsolute(d) || /^\/[a-zA-Z](?:\/|$)/.test(d) || /^~(?:[\\/]|$)/.test(d);
      dudosa = /[$%`]/.test(d) || (!absoluto && dudosa);
      dir = resolver(dir, args[i + 1]); i += 2; continue;
    }
    // core.hooksPath salta los hooks igual que --no-verify
    if (/^(?:-c|--config-env)\s*=?\s*core\.hookspath/i.test(a) || (OPT_GLOBAL_CON_ARG.has(a) && /^core\.hookspath/i.test(String(args[i + 1] || '')))) {
      return MOTIVO_PROHIBIDO('git -c core.hooksPath (salta los hooks, igual que --no-verify)');
    }
    // alias.<x> por -c / --config-env: el guardia no sabría qué subcomando corre en realidad (ej. alias.zz=commit)
    if (/^(?:-c|--config-env)\s*=?\s*alias\./i.test(a) || (OPT_GLOBAL_CON_ARG.has(a) && /^alias\./i.test(String(args[i + 1] || '')))) {
      return MOTIVO_PROHIBIDO('git -c alias.<x>=… (un alias oculta el subcomando real y el guardia no puede revisarlo)');
    }
    // B8: opciones globales que redirigen repo/árbol/hooks/exclusiones: con `git commit` se niegan (abajo)
    if (/^--(?:git-dir|work-tree|namespace|exec-path|bare|config-env)(?:=|$)/.test(a)) redirigido = true;
    {
      const cfg = a === '-c' ? String(args[i + 1] === undefined ? '' : args[i + 1]) : /^-c./.test(a) ? a.slice(2) : '';
      if (CFG_REDIRIGE.test(cfg.trim())) redirigido = true;
      if (CFG_PUSH_FORZADO.test(cfg.trim())) pushForzadoCfg = true;
    }
    if (OPT_GLOBAL_CON_ARG.has(a)) { i += 2; continue; }
    i++;
  }
  _dirCapa = dudosa ? null : dir; // C4d: carpeta del comando (también la de -C) para acreditar la capa de git
  const sub = args[i] && args[i].replace(/[)}`]+$/, ''); // `(git commit)` / `$(git commit)`
  if (!sub) return null;
  const f = analizarBanderas(args.slice(i + 1), VALOR_CORTAS[sub] || '');

  // B13 (ciclo 5): `git config` que ESCRIBE core.hooksPath / include.path (quita la guarda de git): se niega siempre
  if (sub === 'config' && configEscribeGuarda(args.slice(i + 1))) {
    return MOTIVO_PROHIBIDO('git config core.hooksPath (escritura: quita o cambia la guarda de git, igual que --no-verify)');
  }
  // 3. --no-verify en cualquier comando git
  // (ciclo 7, C1b: desde --no-v; git acepta prefijos únicos)
  if (f.largas.some((l) => esPrefijo(l, '--no-verify', 6))) return MOTIVO_PROHIBIDO('--no-verify');
  // 1. reset --hard
  if (sub === 'reset' && f.largas.some((l) => esPrefijo(l, '--hard', 4))) return MOTIVO_PROHIBIDO('git reset --hard');
  // 2. push forzado
  if (sub === 'push') {
    if (f.cortas.has('f') || f.largas.some((l) => esPrefijo(l, '--force', 5) || esPrefijo(l, '--force-with-lease', 5) || esPrefijo(l, '--force-if-includes', 5))) {
      return MOTIVO_PROHIBIDO('git push --force');
    }
    if (f.pos.some((p) => p.startsWith('+'))) return MOTIVO_PROHIBIDO('git push +refspec (push forzado)');
    // --mirror fuerza TODAS las referencias y borra en el remoto las que no existen aquí (prefijos desde --mi)
    if (f.largas.some((l) => esPrefijo(l, '--mirror', 4))) return MOTIVO_PROHIBIDO('git push --mirror (fuerza todas las referencias y borra las que faltan)');
    if (pushForzadoCfg) return MOTIVO_PROHIBIDO('git -c remote.<x>.push=+… / remote.<x>.mirror (push forzado por configuración)');
  }
  // 2b. dejar escrito el push forzado en la configuración: el `git push` siguiente ya no lo delata
  if (sub === 'config' && configEscribePushForzado(args.slice(i + 1))) {
    return MOTIVO_PROHIBIDO('git config remote.<x>.push +… / remote.<x>.mirror true (deja configurado un push forzado)');
  }
  // R3-2: add/commit con la lista de rutas en un archivo: el guardia no ve qué se stagea → prohibido
  // (cualquier prefijo que git acepte; «--pathspec-» a secas es ambiguo y git lo rechaza solo).
  if ((sub === 'add' || sub === 'stage' || sub === 'commit') &&
      f.largas.some((l) => esPrefijo(l, '--pathspec-from-file', 6) || esPrefijo(l, '--pathspec-file-nul', 6))) {
    // Con la capa de git activa el contenido real lo revisa git (pre-commit): solo se niega si hay marcas de salto.
    const r = relajar(MOTIVO_PROHIBIDO('git ' + sub + ' --pathspec-from-file / --pathspec-file-nul (la lista de rutas viene de un archivo y el guardia no puede revisar qué se añade; pasa las rutas en la línea de comandos)'), completo, true);
    return r;
  }
  // 3b. commit -n
  if (sub === 'commit' && f.cortas.has('n')) return MOTIVO_PROHIBIDO('git commit -n (--no-verify)');
  // 3c. am -n (ciclo 7, C1): salta pre-applypatch y applypatch-msg, los únicos hooks que revisan `git am`
  if (sub === 'am' && f.cortas.has('n')) return MOTIVO_PROHIBIDO('git am -n (--no-verify)');
  // 4. clean -f
  if (sub === 'clean' && (f.cortas.has('f') || f.largas.some((l) => esPrefijo(l, '--force', 4)))) {
    return MOTIVO_PROHIBIDO('git clean -f');
  }

  if (sub === 'commit') {
    // B8: el commit debe usar el MISMO contexto git que el guardia revisa (cwd / cd / -C literal)
    if (redirigido || entornoGitPeligroso(completo)) return relajar(MOTIVO_REDIRIGIDO, completo);
    { const salto = marcasConfig(completo); if (salto) return salto; } // GIT_CONFIG_*… junto a un commit: siempre
    // B8: -i/--include suma archivos al índice sin que el guardia los vea; -p/--patch/--interactive eligen trozos aparte.
    // (-o/--only y -a SÍ se modelan: el guardia revisa `diff HEAD -- <rutas>`.)
    // (con la capa de git activa estas opciones se permiten: el pre-commit de git ve el índice final)
    if (f.cortas.has('i')) return relajar(MOTIVO_OPCION_COMMIT('-i'), completo);
    if (f.cortas.has('p')) return relajar(MOTIVO_OPCION_COMMIT('-p'), completo);
    if (f.largas.some((l) => esPrefijo(l, '--include', 5))) return relajar(MOTIVO_OPCION_COMMIT('--include'), completo);
    if (f.largas.some((l) => esPrefijo(l, '--patch', 6))) return relajar(MOTIVO_OPCION_COMMIT('--patch'), completo);
    if (f.largas.some((l) => esPrefijo(l, '--interactive', 8))) return relajar(MOTIVO_OPCION_COMMIT('--interactive'), completo);
  }
  if (sub === 'add' || sub === 'stage') { estado.adds.push({ dir, f }); return null; }
  if (sub === 'commit') return revisarCommit(f, dir, completo, estado.adds, dudosa);
  return null;
}

// ---------------------------------------------------------------- git commit
// Marcas del crédito de Claude en un mensaje. Solo se aplican con la política `prohibir` (POLITICA.prohibir); la
// constante se exporta siempre porque guardia-commit.cjs (la guarda de git) reutiliza estas reglas.
const CREDITO = [/Co-Authored-By:\s*Claude/i, /noreply@anthropic\.com/i, /Generated with \[?Claude Code/i, /Claude-Session:/i];

const SECRETOS = [
  { tipo: 'llave Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { tipo: 'llave sk-', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/g, digito: true, noSi: 'llave Anthropic' },
  { tipo: 'llave Stripe', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { tipo: 'llave AWS', re: /AKIA[0-9A-Z]{16}/g },
  { tipo: 'llave privada', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g },
  { tipo: 'token GitHub', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { tipo: 'llave Google', re: /AIza[0-9A-Za-z_-]{35}/g },
  { tipo: 'token Slack', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
];
const PASSWORD = /(password|passwd|pwd|contraseña)\s*[:=]\s*['"]([^'"\s]{6,})['"]/gi;
const PASSWORD_IGNORAR = /changeme|your|xxx|\*\*\*|<|\$\{|process\.env|example|ejemplo|prueba|test/i;
const ENV_PERMITIDOS = /^\.env\.(example|sample|template|dist)$/;

function tiposEnLinea(linea, sen) {
  const tipos = [];
  for (const s of SECRETOS) {
    if (s.noSi && tipos.includes(s.noSi)) continue;
    s.re.lastIndex = 0;
    let m;
    while ((m = s.re.exec(linea))) {
      if (s.digito && !/\d/.test(m[0])) continue;
      tipos.push(s.tipo);
      break;
    }
  }
  const sr = /service_role/i.test(linea);
  const jwt = /eyJ[A-Za-z0-9_-]{10,}\./.test(linea);
  if (sen) { if (sr) sen.sr = true; if (jwt) sen.jwt = true; } // reglas de varias señales: se agregan por línea
  if (sr && jwt) tipos.push('JWT service_role');
  PASSWORD.lastIndex = 0;
  let m;
  while ((m = PASSWORD.exec(linea))) {
    if (!PASSWORD_IGNORAR.test(m[2])) { tipos.push('contraseña en texto'); break; }
  }
  return tipos;
}

// R3-3: una línea larga ya no se salta: se escanea por ventanas solapadas (VENTANA caracteres, SOLAPE de
// cruce) para que una llave a caballo entre dos ventanas (como máximo SOLAPE caracteres) igual se vea.
// Ronda 6: las líneas de menos de LINEA_LARGA caracteres se escanean COMPLETAS (las reglas de varias señales,
// como service_role + JWT, ven ambas aunque estén a más de una ventana); solo las más largas van por ventanas
// y ahí las reglas de varias señales se agregan por línea (señal A en alguna ventana Y señal B en alguna).
const VENTANA = 8192;
const SOLAPE = 512;
const LINEA_LARGA = 200000;
function tiposEnTexto(linea) {
  if (linea.length < LINEA_LARGA) return tiposEnLinea(linea);
  const tipos = new Set();
  const sen = { sr: false, jwt: false };
  for (let ini = 0; ; ini += VENTANA - SOLAPE) {
    for (const t of tiposEnLinea(linea.slice(ini, ini + VENTANA), sen)) tipos.add(t);
    if (ini + VENTANA >= linea.length) break;
  }
  if (sen.sr && sen.jwt) tipos.add('JWT service_role');
  return [...tipos];
}

function archivoSensible(ruta) {
  const b = path.basename(ruta).toLowerCase();
  if (/^\.env(\..+)?$/.test(b) && !ENV_PERMITIDOS.test(b)) return true;
  return /\.(pem|key|p12|pfx)$/.test(b) || /^id_rsa/.test(b);
}

// Evidencias del navegador (/uae-visual): capturas, reportes y sesiones de trabajo que pueden mostrar datos.
// Nunca van a git, ni con `git add -f`. Las baselines aprobadas (tests/visual/**-snapshots/) sí van.
function evidenciaVisual(ruta) {
  const partes = ruta.replace(/\\/g, '/').split('/');
  const b = partes[partes.length - 1].toLowerCase();
  const dirs = partes.slice(0, -1).map((d) => d.toLowerCase());
  if (dirs.some((d) => d === '.playwright-cli' || d === '.auth' || d === 'blob-report' || d === 'test-results' || d === 'playwright-report')) return true;
  if (/\.har$/.test(b) || /^trace[^/]*\.zip$/.test(b) || /\.report\.(html|json|csv)$/.test(b)) return true;
  for (let i = 0; i + 1 < dirs.length; i++) if (dirs[i] === 'reports' && dirs[i + 1] === 'visual-audit') return true;
  return /storage-state.*\.json$/.test(b) || /^auth-state.*\.json$/.test(b);
}
const MARCA_EVIDENCIA = ' (evidencia visual)';

// Presupuesto TOTAL de tiempo del hook (timeout duro en hooks.json: 10 s; con onFailure block un hook vencido
// BLOQUEA con mensaje genérico). Termina antes del corte para negar con un mensaje útil y dejar margen a node.
// UAEH_GUARDIA_PRESUPUESTO_MS (solo para pruebas): únicamente puede BAJAR el presupuesto (mínimo con 9000); inválida
// (no numérica, <= 0, infinita) → se ignora.
const PRESUPUESTO_DEFECTO_MS = 9000;
const _envPres = Number(process.env.UAEH_GUARDIA_PRESUPUESTO_MS);
const PRESUPUESTO_TOTAL_MS = Number.isFinite(_envPres) && _envPres > 0 ? Math.min(_envPres, PRESUPUESTO_DEFECTO_MS) : PRESUPUESTO_DEFECTO_MS;
const MARGEN_MIN_MS = 300; // si queda menos que esto, ni se intenta llamar a git
function tiempoRestante(t0, ahora, total) { return (total === undefined ? PRESUPUESTO_TOTAL_MS : total) - (ahora - t0); }
const MOTIVO_TIEMPO =
  'Guardia UAEH: git tardó más de ' + PRESUPUESTO_TOTAL_MS / 1000 + ' s revisando el commit (límite del hook: 10 s); repite el comando o divide el commit en partes más pequeñas.';

function ejecutarGit(dir, args) {
  const restante = tiempoRestante(T0, Date.now());
  if (restante < MARGEN_MIN_MS) { const e = new Error('sin tiempo'); e.sinTiempo = true; throw e; }
  return require('child_process').execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8', timeout: restante, maxBuffer: 512 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function errorCorto(e) {
  const stderr = e && e.stderr ? String(e.stderr) : '';
  const primera = (stderr.split(/\r?\n/).find((l) => l.trim()) || (e && (e.code || e.signal)) || 'error desconocido').toString();
  return primera.trim().slice(0, 80);
}

const MOTIVO_NO_EXISTE =
  'Guardia UAEH: el commit incluye archivos que se crean en este mismo comando y no se pueden revisar antes. Crea/stagea primero y haz el commit en un comando aparte.';
const HEAD_AUSENTE = /bad revision|unknown revision|ambiguous argument|does not have any commits|Needed a single revision/i;
const DIFF_BASE = ['--unified=0', '--no-color', '--no-ext-diff', '--no-textconv'];

// Recorre un diff unificado y anota "ruta:línea (tipo)" de cada línea añadida con secreto.
function parsearDiff(diff, anotar) {
  let archivo = '?';
  let linea = 0;
  let enHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) { enHunk = false; continue; }
    if (!enHunk) {
      if (l.startsWith('+++ ')) { archivo = l.slice(4).replace(/\t.*$/, '').replace(/^b\//, '').replace(/\r$/, ''); continue; }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (h) { enHunk = true; linea = Number(h[1]); }
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { linea = Number(h[1]); continue; }
    if (l[0] === '+') {
      // 2.º argumento (ciclo 6, regla de origen de guardia-commit.cjs): clave sin número de línea = ruta + texto + tipo
      const texto = l.slice(1).replace(/\r$/, '');
      for (const tipo of tiposEnTexto(l.slice(1))) anotar(archivo + ':' + linea + ' (' + tipo + ')', archivo + '\0' + texto + '\0' + tipo);
      linea++;
    }
  }
}

// Lo que los "git add" previos (en el mismo comando) van a stagear y aún no está en el índice.
// Devuelve true si algún add trae más archivos nuevos que el tope de escaneo de CONTENIDO (falla cerrado).
function escanearAdds(adds, anotar) {
  let demasiado = false;
  let bytes = 0; // total de contenido de archivos nuevos leído (presupuesto)
  for (const { dir, f } of adds) {
    const todo = f.cortas.has('A') || f.largas.some((l) => esPrefijo(l, '--all', 5));
    const upd = f.cortas.has('u') || f.largas.some((l) => esPrefijo(l, '--update', 5));
    const force = f.cortas.has('f') || f.largas.some((l) => esPrefijo(l, '--force', 5));
    const rutas = f.pos.filter((p) => p !== '');
    if (!todo && !upd && !rutas.length) continue;
    const sinRutas = !rutas.length;
    const base = sinRutas ? ejecutarGit(dir, ['rev-parse', '--show-toplevel']).trim() : dir;
    const ps = sinRutas ? [] : ['--', ...rutas];

    // rastreados modificados
    try {
      for (const nom of ejecutarGit(base, ['diff', 'HEAD', '--name-only', '--diff-filter=d', ...ps]).split(/\r?\n/).filter(Boolean)) {
        if (archivoSensible(nom)) anotar(nom + ' (archivo sensible)');
        if (evidenciaVisual(nom)) anotar(nom + MARCA_EVIDENCIA);
      }
      parsearDiff(ejecutarGit(base, ['diff', 'HEAD', ...DIFF_BASE, ...ps]), anotar);
    } catch (e) { if (!HEAD_AUSENTE.test(String((e && e.stderr) || ''))) throw e; }

    // no rastreados (y con -f también los ignorados)
    if (upd && !todo) continue;
    const nuevos = new Set();
    const listar = (extra) => {
      for (const x of ejecutarGit(base, ['ls-files', '-z', '-o', ...extra, '--exclude-standard', ...ps]).split('\0')) if (x) nuevos.add(x);
    };
    listar([]);
    if (force) listar(['-i']);
    let cuenta = 0;
    for (const rel of nuevos) {
      if (archivoSensible(rel)) anotar(rel + ' (archivo sensible)');
      if (evidenciaVisual(rel)) anotar(rel + MARCA_EVIDENCIA);
      // El tope solo aplica al escaneo de CONTENIDO; las RUTAS de evidencia se revisan todas.
      // Pasado el tope no se salta el contenido en silencio: se marca para negar el commit.
      if (++cuenta > TOPE_CONTENIDO) { demasiado = true; continue; }
      try {
        const abs = path.resolve(base, rel);
        const st = fs.statSync(abs);
        // RESIDUAL (R3-3, aceptado): los archivos NUEVOS de más de TOPE_BYTES o binarios (NUL en los primeros
        // 8 KiB) no se escanean por contenido aquí; los cubre gitleaks/trufflehog en /uae-security.
        if (!st.isFile() || st.size > TOPE_BYTES) continue;
        // Presupuesto: el hook tiene timeout de 10 s y, con onFailure "block", vencido BLOQUEA con mensaje genérico
        // → se niega antes, con un mensaje útil.
        bytes += st.size;
        if (bytes > PRESUPUESTO_BYTES || Date.now() - T0 > PRESUPUESTO_MS) { presupuestoAgotado = true; demasiado = true; continue; }
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 8192).includes(0)) continue; // binario
        buf.toString('utf8').split('\n').forEach((l, i) => {
          for (const tipo of tiposEnTexto(l.replace(/\r$/, ''))) anotar(rel + ':' + (i + 1) + ' (' + tipo + ')');
        });
      } catch (e) {
        // ENOENT: el archivo desapareció entre el listado y la lectura → no hay nada que commitear. Cualquier otro error
        // (permisos, bloqueo, E/S) deja un archivo SIN revisar → se niega con motivo concreto (nunca imprime contenido).
        if (e && e.code === 'ENOENT') continue;
        const err = new Error('lectura fallida');
        err.motivoLectura = 'Guardia UAEH: no se pudo leer ' + rel + ' para revisar secretos (' + ((e && e.code) || 'error') + '); repite el comando.';
        throw err;
      }
    }
  }
  return demasiado;
}

const TOPE_CONTENIDO = 3000;
const PRESUPUESTO_BYTES = 64 * 1024 * 1024; // total de archivos nuevos a escanear por commit
const PRESUPUESTO_MS = 7000; // desde que arrancó el hook (timeout duro: 10 s)
let presupuestoAgotado = false;
const MOTIVO_PRESUPUESTO = 'Guardia UAEH: commit demasiado grande para revisar secretos a tiempo: divídelo en commits más pequeños.';
const TOPE_BYTES = 20 * 1024 * 1024; // archivos nuevos de texto: se escanean hasta 20 MiB (antes 2 MiB)
const MOTIVO_GRANDE = 'Guardia UAEH: commit demasiado grande para revisar secretos: divídelo en commits más pequeños.';

const MOTIVO_CARPETA =
  'Guardia UAEH: no se puede saber en qué carpeta se hace este commit (la ruta lleva una variable o no existe), así que no se revisan los secretos. Para commits usa la ruta literal en cd / git -C.';
// Texto de motivo para los hallazgos (rutas:línea y tipo, NUNCA el valor). Lo comparten esta capa y la guarda de git.
function motivoHallazgos(hallazgos) {
  const evidencias = hallazgos.filter((h) => h.endsWith(MARCA_EVIDENCIA)).map((h) => h.slice(0, -MARCA_EVIDENCIA.length));
  if (evidencias.length) {
    const lista = evidencias.slice(0, 5).join(', ') + (evidencias.length > 5 ? ', … (+' + (evidencias.length - 5) + ' más)' : '');
    return 'Guardia UAEH: el commit incluye evidencias del navegador que nunca van a git → ' + lista + '. Son capturas, reportes o sesiones de trabajo (pueden mostrar datos): sácalas con git restore --staged <ruta> y confirma que estén en .gitignore o .git/info/exclude. Las baselines aprobadas van en tests/visual/**/*-snapshots/.';
  }
  if (hallazgos.length) {
    const lista = hallazgos.slice(0, 5).join(', ') + (hallazgos.length > 5 ? ', … (+' + (hallazgos.length - 5) + ' más)' : '');
    return 'Guardia UAEH: posible secreto en el commit → ' + lista + '. Sácalo del commit (variable de entorno / .gitignore). Si es un dato de prueba, cámbialo por un valor que no parezca llave real.';
  }
  return null;
}

function revisarCommit(f, dir, completo, adds, dirDudosa) {
  // Crédito de Claude: texto del comando + contenido de -F/--file. Solo si la política de commits del usuario lo prohíbe.
  let texto = completo;
  for (const a of f.archivos) {
    if (!a || a === '-') continue;
    try { texto += '\n' + fs.readFileSync(path.resolve(dir, a), 'utf8').slice(0, 1024 * 1024); } catch { /* sin archivo */ }
  }
  if (POLITICA.prohibir && CREDITO.some((re) => re.test(texto))) return MOTIVO_CREDITO;

  // B5: carpeta con variable ($ % `) o inexistente → no se puede revisar → se niega (antes se permitía sin revisar secretos)
  if (dirDudosa) return relajar(MOTIVO_CARPETA, completo);
  try { if (!fs.statSync(dir).isDirectory()) return relajar(MOTIVO_CARPETA, completo); } catch { return relajar(MOTIVO_CARPETA, completo); }

  const todo = f.cortas.has('a') || f.largas.some((l) => esPrefijo(l, '--all', 5));
  const rutas = f.pos.length ? ['--', ...f.pos] : [];
  try {
    // Fuera de un repo git diff se comporta como --no-index y truena raro: se pregunta antes.
    try { ejecutarGit(dir, ['rev-parse', '--git-dir']); }
    catch (e) { if (/not a git repository/i.test(String((e && e.stderr) || ''))) return null; throw e; }

    // git add X previo con X que aún no existe: no se puede revisar → se niega.
    for (const a of adds || []) {
      for (const p of a.f.pos) {
        if (!p || /^:|[*?[]/.test(p)) continue;
        if (fs.existsSync(resolver(a.dir, p))) continue;
        let rastreado = false;
        try { rastreado = ejecutarGit(a.dir, ['ls-files', '--', p]).trim() !== ''; } catch { /* sin info */ }
        if (!rastreado) return relajar(MOTIVO_NO_EXISTE, completo);
      }
    }

    const correr = (extra) => {
      if (todo || f.pos.length) {
        try { return ejecutarGit(dir, ['diff', 'HEAD', ...extra, ...rutas]); }
        catch (e) {
          if (!HEAD_AUSENTE.test(String(e.stderr || ''))) throw e;
          return ejecutarGit(dir, ['diff', '--cached', ...extra, ...rutas]);
        }
      }
      return ejecutarGit(dir, ['diff', '--cached', ...extra, ...rutas]);
    };
    const nombres = correr(['--name-only', '--diff-filter=d']).split(/\r?\n/).filter(Boolean);
    const diff = correr(DIFF_BASE);

    const hallazgos = [];
    const visto = new Set();
    const anotar = (s) => { if (!visto.has(s)) { visto.add(s); hallazgos.push(s); } };
    for (const nom of nombres) {
      if (archivoSensible(nom)) anotar(nom + ' (archivo sensible)');
      if (evidenciaVisual(nom)) anotar(nom + MARCA_EVIDENCIA);
    }
    parsearDiff(diff, anotar);
    const grande = escanearAdds(adds || [], anotar);

    const m = motivoHallazgos(hallazgos);
    if (m) return m;
    if (presupuestoAgotado) return relajar(MOTIVO_PRESUPUESTO, completo);
    if (grande) return relajar(MOTIVO_GRANDE, completo);
    return null;
  } catch (e) {
    if (/not a git repository/i.test(String((e && e.stderr) || ''))) return null;
    if (e && e.motivoLectura) return relajar(e.motivoLectura, completo);
    if (e && (e.sinTiempo || e.code === 'ETIMEDOUT')) return relajar(MOTIVO_TIEMPO, completo);
    return relajar('Guardia UAEH: no se pudo revisar el commit (' + errorCorto(e) + '): revisar a mano antes de commitear.', completo);
  }
}

// ---------------------------------------------------------------- principal
if (require.main !== module) {
  // Para las pruebas y para guardia-commit.cjs (la guarda de git reutiliza estas reglas; no corre el hook)
  module.exports = {
    tiempoRestante, PRESUPUESTO_TOTAL_MS, archivoSensible, evidenciaVisual, tiposEnTexto, parsearDiff, motivoHallazgos,
    CREDITO, MOTIVO_CREDITO, DIFF_BASE, MARCA_EVIDENCIA, TOPE_BYTES, capaGitActiva, saltoGuarda,
  };
} else {
const MOTIVO_SIN_COMANDO =
  'Guardia UAEH: la entrada del hook no se pudo leer o no trae un comando de texto → negado (falla cerrado). Reintenta el comando; si persiste, revisa el hook guardia-git.js del plugin uaeh-harness.';
let entrada;
try {
  entrada = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch { negar(MOTIVO_SIN_COMANDO); }

try {
  const crudo = entrada && entrada.tool_input && entrada.tool_input.command;
  if (typeof crudo !== 'string') negar(MOTIVO_SIN_COMANDO);
  // CICLO 7b/7c: cada interpretación real del CR (lecturasCR: PowerShell corta, Git Bash borra, c7 tal cual); sin CR → una
  const lecturas = lecturasCR(crudo);
  // powershell -EncodedCommand <base64>: el texto "git" va dentro del base64 → tampoco sale temprano (B9)
  // (B20b: setx / SetEnvironmentVariable / HKCU\Environment de GIT_CONFIG_*/HOME tampoco salen temprano)
  // 7c: sale temprano solo si NINGUNA lectura trae git (con el CR borrado, `gi<CR>t` es git)
  if (lecturas.every((v) => !/\bgit\b/i.test(v) && !/\s-e(?:nc\w*|c)?\s+[A-Za-z0-9+\/=]{12,}/i.test(v) && !/setx|SetEnvironmentVariable|HKCU|gitconfig/i.test(v))) salir();
  // B20 (ciclo 6): saltarse la guarda se busca en el texto CRUDO, en ambos modos, ANTES de cualquier análisis
  { const salto = saltoGuarda(crudo); if (salto) negar(salto); } // 7c: saltoGuarda hace sus lecturas desde el crudo
  const ps = entrada.tool_name === 'PowerShell';
  const cwd = typeof entrada.cwd === 'string' && entrada.cwd ? entrada.cwd : process.cwd();
  _cwdBase = cwd;
  // CICLO 7c: se analiza cada lectura del CR (corte de PowerShell, borrado de Git Bash, tal cual de c7); niega si cualquiera
  // niega. Solo con el corte, `git -c x=y<CR> reset --hard` pasaba en Bash (en Git Bash el CR se borra, no separa).
  let r = null;
  lecturas.some((v) => (r = analizar(v, ps, { dir: cwd, adds: [] }, v, 0)));
  if (r) negar(r);
  salir();
} catch {
  // Falla CERRADO (UAEH F2) solo en su dominio: aquí ya se sabe que el comando menciona git. Los comandos sin
  // git salieron antes. Errores al cargar el archivo y timeouts los cubre `onFailure: "block"` en hooks.json.
  negar('Guardia UAEH: error interno al revisar un comando de git → negado (falla cerrado). Revisa el hook guardia-git.js del plugin uaeh-harness o separa el comando en pasos simples.');
}
}
