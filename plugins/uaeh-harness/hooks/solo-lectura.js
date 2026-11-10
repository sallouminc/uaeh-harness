#!/usr/bin/env node
// SOLO LECTURA — candado para agentes REVISORES (verificador, auditor de seguridad, verificador visual).
//
// Se registra en hooks/hooks.json (PreToolUse, matcher "Bash|PowerShell"). Un hook de plugin corre en TODAS las sesiones
// y en TODOS los subagentes (el frontmatter de un agente no admite `hooks`), así que lo primero que hace este archivo es
// averiguar QUIÉN ejecuta la herramienta (compuerta por identidad: hooks/_identidad.js + hooks/candados.json):
//   · Sesión principal (el evento no trae `agent_type`), agente que no figura en candados.json («uae-builder»,
//     «general-purpose»…) o candados.json ilegible → el candado NO aplica: sale con código 0 y sin salida. Es un
//     fail-open por identidad desconocida, a propósito y documentado: el candado se pone donde sí se sabe quién es, y
//     la sesión principal nunca queda bloqueada por él. Con candados.json ilegible deja además un aviso en stderr.
//   · stdin ilegible (JSON roto) → tampoco se puede saber quién ejecuta: no aplica (con aviso en stderr).
//   · Agente listado («uae-verifier», «uae-security», «browser-verifier», con o sin el prefijo del plugin, p. ej.
//     «uaeh-harness:uae-verifier») → aplica, y la lógica es la de siempre, que FALLA CERRADO (más abajo).
//
// Deja pasar lectura, pruebas y diagnóstico; niega las formas comunes de escribir, borrar, mover,
// instalar, publicar o alterar git. Es un candado de "mejor esfuerzo" por texto: frena los
// descuidos y los atajos comunes. NO es una frontera de seguridad: un comando armado a propósito
// para evadirlo puede pasar (lo confirmaron auditorías con Codex y uae-security). La frontera para el
// código auditado es el contenedor de uaeh-sandbox. Para el revisor, la garantía la da el SELLO DE
// INTEGRIDAD (`scripts/uaeh-integridad.cjs`): mide el repo y el arnés antes y después y anula el veredicto si algo
// cambió, sin depender de cómo corte los argumentos cada shell. Este filtro previene; el sello garantiza.
// WSL y contenedores: un revisor SOLO entra a WSL por la caja de arena, con la forma exacta
// `wsl -d <distro> [-u <usuario>] -e /opt/uaeh/bin/uaeh-sandbox ejecutar …` (distro = `wsl.distro` de la configuración o
// UAEH_WSL_DISTRO, por defecto «Ubuntu-24.04»; usuario = cualquiera con nombre válido de Linux salvo root) o, en Linux,
// llamando directo a `/opt/uaeh/bin/uaeh-sandbox ejecutar …`; cualquier otro wsl/docker/podman se niega (si no,
// `wsl -e rm -rf /mnt/c/...` sería una puerta trasera).
//
// Entrada: JSON por stdin ({tool_name, tool_input:{command}, agent_type, ...}).
// Salida para negar: JSON en stdout con permissionDecision "deny", código 0.
// Para un agente listado, si algo falla (sin `command` de texto, error interno): NIEGA (falla cerrado). Texto vacío ("")
// pasa. Los candados no declaran `onFailure`: este archivo no cubre una caída del propio node ni un timeout (la garantía
// de último recurso es el sello de integridad).
//
// FRICCIÓN ACEPTADA (ciclos 2-3 de revisión): el filtro trabaja por texto y NO trata las comillas como inertes (hacerlo abre la
// clase de evasión por paridad con el shell real). Por eso niega `>` y textos con forma de comando aunque estén entre
// comillas: `Write-Output "Remove-Item"`, `grep "rm -rf"`, `sed '…<…>…'`. Para buscar patrones usa la herramienta Grep
// o Read, no grep/sed por Bash.
// `git config`: solo se permiten las lecturas inequívocas (--get, --get-all, --get-regexp, --get-urlmatch, --list/-l y los
// subcomandos `get`/`list`, con opciones de lectura y argumentos simples sin comillas/expansiones); cualquier otra forma
// (--add, --unset*, --replace-all, -e, set, `clave valor`…) sigue negada. Ante la duda, niega.
// Ciclo 4: el ejecutable (git, rm…) se reconoce por su NOMBRE BASE y en cualquier posición de comando (tras then/do/else/`)`/
// `!`/time/env/nice/VAR=1…, con ruta y comillas); `git -c alias.*`, `--config-env` y `& $variable` (con git en el texto)
// se niegan; `>&PALABRA` es escritura y `@` ya no es carácter seguro (splatting de PowerShell).
'use strict';

