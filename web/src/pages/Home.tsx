import { Link, Navigate, useLocation } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, useServers } from '../api'
import { Pi } from '../components/PixelIcons'
import bandSurface from '../assets/band-surface.webp'

// Kept out of the new-server chunk: "/" and old URLs only redirect for anyone
// who already has a server, so the first paint needs none of the wizard.

/** "/" opens the last server you worked on. A fresh install gets a welcome instead. */
export function Home() {
  const { data, isLoading, error } = useServers()
  if (isLoading) return null
  const s = data?.servers.find((x) => x.active) ?? data?.servers[0]
  if (s) return <Navigate to={`/s/${s.id}`} replace />
  return (
    <div className="p-4 sm:p-6 md:p-8 max-w-4xl">
      <div className="vista mb-6">
        <img src={bandSurface} alt="" />
        <span className="vista-tag">Y 63 · SURFACE</span>
      </div>
      {error ? (
        /Crafty is not connected/.test(String(error)) ? <CraftyMissing /> : (
        <div className="block px-5 py-4 border-redstone! flex items-center gap-3">
          <span className="lamp lamp-crash" aria-hidden />
          <div>
            <b className="text-sm">Can’t reach the server runtime</b>
            <p className="text-text-dim text-xs mt-0.5">Check Panel settings → Server runtime. The panel reconnects by itself once the service is back.</p>
          </div>
        </div>
        )
      ) : (
        <>
          <h1 className="text-3xl mb-1">Place your first server</h1>
          <p className="text-text-dim text-sm mb-6 max-w-[62ch]">
            Pick a loader and version, or start from a modpack. Spawnpoint sets the port, EULA, Java and memory,
            then gives you an address to send your friends.
          </p>
          <div className="grid sm:grid-cols-2 gap-4">
            <Link to="/new" className="btn btn-emerald px-5 py-4 text-left flex items-start gap-3">
              <Pi i="pick" className="pi" />
              <span className="flex flex-col gap-0.5"><b>New server</b><span className="text-xs font-semibold opacity-80">Pick a loader and a version</span></span>
            </Link>
            <Link to="/new/modpack" className="btn btn-block px-5 py-4 text-left flex items-start gap-3">
              <Pi i="crate" className="pi" />
              <span className="flex flex-col gap-0.5"><b>Start from a modpack</b><span className="text-xs text-text-dim">Modrinth or CurseForge</span></span>
            </Link>
          </div>
          <ol className="grid sm:grid-cols-3 gap-4 mt-8 text-sm">
            {[
              ['PLACE', 'Spawnpoint builds the server and keeps it running, even while the panel restarts.'],
              ['ADD MODS', 'On Fabric, Forge and NeoForge, each mod change is tested on a copy of the server before it goes live.'],
              ['INVITE', 'On a modded server, friends import a small starter pack once. After that the pack syncs when they join.'],
            ].map(([k, v], i) => (
              <li key={k} className="border-t-2 border-line pt-3">
                <span className="hud !opacity-100 text-emerald">{i + 1} · {k}</span>
                <p className="text-text-dim mt-1.5">{v}</p>
              </li>
            ))}
          </ol>
          <p className="text-text-dim text-xs mt-8 max-w-[62ch]">Already run servers in Crafty Controller? Connect it under Server runtime in <Link to="/settings" className="underline underline-offset-2 hover:text-text">Panel settings</Link> and they show up here.</p>
        </>
      )}
    </div>
  )
}

/** Old flat URLs (bookmarks, docs) land on the same section of the last-opened server. */
export function ToActive({ tab }: { tab: string }) {
  const { data, isLoading } = useServers()
  const { search } = useLocation()
  if (isLoading) return null
  const s = data?.servers.find((x) => x.active) ?? data?.servers[0]
  if (!s) return <Navigate to={search.includes('tab=modpack') ? '/new/modpack' : '/'} replace />
  return <Navigate to={`/s/${s.id}${tab ? `/${tab}` : ''}${search}`} replace />
}

/** Crafty is selected but not connected: one click back to Spawnpoint, or connect it. */
function CraftyMissing() {
  const qc = useQueryClient()
  const back = useMutation({
    mutationFn: () => api('/api/runtime', { method: 'POST', body: JSON.stringify({ mode: 'standalone' }) }),
    onSuccess: () => qc.invalidateQueries(),
  })
  return (
    <div className="block px-5 py-4 border-gold!">
      <b>Crafty Controller is selected but not connected</b>
      <p className="text-text-dim text-sm mt-1 max-w-[62ch]">Your servers are fine. Switch back to Spawnpoint's own service, or connect Crafty with an API key in Settings.</p>
      <div className="flex gap-3 flex-wrap mt-3">
        <button onClick={() => back.mutate()} disabled={back.isPending} className="btn btn-emerald px-4 py-2 text-sm">{back.isPending ? 'Switching…' : 'Use Spawnpoint'}</button>
        <Link to="/settings" className="btn btn-block px-4 py-2 text-sm">Connect Crafty</Link>
      </div>
      {back.error && <p role="alert" className="text-sm text-redstone font-semibold mt-2">{back.error.message.replace(/^\d+: /, '')}</p>}
    </div>
  )
}
