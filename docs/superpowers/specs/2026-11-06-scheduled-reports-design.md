# Diseño: reportes programados configurables (issue #38)

## Intención

Reemplazar el cron fijo que genera un reporte de `clientes` y `pedidos` a medianoche por programaciones configurables asociadas a consultas guardadas. El objetivo es que ADMIN y OPERADOR puedan administrar horarios, zonas horarias, formato y destinatarios, ejecutar ahora y consultar el estado sin perder el aislamiento por workspace ni el enmascaramiento de LECTOR.

## Alcance confirmado

- Solo backend. La issue está etiquetada como backend; las pantallas de Figma quedan fuera de esta rama.
- Mantener `POST /reports/trigger` y sus descargas existentes.
- Quitar el cron fijo `daily-midnight-reports`.

## Enfoques considerados

1. **Persistencia + `SchedulerRegistry` (elegido):** guardar la configuración en PostgreSQL, cargar los trabajos activos al iniciar y reemplazarlos en cada cambio. Es el mecanismo que pide la issue y permite recuperar horarios tras reinicios.
2. **Consultar trabajos vencidos en un cron de sondeo:** evitaría registrar un trabajo por programación, pero añade latencia y no cumple tan directamente el requisito de registro dinámico.
3. **Añadir también las pantallas:** seguiría los diseños enlazados, pero amplía una issue etiquetada como backend y requiere trabajo independiente en el frontend.

## Comportamiento

- Crear, listar, consultar, editar y eliminar programaciones por workspace. También ofrecer pausa, reanudación, ejecución inmediata, resumen y lista de ejecuciones.
- Cada programación referencia una consulta guardada y ejecuta su definición vigente. La consulta debe pertenecer al mismo workspace. No se guarda una copia fija de la definición.
- Frecuencia diaria, semanal o mensual; hora `HH:mm`; zona IANA. Si no se envía zona horaria, usar la del workspace. El día semanal usa `0` para domingo y `6` para sábado. El día mensual admite `1` a `28` para garantizar una ejecución cada mes.
- Formatos `excel`, `pdf` y `json`; `json` se escribe al destino como stream, igual que los formatos existentes. Enviar correo es opcional. Si no se envía, la URL firmada queda disponible en el registro de ejecución hasta su vencimiento.
- Estados `ACTIVE`, `PAUSED` y `ERROR`. Los trabajos `ACTIVE` se registran al iniciar y se actualizan al editar. Un fallo al validar o generar el archivo marca la programación `ERROR` y la retira del registro; se puede corregir y reanudar. Un fallo exclusivo de correo registra la ejecución como fallida, conserva el enlace y deja la programación `ACTIVE` para el siguiente horario.
- `Run Now` se permite en cualquier estado y registra su resultado sin modificar el horario, estado ni registro del trabajo programado.
- La ejecución usa el rol actual del propietario operativo de la programación. Si ya no existe o perdió `MANAGE_REPORTS`, la ejecución automática pasa a `ERROR`. Al reanudarla, un ADMIN u OPERADOR puede asumir esa propiedad operativa; el cambio queda en auditoría.
- Si cualquiera de los destinatarios es LECTOR o una dirección que no pertenece a un usuario del workspace, se genera una salida enmascarada para toda la lista. Si una dirección pertenece a AUDITOR, se rechaza la ejecución porque ese rol no recibe datos de negocio. Las direcciones ADMIN/OPERADOR reciben salida sin enmascarar.
- Las ejecuciones guardan hora de inicio/fin, estado, cantidad de filas, error resumido y URL/vencimiento cuando se creó un archivo. Esto permite el resumen de ejecuciones de hoy y recuperar reportes sin correo. Cada instancia reconcilia sus cron jobs con PostgreSQL periódicamente y comprueba la configuración vigente antes de ejecutar, para descartar disparos obsoletos. La clave única representa la ocurrencia local de la programación; varias instancias que detecten la misma hora dejan que solo una la reclame.
- Registrar en auditoría los cambios de programación y sus ejecuciones; no guardar datos de filas, credenciales ni contenido del reporte.

## Persistencia y API propuestas

- `ScheduledReport`: workspace, consulta guardada, propietario, título, frecuencia, hora, zona, formato, destinatarios, envío por correo y estado. La expresión cron se deriva de estos campos y se devuelve en las respuestas.
- `ScheduledReportRun`: historial de ejecuciones asociado a programación y workspace.
- Endpoints bajo `/reports/schedules`: CRUD, `/summary`, `/:id/pause`, `/:id/resume`, `/:id/run` y `/:id/runs`.
- Respuestas de programación incluyen expresión cron y próxima ejecución en ISO 8601; el resumen incluye conteos por estado, ejecuciones de hoy según zona del workspace y próxima ejecución activa.
- La consulta guardada no se puede eliminar mientras una programación la referencia; responder con conflicto para que primero se quite o cambie la programación.
- Una ejecución reclamada mantiene una lease renovada mientras trabaja. Si vence por caída del proceso, se marca fallida/incompleta para auditoría, no se reintenta y la siguiente hora permanece habilitada.

## Restricciones y notas técnicas

- `SavedQueriesService.prepareRun` reconstruye y valida la definición; su ejecución paginada limita resultados a una página. Para reportes se reutilizará la definición validada con `DataEngineService.executeCrossJoinToStream`, evitando truncar el resultado por paginación.
- La exportación en stream hoy acepta Excel y PDF, mientras JSON solo se exporta como buffer. La ampliación de JSON y las validaciones de nombre/tipo de contenido de almacenamiento forman parte de esta issue.
- `ScheduleModule` ya está instalado. La base de datos PostgreSQL es la fuente de verdad; cada registro en memoria se reconcilia periódicamente entre instancias.
- Los errores persistidos deben ser mensajes seguros y breves, sin valores de conexión ni secretos.

## No objetivos

- Interfaz frontend, editor visual de cron, exportación Word, historial de reportes no programados y reintentos automáticos.
- Cambiar permisos de otras operaciones de reportes o el motor de consultas.

## Decisiones dejadas al implementador

- Nombres exactos de DTOs/enum y diseño de migración, siguiendo patrones Prisma y Nest existentes.
- Cálculo de próxima ejecución y límites de frecuencia con la biblioteca `cron` ya usada por Nest Schedule; no agregar un servicio de cron alternativo.
- Mantener las URLs firmadas y vigencia del storage actual (24 horas).