const fs = require('fs');
const path = require('path');

// Carácter de uso privado U+E000: con él, `enmascararControl()` reemplaza cada palabra de control ACTIVA y las reglas con PRE
// lo reconocen como posición de comando. Se arma con fromCharCode para que no viaje invisible dentro del código fuente.
const MARCA_CONTROL = String.fromCharCode(0xE000);

// Posición de comando: inicio, o tras ; & | ( ) { ! salto de línea, comillas, backtick, las palabras de control del shell
// (then do else elif if while until), los envoltorios (sudo doas env nice nohup time command exec timeout stdbuf setsid
// builtin ionice, con sus opciones/valores y VAR=valor), "xargs [-flags] ", "cmd /c ". Después, asignaciones VAR=valor y
// una ruta opcional (varios tramos, o entre comillas con espacios): el ejecutable se reconoce por su NOMBRE BASE
// (ciclo 4, B11: antes `then git config`, `env git config`, `"C:/Program Files/Git/bin/git.exe" config` pasaban).
const ENVOLTORIOS = String.raw`\b(?:sudo|doas|env|nice|nohup|time|command|exec|timeout|stdbuf|setsid|builtin|ionice)\s+(?:-\S+\s+(?:\S+\s+)?|[A-Za-z_]\w*=\S*\s+|\d+\S*\s+)*`;
// B18/B23/B23b (ciclos 5-6): las palabras de control (then/do/else/if/while…) solo cuentan FUERA de comillas (`grep -rn "if rm" src`,
// `echo "do rm the thing"` pasan) o dentro del texto que un intérprete va a EJECUTAR (`bash -c "if x; then rm y; fi"`, -Command, eval).
// En vez de un lookbehind (cuadrático: 11,8 s con 48 KB), `enmascararControl()` (abajo) hace UN recorrido lineal con estado de
// comillas y cambia cada palabra de control ACTIVA por U+E000 + espacios; PRE reconoce U+E000 como posición de comando.
// B17 (ciclo 5): la asignación de PowerShell es posición de comando: `$v =`, `$v +=`, `[tipo]$v =` delante del comando.
const ASIGNACION_PS = String.raw`\$[\w:]+\s*[+\-*\/]?=\s*|\[[\w.\[\]]+\]\s*\$[\w:]+\s*[+\-*\/]?=\s*`;
const PRE = String.raw`(?:^|[;&|(){!\n` + MARCA_CONTROL + '`' + String.raw`"']|` + ASIGNACION_PS + '|' + ENVOLTORIOS +
  String.raw`|\bxargs\s+(?:-\S+\s+)*|\bcmd(?:\.exe)?\s+/[ck]\s+)\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:(?:[\w.:~$%{}-]*[\\/])+|(?<=["'])[^"'\n]*[\\/])?`;
const FIN = String.raw`(?:\.exe)?["']?(?=\s|$|[;&|)])`;

const CMDS_ARCHIVO = 'rm|rmdir|del|erase|rd|mv|cp|move|copy|xcopy|robocopy|ren|rename|touch|mkdir|md|truncate|shred|dd|chmod|chown|ln|ri|mi|cpi|ni|sc|ac|tee';
const CMDLETS = 'Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Export-Csv|Export-Clixml|Tee-Object|Start-Process|Expand-Archive|Compress-Archive|Stop-Process';
const GIT_SUBS = 'commit|push|reset|checkout|restore|switch|clean|stash|rebase|merge|apply|am|cherry-pick|revert|tag|rm|mv|add|init|config|update-ref|gc|prune|filter-branch|worktree\\s+(?:add|remove)|reflog\\s+expire';
// Opciones globales de git antes del subcomando: -C <ruta>, -c k=v, --no-pager, --git-dir=…
const GIT_GLOBALES = String.raw`(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace)\s+\S+|--[\w-]+(?:=\S+)?|-[pP]))*`;
const MGR = 'npm|pnpm|yarn|bun|pip|pip3|pipx|uv|composer|gem|cargo|go';
const MGR_VERBO = 'i|install|add|remove|uninstall|rm|update|upgrade|up|ci|link|unlink|publish|get|require';

// La única entrada permitida a WSL: la caja de arena (todo lo que va tras `--` corre DENTRO del contenedor).
// (Git Bash convierte /opt/... y /mnt/c/... en rutas de Windows: ahí se antepone MSYS_NO_PATHCONV=1, medido con Git Bash.)
// Las reglas dependen de la configuración: la distro es `wsl.distro` (UAEH_WSL_DISTRO la pisa; sin configuración legible,
// «Ubuntu-24.04») y `-u <usuario>` admite cualquier nombre de usuario válido de Linux EXCEPTO root (lookahead negativo):
// como root, el comando podría reescribir /opt/uaeh, donde viven la caja de arena y sus autopruebas.
// Se construyen la primera vez que hacen falta: la sesión principal y los agentes no listados salen por la compuerta de
// identidad sin cargar la configuración.
const DISTRO_DEFECTO = 'Ubuntu-24.04';
const USUARIO_LINUX = '[a-z_][a-z0-9_-]{0,31}';

function escaparRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Distro de WSL según la configuración del usuario (lib/config.cjs: wsl.distro, UAEH_WSL_DISTRO). Nunca lanza.
function distroWsl() {
  try {
    const cfg = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.cjs')).cargarConfig().config;
    const d = cfg && cfg.wsl && cfg.wsl.distro;
    if (typeof d === 'string' && /^[A-Za-z0-9._-]+$/.test(d)) return d;
  } catch { /* sin configuración legible: distro por defecto */ }
  return DISTRO_DEFECTO;
}

let REGLAS_WSL = null;
function reglasWsl() {
  if (REGLAS_WSL) return REGLAS_WSL;
  const d = escaparRegex(distroWsl());
  const usuario = String.raw`(?:\s+-u\s+(?!root\s)${USUARIO_LINUX})?`;
  const usuarioHT = String.raw`(?:[ \t]+-u[ \t]+(?!root[ \t])${USUARIO_LINUX})?`;
  REGLAS_WSL = {
    // wsl [-d <distro>] [-u <usuario>] -e /opt/uaeh/bin/uaeh-sandbox ejecutar …
    sandbox: new RegExp(String.raw`^\s*(?:MSYS_NO_PATHCONV=1\s+)?wsl(?:\.exe)?\s+-d\s+${d}${usuario}\s+(?:-e|--exec)\s+\/opt\/uaeh\/bin\/uaeh-sandbox\s+ejecutar\s`),
    // En Linux no hay wsl: la caja de arena se llama directamente.
    sandboxLinux: /^\s*\/opt\/uaeh\/bin\/uaeh-sandbox\s+ejecutar\s/,
    // Cualquier otro subcomando de la caja de arena llamado directamente (preparar dependencias, etc.) no es cosa de un revisor.
    sandboxOtro: /^\s*\/opt\/uaeh\/bin\/uaeh-sandbox(?=\s|$)/,
    // Autopruebas de la caja de arena (root, en /opt/uaeh: ningún revisor las puede cambiar). Solo la línea EXACTA,
    // completa y sin nada más, para que el verificador independiente las corra.
    autopruebas: new RegExp(String.raw`^[ \t]*(?:MSYS_NO_PATHCONV=1[ \t]+)?wsl(?:\.exe)?[ \t]+-d[ \t]+${d}${usuarioHT}[ \t]+(?:-e|--exec)[ \t]+(?:(?:env[ \t]+PROBAR_DISCO=1[ \t]+)?bash[ \t]+\/opt\/uaeh\/pruebas\/(?:probar-sandbox|probar-promover|probar-pnpmfile)\.sh|\/opt\/uaeh\/bin\/uaeh-validar[ \t]+--pruebas)[ \t]*$`),
  };
  return REGLAS_WSL;
}

// La pista se anexa a cada negativa de WSL/contenedores: el revisor recibe, en el mismo momento en que se le niega,
// la forma exacta que sí se permite.
const PISTA_WSL = ' (en WSL solo se permite: wsl -d <distro> -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run <run> --agente <id> -- <comando>; el código va entre comillas simples)';
const PISTA_LINUX = ' (la caja de arena se llama así: /opt/uaeh/bin/uaeh-sandbox ejecutar --run <run> --agente <id> -- <comando>; el código va entre comillas simples)';

// ¿El comando de la caja de arena es inocuo del lado de Windows? Fuera de comillas no puede haber
// nada que encadene, redirija o expanda en PowerShell ni en bash; entre comillas dobles, nada que
// expanda ($, backtick, \). Entre comillas simples todo es literal en ambos shells.
function sandboxSeguro(cmd) {
  let q = null;
  for (const c of cmd) {
    if (c === '\n' || c === '\r' || c === '\0') return false;
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '$' || c === '`' || c === '\\') return false;
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    if (';&|<>`$(){}@#%\\'.includes(c)) return false;
  }
  return q === null;
}

