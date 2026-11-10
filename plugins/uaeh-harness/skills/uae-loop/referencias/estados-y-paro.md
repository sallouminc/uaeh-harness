# Estados finales y condiciones de paro

## Flujo
`checkpoint → plan en línea → construye la conversación → commit de trabajo → verificador ∥ seguridad → estado final`.
Ante FAIL o UNKNOWN no hay reparación automática: se reporta y **el usuario decide**.

## Condiciones de paro (cualquiera detiene y se reporta)
- `REGRESSION`: una prueba que pasaba ahora falla → preservar el trabajo (sin reset) y pedir decisión.
- `CRITICAL_FINDING`: secreto filtrado, escalamiento de privilegios, posible pérdida de datos o fallo crítico de autorización.
- `UNKNOWN`: sin pruebas, 0 pruebas ejecutadas, herramienta o dependencia faltante, evidencia insuficiente.
- `BUDGET`: **60 min** desde la hora de inicio → parar y darle al usuario la elección (seguir, recortar o dejarlo).
- `HUMAN_GATE`: migración destructiva, producción, dinero real o cambio jurídico sensible pendiente.

> **Un código de salida 0 no es PASS.** Sin pruebas ejecutadas → `UNKNOWN` o `FAIL`. Las revisiones legales y de
> seguridad pueden quedar `PENDING_HUMAN_REVIEW` sin inventar un aprobado.

## Estados finales permitidos
- `PASS_TECHNICAL`: código y verificaciones automáticas correctos; no implica producción autorizada.
- `PASS_RELEASE_READY`: todas las puertas exigibles aprobadas y autorizaciones obtenidas.
- `PENDING_HUMAN_REVIEW`: decisiones reguladas, sensibles o irreversibles pendientes.
- `BLOCKED_SECURITY`: vulnerabilidad crítica/alta no resuelta u otra condición que prohíbe publicar.
- `FAIL`: prueba o requisito incumplido.
- `UNKNOWN`: falta evidencia; **nunca** se asimila a `PASS`.

## ¿Cuándo está terminada una tarea?
1. El criterio funcional tiene evidencia objetiva (prueba permanente; manual o E2E cuando haga falta).
2. El verificador dice exactamente qué corrió (comando, código de salida, número de pruebas).
3. No hay críticos abiertos ni falsos verdes dentro del diff.
4. El cambio no pisa trabajo ajeno y tiene vuelta atrás cuando hace falta.
5. El usuario aprobó lo que requiere autorización.

El formato del reporte del verificador vive en el agente `uaeh-harness:uae-verifier`.
