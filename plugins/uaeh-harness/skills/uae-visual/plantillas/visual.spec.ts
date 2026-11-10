// Plantilla de la puerta visual UAEH (skill uae-visual): chequeos visuales deterministas por pantalla critica.
// Se copia al proyecto como tests/visual/visual.spec.ts.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---- Lectura minima de DESIGN.md (parser propio, sin dependencias) ----
type Diseno = { fuente_display?: string; fuente_texto?: string; pantallas_criticas: string[] };

function limpiar(v: string): string {
  return v.trim().replace(/^["']|["']$/g, '');
}

function leerDiseno(): Diseno {
  const res: Diseno = { pantallas_criticas: [] };
  const ruta = join(process.cwd(), 'DESIGN.md');
  if (existsSync(ruta)) {
    const lineas = readFileSync(ruta, 'utf8').replace(/\r/g, '').split('\n');
    // El frontmatter va entre las dos primeras lineas "---".
    if (lineas[0]?.trim() === '---') {
      const fin = lineas.indexOf('---', 1);
      const fm = lineas.slice(1, fin === -1 ? lineas.length : fin);
      let enLista = false;
      for (const l of fm) {
        // Lineas vacias y comentarios (#) se ignoran; las claves que no se usan, tambien.
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        const item = l.match(/^\s*-\s+(.+)$/);
        if (enLista && item) {
          res.pantallas_criticas.push(limpiar(item[1]));
          continue;
        }
        const kv = l.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        enLista = false;
        if (!kv) continue;
        const clave = kv[1];
        const valor = kv[2];
        if (clave === 'pantallas_criticas') enLista = valor.trim() === '';
        else if (clave === 'fuente_display') res.fuente_display = limpiar(valor);
        else if (clave === 'fuente_texto') res.fuente_texto = limpiar(valor);
      }
    }
  }
  // Sin pantallas declaradas se prueba solo la portada.
  if (res.pantallas_criticas.length === 0) res.pantallas_criticas = ['/'];
  return res;
}

const diseno = leerDiseno();

// '/' -> 'inicio'; '/a/b' -> 'a-b'
function slug(ruta: string): string {
  const s = ruta.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'inicio';
}

// Primera familia de un font-family, sin comillas y en minusculas.
function primeraFamilia(ff: string): string {
  return ff.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
}

const PROHIBIDAS = ['inter', 'arial', 'roboto'];

for (const ruta of diseno.pantallas_criticas) {
  test.describe(ruta, () => {
    // 1. Errores de consola, de pagina, de red y respuestas >= 400.
    test('consola-y-red', async ({ page }) => {
      const consola: string[] = [];
      const paginaErr: string[] = [];
      const fallos: string[] = [];
      const http: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') consola.push(m.text()); });
      page.on('pageerror', (e) => paginaErr.push(String(e)));
      page.on('requestfailed', (r) => fallos.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
      page.on('response', (r) => { if (r.status() >= 400) http.push(`${r.status()} ${r.url()}`); });
      await page.goto(ruta);
      await page.evaluate(() => document.fonts.ready);
      const msg =
        `consola: ${JSON.stringify(consola)}\n` +
        `pageerror: ${JSON.stringify(paginaErr)}\n` +
        `requestfailed: ${JSON.stringify(fallos)}\n` +
        `http>=400: ${JSON.stringify(http)}`;
      expect(consola, msg).toHaveLength(0);
      expect(paginaErr, msg).toHaveLength(0);
      expect(fallos, msg).toHaveLength(0);
      expect(http, msg).toHaveLength(0);
    });

    // 2. Sin desborde horizontal.
    test('desborde', async ({ page }, info) => {
      await page.goto(ruta);
      await page.evaluate(() => document.fonts.ready);
      const m = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        cliente: document.documentElement.clientWidth,
      }));
      expect(
        m.scroll,
        `desborde horizontal en ${ruta} (${info.project.name}): scrollWidth=${m.scroll} clientWidth=${m.cliente}`,
      ).toBeLessThanOrEqual(m.cliente);
    });

    // 3. Fuentes: ni Inter/Arial/Roboto y coincidencia con DESIGN.md.
    test('fuente', async ({ page }) => {
      await page.goto(ruta);
      await page.evaluate(() => document.fonts.ready);
      const f = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return {
          body: getComputedStyle(document.body).fontFamily,
          h1: h1 ? getComputedStyle(h1).fontFamily : null,
        };
      });
      const body = primeraFamilia(f.body);
      const h1 = f.h1 === null ? null : primeraFamilia(f.h1);
      expect(PROHIBIDAS, `fuente prohibida en body: ${body}`).not.toContain(body);
      if (h1 !== null) expect(PROHIBIDAS, `fuente prohibida en h1: ${h1}`).not.toContain(h1);
      if (diseno.fuente_texto) {
        expect(body, 'body debe usar fuente_texto de DESIGN.md').toBe(diseno.fuente_texto.toLowerCase());
      }
      if (diseno.fuente_display && h1 !== null) {
        expect(h1, 'h1 debe usar fuente_display de DESIGN.md').toBe(diseno.fuente_display.toLowerCase());
      }
    });

    // 4. Accesibilidad con axe (WCAG 2.0/2.1 A y AA).
    test('axe', async ({ page }) => {
      await page.goto(ruta);
      await page.evaluate(() => document.fonts.ready);
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const resumen = r.violations.map((v) => `${v.id} (${v.nodes.length} nodos)`).join('; ');
      expect(r.violations, `violaciones axe: ${resumen}`).toEqual([]);
    });

    // 5. Captura contra la baseline aprobada. Sin baseline falla: no se crea sola.
    test('captura', async ({ page }) => {
      await page.goto(ruta);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${slug(ruta)}.png`, { fullPage: true });
    });
  });
}
