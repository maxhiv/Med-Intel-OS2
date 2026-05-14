import { Link, useLocation } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { UserButton } from "@clerk/react";
import { Activity, LayoutDashboard, Building2, Radio, Users, Target, Layers, FileText, Settings, ShieldAlert, CheckCircle2, FileSignature, MapPin, Database, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();
  const { data: me, isLoading } = useGetMe();

  const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Facilities", href: "/facilities", icon: Building2 },
    { name: "Signals", href: "/signals", icon: Radio },
    { name: "CON Monitor", href: "/con-monitor", icon: Monitor },
    { name: "CON States", href: "/con-states", icon: MapPin },
    { name: "Data Sources", href: "/data-sources", icon: Database },
    { name: "Contacts", href: "/contacts", icon: Users },
    { name: "Campaigns", href: "/campaigns", icon: Target },
    { name: "Sequences", href: "/sequences", icon: Layers },
    { name: "Drafts", href: "/drafts", icon: FileText },
    { name: "Batches", href: "/batches", icon: CheckCircle2 },
    { name: "Reports", href: "/reports", icon: FileText },
  ];

  navigation.push({ name: "Settings", href: "/settings", icon: Settings });

  if (me?.isPlatformAdmin) {
    navigation.push({ name: "Admin", href: "/admin", icon: ShieldAlert });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <div className="w-full md:w-64 bg-sidebar border-r border-sidebar-border flex flex-col hidden md:flex">
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold text-primary">
            <Activity className="h-5 w-5" />
            <span>MedIntel OS</span>
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {navigation.map((item) => {
            const isActive = location.startsWith(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </div>
      
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4 lg:px-6">
          <div className="flex items-center md:hidden">
            <Link href="/dashboard" className="flex items-center gap-2 font-bold text-primary">
              <Activity className="h-5 w-5" />
              <span>MedIntel OS</span>
            </Link>
          </div>
          <div className="ml-auto flex items-center gap-4">
            {!isLoading && me?.account ? (
              <span className="text-sm text-muted-foreground hidden sm:inline-block">
                {me.account.name}
              </span>
            ) : null}
            <UserButton appearance={{ elements: { avatarBox: "h-8 w-8" } }} />
          </div>
        </header>
        
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          {!isLoading && me && !me.account && location !== "/settings" ? (
             <div className="flex flex-col items-center justify-center h-full text-center space-y-4 max-w-md mx-auto">
               <ShieldAlert className="h-12 w-12 text-muted-foreground" />
               <h2 className="text-xl font-semibold">No Account Assigned</h2>
               <p className="text-muted-foreground">Your user profile is not associated with an account. Please contact your platform administrator.</p>
             </div>
          ) : (
             children
          )}
        </main>
      </div>
    </div>
  );
}
