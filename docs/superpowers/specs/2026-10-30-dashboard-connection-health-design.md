# Diseño: conexiones y estado de salud en el dashboard

## Objetivo

Reemplazar la lista de conexiones de muestra del dashboard y su indicador de conexiones activas con información real del workspace autenticado.

## Diseño aprobado para implementar

- Agregar `GET /engine/connections/health`, protegido por JWT, que recorre solo las conexiones del workspace del usuario.
- Comprobar disponibilidad y acceso al catálogo con los exploradores existentes (PostgreSQL, MySQL, SQL Server y Firestore), usando el límite actual de 10 segundos. La respuesta no incluirá credenciales ni objetos/tablas del catálogo.
- Devolver un contrato Swagger tipado con metadatos seguros de la conexión, estado (`HEALTHY`, `UNAVAILABLE` o `UNSUPPORTED`), latencia y hora de comprobación. Los errores se resumirán sin filtrar detalles de conexión.
- El dashboard solicitará esta respuesta al abrir y cada 60 segundos. La tarjeta de conexiones mostrará motor, base/colección, estado, latencia y hora; el indicador de conexiones disponibles usará el conteo real.
- Cualquier rol autenticado podrá consultar el estado de su workspace. Las otras métricas y actividades seguirán identificadas como datos de muestra; no se guardará historial de salud.

## Manejo de estados de UI

- Carga: conservar el diseño actual y mostrar un indicador de consulta.
- Éxito con datos: listar conexiones y estados actuales.
- Workspace sin conexiones: explicar que aún no hay fuentes configuradas.
- Error de API: conservar la última respuesta disponible y ofrecer reintento; sin datos previos, mostrar error recuperable.

## Fuera de alcance

Historial de disponibilidad, alertas, métricas agregadas y vistas de gestión de conexiones.
