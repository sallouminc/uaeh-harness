// Pruebas de los manifiestos del marketplace y de los plugins: coherencia entre sí y con el disco.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RAIZ_REPO, RAIZ_KIT, RAIZ_HARNESS } = require('../helpers/entorno.cjs');

const leer = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

test('marketplace.json: nombre uaeh, dueño, dos plugins con ruta relativa existente y versión igual a la del plugin', () => {
  const m = leer(path.join(RAIZ_REPO, '.claude-plugin', 'marketplace.json'));
  assert.equal(m.name, 'uaeh');
  assert.ok(m.owner && m.owner.name);
  assert.deepEqual(m.plugins.map((p) => p.name).sort(), ['uaeh-harness', 'uaeh-kit']);
  for (const p of m.plugins) {
    assert.match(p.source, /^\.\/plugins\//);
    const dir = path.join(RAIZ_REPO, p.source);
    assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')), `${p.source} sin plugin.json`);
    const pj = leer(path.join(dir, '.claude-plugin', 'plugin.json'));
    assert.equal(pj.name, p.name);
    assert.equal(pj.version, p.version, `versión del marketplace ≠ plugin.json en ${p.name}`);
    assert.match(pj.version, SEMVER);
    assert.ok(pj.description && pj.description.length > 20);
    assert.equal(pj.license, 'MIT');
  }
});

test('uaeh-kit: hooks.json parsea, usa solo eventos informativos, sin onFailure, y cada script referido existe', () => {
  const h = leer(path.join(RAIZ_KIT, 'hooks', 'hooks.json'));
  assert.ok(h.hooks && typeof h.hooks === 'object');
  assert.deepEqual(Object.keys(h.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  let n = 0;
  for (const [evento, grupos] of Object.entries(h.hooks)) {
    for (const g of grupos) {
      assert.ok(Array.isArray(g.hooks), `${evento}: grupo sin hooks[]`);
      for (const hk of g.hooks) {
        n++;
        assert.equal(hk.type, 'command');
        assert.equal(hk.onFailure, undefined, 'los hooks del kit no usan onFailure');
        assert.ok(hk.timeout <= 10, 'tiempo máximo corto: el hook no debe estorbar');
        // Forma exec: command es solo el ejecutable y la ruta del script va en args (sin shell, sin comillas).
        assert.equal(hk.command, 'node', 'forma exec: command = "node"');
        assert.ok(Array.isArray(hk.args) && hk.args.length >= 1, 'forma exec: args[] con el script');
        assert.match(hk.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z-]+\.js$/, `args[0] inesperado: ${hk.args[0]}`);
        const r = hk.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '');
        assert.ok(fs.existsSync(path.join(RAIZ_KIT, r)), `falta ${r}`);
      }
    }
  }
  assert.equal(n, 3);
});

test('uaeh-kit: las cuatro skills tienen frontmatter con name igual a su carpeta y descripción ≤ 350 caracteres', () => {
  const dir = path.join(RAIZ_KIT, 'skills');
  const skills = fs.readdirSync(dir).sort();
  assert.deepEqual(skills, ['dieta', 'doctor', 'medir', 'setup']);
  for (const s of skills) {
    const texto = fs.readFileSync(path.join(dir, s, 'SKILL.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(texto);
    assert.ok(fm, `${s}: sin frontmatter`);
    const name = /^name:\s*(.+)$/m.exec(fm[1]);
    const desc = /^description:\s*(.+)$/m.exec(fm[1]);
    assert.equal(name && name[1].trim(), s);
    assert.ok(desc && desc[1].trim().length > 0 && desc[1].trim().length <= 350, `${s}: descripción de ${desc ? desc[1].length : 0} caracteres`);
    assert.match(texto, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//, `${s}: la skill debe invocar sus scripts vía CLAUDE_PLUGIN_ROOT`);
    for (const ref of texto.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s)`]+)/g)) {
      assert.ok(fs.existsSync(path.join(RAIZ_KIT, ref[1])), `${s}: referencia a ${ref[1]} que no existe`);
    }
  }
});

test('uaeh-kit: plantillas presentes y bloque de reglas con marcadores y {{VERSION}}', () => {
  for (const f of ['bloque-claude-md.md', 'bloque-claude-md.en.md', 'settings-snippet.json', 'proyecto/CLAUDE.md', 'proyecto/tasks/context-map.md', 'proyecto/tasks/todo.md', 'proyecto/tasks/lessons.md']) {
    assert.ok(fs.existsSync(path.join(RAIZ_KIT, 'templates', f)), `falta templates/${f}`);
  }
  for (const f of ['bloque-claude-md.md', 'bloque-claude-md.en.md']) {
    const t = fs.readFileSync(path.join(RAIZ_KIT, 'templates', f), 'utf8');
    assert.match(t, /^<!-- UAEH:BEGIN v\{\{VERSION\}\} -->/);
    assert.match(t, /<!-- UAEH:END -->\s*$/);
    assert.ok(t.length < 5000, `${f} pesa ${t.length}: se relee en cada turno, debe seguir chico`);
  }
  const s = leer(path.join(RAIZ_KIT, 'templates', 'settings-snippet.json'));
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, 'sonnet');
  assert.equal(s.autoCompactWindow, 700000);
});

test('uaeh-harness: manifiesto válido aunque esté en construcción', () => {
  const pj = leer(path.join(RAIZ_HARNESS, '.claude-plugin', 'plugin.json'));
  assert.equal(pj.name, 'uaeh-harness');
  assert.match(pj.version, SEMVER);
  assert.ok(fs.existsSync(path.join(RAIZ_HARNESS, 'README.md')));
});
