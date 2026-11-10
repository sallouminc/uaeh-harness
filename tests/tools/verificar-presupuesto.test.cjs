// Pruebas de tools/verificar-presupuesto.cjs. Herméticas: cada prueba arma un plugin de juguete en una
// carpeta temporal y corre la herramienta real con correr().
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { correr, RAIZ_REPO } = require('../helpers/entorno.cjs');
const { parsearFrontmatter, MAX_DESCRIPCION } = require('../../tools/verificar-presupuesto.cjs');

const HERRAMIENTA = path.join(RAIZ_REPO, 'tools', 'verificar-presupuesto.cjs');
const BOM = String.fromCharCode(0xFEFF);

// Plugin temporal con ayudantes para escribir skills y agentes.
function nuevoPlugin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uaeh-presupuesto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, 'plugin');
  fs.mkdirSync(plugin);
  const escribir = (rel, texto) => {
    const abs = path.join(plugin, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, texto, 'utf8');
  };
  return {
    plugin,
    escribir,
    skill: (carpeta, frontmatter, fin = '\n') => escribir(path.join('skills', carpeta, 'SKILL.md'), `---${fin}${frontmatter}${fin}---${fin}${fin}# ${carpeta}${fin}`),
    agente: (archivo, frontmatter) => escribir(path.join('agents', `${archivo}.md`), `---\n${frontmatter}\n---\n\nInstrucciones.\n`),
    correr: (args = []) => correr(HERRAMIENTA, [...args, plugin]),
    fila: (r, nombre) => r.json().archivos.find((a) => a.nombre === nombre),
  };
}

test('la descripción de 350 caracteres pasa y la de 351 falla con exit 1', (t) => {
  assert.equal(MAX_DESCRIPCION, 350);
  const p = nuevoPlugin(t);
  p.skill('justa', `name: justa\ndescription: ${'a'.repeat(350)}`);
  const ok = p.correr();
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^\s*350\s+\S*justa\/SKILL\.md\s+\(OK\)$/m);
  assert.match(ok.stdout, /total: 350 caracteres/);

  p.skill('larga', `name: larga\ndescription: ${'a'.repeat(351)}`);
  const mal = p.correr();
  assert.equal(mal.status, 1, mal.stdout);
  assert.match(mal.stdout, /^\s*351\s+\S*larga\/SKILL\.md\s+\(FALLÓ\)$/m);
  assert.match(mal.stdout, /la descripción tiene 351 caracteres; el máximo es 350/);
  assert.match(mal.stdout, /^\s*350\s+\S*justa\/SKILL\.md\s+\(OK\)$/m, 'la que cumple sigue en OK');
  assert.match(mal.stdout, /total: 701 caracteres/);
});

test('los caracteres se cuentan como puntos de código, no como unidades UTF-16', (t) => {
  const p = nuevoPlugin(t);
  p.skill('emojis', `name: emojis\ndescription: ${'😀'.repeat(350)}`);
  assert.equal(p.correr().status, 0, '350 emojis son 350 caracteres');
  p.skill('emojis', `name: emojis\ndescription: ${'😀'.repeat(351)}`);
  assert.equal(p.correr().status, 1);
});

test('una descripción multilínea con > se une con espacios y el espacio cuenta', (t) => {
  const p = nuevoPlugin(t);
  const a = 'a'.repeat(175);
  const b = 'b'.repeat(175);
  p.skill('plegada', `name: plegada\ndescription: >\n  ${a}\n  ${b}`);
  const mal = p.correr(['--json']);
  assert.equal(p.fila(mal, 'plegada').caracteres, 351, '175 + un espacio + 175');
  assert.equal(p.fila(mal, 'plegada').estado, 'FALLÓ');
  assert.equal(mal.status, 1);

  p.skill('plegada', `name: plegada\ndescription: >\n  ${a}\n  ${b.slice(1)}`);
  const ok = p.correr(['--json']);
  assert.equal(p.fila(ok, 'plegada').caracteres, 350);
  assert.equal(ok.status, 0);

  // «>-» y una línea vacía (separa párrafos con un salto) se leen igual que YAML.
  p.skill('parrafos', 'name: parrafos\ndescription: >-\n  uno\n  dos\n\n  tres\n');
  assert.equal(p.fila(p.correr(['--json']), 'parrafos').caracteres, 'uno dos\ntres'.length);
});