// ¿Lo que sigue a `git config` (hasta el fin del segmento) es una consulta de SOLO LECTURA inequívoca?
// Tokens simples [\w.:/=@+-] (opcionalmente entre comillas enteras); todo lo demás (comillas parciales, $ ` \ ( ) { } * ? ~ # ! % , etc.) → false.
function configLectura(resto) {
  let t = resto
    .replace(/\s*\d?>&\s*\d(?![\w.\/-])/g, ' ')
    .replace(/\s*\d?>>?\s*(?:\/dev\/null|nul|\$null)(?![\w.\/])/gi, ' ');
  const fin = t.search(/[;&|\n\r)]/);
  if (fin >= 0) t = t.slice(0, fin);
  t = t.trim();
  if (!t) return false;
  const SEGURO = '[\\w.:/=+-]'; // sin @: en PowerShell @var es splatting (varios argumentos ocultos)
  const reTok = new RegExp('^(?:"(' + SEGURO + '*)"|\'(' + SEGURO + '*)\'|(' + SEGURO + '+))$');
  const toks = [];
  for (const crudo of t.split(/[ \t]+/)) {
    const m = reTok.exec(crudo);
    if (!m) return false;
    toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  const MODOS_GET = new Set(['--get', '--get-all', '--get-regexp']);
  const MODOS_LISTA = new Set(['--list', '-l']);
  const SIN_VALOR = new Set(['--show-origin', '--show-scope', '--global', '--local', '--system', '--worktree', '-z', '--null',
    '--name-only', '--includes', '--no-includes', '--bool', '--int', '--path', '--all', '--regexp']);
  const CON_VALOR = new Set(['--file', '-f', '--default']);
  let modo = null; // 'get' | 'url' | 'lista'
  let pos = 0;
  let i = 0;
  if (toks[0] === 'get' || toks[0] === 'list') { modo = toks[0] === 'get' ? 'get' : 'lista'; i = 1; }
  for (; i < toks.length; i++) {
    const a = toks[i];
    if (a.startsWith('-')) {
      if (MODOS_GET.has(a) || a === '--get-urlmatch' || MODOS_LISTA.has(a)) {
        if (modo) return false; // dos modos: ambiguo
        modo = a === '--get-urlmatch' ? 'url' : MODOS_LISTA.has(a) ? 'lista' : 'get';
      } else if (SIN_VALOR.has(a)) { /* opción de lectura */ }
      else if (/^--type=[\w-]+$/.test(a)) { /* opción de lectura */ }
      else if (/^--file=./.test(a) || /^--default=./.test(a)) { /* opción de lectura */ }
      else if (CON_VALOR.has(a)) { i++; if (i >= toks.length || toks[i].startsWith('-')) return false; }
      else return false;
    } else pos++;
  }
  if (!modo) return false;
  if (modo === 'lista') return pos === 0;
  if (modo === 'url') return pos >= 1 && pos <= 2;
  return pos >= 1 && pos <= 2;
}

// Regla de git que modifica. Igual que una regex con exec(), pero una coincidencia `git config` de lectura inequívoca
// se salta (y se sigue buscando: `git config --get a && git config b c` sigue negado).
const RE_GIT_MOD = new RegExp(PRE + String.raw`git` + FIN + GIT_GLOBALES + String.raw`\s+(${GIT_SUBS})(?=\s|$|[;&|)])`, 'ig');
const REGLA_GIT_MOD = {
  exec(cmd) {
    RE_GIT_MOD.lastIndex = 0;
    let m;
    while ((m = RE_GIT_MOD.exec(cmd))) {
      if (/^config$/i.test(m[1]) && configLectura(cmd.slice(m.index + m[0].length))) continue;
      return m;
    }
    return null;
  },
};

