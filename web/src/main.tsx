import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import Shell, { Pad } from './components/Shell.tsx'
import { Home, ToActive } from './pages/Home.tsx'

const queryClient = new QueryClient()

// every page but the shell loads on first visit, keeping the initial bundle small
const page = (load: () => Promise<{ default: ComponentType }>) => () =>
  load().then((m) => ({ Component: m.default }))

const router = createBrowserRouter([
  // the setup wizard has no sidebar; its API is open only until setup finishes
  { path: '/setup', lazy: page(() => import('./pages/Setup.tsx')) },
  {
    element: <Shell />,
    // the first lazy chunks land within a frame or two; paint bedrock meanwhile
    hydrateFallbackElement: <div className="min-h-screen" style={{ background: 'var(--color-bedrock)' }} />,
    children: [
      { path: '/', element: <Home /> },
      {
        element: <Pad />,
        children: [
          { path: '/new', lazy: page(() => import('./pages/Servers.tsx')) },
          { path: '/new/modpack', lazy: page(() => import('./pages/server/Mods.tsx')) },
          { path: '/settings', lazy: page(() => import('./pages/Settings.tsx')) },
        ],
      },
      {
        path: '/s/:id',
        lazy: page(() => import('./pages/server/Workspace.tsx')),
        children: [
          { index: true, lazy: page(() => import('./pages/server/Overview.tsx')) },
          { path: 'console', lazy: page(() => import('./pages/server/Console.tsx')) },
          { path: 'changes', lazy: page(() => import('./pages/server/Changes.tsx')) },
          { path: 'mods', lazy: page(() => import('./pages/server/Mods.tsx')) },
          { path: 'players', lazy: page(() => import('./pages/server/Players.tsx')) },
          { path: 'worlds', lazy: page(() => import('./pages/server/Worlds.tsx')) },
          { path: 'automation', lazy: page(() => import('./pages/server/Automation.tsx')) },
          { path: 'files', lazy: page(() => import('./pages/server/Files.tsx')) },
          { path: 'server', lazy: page(() => import('./pages/server/Server.tsx')) },
          { path: '*', element: <Navigate to=".." relative="path" replace /> },
        ],
      },
      { path: '/dashboard', element: <ToActive tab="" /> },
      { path: '/config', element: <ToActive tab="server" /> },
      { path: '/content', element: <ToActive tab="mods" /> },
      { path: '/files', element: <ToActive tab="files" /> },
      { path: '/backups', element: <ToActive tab="worlds" /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