test('un bloque literal con | conserva los saltos de línea y los recorta al final', (t) => {
  const p = nuevoPlugin(t);
  p.skill('literal', 'name: literal\ndescription: |\n  uno\n  dos\n  tres\n\n');
  assert.equal(p.fila(p.correr(['--json']), 'literal').caracteres, 'uno\ndos\ntres'.length);
});

test('el frontmatter con fin de línea CRLF se lee igual', (t) => {
  const p = nuevoPlugin(t);
  p.skill('crlf', 'name: crlf\r\ndescription: >\r\n  uno\r\n  dos', '\r\n');
  const fila = p.fila(p.correr(['--json']), 'crlf');
  assert.equal(fila.caracteres, 'uno dos'.length);
  assert.equal(fila.estado, 'OK');
});

test('un BOM al inicio del archivo no impide leer el frontmatter (lo denuncia verificar-publicacion)', (t) => {
  const p = nuevoPlugin(t);
  p.escribir(path.join('skills', 'conbom', 'SKILL.md'), `${BOM}---\nname: conbom\ndescription: abc\n---\n\n# cuerpo\n`);
  const fila = p.fila(p.correr(['--json']), 'conbom');
  assert.equal(fila.estado, 'OK');
  assert.equal(fila.caracteres, 3);
});

test('el name distinto de la carpeta (skill) o del archivo (agente) falla', (t) => {
  const p = nuevoPlugin(t);
  p.skill('carpeta', 'name: otra-cosa\ndescription: algo');
  p.skill('buena', 'name: buena\ndescription: algo');
  p.agente('revisor', 'name: revisor\ndescription: bien');
  p.agente('archivo', 'name: distinto\ndescription: mal');
  const r = p.correr(['--json']);
  assert.equal(r.status, 1);
  const filas = r.json().archivos;
  const por = (tipo, nombre) => filas.find((a) => a.tipo === tipo && a.nombre === nombre);
  assert.equal(por('skill', 'otra-cosa').estado, 'FALLÓ');
  assert.match(por('skill', 'otra-cosa').motivos.join(' '), /«name» es «otra-cosa» pero la carpeta se llama «carpeta»/);
  assert.equal(por('skill', 'buena').estado, 'OK');
  assert.equal(por('agente', 'revisor').estado, 'OK');
  assert.equal(por('agente', 'distinto').estado, 'FALLÓ');
  assert.match(por('agente', 'distinto').motivos.join(' '), /el archivo se llama «archivo»/);
  assert.equal(r.json().fallaron, 2);
});

test('sin frontmatter, sin name o sin description falla con el motivo', (t) => {
  const p = nuevoPlugin(t);
  p.escribir('skills/pelada/SKILL.md', '# sin frontmatter\n');
  p.skill('vacia', 'name: vacia\ndescription:');
  p.skill('sinnombre', 'description: hay descripción');
  const r = p.correr();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /sin frontmatter/);
  assert.match(r.stdout, /falta «description» o está vacía/);
  assert.match(r.stdout, /falta «name»/);
});

test('un plugin sin skills ni agentes sale con 0 y avisa', (t) => {
  const p = nuevoPlugin(t);
  const r = p.correr();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /sin skills ni agentes/);
  fs.mkdirSync(path.join(p.plugin, 'skills'), { recursive: true });
  assert.equal(p.correr().status, 0, 'una carpeta skills/ vacía tampoco falla');
  const j = p.correr(['--json']).json();
  assert.deepEqual(j.archivos, []);
  assert.equal(j.total, 0);
  assert.ok(j.avisos.some((a) => /sin skills ni agentes/.test(a)));
});

