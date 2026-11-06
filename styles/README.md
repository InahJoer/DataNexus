# Estilos de DataNexus

Cada pantalla tiene su propio archivo CSS en esta carpeta. Todos se importan **una sola vez** desde
[`app/layout.tsx`](../app/layout.tsx), como recomienda Next.js para que el orden de los estilos sea predecible.

| Archivo | Pantalla o parte de la app |
| --- | --- |
| `base.css` | Variables de diseño (`--ink`, `--green`, …), reset y marca. Va primero. |
| `onboarding.css` | Layout de dos columnas compartido por Login y Workspaces. |
| `login.css` | Formulario de acceso. Contiene `.button`, inputs y mensajes de formulario reutilizables. |
| `workspaces.css` | Selección de workspace (`app/workspaces`). |
| `dashboard.css` | Sidebar, barra superior, métricas, conexiones y actividad (`app/dashboard`). |
| `responsive.css` | Media queries de Onboarding, Login, Workspaces y Dashboard. |
| `cross-join.css` | Constructor de Cross-Joins (`components/cross-join-builder.tsx`). |
| `audit.css` | Bitácora de auditoría (`components/audit-table.tsx`). |

## Reglas

1. **El orden de importación importa.** Si un archivo redefine una clase de otro, gana el que se importa después.
   `responsive.css` va después de las pantallas que ajusta para poder sobrescribirlas.
2. **Una pantalla nueva = un archivo nuevo** aquí, con el prefijo de clases de esa pantalla (por ejemplo
   `.connections-…` en `connections.css`), importado en `app/layout.tsx` antes de `responsive.css` si este lo ajusta,
   o al final si trae sus propias media queries (como `cross-join.css` y `audit.css`).
3. **Colores y tipografía solo desde las variables de `base.css`**, para respetar la paleta de bajo contraste (RNF-07).
4. No uses `style={{ … }}` en los componentes: los estilos viven aquí.
