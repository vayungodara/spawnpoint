// Typed API client + TanStack Query hooks
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

export interface Detection {
  loader: string
  mc: string | null
}
export interface ServerInfo {
  id: string
  name: string
  port: number
  path: string
  active: boolean
  detection: Detection
  address: string | null
}
export interface Stats {
  running: boolean
  crashed: boolean
  waiting_start: boolean
  started: string
  cpu: number
  mem: number | string
  mem_percent: number
  online: number
  max: number
  players: string
  version: string
  desc: string
  world_size: string
  phase?: 'stopped' | 'starting' | 'ready'
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = init?.body ? { 'content-type': 'application/json' } : undefined
  const r = await fetch(path, { headers, ...init })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
  return r.json() as Promise<T>
}

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerInfo[]; active: string | null }>('/api/servers'),
    refetchInterval: 10_000,
  })
}

export function useStats(id: string | undefined) {
  return useQuery({
    queryKey: ['stats', id],
    queryFn: () => api<Stats>(`/api/servers/${id}/stats`),
    enabled: !!id,
    refetchInterval: 4_000,
  })
}

export function useLogs(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['logs', id],
    queryFn: () => api<{ lines: string[] }>(`/api/servers/${id}/logs?tail=200`),
    enabled: !!id && enabled,
    refetchInterval: 2_500,
  })
}

export function useSetActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api('/api/servers/active', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export function useServerAction(id: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') =>
      api(`/api/servers/${id}/action`, { method: 'POST', body: JSON.stringify({ action }) }),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['stats', id] }), 1500),
  })
}

export interface AutostopStatus {
  enabled: boolean
  idleMinutes: number
  idle: { id: string; emptyForSec: number; stopsInSec: number }[]
}

export function useAutostop() {
  return useQuery({
    queryKey: ['autostop'],
    queryFn: () => api<AutostopStatus>('/api/autostop'),
    refetchInterval: 10_000,
  })
}

export function useSetAutostop() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cfg: { enabled: boolean; idleMinutes: number }) =>
      api('/api/autostop', { method: 'PUT', body: JSON.stringify(cfg) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['autostop'] }),
  })
}

export function useSendCommand(id: string | undefined) {
  return useMutation({
    mutationFn: (cmd: string) =>
      api<{ ok: boolean; via: string; output?: string }>(`/api/servers/${id}/command`, {
        method: 'POST',
        body: JSON.stringify({ cmd }),
      }),
  })
}
