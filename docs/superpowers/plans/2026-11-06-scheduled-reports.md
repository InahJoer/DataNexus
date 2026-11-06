# Reportes programados configurables Implementation Plan

**Goal:** Reemplazar el cron diario fijo por reportes vinculados a consultas guardadas y configurables por horario, zona, formato, destinatarios y estado.

**Architecture:** PostgreSQL mantiene programaciones y ejecuciones como fuente de verdad. Un servicio de `SchedulerRegistry` registra los cron activos al iniciar y al modificarlos, y los reconcilia periódicamente en cada instancia; cada disparo verifica la configuración vigente y reclama una clave única por ocurrencia local. Una lease con heartbeat permite marcar ejecuciones abandonadas sin repetirlas. La consulta guardada vigente se valida en `SavedQueriesService` y se exporta usando el almacenamiento actual.

**Tech Stack:** NestJS 12, Prisma 6, PostgreSQL, `@nestjs/schedule`, `cron`, DataEngine, storage local/GCS y MailService.

**Spec:** `docs/superpowers/specs/2026-11-06-scheduled-reports-design.md`

## Global Constraints

- Mantener el alcance solo backend y conservar `POST /reports/trigger`.
- Retirar el cron `daily-midnight-reports`; los trabajos configurables deben recuperarse desde PostgreSQL al iniciar.
- Usar frecuencia diaria/semanal/mensual, hora `HH:mm`, zona IANA y `dayOfMonth` de 1 a 28.
- Los formatos admitidos son `excel`, `pdf` y `json`; el almacenamiento firmado mantiene vigencia de 24 horas.
- LECTOR y destinatarios externos/desconocidos reciben datos enmascarados; AUDITOR no puede recibir reportes de negocio.
- No añadir ni ejecutar pruebas, builds o validaciones automatizadas en esta sesión.
- No hacer commit ni push; el usuario gestiona el envío al remoto.

## Review Focus

- Dos instancias reciben el mismo disparo: la clave única de ejecución debe dejar que una sola lo procese.
- Zona IANA inválida o cambio DST: no registrar una tarea imposible ni devolver un `nextRun` incoherente.
- Consulta inexistente/de otro workspace o propietario sin `MANAGE_REPORTS`: no ejecutar datos cruzados.
- Destinatario LECTOR/externo mezclado con ADMIN/OPERADOR: toda la entrega debe conservar el enmascaramiento.
- Falla de correo después de generar: conservar el artefacto y no desactivar el horario.

## File Structure

- `backend/prisma/schema.prisma` y una migración nueva: enums, modelos, relaciones e índices de ejecución.
- `backend/src/reports/dto/scheduled-report.dto.ts`: validación de configuración y respuestas.
- `backend/src/reports/scheduled-reports.controller.ts`: rutas autenticadas de programación, resumen e historial.
- `backend/src/reports/scheduled-reports.service.ts`: CRUD, estados, scheduler dinámico, reclamación idempotente, resumen y ejecución.
- `backend/src/reports/reports.service.ts`: generación compartida con correo opcional y máscara por rol; remover cron antiguo.
- `backend/src/data-engine/data-engine.service.ts`: salida JSON a stream.
- `backend/src/reports/storage/local-report-storage.service.ts` y `gcs-report-storage.service.ts`: permitir JSON.
- `backend/src/queries/saved-queries.service.ts`: impedir eliminar una consulta referenciada.
- `backend/src/queries/queries.module.ts`, `backend/src/reports/reports.module.ts`: exportar/importar servicios e instalar controller/provider.
- `backend/src/audit/audit.types.ts` y `backend/prisma/schema.prisma`: eventos auditables para cambios y ejecuciones.

