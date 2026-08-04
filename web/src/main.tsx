import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import Shell from './components/Shell.tsx'
import Servers from './pages/Servers.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Config from './pages/Config.tsx'
import Content from './pages/Content.tsx'
import Backups from './pages/Backups.tsx'
import Files from './pages/Files.tsx'
import Settings from './pages/Settings.tsx'
import Setup from './pages/Setup.tsx'

const queryClient = new QueryClient()

const router = createBrowserRouter([
  // first-run wizard lives OUTSIDE Shell: no sidebar, no PIN gate — its own
  // API self-guards and the page bounces home when setup is already done
  { path: '/setup', element: <Setup /> },
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Servers /> },
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/config', element: <Config /> },
      { path: '/content', element: <Content /> },
      { path: '/files', element: <Files /> },
      { path: '/backups', element: <Backups /> },
      { path: '/settings', element: <Settings /> },
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
