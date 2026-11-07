/** Estado de carga mientras llega una pantalla del layout: el sidebar y la barra superior siguen visibles. */
export default function Loading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="visually-hidden">Cargando…</span>
      <span className="skeleton skeleton--eyebrow" />
      <span className="skeleton skeleton--title" />
      <span className="skeleton skeleton--text" />
      <div className="page-loading-grid" aria-hidden="true">
        <span className="skeleton skeleton--card" />
        <span className="skeleton skeleton--card" />
        <span className="skeleton skeleton--card" />
      </div>
    </div>
  );
}
