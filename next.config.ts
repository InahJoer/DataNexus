import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nextConfig: NextConfig = {
  output: 'standalone',
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  // Solo afecta a `next dev`: permite abrir la app desde la IP de la red local (otro equipo o un celular en la misma
  // Wi-Fi, por ejemplo http://192.168.1.18:3000) además de localhost. Cada * es un número de la IP.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local'],
};

export default nextConfig;
