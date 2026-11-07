const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1_099_511_627_776 → "1 TB"; 68_719_476_736 → "64 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = value >= 100 || Number.isInteger(value) ? 0 : 1;
  return `${new Intl.NumberFormat('es', { maximumFractionDigits: digits }).format(value)} ${UNITS[exponent]}`;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
