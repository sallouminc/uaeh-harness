// Pruebas de plugins/uaeh-harness/hooks/solo-lectura.js — el candado de solo lectura de los agentes revisores.
//
// Corren el hook de verdad (un proceso por caso, con el JSON por stdin como lo manda Claude Code) dentro de una casa
// temporal: nunca leen la configuración real. La tabla es [esperado, comando]: 'D' = niega, 'A' = permite. Cada caso se
// ejecuta como agente «uae-verifier» y con las dos herramientas (Bash y PowerShell: el hook no las distingue).
// Además se prueba: la compuerta por identidad (sesión principal, agentes no listados, prefijo del plugin, candados.json
// ausente o roto), el fallo cerrado de los agentes listados, la distro y el usuario de WSL configurables, la forma Linux
// de la caja de arena, el costo lineal con comandos de ~48 KB y que ninguna variante generada que de verdad modifica pase.
// Correr: node --test tests/harness/solo-lectura.test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { RAIZ_HARNESS, entornoTemporal, eventoHerramienta } = require('../helpers/entorno.cjs');

const HOOK = path.join(RAIZ_HARNESS, 'hooks', 'solo-lectura.js');
const REVISOR = 'uae-verifier';

// ── Tabla ─────────────────────────────────────────────────────────────────────────────
// Los comandos de esta tabla son solo texto que se manda por stdin al hook: nada se ejecuta. La distro de WSL de los
// casos es la de fábrica («Ubuntu-24.04»). tests/diferencial.opcional.cjs lee estos bloques: conserva la forma
// «const BLOQUES = { … };» con el cierre «};» en la columna 0.
const BLOQUES = {
  "permitidos: lectura, pruebas y diagnóstico (docker y wsl sueltos se niegan)": [
    // ---- permitidos
    ['A', 'git diff'], ['A', 'git status'], ['A', 'git log --oneline -5'], ['A', 'git show HEAD'],
    ['A', 'git branch -a'], ['A', 'git rev-parse HEAD'], ['A', 'git ls-files'],
    ['A', 'git -C repo diff --stat'], ['A', 'git -c core.pager=cat log'],
    ['A', 'npm test'], ['A', 'npm run test'], ['A', 'pnpm test'], ['A', 'pnpm vitest run'],
    ['A', 'npx vitest run'], ['A', 'npx tsc --noEmit'],
    ['A', 'powershell -File scripts/verify.ps1'], ['A', 'pwsh scripts/verify.ps1'],
    ['A', 'Get-Content foo.txt'], ['A', 'Select-String -Path a.txt -Pattern x'],
    ['A', 'Get-ChildItem | Where-Object { $_.Length -gt 0 }'],
    ['A', 'node -e "const f=(a)=>a; console.log(f(1)>=0)"'],
    ['A', 'sed -n 1,10p f'], ['A', 'cat f | grep x'],
    // docker y wsl sueltos ya NO (solo por la caja de arena; ver bloque WSL abajo)
    ['D', 'docker run --rm --network none img'],
    ['D', 'wsl -e bash -c "gitleaks detect --no-git -s /mnt/c/x"'],
    ['A', 'npm test 2>&1'], ['A', 'npm test > /dev/null 2>&1'], ['A', 'npm test 2>$null'],
    ['A', 'Get-Content x >$null'], ['A', 'echo hi >nul'], ['A', 'cmd 2> NUL'], ['A', 'ls 1>&2'],
    ['A', 'Get-Process *>&1'], ['A', 'echo hi >&2'], ['A', 'ls 2>/dev/null'],
    ['A', 'curl -s https://example.com'], ['A', 'curl -o /dev/null -w "%{http_code}" https://example.com'],
    ['A', 'gh pr view 12'], ['A', 'gh api repos/x/y'], ['A', 'supabase db diff'],
    ['A', 'npx eslint .'], ['A', 'node scripts/check.js'], ['A', 'git branch --list'],
    ['A', 'awk "{print $1}" f'], ['A', 'git log --format="%h => %s"'],
  ],
  "negados: git que modifica": [
    // ---- negados: git
    ['D', 'git commit -m x'], ['D', 'git push'], ['D', 'git reset --hard'], ['D', 'git checkout main'],
    ['D', 'git restore f'], ['D', 'git switch x'], ['D', 'git clean -fd'], ['D', 'git stash'],
    ['D', 'git stash list'], ['D', 'git rebase main'], ['D', 'git merge x'], ['D', 'git apply p.diff'],
    ['D', 'git am p.mbox'], ['D', 'git cherry-pick abc'], ['D', 'git revert abc'], ['D', 'git tag v1'],
    ['D', 'git rm f'], ['D', 'git mv a b'], ['D', 'git add .'], ['D', 'git init'],
    ['D', 'git config user.name x'], ['D', 'git update-ref -d HEAD'], ['D', 'git gc'], ['D', 'git prune'],
    ['D', 'git filter-branch --all'], ['D', 'git worktree add ../x'], ['D', 'git worktree remove ../x'],
    ['D', 'git branch -D x'], ['D', 'git branch -d x'], ['D', 'git branch --delete x'],
    ['D', 'git branch -m a b'], ['D', 'git branch -M a'], ['D', 'git reflog expire --all'],
    ['D', 'cd repo && git commit -m x'], ['D', 'git -C repo push'], ['D', 'git -c user.name=t commit -m x'],
    ['D', 'git -C "my repo" -c a=b add f'],
  ],
  "negados: comandos de archivo": [
    // ---- negados: archivos
    ['D', 'rm -rf x'], ['D', 'rmdir x'], ['D', 'del x'], ['D', 'erase x'], ['D', 'rd x'], ['D', 'mv a b'],
    ['D', 'cp a b'], ['D', 'move a b'], ['D', 'copy a b'], ['D', 'xcopy a b'], ['D', 'robocopy a b'],
    ['D', 'ren a b'], ['D', 'rename a b'], ['D', 'touch f'], ['D', 'mkdir d'], ['D', 'md d'],
    ['D', 'truncate -s 0 f'], ['D', 'shred f'], ['D', 'dd if=a of=b'], ['D', 'chmod +x f'],
    ['D', 'chown u f'], ['D', 'ln -s a b'], ['D', 'ri x'], ['D', 'mi a b'], ['D', 'cpi a b'], ['D', 'ni f'],
    ['D', 'sc f hola'], ['D', 'ac f hola'],
    ['D', 'bash -c "rm -rf x"'], ['D', 'cmd /c "del x"'], ['D', 'echo a; rm x'], ['D', 'ls | xargs rm'],
    ['D', 'sudo rm x'], ['D', '(rm x)'], ['D', "sh -c 'mkdir x'"],
  ],
  "negados: cmdlets de PowerShell y primitivas de escritura": [
    // ---- negados: cmdlets
    ['D', 'Remove-Item x'], ['D', 'Set-Content f x'], ['D', 'Add-Content f x'], ['D', '"abc" | Out-File x'],
    ['D', 'New-Item f'], ['D', 'Move-Item a b'], ['D', 'Copy-Item a b'], ['D', 'Rename-Item a b'],
    ['D', 'Clear-Content f'], ['D', 'Set-ItemProperty p n v'], ['D', 'New-ItemProperty p'],
    ['D', 'Remove-ItemProperty p'], ['D', 'Get-Process | Export-Csv x'], ['D', 'x | Export-Clixml f'],
    ['D', 'Get-Date | Tee-Object f'], ['D', 'Start-Process notepad'], ['D', 'Expand-Archive a b'],
    ['D', 'Compress-Archive a b'], ['D', 'Stop-Process -Name x'], ['D', 'Invoke-WebRequest u -OutFile x'],
    ['D', "[IO.File]::WriteAllText('x','y')"], ['D', "[System.IO.File]::AppendAllText('x','y')"],
    ['D', '[IO.File]::WriteAllBytes("x", $b)'],
    // regresión SEC-001: primitivas de escritura que el candado dejaba pasar
    ['D', `node -e 'const fs=require("fs");fs.closeSync(fs.openSync("x.txt","w"))'`],
    ['D', `node -e 'require("fs").writeSync(1,"x")'`], ['D', `python -c "import os; os.open('x', os.O_WRONLY|os.O_CREAT)"`],
    ['D', "$w=[IO.StreamWriter]::new('x.txt'); $w.Close()"], ['D', "[System.IO.FileStream]::new('x', 'Create')"],
    ['D', "[IO.File]::OpenWrite('x')"],
    ['A', "[IO.Path]::GetFileName('C:/a/b.txt')"],
  ],
  "negados: editores, instaladores y despliegue": [
    // ---- negados: editores, instaladores, despliegue
    ['D', 'cat f | tee out'], ['D', 'tee out'], ['D', 'sed -i s/a/b/ f'], ['D', "sed -i.bak 's/a/b/' f"],
    ['D', 'sed -ni 1p f'], ['D', 'perl -pi -e s/a/b/ f'], ['D', 'awk -i inplace "{print}" f'],
    ['D', 'npm i lodash'], ['D', 'npm install'], ['D', 'pnpm add x'], ['D', 'yarn add x'], ['D', 'bun add x'],
    ['D', 'pip install x'], ['D', 'pip3 install x'], ['D', 'pipx install x'], ['D', 'uv add x'],
    ['D', 'composer require x'], ['D', 'gem install x'], ['D', 'cargo add x'], ['D', 'go get x'],
    ['D', 'npm ci'], ['D', 'npm publish'], ['D', 'pnpm dlx create-x'], ['D', 'npm uninstall x'],
    ['D', 'npm --silent install'], ['D', 'python -m pip install x'],
    ['D', 'vercel deploy'], ['D', 'netlify deploy'], ['D', 'firebase deploy'], ['D', 'eas build'],
    ['D', 'fly deploy'], ['D', 'heroku push'], ['D', 'cd x && vercel --prod'], ['D', 'npx vercel --prod'],
    ['D', 'gh pr merge 1'], ['D', 'gh pr create'], ['D', 'gh pr close 1'], ['D', 'gh release create v1'],
    ['D', 'gh repo delete x'], ['D', 'gh repo create x'], ['D', 'gh api -X POST /x'], ['D', 'gh api repos/x --method DELETE'],
    ['D', 'supabase db push'], ['D', 'supabase db reset'], ['D', 'supabase migration up'],
    ['D', 'supabase migration repair 1'], ['D', 'supabase functions deploy f'], ['D', 'supabase secrets set A=b'],
    ['D', 'curl -X POST https://x'], ['D', 'curl -XPUT https://x'], ['D', 'curl -X delete https://x'],
    ['D', 'curl -d a=b https://x'], ['D', 'curl --data "a" https://x'], ['D', 'curl -o f https://x'],
    ['D', 'find . -delete'],
  ],
  "verificador: banderas que reescriben, snapshots y código en línea": [
    // ---- verificador: banderas que reescriben, snapshots, código en línea
    ['A', 'npx vitest run'], ['A', 'npx eslint .'], ['A', 'npx eslint . --fix-dry-run'],
    ['A', `node -e "console.log(require('fs').readFileSync('package.json','utf8').length)"`],
    ['A', `python -c "import json;print(json.load(open('a.json'))['x'])"`],
    ['A', `node -p "1+1"`], ['A', 'npx prettier --check .'], ['A', 'git diff -u'],
    ['D', 'npx prettier --write .'], ['D', 'pnpm lint --fix'], ['D', 'npx eslint . --fix'],
    ['D', 'npx prettier -w .'], ['D', 'npx playwright test --update-snapshots'],
    ['D', 'npx vitest run -u'], ['D', 'npx jest --updateSnapshot'], ['D', 'npm test -- -u'],
    ['D', `node -e "require('fs').writeFileSync('x','y')"`],
    ['D', `node -e "require('fs').rmSync('x',{recursive:true})"`],
    ['D', `python -c "open('x','w').write('y')"`],
    ['D', `python3 -c "import shutil;shutil.rmtree('x')"`],
    ['D', `node --eval "require('child_process').execSync('rm x')"`],
    ['D', `py -c "from pathlib import Path;Path('x').write_text('y')"`],
    ['D', `deno eval "Deno.removeSync('x')"; echo unlink`],
  ],
  "negados: redirecciones": [
    // ---- negados: redirecciones
    ['D', 'echo hi > out.txt'], ['D', 'echo hi >> out.txt'], ['D', 'echo hi>out.txt'], ['D', 'ls 2> err.log'],
    ['D', 'echo hi > /dev/nullx'], ['D', 'echo hi >nullable'], ['D', 'Get-Date *> log.txt'],
  ],
  "WSL: la caja de arena en su forma exacta": [
    // ---- WSL y contenedores: solo la caja de arena, en su forma exacta
    ['A', `wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente h01 -- node -e 'require("fs").writeFileSync("/scratch/x","y")'`],
    ['A', `wsl.exe -d Ubuntu-24.04 -u pepe -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente v01 --bd --segundos 60 -- sh -c 'sh /uaeh/armar.sh && cd /work/app && node app.js > /scratch/log 2>&1 & sleep 2; curl -s localhost:3000'`],
    ['A', `wsl -d Ubuntu-24.04 --exec /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente h02 --deps uaeh-deps-r-abc --env NODE_ENV=test -- node /work/poc.js`],
    ['A', `wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente h03 -- node -e "console.log(1)"`],
    ['A', `MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente v01 -- node -e 'console.log(1)'`],
    ['D', 'MSYS_NO_PATHCONV=1 wsl -e rm x'], ['D', 'LD_PRELOAD=/x.so wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run x -- true'],
    ['D', 'MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run x -- true; rm x'],
  ],
  "WSL: autopruebas, wsl/docker sueltos y formas de la caja de arena que se niegan": [
    // autopruebas de /opt/uaeh: solo la línea exacta
    ['A', 'wsl -d Ubuntu-24.04 -e env PROBAR_DISCO=1 bash /opt/uaeh/pruebas/probar-sandbox.sh'],
    ['A', 'wsl -d Ubuntu-24.04 -e bash /opt/uaeh/pruebas/probar-promover.sh'], ['A', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-validar --pruebas'],
    ['A', 'MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -e bash /opt/uaeh/pruebas/probar-pnpmfile.sh'],
    ['D', 'wsl -d Ubuntu-24.04 -e bash /opt/uaeh/pruebas/probar-sandbox.sh; rm x'], ['D', 'wsl -d Ubuntu-24.04 -e bash /opt/uaeh/pruebas/otra.sh'],
    ['D', 'wsl -d Ubuntu-24.04 -u root -e bash /opt/uaeh/pruebas/probar-sandbox.sh'], ['D', 'wsl -d Ubuntu-24.04 -e bash /opt/uaeh/pruebas/../x.sh'],
    ['D', 'wsl -d Ubuntu-24.04 -e bash /opt/uaeh/pruebas/probar-sandbox.sh x'], ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-validar /mnt/c/x'],
    ['D', 'wsl -d Ubuntu-24.04 -e bash\n/opt/uaeh/pruebas/probar-sandbox.sh'], ['D', 'wsl -d Ubuntu-24.04 -e env X=1 bash /opt/uaeh/pruebas/probar-sandbox.sh'],  ['A', 'Get-Content Dockerfile'], ['A', 'cat docker-compose.yml'], ['A', 'Select-String -Path README.md -Pattern wslpath'],
    ['D', 'wsl -d Ubuntu-24.04 -e rm -rf /mnt/c/datos/x'], ['D', 'wsl -e rm x'], ['D', 'wsl -- rm x'],
    ['D', 'wsl rm x'], ['D', 'wsl bash -c "rm x"'], ['D', 'wsl.exe --exec touch /mnt/c/x'],
    ['D', 'wsl --shutdown'], ['D', 'wsl --unregister Ubuntu'], ['D', 'wsl -u root -e apt-get install x'],
    ['D', 'C:\\Windows\\System32\\wsl.exe -e rm x'], ['D', 'C:/Windows/System32/bash.exe -c ls'],
    ['D', 'ubuntu.exe run rm x'], ['D', 'ubuntu2404 run rm x'], ['D', 'wslg.exe -e x'],
    ['D', 'docker run -v /:/host alpine rm -rf /host/x'], ['D', 'docker ps'], ['D', '/usr/bin/docker run x'],
    ['D', 'podman run x'], ['D', 'nerdctl run x'], ['D', 'docker-compose up'], ['D', 'kubectl apply -f x'],
    ['D', 'echo a; wsl -e rm x'], ['D', 'ls && docker run x'], ['D', 'cmd /c wsl -e rm x'], ['D', '& wsl -e rm x'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox preparar-deps --run /mnt/c/x/run-1'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- true; rm x'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- true && rm x'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- true | Out-Null'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- true > f.txt'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- echo $(Remove-Item x)'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- node -e "$(rm x)"'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- node -e "`rm x`"'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- echo `rm x`'],
    ['D', "wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- echo 'a'\n rm x"],
    ['D', "wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- echo 'sin cerrar"],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 --% ; rm x'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- @(rm x)'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/c/x/run-1 --agente h01 -- ${env:x}'],
    ['D', 'wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandboxx ejecutar --run x -- true'],
    ['D', 'wsl -d Ubuntu-24.04 -e /tmp/uaeh-sandbox ejecutar --run x -- true'],
    ['D', 'wsl -d Debian -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run x -- true'],
    ['D', 'wsl -d Ubuntu-24.04 -u root -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run x -- true'],
    ['D', 'x; wsl -d Ubuntu-24.04 -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run x -- true'],
  ],
  "git config: solo lecturas inequívocas (ciclo 3, B2)": [
    // ---- ciclo 3 (B2): git config, SOLO lecturas inequívocas
    ['A', 'git config --get user.name'], ['A', 'git config --get-all remote.origin.fetch'],
    ['A', 'git config --get-regexp remote.origin'], ['A', 'git config --get-urlmatch http https://example.com'],
    ['A', 'git config --list'], ['A', 'git config -l'], ['A', 'git config --global --list'],
    ['A', 'git config --local --list --show-origin'], ['A', 'git config --list --show-scope -z'],
    ['A', 'git config --system --get core.autocrlf'], ['A', 'git config --worktree --get core.x'],
    ['A', 'git config --file .gitmodules --get-regexp path'], ['A', 'git config -f .gitmodules --list'],
    ['A', 'git config --file=.gitmodules --list'], ['A', 'git config --get --type=bool core.bare'],
    ['A', 'git config --bool --get core.bare'], ['A', 'git config --int --get http.postbuffer'],
    ['A', 'git config --path --get core.excludesfile'], ['A', 'git config --default x --get a.b'],
    ['A', 'git config --name-only --get-regexp user'], ['A', 'git config --includes --get a.b'],
    ['A', 'git config --no-includes --list'], ['A', 'git config get user.name'], ['A', 'git config list'],
    ['A', 'git config list --show-origin'], ['A', 'git config --get "user.name"'], ['A', "git config --get 'user.name'"],
    ['A', 'git config --get user.name 2>&1'], ['A', 'git config --get user.name 2>/dev/null'],
    ['A', 'git config --list | head -5'], ['A', 'git -C repo config --get remote.origin.url'],
    ['A', 'git config --get a.b && git status'], ['A', 'git config --get a.b; git log'],
    ['A', 'git config --get a.b || echo vacio'],
    ['D', 'git config'], ['D', 'git config user.name x'], ['D', 'git config --global user.name x'],
    ['D', 'git config user.name'], ['D', 'git config --add a.b c'], ['D', 'git config --unset a.b'],
    ['D', 'git config --unset-all a.b'], ['D', 'git config --replace-all a.b c'], ['D', 'git config -e'],
    ['D', 'git config --edit'], ['D', 'git config --global --edit'], ['D', 'git config --rename-section a b'],
    ['D', 'git config --remove-section a'], ['D', 'git config set a.b c'], ['D', 'git config unset a.b'],
    ['D', 'git config --global'], ['D', 'git config --get'], ['D', 'git config get'],
    ['D', 'git config --list a.b'], ['D', 'git config list a.b'], ['D', 'git config --get a b c'],
    ['D', 'git config --get --add a.b c'], ['D', 'git config --get --unset a.b'], ['D', 'git config --list --add a b'],
    ['D', 'git config --get --list'], ['D', 'git config --get a.b --replace-all c'],
    ['D', 'git config --get a.b && git config b c'], ['D', 'git config --get a.b; git config --unset b'],
    ['D', 'git config --list | git config --add a b'], ['D', 'git config --get a.b\ngit config x y'],
    ['D', 'git config --get $(rm x)'], ['D', 'git config --get `rm x`'], ['D', 'git config --get a.b > out.txt'],
    ['D', 'git config --get "--add" a b'], ['D', 'git config --get a.b $(git config --add c d)'],
    ['D', 'git config --get "a.b'], ['D', 'git config --get a\\.b'], ['D', 'git config --get a*'],
    ['D', 'git config -z -z'], ['D', 'git config --file'], ['D', 'git config --file --get a.b'],
    ['D', 'git config -f x -f y --add a b'], ['D', 'git config --type=bool a.b true'],
    ['D', 'git config --get-urlmatch http https://a.com --add x y'], ['D', 'git config -lz'],
    ['D', 'git config --blob HEAD:x --list'], ['D', 'git config --get a.b # nota'],
    ['D', 'Write-Output "Remove-Item"'], ['D', 'echo "git config --add a b"'],
  ],
  ">&PALABRA es escritura (ciclo 4, B10)": [
    // ---- ciclo 4 B10: `>&PALABRA` es escritura (Bash: `>&2file` = `&>2file`); `>&N` con fin de token sigue pasando
    ['D', 'echo hi >&2file'], ['D', 'git config --get a >&2file'], ['D', 'echo hi >&file'], ['D', 'echo hi >&2.log'],
    ['D', 'echo hi >&2/x'], ['D', 'ls 2>&1file'], ['D', 'git config --get a.b >&2out'],
    ['A', 'echo hi >&2'], ['A', 'ls 2>&1'], ['A', 'ls 2>&1 | cat'], ['A', 'echo hi >&2; echo ok'],
    ['A', 'git config --get a.b >&2'], ['A', 'git config --get a.b 2>&1'], ['A', 'Get-Process *>&1'], ['A', 'ls 1>&2'],
  ],
  "git en cualquier posición de comando y por su nombre base (ciclo 4, B11)": [
    // ---- ciclo 4 B11: git que modifica en cualquier posición de comando y por su NOMBRE BASE
    ['D', 'if true; then git config b c; fi'], ['D', 'for x in 1; do git config b c; done'],
    ['D', 'if false; then :; else git config b c; fi'], ['D', 'if false; then :; elif true; then git config b c; fi'],
    ['D', 'while false; do git config b c; done'], ['D', 'case x in x) git config b c;; esac'],
    ['D', 'time git config b c'], ['D', 'env git config b c'], ['D', 'env -i git config b c'], ['D', 'env FOO=1 git config b c'],
    ['D', 'env -u V git config b c'], ['D', 'command git config b c'], ['D', 'exec git config b c'], ['D', 'nice git config b c'],
    ['D', 'nice -n 5 git config b c'], ['D', 'nohup git config b c'], ['D', 'timeout 5 git config b c'], ['D', '! git config b c'],
    ['D', 'FOO=1 git config b c'], ['D', 'FOO=1 BAR="a b" git config b c'], ['D', 'setsid git config b c'], ['D', 'stdbuf -o0 git config b c'],
    ['D', '"C:/Program Files/Git/bin/git.exe" config b c'], ['D', "'C:/Program Files/Git/bin/git.exe' config b c"],
    ['D', '/usr/bin/git config b c'], ['D', '/mingw64/bin/git.exe config b c'], ['D', 'C:\\Git\\cmd\\git.exe config b c'],
    ['D', '"git" config b c'], ['D', "'git' config b c"], ['D', 'git.exe config b c'], ['D', './git config b c'],
    ['D', 'then git commit -m x'], ['D', 'env git push'], ['D', 'time git commit -m x'], ['D', '/usr/bin/git push'],
    ['D', '"C:/Program Files/Git/bin/git.exe" commit -m x'], ['D', 'env -i git reset --hard'], ['D', '"rm" -rf x'], ['D', 'env rm x'],
    ['D', 'git -c alias.cfg=config cfg a.b c'], ['D', 'git --config-env=alias.cfg=X cfg a.b c'], ['D', 'git -c alias.st=status st'],
    ['D', 'git -calias.cfg=config cfg a.b c'], ['D', 'git -C repo -c alias.x=commit x'], ['D', 'git --config-env alias.x=V x'],
    ['D', '$g = "git"; & $g config b c'], ['D', "$g='git'; & $g config b c"], ['D', '$g = "git"; & "$g" push'],
    ['A', 'time git status'], ['A', 'env FOO=1 git status'], ['A', 'env -i git log -1'], ['A', '! git diff --quiet'], ['A', 'nice git log'],
    ['A', 'if true; then git status; fi'], ['A', 'for x in 1; do git log -1; done'], ['A', 'FOO=1 git diff'],
    ['A', '"C:/Program Files/Git/bin/git.exe" status'], ['A', '/usr/bin/git log -1'], ['A', 'timeout 5 git diff'],
    ['A', 'git config --get a.b'], ['A', 'git config --list'], ['A', 'time git config --get a.b'], ['A', 'env git config --list'],
    ['A', '"C:/Program Files/Git/bin/git.exe" config --get a.b'], ['A', 'if true; then git config --get a.b; fi'],
    ['A', 'FOO=1 git config --get a.b'], ['A', 'git -c core.pager=cat log -1'], ['A', 'Get-Content x'],
    ['A', '& $PSScriptRoot/x.ps1'], ['A', '$x = 5; Write-Output $x'],
  ],
  "@ en PowerShell es splatting (ciclo 4, B12)": [
    // ---- ciclo 4 B12: `@` en PowerShell es splatting
    ['D', 'git config --get @a'], ['D', 'git config --get a.b @args'], ['D', 'git config --list @x'], ['D', 'git config --get @{a=1}'],
    ['A', 'git config --get a.b'], ['A', 'git config --get user.email'],
  ],
  "la asignación de PowerShell es posición de comando (ciclo 5, B17)": [
    // ---- ciclo 5 B17 (uae-security c4 SEC-006): la asignación de PowerShell es posición de comando
    ['D', '$o = git checkout -- .'], ['D', '$o = git stash'], ['D', '$o = git config user.name x'], ['D', '$o=git checkout -- .'],
    ['D', '$o += git checkout -- .'], ['D', '[string]$o = git stash'], ['D', '[System.String]$o = git reset HEAD~1'],
    ['D', '$script:o = git commit -m x'], ['D', '$a = 1; $o = git push'], ['D', '$o = & git push'],
    ['D', '$o = rm -rf x'], ['D', '$o = Remove-Item x'],
    ['A', '$o = git status'], ['A', '$o = git diff --stat'], ['A', '$o += git log -1'], ['A', '[string]$o = git rev-parse HEAD'],
    ['A', '$o = git config --get a.b'], ['A', '$x = 5; git status'], ['A', '$n = (git log --oneline).Count'],
    // `& $variable` solo con git en el texto y solo PowerShell/`&` suelto: Bash `cmd && $VAR …` ya no se niega por eso
    ['A', 'git status && $EDITOR_CMD x'], ['A', 'git status && $HOME/bin/tool'], ['A', 'true && $RUNNER --check; git status'],
    ['D', "$g = 'git'; & $g config a b"], ['D', 'git status; & $g push'], ['D', "git status | & $g x"],
    ['D', 'git status && & $g x'], ['D', '$o = & $g push; git status'],
  ],
  "palabras de control solo cuentan fuera de comillas (ciclo 5, B18)": [
    // ---- ciclo 5 B18 (verificador B c4 V-007): then/do/else/if/while… solo cuentan FUERA de comillas
    ['A', 'grep -rn "if rm" src'], ['A', 'grep -n "then cp" install.sh'], ['A', 'echo "do rm the thing"'], ['A', "grep -n 'else mv' f"],
    ['A', 'grep -rn "while rm" src'], ['A', 'grep "until touch" f'], ['A', 'echo "elif rm x"'],
    ['D', 'if true; then rm x; fi'], ['D', 'for i in 1; do rm x; done'], ['D', 'if false; then echo a; else rm x; fi'],
    ['D', 'while true; do rm x; done'], ['D', 'if true; then git commit -m x; fi'],
    ['D', 'bash -c "if true; then rm x; fi"'], ['D', "sh -c 'if true; then rm x; fi'"], ['D', 'eval "if true; then rm x; fi"'],
    ['D', 'powershell -Command "if ($true) { rm x }"'], ['D', 'echo "a" ; if true; then rm x; fi'],
    ['A', 'echo "a" ; if true; then echo hi; fi'],
    // una palabra de control ACTIVA a mitad de línea (fuera de comillas) cuenta como posición de comando: ante la duda, niega
    ['D', 'x then rm x'], ['D', 'echo a then touch f'], ['D', 'echo a do mv a b'], ['D', 'x else git commit -m x'],
    ['D', 'echo a then then rm x'], ['D', 'ls if rm x'], ['D', 'ls while mv a b'], ['D', 'ls until touch f'], ['D', 'x elif rm x'],
    // ... pero dentro de comillas de un comando que no ejecuta su argumento sigue siendo texto
    ['A', 'echo "x then rm x"'], ['A', "echo 'echo a do mv a b'"], ['A', 'grep -n "x else touch f" f'],
  ],
  "comillas por línea, apóstrofo escapado y comentarios (ciclo 6, B23)": [
    // ---- ciclo 6 B23 (uae-security c5 SEC-004, Codex SEC-006): comillas por línea, `\'` escapada, comentarios
    ['D', "# it's\nif true; then rm -rf x; fi"],
    ['D', 'ls # what\'s here\nfor f in *; do rm "$f"; done'],
    ['D', "echo don\\'t; if true; then rm -rf x; fi"],
    ['D', 'echo "C:\\dir\\" ; if true; then rm x; fi'],
    ['D', "echo it's\nif true; then rm x; fi"],
  ],
  "comillas del otro tipo dentro de -c \"…\" (ciclo 6, B23b)": [
    // ---- ciclo 6 B23b (verificador B c5 V-B01/V-B02): comillas del OTRO tipo dentro de -c "…"
    ['D', 'bash -c "echo \'a\'; if true; then rm x; fi"'],
    ['D', 'bash -c "if [ -f \'a b\' ]; then rm \'a b\'; fi"'],
    ['D', 'bash -c "[ -f \'a\' ] && echo y; if true; then rm x; fi"'],
    ['D', 'sh -c \'if [ -f "a b" ]; then rm "a b"; fi\''],
    ['D', 'sudo bash -lc "echo \'a\'; if true; then rm x; fi"'],
    ['D', 'node -e "if true; then rm x; fi"'],
    ['D', 'bash -c "bash -c \'if true; then rm x; fi\'"'],
    // `-c`/`-e` sin intérprete reconocido NO activa el modo «código ejecutable»; los comentarios no cuentan
    ['A', 'grep -c "if rm" f'], ['A', 'grep -c \'do rm\' f'], ['A', 'grep -e "then rm" f'], ['A', 'ls | grep -c "else mv"'],
    ['A', 'git log --grep="if rm" -n 3'], ['A', 'node scripts/t.js "if rm x"'], ['A', 'echo "a" # if rm x'],
    ['A', "echo hi # it's\ngrep -n \"if rm\" f"], ['A', 'cat f | grep -c "while rm" | wc -l'],
  ],
  "# solo es comentario al inicio de palabra (ciclo 7, C5a)": [
    // ---- ciclo 7 C5a (verificador B c6 V-B02, REGRESIÓN de c6): `#` es comentario SOLO al inicio de palabra; `${#a}` no
    ['D', 'if [ ${#a} -gt 0 ]; then mv a b; fi'], ['D', 'for i in $(seq 1 ${#a}); do rm f$i; done'],
    ['D', 'n=${#arr[@]}; for f in *; do rm "$f"; done'], ['D', 'x=${#a}; if true; then rm -rf y; fi'],
    ['D', 'echo $#; if true; then rm -rf y; fi'],
    ['A', 'echo ${#a}'], ['A', 'n=${#arr[@]}; echo "$n"'], ['A', 'x=${#a}; grep -c "if rm" f'], ['A', 'echo a;# if rm x'],
  ],
  "el intérprete pegado a un separador sigue siendo intérprete (ciclo 7, C5b)": [
    // ---- ciclo 7 C5b (Codex c6 SEC-003, REGRESIÓN de c6): el intérprete PEGADO a un separador sigue siendo intérprete
    ['D', '(bash -c "if true; then rm x; fi")'], ['D', 'out=$(bash -c "if true; then git checkout -- .; fi")'],
    ['D', 'echo ok;bash -c "if true; then rm x; fi"'], ['D', 'a&&bash -c "if true; then rm x; fi"'],
    ['D', 'a|bash -c "if true; then rm x; fi"'], ['D', '`bash -c "if true; then rm x; fi"`'],
    ['D', '$(bash -c "if true; then rm x; fi")'], ['D', "ok;sh -c 'for f in *; do rm \"$f\"; done'"],
    ['A', 'ls;grep -c "if rm" f'], ['A', '(grep -c "if rm" f)'], ['A', 'echo bash;grep -c "if rm" f'], ['A', 'x=$(grep -c "do rm" f)'],
  ],
  "cita ANSI-C: la comilla escapada no cierra (ciclo 7, C5c)": [
    // ---- ciclo 7 C5c (verificador B c6 V-B06): cita ANSI-C `$'…'`, donde `\'` NO cierra
    ['D', "echo $'it\\'s'; if true; then rm -rf y; fi"], ['D', "echo $'a\\'b' && for f in *; do rm \"$f\"; done"],
    ['A', "echo $'it\\'s'"], ['A', "echo $'it\\'s' # if rm x"],
  ],
};

// ── Utilidades ────────────────────────────────────────────────────────────────────────

function nuevoEntorno(prefijo) {
  const e = entornoTemporal(prefijo);
  delete e.env.UAEH_WSL_DISTRO; // si el desarrollador los tiene exportados, la prueba no sería hermética
  delete e.env.UAEH_WSL_USER;
  return e;
}

// Casa compartida por los casos de la tabla: el hook no escribe nada, con una basta.
const E = nuevoEntorno('uaeh-solo-lectura-');
process.on('exit', () => E.limpiar());

function resultado(status, stdout, stderr) {
  let json = null;
  try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { json = null; }
  const salida = json && json.hookSpecificOutput;
  return {
    status, stdout, stderr, json,
    deny: !!salida && salida.permissionDecision === 'deny',
    motivo: (salida && salida.permissionDecisionReason) || '',
  };
}

// Una ejecución del hook con `entrada` (objeto → JSON) o con `crudo` (texto tal cual por stdin). Devuelve una promesa.
function ejecutarUna(entrada, { crudo, env = E.env, hook = HOOK } = {}) {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, [hook], { env, cwd: E.proyecto, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    hijo.stdout.setEncoding('utf8');
    hijo.stderr.setEncoding('utf8');
    hijo.stdout.on('data', (d) => { stdout += d; });
    hijo.stderr.on('data', (d) => { stderr += d; });
    const reloj = setTimeout(() => { hijo.kill(); rechazar(new Error('el hook no terminó en 45 s')); }, 45000);
    hijo.on('error', (e) => { clearTimeout(reloj); rechazar(e); });
    hijo.on('close', (status, senal) => { clearTimeout(reloj); resolver({ ...resultado(status, stdout, stderr), senal }); });
    hijo.stdin.on('error', () => { /* el hook puede salir antes de leer todo stdin */ });
    hijo.stdin.end(crudo !== undefined ? crudo : JSON.stringify(entrada));
  });
}

// El hook SIEMPRE sale con código 0 (negar o permitir se dice por stdout). Un código distinto, una señal o un error al
// arrancar son fallos del entorno (el sistema mata procesos cortos bajo carga, un antivirus bloquea el arranque…) y no una
// decisión del candado: se reintenta hasta 3 veces. Un fallo real del hook fallaría las 3 veces.
async function ejecutar(entrada, opciones = {}) {
  let ultimo = null;
  for (let intento = 1; intento <= 3; intento++) {
    try { ultimo = await ejecutarUna(entrada, opciones); } catch (e) { ultimo = { error: e, status: null }; }
    if (!ultimo.error && ultimo.status === 0) return ultimo;
  }
  if (ultimo.error) throw ultimo.error;
  return ultimo;
}

const ejecutarComo = (agente, comando, opciones = {}) => ejecutar(eventoHerramienta(comando, { agente, tool: opciones.tool }), opciones);

const CONCURRENCIA = Math.max(2, Math.min(8, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length));

// Aplica `fn` a cada elemento con un tope de procesos a la vez; devuelve los resultados en el orden de entrada.
async function enParalelo(elementos, fn) {
  const salida = new Array(elementos.length);
  let siguiente = 0;
  async function trabajador() {
    for (;;) {
      const i = siguiente++;
      if (i >= elementos.length) return;
      salida[i] = await fn(elementos[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, elementos.length) }, trabajador));
  return salida;
}

// Corre cada caso [esperado, comando] con cada herramienta (o, con `alternar`, una sola por caso, rotando la lista);
// devuelve la lista de fallos, ya redactados.
async function fallosDeTabla(casos, { agente = REVISOR, herramientas = ['Bash', 'PowerShell'], alternar = false, env = E.env } = {}) {
  const trabajos = [];
  casos.forEach(([esperado, comando], i) => {
    for (const tool of alternar ? [herramientas[i % herramientas.length]] : herramientas) trabajos.push({ tool, esperado, comando });
  });
  const filas = await enParalelo(trabajos, async ({ tool, esperado, comando }) => {
    const r = await ejecutarComo(agente, comando, { tool, env });
    const bien = r.status === 0 && r.deny === (esperado === 'D');
    return bien ? null : `[${tool}] esperaba ${esperado === 'D' ? 'NEGAR' : 'PERMITIR'}: ${JSON.stringify(comando)} → ${r.deny ? `negó (${r.motivo})` : 'permitió'} (código ${r.status})`;
  });
  return filas.filter(Boolean);
}

function exigirSinFallos(fallos, total) {
  assert.equal(fallos.length, 0, `${fallos.length} de ${total} casos fallaron:\n  ${fallos.slice(0, 25).join('\n  ')}`);
}

// ── La tabla, un bloque por prueba ────────────────────────────────────────────────────

test('la tabla conserva los 564 casos del candado original y todos tienen forma válida', () => {
  const todos = Object.values(BLOQUES).flat();
  assert.ok(todos.length >= 564, `la tabla tiene ${todos.length} casos; se esperaban al menos 564`);
  for (const fila of todos) {
    const valida = Array.isArray(fila) && fila.length === 2 && (fila[0] === 'A' || fila[0] === 'D') && typeof fila[1] === 'string' && fila[1] !== '';
    assert.ok(valida, `caso mal formado: ${JSON.stringify(fila)}`);
  }
});

// Cada caso corre una vez, alternando Bash y PowerShell (el hook solo mira tool_input.command; la prueba siguiente lo comprueba).
for (const [nombre, casos] of Object.entries(BLOQUES)) {
  test(`tabla · ${nombre} (${casos.length} casos, Bash y PowerShell alternados)`, { timeout: 240000 }, async () => {
    exigirSinFallos(await fallosDeTabla(casos, { alternar: true }), casos.length);
  });
}

test('tabla · la herramienta no cambia la decisión: los 4 primeros casos de cada bloque con Bash y con PowerShell', { timeout: 240000 }, async () => {
  const muestra = Object.values(BLOQUES).flatMap((casos) => casos.slice(0, 4));
  exigirSinFallos(await fallosDeTabla(muestra), muestra.length * 2);
});

// ── Formato de la respuesta ───────────────────────────────────────────────────────────

test('motivos · texto en español con la regla, JSON de PreToolUse y la pista de los scripts', async () => {
  const rm = await ejecutarComo(REVISOR, 'rm -rf x');
  assert.equal(rm.status, 0);
  assert.match(rm.motivo, /^Agente revisor en SOLO LECTURA: «rm» no está permitido\. Reporta el hallazgo en vez de modificar\.$/);
  assert.equal(rm.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(rm.json.hookSpecificOutput.permissionDecision, 'deny');
  const git = await ejecutarComo(REVISOR, 'git -C r push');
  assert.ok(git.motivo.includes('«git push»'), git.motivo);
  const redireccion = await ejecutarComo(REVISOR, 'echo hi > out.txt');
  assert.ok(redireccion.motivo.includes('(si era una comparación dentro de un script, usa -gt/-lt o un archivo de script)'), redireccion.motivo);
});

test('pistas · la negativa de WSL y contenedores explica la forma permitida, sin programas ni rutas de ninguna máquina', async () => {
  const pistaWsl = 'wsl -d <distro> -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run <run> --agente <id> -- <comando>';
  for (const comando of ['wsl -e rm x', 'docker ps', 'podman run x', 'C:/Windows/System32/bash.exe -c ls']) {
    const r = await ejecutarComo(REVISOR, comando);
    assert.ok(r.deny, comando);
    assert.ok(r.motivo.includes(pistaWsl), `${comando}: ${r.motivo}`);
    assert.ok(r.motivo.includes('el código va entre comillas simples'), r.motivo);
    assert.doesNotMatch(r.motivo, /php|[A-Za-z]:[\\/]Program|[A-Za-z]:[\\/]Users/i, `${comando}: la pista no debe nombrar programas o rutas concretas`);
  }
  const linux = await ejecutarComo(REVISOR, '/opt/uaeh/bin/uaeh-sandbox preparar-deps --run r');
  assert.ok(linux.deny);
  assert.ok(linux.motivo.includes('/opt/uaeh/bin/uaeh-sandbox ejecutar --run <run> --agente <id> -- <comando>'), linux.motivo);
});

// ── Compuerta por identidad ───────────────────────────────────────────────────────────

test('compuerta · la sesión principal (sin agent_type) no queda bajo el candado y no deja ruido', async () => {
  const casos = [];
  for (const comando of ['rm -rf x', 'git commit -m x', 'echo hi > out.txt', 'wsl -e rm x', 'npm install', 'sed -i s/a/b/ f']) {
    for (const tool of ['Bash', 'PowerShell']) casos.push({ comando, tool });
  }
  const filas = await enParalelo(casos, async ({ comando, tool }) => ({ comando, tool, r: await ejecutar(eventoHerramienta(comando, { tool })) }));
  for (const { comando, tool, r } of filas) {
    assert.equal(r.status, 0, `${tool} ${comando}`);
    assert.equal(r.stdout, '', `la sesión principal no debe recibir negativa: ${tool} ${comando}`);
    assert.equal(r.stderr, '', `ni avisos: ${tool} ${comando}`);
  }
});

test('compuerta · un agent_type que no es texto, vacío o sin nombre cuenta como sesión principal', async () => {
  for (const valor of [5, null, true, ['uae-verifier'], { a: 1 }, '', '   ', 'uaeh-harness:']) {
    const r = await ejecutar({ ...eventoHerramienta('rm -rf x'), agent_type: valor });
    assert.equal(r.status, 0, JSON.stringify(valor));
    assert.equal(r.stdout, '', JSON.stringify(valor));
  }
});

test('compuerta · los agentes que no figuran en candados.json pasan sin salida (uae-builder, general-purpose, Explore…)', async () => {
  const agentes = ['uae-builder', 'general-purpose', 'Explore', 'Plan', 'uae-architect', 'uae-triage', 'design-auditor',
    'uaeh-harness:uae-builder', 'uae-verifier-2', 'mi-uae-verifier'];
  const casos = [];
  for (const agente of agentes) for (const comando of ['rm -rf x', 'git push', 'echo hi > out.txt']) casos.push({ agente, comando });
  const filas = await enParalelo(casos, async ({ agente, comando }) => ({ agente, comando, r: await ejecutarComo(agente, comando) }));
  for (const { agente, comando, r } of filas) {
    assert.equal(r.status, 0, `${agente}: ${comando}`);
    assert.equal(r.stdout, '', `${agente} no es un revisor listado; no debe recibir negativa: ${comando}`);
  }
});

test('compuerta · uae-verifier, uae-security y browser-verifier niegan, con el prefijo del plugin o de cualquier otro', async () => {
  const casos = [];
  for (const agente of ['uae-verifier', 'uae-security', 'browser-verifier']) for (const prefijo of ['', 'uaeh-harness:', 'otro-plugin:']) casos.push(prefijo + agente);
  const filas = await enParalelo(casos, async (agente) => ({ agente, r: await ejecutarComo(agente, 'rm -rf x') }));
  for (const { agente, r } of filas) {
    assert.equal(r.status, 0, agente);
    assert.ok(r.deny, `${agente} debe quedar bajo el candado`);
  }
});

const SUBCONJUNTO_CON_PREFIJO = [
  ['A', 'git diff'], ['A', 'git status'], ['A', 'npm test'], ['A', 'cat f | grep x'], ['A', 'git config --get user.name'],
  ['D', 'rm -rf x'], ['D', 'git commit -m x'], ['D', 'sed -i s/a/b/ f'], ['D', 'echo hi > out.txt'], ['D', 'wsl -e rm x'],
];

test('compuerta · con el prefijo del plugin (uaeh-harness:uae-verifier) rige la misma tabla (subconjunto de 10 casos)', async () => {
  const enTabla = new Set(Object.values(BLOQUES).flat().map((fila) => JSON.stringify(fila)));
  for (const fila of SUBCONJUNTO_CON_PREFIJO) assert.ok(enTabla.has(JSON.stringify(fila)), `el subconjunto debe salir de la tabla: ${fila[1]}`);
  assert.equal(SUBCONJUNTO_CON_PREFIJO.length, 10);
  exigirSinFallos(await fallosDeTabla(SUBCONJUNTO_CON_PREFIJO, { agente: `uaeh-harness:${REVISOR}` }), SUBCONJUNTO_CON_PREFIJO.length * 2);
});

// ── Fallo cerrado de los agentes listados ─────────────────────────────────────────────

test('falla cerrado · un revisor sin comando de texto NIEGA (uae-security, uae-verifier y con prefijo)', async () => {
  const sinComando = (agente) => [
    ['sin tool_input', { agent_type: agente }],
    ['tool_input vacío', { agent_type: agente, tool_input: {} }],
    ['command numérico', { agent_type: agente, tool_input: { command: 5 } }],
    ['command 123', { agent_type: agente, tool_input: { command: 123 } }],
    ['command null', { agent_type: agente, tool_input: { command: null } }],
    ['command lista', { agent_type: agente, tool_input: { command: ['rm', 'x'] } }],
    ['tool_input texto', { agent_type: agente, tool_input: 'ls' }],
  ];
  const casos = [];
  for (const agente of ['uae-security', REVISOR, `uaeh-harness:${REVISOR}`]) for (const [nombre, entrada] of sinComando(agente)) casos.push({ agente, nombre, entrada });
  const filas = await enParalelo(casos, async (c) => ({ ...c, r: await ejecutar(c.entrada) }));
  for (const { agente, nombre, r } of filas) {
    assert.equal(r.status, 0, `${agente}: ${nombre}`);
    assert.ok(r.deny, `${agente}: ${nombre} debe negarse`);
    assert.match(r.motivo, /falla cerrado/, `${agente}: ${nombre}`);
  }
});

test('falla cerrado · el texto vacío ("") de un revisor sí pasa', async () => {
  const r = await ejecutar({ agent_type: REVISOR, tool_input: { command: '' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('stdin ilegible · ya no se sabe quién ejecuta: sale 0 sin negar y deja un aviso en stderr', async () => {
  const crudos = [
    ['vacía', ''], ['no es JSON', 'hola'], ['llaves rotas', '{{{'],
    ['JSON truncado de un revisor', '{"agent_type":"uae-verifier","tool_input":{"command":'],
  ];
  const filas = await enParalelo(crudos, async ([nombre, crudo]) => ({ nombre, r: await ejecutar(null, { crudo }) }));
  for (const { nombre, r } of filas) {
    assert.equal(r.status, 0, nombre);
    assert.equal(r.stdout, '', nombre);
    assert.match(r.stderr, /solo-lectura: stdin no es un JSON legible/, nombre);
  }
});

test('stdin con JSON válido que no es un evento (null, número, texto, lista) cuenta como sesión principal, sin aviso', async () => {
  for (const crudo of ['null', '5', '"texto"', '[]', 'true']) {
    const r = await ejecutar(null, { crudo });
    assert.equal(r.status, 0, crudo);
    assert.equal(r.stdout, '', crudo);
    assert.equal(r.stderr, '', crudo);
  }
});

// ── Caja de arena: distro, usuario y forma Linux ──────────────────────────────────────

const RUN = '/mnt/d/runs/r/run-1';
const sandbox = (distro, extra = '') => `wsl -d ${distro}${extra} -e /opt/uaeh/bin/uaeh-sandbox ejecutar --run ${RUN} --agente a1 -- true`;

test('WSL · la distro de fábrica es Ubuntu-24.04: a secas, otra o con una letra distinta se niegan', async () => {
  const casos = [
    ['A', sandbox('Ubuntu-24.04')],
    ['D', sandbox('Ubuntu')], ['D', sandbox('Debian')], ['D', sandbox('ubuntu-24.04')], ['D', sandbox('Ubuntu-24x04')],
    ['D', sandbox('Ubuntu-24.04x')], ['D', sandbox('Ubuntu-24.04-extra')],
  ];
  exigirSinFallos(await fallosDeTabla(casos), casos.length * 2);
});

test('WSL · UAEH_WSL_DISTRO y wsl.distro de uaeh.config.json cambian la distro permitida', async () => {
  const conVariable = { ...E.env, UAEH_WSL_DISTRO: 'Debian' };
  const porVariable = [['A', sandbox('Debian')], ['D', sandbox('Ubuntu-24.04')], ['D', sandbox('Ubuntu')]];
  exigirSinFallos(await fallosDeTabla(porVariable, { env: conVariable }), porVariable.length * 2);
  assert.ok((await ejecutarComo(REVISOR, sandbox('Debian'))).deny, 'sin la variable ni la configuración, Debian no es la distro');

  const e = nuevoEntorno('uaeh-solo-lectura-cfg-');
  try {
    e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ wsl: { distro: 'Debian' } }));
    const porArchivo = [['A', sandbox('Debian')], ['D', sandbox('Ubuntu-24.04')]];
    exigirSinFallos(await fallosDeTabla(porArchivo, { env: e.env }), porArchivo.length * 2);
    // la variable de entorno manda sobre el archivo
    const variableGana = [['A', sandbox('Fedora')], ['D', sandbox('Debian')]];
    exigirSinFallos(await fallosDeTabla(variableGana, { env: { ...e.env, UAEH_WSL_DISTRO: 'Fedora' } }), variableGana.length * 2);
    // una distro inválida en la configuración cae a la de fábrica
    e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), JSON.stringify({ wsl: { distro: 'Dis tro' } }));
    const invalida = [['A', sandbox('Ubuntu-24.04')], ['D', sandbox('Dis')]];
    exigirSinFallos(await fallosDeTabla(invalida, { env: e.env }), invalida.length * 2);
    // un archivo de configuración roto tampoco impide que el candado funcione
    e.escribir(path.join(e.uaehHome, 'uaeh.config.json'), '{ esto no es json');
    const rota = [['A', sandbox('Ubuntu-24.04')], ['D', 'rm -rf x']];
    exigirSinFallos(await fallosDeTabla(rota, { env: e.env }), rota.length * 2);
  } finally { e.limpiar(); }
});

test('WSL · -u admite cualquier usuario válido de Linux salvo root (caja de arena y autopruebas)', async () => {
  const autoprueba = (usuario) => `wsl -d Ubuntu-24.04 -u ${usuario} -e bash /opt/uaeh/pruebas/probar-sandbox.sh`;
  const permitidos = ['pepe', 'dev', '_svc', 'user-1', 'a', 'rooty', 'root2', 'x'.repeat(32)];
  const negados = ['root', 'Root', 'ROOT', '0', '-e', '"root"', "'pepe'", '1abc', 'pepe;rm', 'x'.repeat(33)];
  const casos = [];
  for (const u of permitidos) casos.push(['A', sandbox('Ubuntu-24.04', ` -u ${u}`)], ['A', autoprueba(u)]);
  for (const u of negados) casos.push(['D', sandbox('Ubuntu-24.04', ` -u ${u}`)], ['D', autoprueba(u)]);
  casos.push(
    ['D', sandbox('Ubuntu-24.04', ' -u pepe -u root')], ['D', sandbox('Ubuntu-24.04', ' -u root -u pepe')],
    ['D', sandbox('Ubuntu-24.04', ' -u')], ['D', sandbox('Ubuntu-24.04', ' --user pepe')],
    ['A', 'wsl.exe -d Ubuntu-24.04 -u pepe --exec /opt/uaeh/bin/uaeh-sandbox ejecutar --run /mnt/d/runs/r/run-1 --agente a1 -- true'],
    ['A', `MSYS_NO_PATHCONV=1 ${sandbox('Ubuntu-24.04', ' -u pepe')}`],
    ['D', `MSYS_NO_PATHCONV=1 ${sandbox('Ubuntu-24.04', ' -u root')}`],
  );
  exigirSinFallos(await fallosDeTabla(casos), casos.length * 2);
});

test('caja de arena en Linux · /opt/uaeh/bin/uaeh-sandbox ejecutar … pasa; encadenar, expandir u otros subcomandos se niega', async () => {
  const base = '/opt/uaeh/bin/uaeh-sandbox ejecutar --run r --agente a --';
  const casos = [
    ['A', `${base} ls`], ['A', `  ${base} ls`], ['A', `${base} node -e 'console.log(1)'`], ['A', `${base} sh -c 'cd /work && ls > /scratch/log 2>&1; cat /scratch/log'`],
    ['A', `${base} node -e "console.log(1)"`],
    ['D', `${base} ls; rm x`], ['D', `${base} ls && rm x`], ['D', `${base} ls | cat`], ['D', `${base} ls > f.txt`],
    ['D', `${base} echo $(rm x)`], ['D', `${base} echo \`rm x\``], ['D', `${base} echo 'sin cerrar`], ['D', `${base} node -e "$(rm x)"`],
    ['D', `${base} true\nrm x`],
    ['D', '/opt/uaeh/bin/uaeh-sandbox preparar-deps --run r'], ['D', '/opt/uaeh/bin/uaeh-sandbox'], ['D', '/opt/uaeh/bin/uaeh-sandbox ejecutar'],
    ['D', 'rm -rf /opt/uaeh/bin/uaeh-sandbox'],
  ];
  exigirSinFallos(await fallosDeTabla(casos), casos.length * 2);
});

// ── candados.json y piezas ausentes (copia del plugin en la casa temporal) ────────────

let copias = 0;
// Copia solo-lectura.js, _identidad.js, candados.json y scripts/lib/* a una carpeta nueva y devuelve sus rutas.
function copiarPlugin(e, { candados = true, identidad = true, lib = true } = {}) {
  const raiz = path.join(e.dir, `plugin-copia-${++copias}`);
  const hooks = path.join(raiz, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const origen = path.join(RAIZ_HARNESS, 'hooks');
  fs.copyFileSync(path.join(origen, 'solo-lectura.js'), path.join(hooks, 'solo-lectura.js'));
  if (identidad) fs.copyFileSync(path.join(origen, '_identidad.js'), path.join(hooks, '_identidad.js'));
  if (candados) fs.copyFileSync(path.join(origen, 'candados.json'), path.join(hooks, 'candados.json'));
  if (lib) {
    const destinoLib = path.join(raiz, 'scripts', 'lib');
    const origenLib = path.join(RAIZ_HARNESS, 'scripts', 'lib');
    fs.mkdirSync(destinoLib, { recursive: true });
    for (const f of fs.readdirSync(origenLib)) if (fs.statSync(path.join(origenLib, f)).isFile()) fs.copyFileSync(path.join(origenLib, f), path.join(destinoLib, f));
  }
  return { raiz, hook: path.join(hooks, 'solo-lectura.js'), candados: path.join(hooks, 'candados.json') };
}

test('copia del plugin · completa, el candado niega a un revisor y calla ante la sesión principal (la copia es válida)', async () => {
  const c = copiarPlugin(E);
  const revisor = await ejecutarComo(REVISOR, 'rm -rf x', { hook: c.hook });
  assert.ok(revisor.deny, 'la copia completa debe negar a un revisor');
  assert.equal(revisor.stderr, '');
  const principal = await ejecutar(eventoHerramienta('rm -rf x'), { hook: c.hook });
  assert.equal(principal.stdout, '');
  assert.equal(principal.stderr, '');
});

test('copia del plugin · sin candados.json el candado no aplica a nadie: permite y avisa por stderr', async () => {
  const c = copiarPlugin(E, { candados: false });
  for (const agente of [REVISOR, 'uae-security', `uaeh-harness:${REVISOR}`]) {
    const r = await ejecutarComo(agente, 'rm -rf x', { hook: c.hook });
    assert.equal(r.status, 0, agente);
    assert.equal(r.stdout, '', `${agente}: con candados.json ausente la identidad es desconocida y el hook no niega`);
    assert.match(r.stderr, /solo-lectura: candados\.json ilegible o sin la clave "solo-lectura"/, agente);
  }
  const principal = await ejecutar(eventoHerramienta('rm -rf x'), { hook: c.hook });
  assert.equal(principal.stdout, '');
  assert.equal(principal.stderr, '', 'la sesión principal no necesita candados.json: sin agent_type no se lee ni se avisa');
});

test('copia del plugin · candados.json roto o sin la clave solo-lectura: permite y avisa', async () => {
  for (const [nombre, texto] of [['JSON roto', '{ "solo-lectura": ['], ['vacío', ''], ['sin la clave', '{"solo-navegador":["browser-verifier"]}'],
    ['la clave no es una lista', '{"solo-lectura":"uae-verifier"}'], ['no es un objeto', '[]']]) {
    const c = copiarPlugin(E);
    fs.writeFileSync(c.candados, texto, 'utf8');
    const r = await ejecutarComo(REVISOR, 'rm -rf x', { hook: c.hook });
    assert.equal(r.status, 0, nombre);
    assert.equal(r.stdout, '', nombre);
    assert.match(r.stderr, /candados\.json ilegible o sin la clave/, nombre);
  }
});

test('copia del plugin · la lista de agentes sale de candados.json, no del código', async () => {
  const c = copiarPlugin(E);
  fs.writeFileSync(c.candados, JSON.stringify({ 'solo-lectura': ['agente-propio'] }), 'utf8');
  assert.ok((await ejecutarComo('agente-propio', 'rm -rf x', { hook: c.hook })).deny, 'el agente listado debe quedar bajo el candado');
  assert.ok((await ejecutarComo('uaeh-harness:agente-propio', 'rm -rf x', { hook: c.hook })).deny, 'también con prefijo');
  const ya = await ejecutarComo(REVISOR, 'rm -rf x', { hook: c.hook });
  assert.equal(ya.stdout, '', 'uae-verifier ya no está en la lista de esta copia');
  assert.equal(ya.stderr, '', 'y no es un error: la lista se leyó bien');
});

test('copia del plugin · sin _identidad.js no se sabe quién ejecuta: sale 0 sin negar y avisa', async () => {
  const c = copiarPlugin(E, { identidad: false });
  const r = await ejecutarComo(REVISOR, 'rm -rf x', { hook: c.hook });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no se pudo cargar hooks\/_identidad\.js/);
});

test('copia del plugin · sin scripts/lib la distro vuelve a la de fábrica (aunque UAEH_WSL_DISTRO diga otra) y el candado sigue funcionando', async () => {
  const c = copiarPlugin(E, { lib: false });
  const envDebian = { ...E.env, UAEH_WSL_DISTRO: 'Debian' };
  const casos = [['A', sandbox('Ubuntu-24.04')], ['D', sandbox('Debian')], ['D', 'rm -rf x'], ['A', 'git status']];
  for (const [esperado, comando] of casos) {
    const r = await ejecutarComo(REVISOR, comando, { hook: c.hook, env: envDebian });
    assert.equal(r.status, 0, comando);
    assert.equal(r.deny, esperado === 'D', `sin la biblioteca de configuración: ${comando}`);
  }
  // control: con la biblioteca, la misma variable sí cambia la distro
  const control = await ejecutarComo(REVISOR, sandbox('Debian'), { env: envDebian });
  assert.equal(control.deny, false);
});

// ── Costo lineal y propiedad de las variantes generadas (en el mismo proceso) ─────────

let revisarEnProceso = null;
// Carga revisar() del hook con una casa vacía: así no lee la configuración real. Las reglas de WSL se fijan en la primera llamada.
function cargarRevisar() {
  if (revisarEnProceso) return revisarEnProceso;
  const previo = { UAEH_HOME: process.env.UAEH_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, UAEH_WSL_DISTRO: process.env.UAEH_WSL_DISTRO };
  process.env.UAEH_HOME = E.uaehHome;
  process.env.CLAUDE_CONFIG_DIR = E.claudeHome;
  delete process.env.UAEH_WSL_DISTRO;
  try {
    const { revisar } = require(HOOK);
    assert.equal(typeof revisar, 'function', 'el hook debe exportar revisar() cuando se carga como módulo');
    revisar('echo hola');
    revisarEnProceso = revisar;
    return revisar;
  } finally {
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('rendimiento · comandos de ~48 KB sin costo cuadrático (en proceso y con el hook completo)', { timeout: 120000 }, async () => {
  // El lookbehind de una versión anterior tardaba ~11,8 s con 48 KB (el hook tiene 5 s). Los topes son holgados a propósito.
  const formas = {
    comillas: 'echo "a b" \'c d\' x; ',
    palabras: 'if x then y do z else w ',
    mezcla: 'bash -c "echo \'a\'; ls"; grep -c "if rm" f; ',
    escapes: 'echo don\\\'t "q\\"r" # c\n',
    espacios: 'ls                                  ',
    // `${#a}`, `$'…'` con `\'` e intérprete pegado a un separador
    ciclo7: 'x=${#a}; echo $\'it\\\'s\'; (bash -c "ls"); ok;sh -c \'ls\' ',
  };
  const revisar = cargarRevisar();
  for (const [nombre, unidad] of Object.entries(formas)) {
    const cmd = unidad.repeat(Math.ceil(48000 / unidad.length));
    const t0 = process.hrtime.bigint();
    revisar(cmd);
    const enProceso = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(enProceso < 1500, `revisar() con ${cmd.length} caracteres (${nombre}) tardó ${enProceso.toFixed(0)} ms`);
    const t1 = Date.now();
    const r = await ejecutarComo(REVISOR, cmd);
    const completo = Date.now() - t1;
    assert.equal(r.status, 0, nombre);
    assert.ok(completo < 4000, `el hook completo con ${cmd.length} caracteres (${nombre}) tardó ${completo} ms`);
  }
});

// Variantes GENERADAS: (comentario o comilla previa) × (prefijo) × (cuerpo directo | intérprete + comilla + cuerpo).
// Cada una lleva su VERDAD de construcción: ¿modifica de verdad? (cuerpo que borra o mueve y que se ejecuta).
function generarVariantes() {
  const PREVIOS = ['', "# it's\n", "echo it\\'s; ", "echo $'it\\'s'; ", 'x=${#a}; ', 'n=${#arr[@]}; ', 'echo "a b"; ', "echo 'a'; ",
    'ls # c\n', 'echo a # if rm x\n', "echo \"it's\"; "];
  const PREFIJOS = [['', ''], ['(', ')'], ['$(', ')'], ['ok;', ''], ['ok; ', ''], ['a&&', ''], ['a && ', ''], ['a|', ''], ['`', '`'],
    ['{ ', '; }'], ['x=$(', ')']];
  const CUERPOS = ['if true; then rm -rf y; fi', 'for f in *; do rm $f; done', 'while true; do mv a b; done',
    'if true; then git checkout -- .; fi', 'if [ ${#a} -gt 0 ]; then mv a b; fi', 'if true; then echo hi; fi', 'for f in *; do echo $f; done',
    'while read l; do echo $l; done'];
  const CUERPO_MODIFICA = (cuerpo) => /\b(?:rm|mv|git checkout)\b/.test(cuerpo);
  // Intérpretes que EJECUTAN el texto entre comillas (los 3 últimos solo lo reciben como argumento: el texto es inerte).
  const INTERPRETES = ['bash -c', 'sh -c', 'sudo bash -lc', 'pwsh -Command', 'cmd /c', 'python -c', 'node -e', 'eval', 'grep -c', 'grep -e', 'echo'];
  const INERTES = new Set(['grep -c', 'grep -e', 'echo']);
  const COMILLAS = [(s) => '"' + s + '"', (s) => "'" + s + "'", (s) => "$'" + s + "'"];
  const generadas = [];
  const verdad = new Map();
  for (const previo of PREVIOS) {
    for (const [abre, cierra] of PREFIJOS) {
      for (const cuerpo of CUERPOS) {
        const directo = previo + abre + cuerpo + cierra;
        generadas.push(directo);
        verdad.set(directo, CUERPO_MODIFICA(cuerpo));
        for (const interprete of INTERPRETES) {
          for (const comillar of COMILLAS) {
            const c = previo + abre + interprete + ' ' + comillar(cuerpo) + cierra;
            generadas.push(c);
            if (!verdad.has(c)) verdad.set(c, CUERPO_MODIFICA(cuerpo) && !INERTES.has(interprete));
          }
        }
      }
    }
  }
  return { generadas, verdad };
}

test('propiedad · ninguna variante generada que de verdad modifica llega a pasar el candado', { timeout: 300000 }, () => {
  const revisar = cargarRevisar();
  const { generadas, verdad } = generarVariantes();
  const modifican = generadas.filter((c) => verdad.get(c));
  const pasan = modifican.filter((c) => !revisar(c));
  assert.ok(generadas.length > 30000 && modifican.length > 10000, `el generador produjo ${generadas.length} variantes (${modifican.length} modifican)`);
  assert.equal(pasan.length, 0, `${pasan.length} de ${modifican.length} variantes que modifican llegaron a pasar:\n  ${pasan.slice(0, 20).map((c) => JSON.stringify(c)).join('\n  ')}`);
});

test('el módulo del hook solo expone revisar() y no ejecuta nada al cargarse', () => {
  const previo = process.env.UAEH_HOME;
  process.env.UAEH_HOME = E.uaehHome;
  try {
    const modulo = require(HOOK);
    assert.deepEqual(Object.keys(modulo), ['revisar']);
  } finally { if (previo === undefined) delete process.env.UAEH_HOME; else process.env.UAEH_HOME = previo; }
});

// Debe ir al final: comprueba lo que dejaron TODAS las pruebas anteriores en la casa temporal compartida.
test('solo lectura de verdad · el hook no escribió nada en la casa, el estado ni el proyecto temporales', () => {
  for (const [nombre, dir] of [['UAEH_HOME', E.uaehHome], ['proyecto', E.proyecto], ['TMP', E.tmp]]) {
    assert.deepEqual(fs.readdirSync(dir), [], `${nombre} debe seguir vacío: ${dir}`);
  }
});
