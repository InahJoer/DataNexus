# Estilos de DataNexus

Cada pantalla tiene su propio archivo CSS en esta carpeta. Todos se importan **una sola vez** desde
[`app/layout.tsx`](../app/layout.tsx), como recomienda Next.js para que el orden de los estilos sea predecible.

| Archivo | Pantalla o parte de la app |
| --- | --- |
| `base.css` | Variables de diseño (`--ink`, `--green`, …), reset y marca. Va primero. |
| `onboarding.css` | Layout de dos columnas compartido por Login y Workspaces. |
| `login.css` | Formulario de acceso. Contiene `.button`, inputs y mensajes de formulario reutilizables. |
| `auth.css` | Pantallas de acceso (`components/auth/`): diagrama de fuentes, avisos, casilla "Mantener sesión", política de contraseña, invitación y aviso de inactividad. |
| `workspaces.css` | Selección de workspace (`app/workspaces`). |
| `dashboard.css` | Vista general (#68): KPIs, consumo de API, latencia, consultas, entorno y actividad. Define `.surface-card` y `.status-pill`, que usan otras pantallas. Trae sus media queries. |
| `responsive.css` | Media queries de Onboarding, Login, Workspaces y Dashboard. |
| `cross-join.css` | Constructor de Cross-Joins (`components/cross-join-builder.tsx`). (incluye el grid de resultados y el modal de exportación) |
| `audit.css` | Bitácora de auditoría (`components/audit-table.tsx`). |
| `app-shell.css` | Layout base de `app/(app)`: sidebar con el menú por rol, barra superior, encabezado de página (`PageHeader`) y estados de carga, vacío y error. Trae sus media queries. |
| `connections.css` | Conexiones (#44) y piezas compartidas: tabla `.data-table`, modal `.modal` y formularios `.form-*`. |
| `explorer.css` | Explorador de datos (`app/(app)/explorer`): árbol de conexiones, grid editable, filtros y panel de documento. |
| `query-builder.css` | Query Builder visual (`components/query-builder/`): paleta, lienzo con tarjetas y uniones, panel de salida, vista previa, resultados y gráfico rápido. Trae sus media queries. |

## Reglas

1. **El orden de importación importa.** Si un archivo redefine una clase de otro, gana el que se importa después.
   `responsive.css` va después de las pantallas que ajusta para poder sobrescribirlas.
2. **Una pantalla nueva = un archivo nuevo** aquí, con el prefijo de clases de esa pantalla (por ejemplo
   `.connections-…` en `connections.css`), importado en `app/layout.tsx` antes de `responsive.css` si este lo ajusta,
   o al final si trae sus propias media queries (como `cross-join.css` y `audit.css`).
3. **Colores y tipografía solo desde las variables de `base.css`**, para respetar la paleta de bajo contraste (RNF-07).
4. No uses `style={{ … }}` en los componentes: los estilos viven aquí.
