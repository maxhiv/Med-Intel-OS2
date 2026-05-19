import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Activity, ArrowRight, BarChart3, Database, ShieldAlert, Target } from "lucide-react";

export default function LandingPage() {
  const { isSignedIn, isLoaded } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      setLocation("/dashboard");
    }
  }, [isLoaded, isSignedIn, setLocation]);

  if (isLoaded && isSignedIn) return null;

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      <header className="h-16 border-b border-border flex items-center justify-between px-6 lg:px-12 bg-card/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-2 font-bold text-primary text-lg">
          <Activity className="h-6 w-6" />
          <span>MedIntel OS</span>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="ghost" asChild>
            <Link href="/sign-in">Sign In</Link>
          </Button>
          <Button asChild>
            <Link href="/sign-up">Get Started</Link>
          </Button>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        <section className="px-6 lg:px-12 py-24 md:py-32 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div className="space-y-8">
            <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground">
              Platform v1.0 Live
            </div>
            <h1 className="text-5xl md:text-6xl font-bold tracking-tight leading-tight">
              The operations cockpit for <span className="text-primary">medical equipment sales.</span>
            </h1>
            <p className="text-xl text-muted-foreground leading-relaxed max-w-2xl">
              Hunting purchase signals at hospitals, surgery centers, dialysis clinics, and imaging centers. Bloomberg-Terminal-meets-CRM density for high-performance teams.
            </p>
            <div className="flex items-center gap-4">
              <Button size="lg" className="h-12 px-8 text-base" asChild>
                <Link href="/sign-up">
                  Start Prospecting <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="h-12 px-8 text-base">
                View Demo
              </Button>
            </div>
          </div>
          <div className="relative relative h-[500px] w-full rounded-xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col">
             <div className="h-10 border-b border-border bg-muted/50 flex items-center px-4 gap-2">
               <div className="flex gap-1.5">
                 <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50" />
                 <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
                 <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50" />
               </div>
               <div className="mx-auto bg-background border border-border rounded text-xs px-24 py-1 text-muted-foreground font-mono">
                 medintel-os.hansen.local
               </div>
             </div>
             <div className="flex-1 p-6 grid grid-cols-2 gap-4 bg-background/50">
               <div className="space-y-4">
                 <div className="h-24 rounded-lg bg-card border border-border flex items-center px-4 gap-4">
                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      <Target className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-2xl font-bold font-mono">14,208</div>
                      <div className="text-xs text-muted-foreground uppercase tracking-wider">Active Signals</div>
                    </div>
                 </div>
                 <div className="h-48 rounded-lg bg-card border border-border p-4">
                    <div className="h-4 w-1/3 bg-muted rounded mb-4" />
                    <div className="space-y-2">
                      <div className="h-8 w-full bg-muted/50 rounded" />
                      <div className="h-8 w-full bg-muted/50 rounded" />
                      <div className="h-8 w-full bg-muted/50 rounded" />
                    </div>
                 </div>
               </div>
               <div className="space-y-4">
                 <div className="h-64 rounded-lg bg-card border border-border p-4">
                    <div className="h-4 w-1/3 bg-muted rounded mb-4" />
                    <div className="h-full w-full bg-primary/5 rounded border border-primary/20" />
                 </div>
               </div>
             </div>
          </div>
        </section>

        <section className="border-t border-border bg-card py-24">
          <div className="max-w-7xl mx-auto px-6 lg:px-12 grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Database className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold">Deep Facility Intel</h3>
              <p className="text-muted-foreground">
                Comprehensive data on beds, ownership, installed equipment base, and depreciation schedules.
              </p>
            </div>
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <BarChart3 className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold">Signal Detection</h3>
              <p className="text-muted-foreground">
                Automated tracking of CON approvals, leadership changes, and EOL equipment flags.
              </p>
            </div>
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Target className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold">Precision Outreach</h3>
              <p className="text-muted-foreground">
                Generate highly personalized campaign drafts tailored to specific facility purchase signals.
              </p>
            </div>
          </div>
        </section>
      </main>
      
      <footer className="h-24 border-t border-border flex items-center justify-between px-6 lg:px-12 text-sm text-muted-foreground">
        <div>&copy; {new Date().getFullYear()} MedIntel OS. All rights reserved.</div>
        <div className="flex items-center gap-6">
          <a href="#" className="hover:text-foreground transition-colors">Privacy</a>
          <a href="#" className="hover:text-foreground transition-colors">Terms</a>
          <a href="#" className="hover:text-foreground transition-colors">System Status</a>
        </div>
      </footer>
    </div>
  );
}