// [regex, función que devuelve el nombre de la regla]
// WSL, contenedores y orquestadores (también con ruta: C:\Windows\System32\wsl.exe, /usr/bin/docker)
const RE_WSL = /(?:^|[\s;&|({\n`"'\\/])((?:wsl|wslg|wslconfig|ubuntu\d{0,4}|docker(?:-compose)?|podman|nerdctl|ctr|kubectl)(?:\.exe)?)(?=\s|$|[;&|)"'`])/i;
const RE_BASH_WSL = /[\\/]system32[\\/]bash(?:\.exe)?(?=\s|$|[;&|)"'`])/i;

const REGLAS = [
  // git que modifica (también con -C / -c antes del subcomando)
  [REGLA_GIT_MOD,
    (m) => 'git ' + m[1].replace(/\s+/g, ' ').toLowerCase()],
  // alias y --config-env en git: ocultan el subcomando real (`git -c alias.cfg=config cfg a b`) → no se admiten en revisores
  [new RegExp(PRE + String.raw`git` + FIN + String.raw`[^;&|\n]*?\s(?:-c\s*["']?alias\.|--config-env)`, 'i'), () => 'git -c alias.* / --config-env'],
  [new RegExp(PRE + String.raw`git` + FIN + GIT_GLOBALES + String.raw`\s+branch\b[^;&|\n]*?\s(-[dDmM]\w*|--delete|--move)(?=\s|$|[;&|)])`),
    (m) => 'git branch ' + m[1]],
  // comandos de archivo en posición de comando
  [new RegExp(PRE + `(${CMDS_ARCHIVO})` + FIN, 'i'), (m) => m[1]],
  // cmdlets de PowerShell en cualquier parte
  [new RegExp(String.raw`(?<![\w-])(${CMDLETS})(?![\w-])`, 'i'), (m) => m[1]],
  [/\s-OutFile\b/i, () => '-OutFile'],
  [/\bInvoke-(?:WebRequest|RestMethod)\b[^\n;|]*-Method\s+['"]?(?:Post|Put|Patch|Delete)\b/i, () => 'Invoke-WebRequest -Method'],
  [/\[(?:System\.)?IO\.File\]::(Write\w*|AppendAll\w*|Delete|Move|Copy|Replace|Create|Open\w*)\b/i, (m) => '[IO.File]::' + m[1]],
  [/\[(?:System\.)?IO\.(StreamWriter|FileStream|BinaryWriter|FileInfo|DirectoryInfo)\]/i, (m) => '[IO.' + m[1] + ']'],
  // editores en sitio
  [/\bsed\b(?:[^|;&\n]*?\s)?(?:-[a-zA-Z]*i\S*|--in-place\S*)(?=\s|$)/, () => 'sed -i'],
  [/\bperl\b(?:[^|;&\n]*?\s)?-[a-zA-Z]*i\S*(?=\s|$)/, () => 'perl -i'],
  [/\bawk\b[^|;&\n]*?\s-i\s+inplace\b/i, () => 'awk -i inplace'],
  // instaladores (con banderas opcionales antes del verbo) y pnpm dlx
  [new RegExp(PRE + String.raw`(?:uv\s+pip|(${MGR}))` + FIN + String.raw`(?:\s+--?[\w-]+(?:=\S+)?)*\s+(${MGR_VERBO})(?=\s|$|[;&|)])`, 'i'),
    (m) => (m[0].trim().replace(/^[^\w]+/, '').split(/\s+/).slice(0, 2).join(' ')).toLowerCase()],
  [new RegExp(PRE + String.raw`(?:python3?|py)(?:\.exe)?\s+(?:-\S+\s+)*-m\s+pip\s+(?:install|uninstall)\b`, 'i'), () => 'pip install'],
  [new RegExp(PRE + String.raw`pnpm` + FIN + String.raw`\s+dlx\b`, 'i'), () => 'pnpm dlx'],
  // despliegue / publicación
  [new RegExp(PRE + String.raw`(?:(?:npx|bunx)\s+(?:-\S+\s+)*)?(vercel|netlify|firebase|eas|fly|flyctl|heroku)` + FIN, 'i'), (m) => m[1]],
  [new RegExp(PRE + String.raw`gh` + FIN + String.raw`\s+(pr\s+(?:merge|create|close)|release|repo\s+(?:delete|create))\b`, 'i'), (m) => 'gh ' + m[1].replace(/\s+/g, ' ')],
  [new RegExp(PRE + String.raw`gh` + FIN + String.raw`\s+api\b[^\n;&|]*?(?:(?:-X|--method)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\b|\s(?:-[fF]|--field|--raw-field|--input)(?=[\s=]))`, 'i'), () => 'gh api (escritura)'],
  [new RegExp(PRE + String.raw`supabase` + FIN + String.raw`\s+(?:db\s+(?:push|reset)|migration\s+(?:up|repair)|functions\s+deploy|secrets\s+set)\b`, 'i'), (m) => m[0].trim().replace(/^[^\w]+/, '').replace(/\s+/g, ' ')],
  // curl que escribe (método de escritura, cuerpo, o salida a archivo)
  [new RegExp(PRE + String.raw`curl` + FIN + String.raw`([^\n;&|]*)`, 'i'), (m) => {
    const a = m[1];
    if (/(?:\s-X|\s--request)[\s=]*['"]?(?:POST|PUT|PATCH|DELETE)\b/i.test(a)) return 'curl -X (escritura)';
    if (/\s(?:-d|--data(?:-\w+)*|--json|-F|--form|-T|--upload-file)(?![a-zA-Z-])/.test(a)) return 'curl con cuerpo (-d/--data)';
    const o = a.match(/\s(?:-o|--output)[\s=]*(\S+)/);
    if (o && !/^['"]?(?:\/dev\/null|nul|\$null)['"]?$/i.test(o[1])) return 'curl -o (escribe archivo)';
    if (/\s-O(?![a-zA-Z-])/.test(a)) return 'curl -O (escribe archivo)';
    return null;
  }],
  // banderas que reescriben archivos (--fix-dry-run SÍ se permite; -w solo en prettier)
  [/\s--write(?=[\s=]|$)/, () => '--write'],
  [/\s--fix(?![\w-])/, () => '--fix'],
  [/\bprettier\b[^|;&\n]*\s-w(?=\s|$)/, () => 'prettier -w'],
  // actualizar snapshots / baselines (nunca sobrescribir capturas aprobadas)
  [/\s--update-(?:snapshots?|baselines?)(?![\w-])/i, () => '--update-snapshots'],
  [/\s--updateSnapshot(?![\w-])/i, () => '--updateSnapshot'],
  [/\b(?:vitest|jest|playwright)\b[^|;&\n]*\s-u(?=\s|$)/, () => 'runner de pruebas -u (actualiza snapshots)'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b[^|;&\n]*\s-u(?=\s|$)/, () => 'test -u (actualiza snapshots)'],
  // código en línea (node -e, python -c, deno eval, bun -e): defensa en profundidad
  [/(?:\bnode(?:\.exe)?\s+(?:-\S+\s+)*(?:-e|--eval|-p|--print)(?=\s|$)|\b(?:python3?|py)(?:\.exe)?\s+(?:-\S+\s+)*-c(?=\s|$)|\bdeno\s+eval\b|\bbun\s+(?:-\S+\s+)*-e(?=\s|$))[\s\S]*/,
    (m) => {
      const d = m[0].match(/writeFile|appendFile|createWriteStream|openSync|writeSync|fs\.open\b|os\.open\(|rmSync|\brm\(|unlink|rmdir|rename|copyFile|mkdir|open\([^)]*,\s*(?:mode\s*=\s*)?['"][wax][bt+]*['"]|os\.remove|shutil\.(?:rmtree|move)|write_text|write_bytes|subprocess|child_process/);
      return d ? 'código en línea con «' + d[0] + '»' : null;
    }],
  // find que borra o escribe
  [/\bfind\b[^\n;&|]*?\s(-delete|-fprint\w*|-fls)(?=\s|$)/, (m) => 'find ' + m[1]],
  [new RegExp(String.raw`\bfind\b[^\n;&|]*?\s-exec(?:dir)?\s+(?:[\w./\\-]*[\\/])?(?:${CMDS_ARCHIVO.replace('|tee', '')})` + FIN, 'i'), () => 'find -exec (escribe)'],
];

// Sale con código 0. `obj` (si hay) va a stdout como JSON; `aviso` (si hay) va a stderr, con escritura síncrona para que
// process.exit no lo corte.
function salir(obj, aviso) {
  if (aviso) { try { fs.writeSync(2, aviso + '\n'); } catch { /* sin stderr: el aviso se pierde, nada más */ } }
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// Redirecciones > y >> a archivo. Se permiten 2>&1, >&2, *>&1, >$null, >/dev/null, >nul.
// No se confunde con ->, =>, >=.
function hayRedireccion(cmd) {
  const limpio = cmd
    // `>&N` solo cuando N es el fin del token: `>&2file` Bash lo ejecuta como `&>2file` (ESCRIBE el archivo)
    .replace(/[0-9*&]?>&\s*[0-9](?![\w.\/-])/g, ' ')
    .replace(/(?:[0-9*&]|\b)?>>?\s*(?:\$null\b|\/dev\/null\b|nul\b)/gi, ' ');
  for (let i = 0; i < limpio.length; i++) {
    if (limpio[i] !== '>') continue;
    const prev = limpio[i - 1];
    const next = limpio[i + 1];
    if (prev === '-' || prev === '=' || prev === '|') continue; // ->  =>  |>
    if (next === '=') continue;                                   // >=
    return true;
  }
  return false;
}

function motivo(regla, extra) {
  return `Agente revisor en SOLO LECTURA: «${String(regla).slice(0, 80)}» no está permitido. Reporta el hallazgo en vez de modificar.` + (extra || '');
}

// ---- B23/B23b (ciclo 6): palabras de control activas, UN recorrido lineal ----
const RE_CTRL = /(?:then|do|else|elif|if|while|until)(?=\s)/y;
const RE_BANDERA_EJEC = /^(?:-[a-zA-Z]*[ce]|-command|--eval|\/[ck]|eval)$/i;
const INTERPRETES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'python', 'python3', 'py', 'node']);
// ¿La comilla que abre en `i` es el código de un intérprete (bash -c "…", pwsh -Command '…', cmd /c "…", python -c, node -e, eval)?
// `grep -c "if rm" f` NO: sin intérprete reconocido entre los tokens anteriores del mismo segmento. Cada paso tiene tope: lineal.
function comillaEjecutable(cmd, i, iniLinea) {
  const esp = (x) => x === ' ' || x === '\t';
  let j = i - 1;
  while (j >= iniLinea && esp(cmd[j])) j--;
  const toks = [];
  while (toks.length < 14 && j >= iniLinea) {
    let k = j;
    while (k >= iniLinea && j - k < 80 && !esp(cmd[k])) k--;
    if (j - k >= 80) return false;
    toks.push(cmd.slice(k + 1, j + 1));
    j = k;
    while (j >= iniLinea && esp(cmd[j])) j--;
  }
  if (!toks.length) return false;
  // `eval` también pegado a un separador: `$(eval "…")`, `` `eval '…'` ``, `ok;eval "…"` (ciclo 7, hallado por el diferencial)
  if (/^eval$/i.test(toks[0].split(/[;&|(){}`]/).pop())) return true;
  if (!RE_BANDERA_EJEC.test(toks[0])) return false;
  for (let t = 1; t < toks.length; t++) {
    // C5b (ciclo 7, Codex c6 SEC-003): el intérprete puede ir PEGADO a un separador (`(bash`, `$(bash`, `ok;bash`, `a&&bash`,
    // `a|bash`, `` `bash ``): se mira el tramo tras el último separador; si no es intérprete, el separador cierra el segmento.
    const partes = toks[t].split(/[;&|(){}`]/);
    const base = partes[partes.length - 1].replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (INTERPRETES.has(base)) return true;
    if (partes.length > 1) return false;
  }
  return false;
}

// Marca (en `act`) el inicio de cada palabra de control activa. `esc`: la barra invertida escapa (bash) o es literal (rutas de
// Windows): se corren las dos lecturas y vale la UNIÓN (ante la duda, activa). Salto de línea reinicia las comillas; `# …` fuera
// de comillas es comentario SOLO al inicio de palabra (ciclo 7, C5a: `${#a}`, `${#arr[@]}`, `$#` no son comentario).
// Ciclo 7, C5c: en la lectura con escape, `$'…'` (cita ANSI-C de bash) se entiende: ahí `\'` NO cierra la comilla.
function marcarControl(cmd, esc, act) {
  const n = cmd.length;
  let st = 0, d = '', sub = 0, subD = '', subEj = false, ini = 0, ansi = false;
  const ctrl = (i) => {
    if (i > 0 && /\w/.test(cmd[i - 1])) return;
    RE_CTRL.lastIndex = i;
    if (RE_CTRL.test(cmd)) act.add(i);
  };
  for (let i = 0; i < n; i++) {
    const c = cmd[i];
    if (c === '\n') { st = 0; sub = 0; ansi = false; ini = i + 1; continue; }
    if (st === 0) {
      if (esc && c === '\\') { if (cmd[i + 1] !== '\n') i++; continue; }
      if (c === '#' && (i === ini || /[\s;&|()<>]/.test(cmd[i - 1]))) {
        const nl = cmd.indexOf('\n', i);
        if (nl < 0) break;
        i = nl - 1; continue;
      }
      if (esc && c === '$' && cmd[i + 1] === "'") { st = comillaEjecutable(cmd, i, ini) ? 2 : 1; d = "'"; ansi = true; i++; continue; }
      if (c === '"' || c === "'") { st = comillaEjecutable(cmd, i, ini) ? 2 : 1; d = c; continue; }
      ctrl(i);
    } else if (st === 1) {
      if (c === d) { st = 0; ansi = false; }
      else if (esc && (d === '"' || ansi) && c === '\\' && cmd[i + 1] !== '\n') i++;
    } else if (sub) {
      if (c === subD) sub = 0;
      else if (esc && subD === '"' && c === '\\' && cmd[i + 1] !== '\n') i++;
      else if (subEj) ctrl(i);
    } else {
      if (c === d) { st = 0; ansi = false; continue; }
      if (esc && (d === '"' || ansi) && c === '\\') { if (cmd[i + 1] !== '\n') i++; continue; }
      if (c === '"' || c === "'") { sub = 1; subD = c; subEj = comillaEjecutable(cmd, i, ini); continue; }
      ctrl(i);
    }
  }
}

// Texto para las reglas con PRE: cada palabra de control activa pasa a U+E000 + espacios (misma longitud).
function enmascararControl(cmd) {
  if (!/(?:then|do|else|elif|if|while|until)\s/.test(cmd)) return cmd;
  const act = new Set();
  marcarControl(cmd, true, act);
  marcarControl(cmd, false, act);
  if (!act.size) return cmd;
  const partes = [];
  let prev = 0;
  for (const i of [...act].sort((a, b) => a - b)) {
    RE_CTRL.lastIndex = i; RE_CTRL.test(cmd);
    const len = RE_CTRL.lastIndex - i;
    partes.push(cmd.slice(prev, i), MARCA_CONTROL + ' '.repeat(len - 1));
    prev = i + len;
  }
  partes.push(cmd.slice(prev));
  return partes.join('');
}

function revisar(cmd) {
  const wsl = reglasWsl();
  if (wsl.autopruebas.test(cmd)) return null;
  const sandboxWsl = wsl.sandbox.test(cmd);
  if (sandboxWsl || wsl.sandboxLinux.test(cmd)) {
    return sandboxSeguro(cmd) ? null : motivo('uaeh-sandbox con encadenamiento o expansión fuera de comillas simples', sandboxWsl ? PISTA_WSL : PISTA_LINUX);
  }
  if (wsl.sandboxOtro.test(cmd)) return motivo('uaeh-sandbox (solo se permite «ejecutar»)', PISTA_LINUX);
  const w = RE_WSL.exec(cmd);
  if (w) return motivo(w[1], PISTA_WSL);
  if (RE_BASH_WSL.test(cmd)) return motivo('bash.exe de System32 (abre WSL)', PISTA_WSL);
  // PowerShell: `& $variable args` ejecuta lo que diga la variable ($g='git'; & $g config b c): con git en el texto no se puede saber qué corre
  if (/\bgit\b/i.test(cmd) && /(?:^|[;|({\n=]|&&|\|\|)\s*&(?!&)\s*["']?\$/.test(cmd)) return motivo('& $variable (ejecuta un programa dado por variable)');
  const cmdM = enmascararControl(cmd);
  for (const [re, nombre] of REGLAS) {
    const m = re.exec(cmdM);
    if (!m) continue;
    const r = nombre(m);
    if (r) return motivo(r);
  }
  if (hayRedireccion(cmd)) {
    return motivo('redirección > / >> a archivo', ' (si era una comparación dentro de un script, usa -gt/-lt o un archivo de script)');
  }
  return null;
}

function negar(razon) {
  salir({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: razon } });
}

// ---- Arranque: dos tramos con política de fallo distinta ----
// 1) ¿Quién ejecuta? Si no se puede saber (stdin ilegible, módulo de identidad que no carga) o el candado no aplica a ese
//    agente (sesión principal, agente no listado, candados.json ilegible), sale en silencio: fail-open por identidad
//    desconocida (decisión de diseño, documentada en la cabecera).
// 2) Para un agente listado rige la lógica de siempre, que FALLA CERRADO: sin `command` de texto o con un error interno,
//    el comando se niega. El texto vacío ("") sí pasa.
function leerEntrada() {
  try { return { legible: true, valor: JSON.parse(fs.readFileSync(0, 'utf8')) }; } catch { return { legible: false, valor: null }; }
}

function evaluarIdentidad(entrada) {
  try { return require(path.join(__dirname, '_identidad.js')).evaluar('solo-lectura', entrada); } catch {
    return { aplica: false, aviso: 'no se pudo cargar hooks/_identidad.js: no se sabe quién ejecuta y el candado no aplica' };
  }
}

function principal() {
  const leida = leerEntrada();
  if (!leida.legible) salir(null, 'solo-lectura: stdin no es un JSON legible: no se sabe quién ejecuta y el candado no aplica');
  const entrada = leida.valor;
  const id = evaluarIdentidad(entrada);
  if (!id.aplica) salir(null, id.aviso ? 'solo-lectura: ' + id.aviso : null);

  try {
    const cmd = entrada && entrada.tool_input && entrada.tool_input.command;
    // Falla CERRADO: sin `command` de texto no hay nada que evaluar → se niega. Texto vacío ("") sí pasa.
    if (typeof cmd !== 'string') negar('Agente revisor en SOLO LECTURA: la entrada no trae un comando de texto → negado (falla cerrado). Reporta el problema en vez de reintentar.');
    if (!cmd) salir();
    const r = revisar(cmd);
    if (r) negar(r);
    salir();
  } catch {
    // Falla CERRADO: si el candado truena, el comando no pasa (aquí ya se sabe que el agente es un revisor).
    negar('Agente revisor en SOLO LECTURA: error interno del candado → comando negado (falla cerrado). Reporta el problema en vez de reintentar.');
  }
}

// `revisar` se exporta para las pruebas (corpus grande en el mismo proceso); como script, el hook solo ejecuta principal().
module.exports = { revisar };
if (require.main === module) principal();