test('una carpeta de skill sin SKILL.md es un aviso, no un fallo', (t) => {
  const p = nuevoPlugin(t);
  p.skill('bien', 'name: bien\ndescription: ok');
  fs.mkdirSync(path.join(p.plugin, 'skills', 'huerfana'), { recursive: true });
  const r = p.correr();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /AVISO: .*huerfana: carpeta sin SKILL\.md/);
});

test('--json devuelve máximo, filas, total, fallaron y avisos', (t) => {
  const p = nuevoPlugin(t);
  p.skill('uno', 'name: uno\ndescription: abcde');
  p.skill('dos', `name: dos\ndescription: ${'x'.repeat(400)}`);
  p.agente('tres', 'name: tres\ndescription: fgh');
  const r = p.correr(['--json']);
  assert.equal(r.status, 1);
  const j = r.json();
  assert.equal(j.maximo, 350);
  assert.equal(j.total, 5 + 400 + 3);
  assert.equal(j.fallaron, 1);
  assert.deepEqual(j.avisos, []);
  // Orden estable por plugin: primero los skills (por carpeta) y luego los agentes (por archivo).
  assert.deepEqual(j.archivos.map((a) => [a.tipo, a.nombre, a.caracteres, a.estado]), [
    ['skill', 'dos', 400, 'FALLÓ'],
    ['skill', 'uno', 5, 'OK'],
    ['agente', 'tres', 3, 'OK'],
  ]);
  for (const a of j.archivos) assert.deepEqual(Object.keys(a), ['ruta', 'tipo', 'nombre', 'caracteres', 'estado', 'motivos']);
});

test('el analizador de frontmatter entiende comillas, escapes, comentarios y valores en varias líneas', () => {
  const v = (cuerpo) => parsearFrontmatter(`---\n${cuerpo}\n---\n`).datos;
  const U = '\\' + 'u'; // no se escribe la secuencia de escape completa en el archivo
  assert.equal(v(String.raw`description: "con \"comillas\" y \\ barra y ${U}00e9 y \x41"`).description, 'con "comillas" y \\ barra y é y A');
  assert.equal(v("description: 'it''s fine'").description, "it's fine");
  assert.equal(v('description: texto simple # comentario').description, 'texto simple');
  assert.equal(v('description: C# y no#comentario').description, 'C# y no#comentario', 'solo un # precedido de espacio abre comentario');
  assert.equal(v('description: primera\n  segunda\n  tercera').description, 'primera segunda tercera');
  assert.equal(v('description:\n  vive en la línea siguiente').description, 'vive en la línea siguiente');
  assert.equal(v('name: a\ndescription: b\nallowed-tools: [x, y]').name, 'a');
  assert.equal(v('description: "uno\n  dos"').description, 'uno dos');
  assert.equal(v('description: >2\n    texto\n').description, 'texto');
  assert.equal(parsearFrontmatter('sin nada').error.startsWith('sin frontmatter'), true);
  assert.match(parsearFrontmatter('---\nname: x\n').error, /sin cierre/);
});

test('uso incorrecto: opción desconocida o carpeta de plugin inexistente salen con 2', () => {
  assert.equal(correr(HERRAMIENTA, ['--rara']).status, 2);
  const noExiste = path.join(os.tmpdir(), `uaeh-no-existe-${process.pid}`);
  const r = correr(HERRAMIENTA, [noExiste]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no existe la carpeta de plugin/);
});

test('sobre el repo real corre sin tronar y su código de salida es coherente con su informe', () => {
  const r = correr(HERRAMIENTA, ['--json']);
  assert.ok(r.status === 0 || r.status === 1, `salida inesperada: ${r.status}\n${r.stderr}`);
  const j = r.json();
  assert.ok(j && Array.isArray(j.archivos), 'JSON legible');
  assert.equal(r.status === 1, j.fallaron > 0);
  const texto = correr(HERRAMIENTA, []);
  assert.equal(texto.status, r.status);
  assert.match(texto.stdout, /verificar-presupuesto: /);
});
