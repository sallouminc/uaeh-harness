# Filtro contra falsos positivos (resumen; fuente completa: `checklist-prelanzamiento.md`, otra referencia de esta carpeta)

Se aplica a TODO candidato (escáneres, Codex, cazadores) ANTES de gastar un verificador:

1. **Cita la línea.** `archivo:línea` + el texto releído. Sin cita → no avanza (apéndice). Para símbolos generados (ORM, migraciones, decoradores, cliente de Prisma) se cita lo que los CREA.
2. **Confianza ≥ 8/10** para pasar a validación (9-10 verificado leyendo; 7-8 muy probable; ≤ 6 apéndice o `TENTATIVO` solo en deep).
3. **Trazado activo, sin atacar:** secretos → formato real (prefijo y largo), nunca probarlos contra la API; webhooks → ¿se valida la firma?; SSRF → ¿la URL del usuario llega a un host interno?; CI → ¿`pull_request_target` descarga el PR?; dependencias → ¿la función vulnerable se importa y llama de verdad?; IA → ¿la entrada del usuario llega al prompt de sistema?
4. **Segunda mirada independiente:** el verificador recibe solo `archivo:línea` y las reglas, sin el razonamiento del cazador.
5. **Descartes automáticos:** DoS/rate limit (EXCEPTO gasto ilimitado en LLM o APIs de pago: sí cuenta), secretos en disco ya protegidos, memoria/CPU, validación de campos no críticos sin impacto, seguridad de memoria en lenguajes seguros, solo pruebas/fixtures, log spoofing, SSRF que solo controla la ruta, contenido del usuario en posición de mensaje de usuario de IA, regex sobre entrada confiable, falta de hardening, falta de logs, aleatoriedad fuera de seguridad, dependencias CVSS < 4 sin exploit.
6. **Precedentes:** loggear un secreto SÍ cuenta; UUID son inadivinables; env y flags de CLI son confiables; React/Angular escapan por defecto (solo `dangerouslySetInnerHTML` y similares); el JS del navegador no autentica (eso es del servidor); root en docker-compose de desarrollo NO es hallazgo, en producción SÍ.
7. **Variantes:** un hallazgo confirmado dispara la búsqueda del mismo patrón en todo el repo; las variantes se ligan al original.

Escáneres: un hallazgo de semgrep/gitleaks/osv es un **candidato**, no una vulnerabilidad. osv/pnpm audit → solo si el paquete vulnerable está en producción y la función afectada es alcanzable.