## Task 1: Persistencia, relaciones y auditoría

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20261106201000_reportes_programados/migration.sql`
- Modify: `backend/src/audit/audit.types.ts`
- Modify: `backend/src/queries/saved-queries.service.ts`

- Añadir enums para frecuencia, estado de programación, estado de ejecución y origen (`SCHEDULED`/`MANUAL`).
- Crear `ScheduledReport` con workspace, consulta, propietario opcional, frecuencia, hora, zona, formato, destinatarios, envío por correo y estado.
- Crear `ScheduledReportRun` con programación, workspace, inicio/fin, estado, filas, error seguro, URL/vencimiento, hora prevista, lease e `idempotencyKey` único nullable.
- Usar borrado restrictivo de consultas guardadas y traducir la referencia a `ConflictException` antes de intentar eliminar.
- Añadir eventos de auditoría para crear/editar/eliminar/programar/ejecutar y que coincidan entre Prisma y `audit.types.ts`.

**Interfaces:** `ScheduledReport` y `ScheduledReportRun` quedan como contratos de persistencia para Tasks 2 y 3.

## Task 2: CRUD y registro dinámico

**Files:**
- Create: `backend/src/reports/dto/scheduled-report.dto.ts`
- Create: `backend/src/reports/scheduled-reports.controller.ts`
- Create: `backend/src/reports/scheduled-reports.service.ts`
- Modify: `backend/src/reports/reports.module.ts`
- Modify: `backend/src/queries/queries.module.ts`

- Implementar `GET/POST/PATCH/DELETE /reports/schedules`, `GET /summary`, pausa, reanudación y listado de ejecuciones.
- Validar que consulta y propietario pertenezcan al workspace; validar hora, frecuencia, día y zona IANA.
- Derivar el cron de la frecuencia y devolver expresión y próxima ejecución ISO.
- Cargar programaciones `ACTIVE` en `onModuleInit`; reemplazar/remover jobs en edición, pausa, reanudación y eliminación; reconciliar la fuente PostgreSQL entre instancias cada 10 segundos.
- Permitir CRUD solo con `MANAGE_REPORTS`; el usuario propietario actual debe conservar ese permiso al ejecutarse el cron.
- Calcular ejecuciones del día en la zona horaria del workspace y próxima ejecución activa.
- Exportar `SavedQueriesService` desde `QueriesModule` para reutilizar validación y definición vigente.

**Interfaces:** `ScheduledReportsService.create/list/findOne/update/remove/pause/resume/summary/listRuns/runNow` atiende el controller; su método de carga dinámica llama al mismo runner que los cron.

## Task 3: Ejecución y distribución segura

**Files:**
- Modify: `backend/src/reports/scheduled-reports.service.ts`
- Modify: `backend/src/reports/reports.service.ts`
- Modify: `backend/src/reports/dto/trigger-report.dto.ts`
- Modify: `backend/src/data-engine/data-engine.service.ts`
- Modify: `backend/src/reports/storage/local-report-storage.service.ts`
- Modify: `backend/src/reports/storage/gcs-report-storage.service.ts`

- Preparar la consulta con `SavedQueriesService.prepareRun` y ejecutar su payload completo por `executeCrossJoinToStream` sin aplicar paginación.
- Añadir JSON como salida de stream y aceptar su extensión y content type en ambos adapters de almacenamiento.
- Reutilizar la generación actual y permitir omitir el email; si se manda, generar enlace firmado como hoy.
- Resolver correos contra miembros del workspace; si algún destinatario es LECTOR o desconocido, generar para todos con máscara LECTOR. Rechazar direcciones de AUDITOR.
- Reclamar cada disparo automático mediante `idempotencyKey` única por programación y ocurrencia local; validar la configuración vigente y, en duplicado, omitir la segunda ejecución.
- Renovar la lease durante la ejecución y marcar como fallidos los trabajos cuya lease expire; conservar la clave para no reintentar el mismo disparo.
- `Run Now` registra ejecución manual sin cambiar estado ni cron. Error de extracción/exportación lleva cron a `ERROR`; un fallo solo de correo deja artefacto y mantiene `ACTIVE`.
- Guardar estado, filas, error genérico y URL/vencimiento en el historial; nunca almacenar filas ni credenciales.

**Interfaces:** el runner recibe programación y origen, y retorna el `ScheduledReportRun` actualizado; el controller devuelve el mismo resultado en `Run Now` y `listRuns` devuelve enlaces aún vigentes.

## Task 4: Retirada del cron heredado y cableado final

**Files:**
- Modify: `backend/src/reports/reports.service.ts`
- Modify: `backend/src/reports/reports.module.ts`
- Modify: `backend/src/reports/scheduled-reports.controller.ts`

- Eliminar `handleMidnightCron` y sus consultas de `clientes`/`pedidos`.
- Confirmar que reportes bajo demanda siguen usando su endpoint y que el módulo registra el controller/provider programado.
- Revisar el diff para confirmar que no entraron cambios de frontend, commits ni push.

**Completion contract:** la rama contiene la migración y el backend implementado conforme a la spec. No se ejecutan pruebas, builds ni validaciones automatizadas por las instrucciones de esta sesión.
