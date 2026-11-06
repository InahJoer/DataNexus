# Edición de celdas con sincronización al origen

**Estado:** Aprobado para implementación.

## Intención

Permitir que ADMIN y OPERADOR cambien desde la API una celda de una fila de origen y que el cambio llegue a SQL o Firestore, con detección de ediciones obsoletas y una entrada de auditoría `MODIFY_RECORD`.

## Alcance y objetivos

- Añadir `PATCH /engine/records` al backend NestJS.
- Implementar la operación para PostgreSQL, MySQL, SQL Server y Firestore, conforme a los criterios del issue #36.
- Recibir la conexión, entidad, esquema opcional, llave primaria, campo, valor esperado y valor nuevo.
- Rechazar una escritura si el valor de origen ya no coincide con el valor esperado, devolviendo HTTP 409.
- Permitir la edición a ADMIN y OPERADOR; bloquear LECTOR y AUDITOR en el guard y el servicio.
- Registrar los valores anterior y nuevo mediante `MODIFY_RECORD`, junto con actor, conexión, entidad y campo.
- Mantener la regla de que AUDITOR no recibe datos de negocio: podrá ver el evento, pero no la llave de la fila ni los valores anterior/nuevo.
- Validar pertenencia de la conexión al workspace, validar identificadores contra el catálogo y parametrizar los valores.

## No objetivos

- Construir o cambiar la interfaz del frontend. Hoy existe una tabla de resultados de cross-join, pero no una grilla de exploración para editar registros.
- Soportar MongoDB en esta entrega, dado que el issue pide SQL y Firestore.
- Edición masiva, cambios de esquema, creación o eliminación de filas, o modificación de llaves primarias.

## Contrato propuesto

`PATCH /engine/records` recibe un DTO con `conexionId`, `entidad`, `esquema?`, `llavePrimaria`, `campo`, `valorAnterior` y `valorNuevo`. `llavePrimaria` es un mapa de columnas a valores para SQL, para admitir llaves compuestas ya soportadas por la navegación paginada; en Firestore es el ID del documento como cadena. Los valores de celda admiten escalares JSON, incluyendo `null`.

El endpoint autentica con JWT y usa un permiso `MODIFY_RECORDS` asignado solo a ADMIN y OPERADOR. El servicio vuelve a comprobar el permiso y obtiene la conexión dentro del workspace del actor. Las llaves y el campo no se aceptan como SQL libre: se resuelven contra metadatos y se escapan como identificadores; valores se envían como parámetros.

## Concurrencia y errores

- SQL abre una transacción, bloquea la fila completa por llave primaria, compara el campo con el valor esperado usando la misma normalización que la navegación y actualiza antes de confirmar. Así el resultado no depende de collations insensibles a mayúsculas ni de una comparación fuera de la transacción. MySQL solo permite editar tablas InnoDB, que garantizan transacciones y bloqueos de fila. Fila inexistente devuelve 404; valor distinto devuelve 409.
- Firestore lee y compara el campo dentro de una transacción, y escribe solo si el valor aún coincide. Documento inexistente devuelve 404; valor distinto devuelve 409.
- En Firestore, un campo ausente no equivale a un campo presente con valor `null`; un valor esperado que no coincide, incluido el campo ausente, devuelve 409.
- Intentar editar una columna de llave primaria, una vista u objeto no editable se rechaza como solicitud no válida. Un adaptador sin escritura devuelve el error de operación no soportada.
- Si se omite el esquema, cada adaptador debe resolverlo con la misma regla que usa `readPage` para que una fila se edite en el mismo objeto que se exploró.
- Solo se registra `MODIFY_RECORD` como éxito después de una escritura confirmada. El detalle guarda la conexión, entidad, llave, campo y valores anterior/nuevo; nunca credenciales ni la fila completa. La serialización de auditoría debe permitir explícitamente esos campos.
- Si la escritura de origen se confirma y guardar el evento falla, la API responde 503 con código `AUDIT_WRITE_FAILED_AFTER_MUTATION` y `mutationApplied: true`; el cliente debe volver a leer la fila antes de reintentar. No se intenta una reversión compensatoria que pudiera pisar una tercera edición.
- `AuditService.findAll` y `exportLogs` devuelven los valores y la llave para ADMIN; para AUDITOR redactan esos datos en JSON y CSV, manteniendo actor, fecha, resultado, entidad y campo.
- `MODIFY_RECORD` y el target type `RECORD` ya están definidos en el `main` actualizado; no se necesita una migración de enum.

## Enfoques considerados

1. **API backend por adaptador (seleccionado).** Extender `IDataSourceAdapter`, agregar el endpoint, servicio, permiso y auditoría; implementar escrituras condicionales para SQL y transacción para Firestore. Coincide con tareas, etiquetas y aceptación del issue, y reutiliza el acceso a fuentes ya existente. Costo: el frontend aún no ofrece una grilla editable.
2. **Flujo completo con nueva grilla frontend.** Añadir lo anterior y además construir una pantalla para explorar filas, editar celdas y mostrar conflictos. El usuario tendría un flujo visible de punta a punta, pero la grilla de exploración no existe y la tarea crecería más allá del alcance marcado como backend.

## Criterios de aceptación

- Un usuario autorizado actualiza una celda de SQL y de Firestore; el origen refleja el valor nuevo.
- Si el valor anterior ya cambió, la API responde 409 y no sobrescribe la edición concurrente.
- LECTOR y AUDITOR reciben 403 y no producen escrituras.
- Cada cambio confirmado crea un evento `MODIFY_RECORD` con valores anterior/nuevo; fallas no se auditan como éxito.
- La API no permite inyección mediante nombres de entidad/campo ni escribe fuera del workspace.

## Decisiones para la implementación

- Se elige alcance solo backend, confirmado para este issue.
- Se preservan las llaves compuestas SQL existentes; Firestore utiliza el ID de documento.
- La UI, MongoDB y mutaciones distintas a actualizar una celda quedan fuera.
- El constructor puede elegir la forma interna exacta del método de adaptador y las excepciones de dominio mientras preserve el contrato y los códigos HTTP indicados.
