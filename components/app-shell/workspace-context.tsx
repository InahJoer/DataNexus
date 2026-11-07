'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { useApiQuery, type ApiQuery } from '@/lib/api/use-api-query';
import type { components } from '@/lib/api/schema';

export type Workspace = components['schemas']['WorkspaceResponseDto'];
export type DashboardSummary = components['schemas']['DashboardSummaryDto'];

type WorkspaceContextValue = Readonly<{
  workspace: ApiQuery<Workspace>;
  /** Resumen del workspace (#40): lo comparten el sidebar, las notificaciones y la Vista general. */
  summary: ApiQuery<DashboardSummary>;
}>;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** El backend cachea el resumen 60 s; pedirlo más seguido no trae datos nuevos. */
const SUMMARY_REFRESH_MS = 60_000;

export function WorkspaceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const workspace = useApiQuery(useCallback((api: ApiClient) => api.GET('/workspaces/me'), []));
  const summary = useApiQuery(
    useCallback((api: ApiClient) => api.GET('/dashboard/summary'), []),
    { refreshMs: SUMMARY_REFRESH_MS },
  );
  return <WorkspaceContext.Provider value={{ workspace, summary }}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace debe usarse dentro de WorkspaceProvider');
  return context;
}
