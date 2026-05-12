import { ClerkProvider } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dark } from "@clerk/themes";

import { AppLayout } from "@/components/layout/app-layout";
import { ProtectedRoute } from "@/components/auth/protected-route";

// Pages placeholder mapping
import LandingPage from "@/pages/landing";
import SignInPage from "@/pages/auth/sign-in";
import SignUpPage from "@/pages/auth/sign-up";
import DashboardPage from "@/pages/dashboard";
import FacilitiesPage from "@/pages/facilities/index";
import FacilityDetailPage from "@/pages/facilities/detail";
import SignalsPage from "@/pages/signals";
import ConFilingsPage from "@/pages/con-filings";
import ContactsPage from "@/pages/contacts";
import CampaignsPage from "@/pages/campaigns/index";
import CampaignDetailPage from "@/pages/campaigns/detail";
import SequencesPage from "@/pages/sequences";
import DraftsPage from "@/pages/drafts";
import BatchesPage from "@/pages/batches";
import ReportsPage from "@/pages/reports";
import AdminPage from "@/pages/admin/index";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  typeof window !== "undefined" ? window.location.hostname : "",
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

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
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/facilities" component={FacilitiesPage} />
              <Route path="/facilities/:id" component={FacilityDetailPage} />
              <Route path="/signals" component={SignalsPage} />
              <Route path="/con-filings" component={ConFilingsPage} />
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
        baseTheme: document.documentElement.classList.contains("dark") ? dark : undefined,
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