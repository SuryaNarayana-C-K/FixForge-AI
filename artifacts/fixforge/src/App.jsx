import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import NewRepair from '@/pages/new-repair';
import Repairs from '@/pages/repairs';
import RepairDetail from '@/pages/repair-detail';
import ProjectDetail from '@/pages/project-detail';
import Observability from '@/pages/observability';
import AdminPage from '@/pages/admin';
import Login from '@/pages/login';
import Register from '@/pages/register';
import { AppShell } from '@/components/app-shell';
import { AuthProvider } from '@/hooks/use-auth';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <AppShell>
        <Switch>
          <Route path="/"><Dashboard /></Route>
          <Route path="/login"><Login /></Route>
          <Route path="/register"><Register /></Route>
          <Route path="/admin"><AdminPage /></Route>
          <Route path="/new-repair"><NewRepair /></Route>
          <Route path="/repairs"><Repairs /></Route>
          <Route path="/repairs/:id"><RepairDetail /></Route>
          <Route path="/observability"><Observability /></Route>
          <Route path="/repair-intelligence"><Observability /></Route>
          <Route path="/projects/:id"><ProjectDetail /></Route>
          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
