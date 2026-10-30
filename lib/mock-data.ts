export const sampleWorkspace = {
  name: 'Northstar Analytics',
  initials: 'NA',
  domain: 'northstar.io',
  plan: 'Enterprise',
  members: 12,
} as const;

export const dashboardMetrics = [
  { label: 'Conexiones activas', value: '12', detail: 'de 14 fuentes', change: '+2 este mes', icon: 'plug', tone: 'mint' },
  { label: 'Filas analizadas', value: '2.4M', detail: 'en los últimos 30 días', change: '+18.6%', icon: 'database', tone: 'blue' },
  { label: 'Consultas ejecutadas', value: '8,492', detail: 'en los últimos 30 días', change: '+12.3%', icon: 'activity', tone: 'violet' },
  { label: 'Reportes programados', value: '18', detail: '4 se envían esta semana', change: 'Todo al día', icon: 'layers', tone: 'amber' },
] as const;

export const queryTrend = [
  { day: 'Lun', value: 34 },
  { day: 'Mar', value: 47 },
  { day: 'Mié', value: 39 },
  { day: 'Jue', value: 62 },
  { day: 'Vie', value: 51 },
  { day: 'Sáb', value: 74 },
  { day: 'Dom', value: 68 },
] as const;

export const dataConnections = [
  { name: 'PostgreSQL · Analytics', kind: 'Base de datos', initials: 'PG', color: 'connection-postgres', status: 'Sincronizado', lastSync: 'hace 2 min', rows: '1.2M filas' },
  { name: 'Salesforce · CRM', kind: 'Aplicación', initials: 'SF', color: 'connection-salesforce', status: 'Sincronizado', lastSync: 'hace 18 min', rows: '84.6K filas' },
  { name: 'BigQuery · Warehouse', kind: 'Almacén de datos', initials: 'BQ', color: 'connection-bigquery', status: 'Revisar conexión', lastSync: 'hace 1 h', rows: '—' },
] as const;

export const recentActivity = [
  { initials: 'AL', name: 'Alex Lee', action: 'ejecutó un cruce de datos', target: 'Ventas + Clientes', time: 'Hace 8 min', tone: 'activity-teal' },
  { initials: 'MC', name: 'Maya Chen', action: 'actualizó una conexión', target: 'Salesforce · CRM', time: 'Hace 42 min', tone: 'activity-violet' },
  { initials: 'JD', name: 'Jordan Davis', action: 'programó un reporte', target: 'Resumen semanal', time: 'Ayer, 16:24', tone: 'activity-amber' },
] as const;
