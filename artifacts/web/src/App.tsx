import { ClerkProvider } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dark } from "@clerk/themes";
import { ApiError } from "@workspace/api-client-react";

import { AppLayout } from "@/components/layout/app-layout";
import { ProtectedRoute } from "@/components/auth/protected-route";

import LandingPage from "@/pages/landing";
import SignInPage from "@/pages/auth/sign-in";
import SignUpPage from "@/pages/auth/sign-up";
import DashboardPage from "@/pages/dashboard";
import FacilitiesPage from "@/pages/facilities/index";
import FacilityDetailPage from "@/pages/facilities/detail";
import TerritoriesPage from "@/pages/territories/index";
import TerritoryDetailPage from "@/pages/territories/detail";
import OpportunityInboxPage from "@/pages/opportunities/index";
import OpportunityDetailPage from "@/pages/opportunities/detail";
import SignalsPage from "@/pages/signals";
import ConFilingsPage from "@/pages/con-filings";
import ConMonitorPage from "@/pages/con-monitor";
import ConStatesPage from "@/pages/con-states";
import DataSourcesPage from "@/pages/data-sources";
import ContactsPage from "@/pages/contacts";
import CampaignsPage from "@/pages/campaigns/index";
import CampaignDetailPage from "@/pages/campaigns/detail";
import SequencesPage from "@/pages/sequences";
import DraftsPage from "@/pages/drafts";
import BatchesPage from "@/pages/batches";
import ReportsPage from "@/pages/reports";
import AdminPage from "@/pages/admin/index";
import SettingsPage from "@/pages/settings";
import LeadsPage from "@/pages/leads";
import NotFound from "@/pages/not-found";

// publishableKeyFromHost derives the correct key for the current domain.
// VITE_CLERK_PUBLISHABLE_KEY is the test key in dev and is automatically
// swapped to the live key by Replit at publish time — do not edit manually.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
// Empty in dev (proxy is production-only). Automatically set by Replit at
// publish time to https://<app-domain>/api/__clerk — do not set manually.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

// Deduplicate concurrent auth-expiry checks — only one verification in flight at a time.
let _authCheckScheduled = false;

/**
 * Called when any API request returns 401.
 * Schedules a 3-second delayed verification against /api/me before redirecting.
 * This prevents redirect loops during Clerk's automatic JWT refresh window.
 */
function scheduleAuthCheck(): void {
  if (_authCheckScheduled) return;
  _authCheckScheduled = true;

  setTimeout(() => {
    _authCheckScheduled = false;
    const apiBase = basePath || "";
    fetch(`${apiBase}/api/me`, { credentials: "include" })
      .then((r) => {
        if (r.status === 401) {
          // Session is truly expired — clear cache and redirect once.
          queryClient.clear();
          const signInUrl = `${basePath}/sign-in`;
          if (!window.location.pathname.startsWith(`${basePath}/sign-in`)) {
            window.location.replace(signInUrl);
          }
        }
        // If status is 200/304, the Clerk JWT refreshed; nothing to do.
      })
      .catch(() => {
        // Network error — don't redirect, may recover.
      });
  }, 3000);
}

// Listen for 401s emitted directly from the fetch wrapper (covers non-React-Query calls).
// Guard with a named handler to avoid duplicate registrations under HMR.
if (typeof window !== "undefined" && !(window as unknown as Record<string, unknown>).__authExpiredListenerRegistered) {
  (window as unknown as Record<string, unknown>).__authExpiredListenerRegistered = true;
  window.addEventListener("auth:expired", () => scheduleAuthCheck());
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isAuthError(error)) scheduleAuthCheck();
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isAuthError(error)) scheduleAuthCheck();
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return false;
        }
        return failureCount < 2;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      
      <Route path="/:rest*">
        <ProtectedRoute>
          <AppLayout>
            <Switch>
              <Route path="/leads" component={LeadsPage} />
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/facilities" component={FacilitiesPage} />
              <Route path="/facilities/:id" component={FacilityDetailPage} />
              <Route path="/territories" component={TerritoriesPage} />
              <Route path="/territories/:id" component={TerritoryDetailPage} />
              <Route path="/opportunities" component={OpportunityInboxPage} />
              <Route path="/opportunities/:id" component={OpportunityDetailPage} />
              <Route path="/signals" component={SignalsPage} />
              <Route path="/con-filings" component={ConFilingsPage} />
              <Route path="/con-monitor" component={ConMonitorPage} />
              <Route path="/con-states" component={ConStatesPage} />
              <Route path="/data-sources" component={DataSourcesPage} />
              <Route path="/contacts" component={ContactsPage} />
              <Route path="/campaigns" component={CampaignsPage} />
              <Route path="/campaigns/:id" component={CampaignDetailPage} />
              <Route path="/sequences" component={SequencesPage} />
              <Route path="/drafts" component={DraftsPage} />
              <Route path="/batches" component={BatchesPage} />
              <Route path="/reports" component={ReportsPage} />
              <Route path="/admin/*?" component={AdminPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route component={NotFound} />
            </Switch>
          </AppLayout>
        </ProtectedRoute>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
      appearance={{
        theme: dark,
        variables: {
          colorPrimary: "hsl(175 40% 20%)",
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
