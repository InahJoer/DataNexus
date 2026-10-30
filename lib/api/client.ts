import createClient from 'openapi-fetch';
import type { paths } from './schema';

const baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export function createApiClient(accessToken?: string) {
  return createClient<paths>({
    baseUrl,
    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
  });
}
