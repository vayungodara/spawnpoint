import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import Shell from './components/Shell.tsx'
import Servers from './pages/Servers.tsx'

const queryClient = new QueryClient()

// every page but the landing one loads on first visit, keeping the initial bundle small
const page = (load: () => Promise<{ default: ComponentType }>) => () =>
  load().then((m) => ({ Component: m.default }))

const router = createBrowserRouter([
  // the setup wizard has no sidebar; its API is open only until setup finishes
  { path: '/setup', lazy: page(() => import('./pages/Setup.tsx')) },
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Servers /> },
      { path: '/dashboard', lazy: page(() => import('./pages/Dashboard.tsx')) },
      { path: '/config', lazy: page(() => import('./pages/Config.tsx')) },
      { path: '/content', lazy: page(() => import('./pages/Content.tsx')) },
      { path: '/files', lazy: page(() => import('./pages/Files.tsx')) },
      { path: '/backups', lazy: page(() => import('./pages/Backups.tsx')) },
      { path: '/settings', lazy: page(() => import('./pages/Settings.tsx')) },
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
