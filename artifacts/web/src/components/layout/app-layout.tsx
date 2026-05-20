import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import { UserButton } from "@clerk/react";
import {
  Activity,
  LayoutDashboard,
  Building2,
  Radio,
  Users,
  Target,
  Layers,
  FileText,
  Settings,
  ShieldAlert,
  CheckCircle2,
  FileSignature,
  MapPin,
  Database,
  Monitor,
  Crosshair,
  Compass,
  Inbox,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

interface AppLayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

export function AppLayout({ children }: AppLayoutProps) {
  const [location] = useLocation();
  const { data: me, isLoading } = useGetMe();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Close the mobile drawer whenever the route changes so a tap on a nav
  // link doesn't leave the overlay hanging.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location]);

  // When `VITE_MEDINTEL_OS_MODE=true` we run in prospect-intelligence mode
  // per the Medintel OS brief — outbound-marketing surfaces (contacts,
  // campaigns, sequences, drafts, batches) are hidden because the product
  // explicitly does not do automated outreach. The routes still resolve
  // for any direct deep-links the back-office team needs.
  const medintelMode =
    String(import.meta.env.VITE_MEDINTEL_OS_MODE ?? "").toLowerCase() === "true";

  const topItems: NavItem[] = [
    { name: "Opportunities", href: "/opportunities", icon: Inbox },
    { name: "Lead Cards", href: "/leads", icon: Crosshair },
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  ];

  const groups: NavGroup[] = [
    {
      label: "Intelligence",
      items: [
        { name: "Territories", href: "/territories", icon: Compass },
        { name: "Facilities", href: "/facilities", icon: Building2 },
        { name: "Signals", href: "/signals", icon: Radio },
        { name: "CON Monitor", href: "/con-monitor", icon: Monitor },
        { name: "CON States", href: "/con-states", icon: MapPin },
        { name: "Data Sources", href: "/data-sources", icon: Database },
      ],
    },
    ...(medintelMode
      ? []
      : [
          {
            label: "Outreach",
            items: [
              { name: "Contacts", href: "/contacts", icon: Users },
              { name: "Campaigns", href: "/campaigns", icon: Target },
              { name: "Sequences", href: "/sequences", icon: Layers },
              { name: "Drafts", href: "/drafts", icon: FileSignature },
              { name: "Batches", href: "/batches", icon: CheckCircle2 },
              { name: "Reports", href: "/reports", icon: FileText },
            ],
          },
        ]),
    ...(medintelMode
      ? [
          {
            label: "Reports",
            items: [{ name: "Reports", href: "/reports", icon: FileText }],
          },
        ]
      : []),
    {
      label: "System",
      items: [
        { name: "Settings", href: "/settings", icon: Settings },
        ...(me?.isPlatformAdmin
          ? [{ name: "Admin", href: "/admin", icon: ShieldAlert }]
          : []),
      ],
    },
  ];

  function NavLink({ item }: { item: NavItem }) {
    const isActive = location.startsWith(item.href);
    return (
      <Link
        href={item.href}
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
          isActive
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        {item.name}
      </Link>
    );
  }

  function NavBody() {
    return (
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        {topItems.map((item) => (
          <NavLink key={item.href} item={item} />
        ))}
        {groups.map((group) => (
          <div key={group.label} className="pt-3">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} />
              ))}
            </div>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside className="w-64 bg-sidebar border-r border-sidebar-border flex-col hidden md:flex">
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold text-primary">
            <Activity className="h-5 w-5" />
            <span>MedIntel OS</span>
          </Link>
        </div>
        <NavBody />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-3 sm:px-4 lg:px-6">
          {/* Mobile: hamburger that opens the drawer with the same nav contents */}
          <div className="flex items-center gap-2 md:hidden">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open navigation"
                  className="-ml-1"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0 bg-sidebar">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <div className="h-14 flex items-center px-4 border-b border-sidebar-border">
                  <Link
                    href="/dashboard"
                    className="flex items-center gap-2 font-bold text-primary"
                  >
                    <Activity className="h-5 w-5" />
                    <span>MedIntel OS</span>
                  </Link>
                </div>
                <NavBody />
              </SheetContent>
            </Sheet>
            <Link
              href="/dashboard"
              className="flex items-center gap-2 font-bold text-primary"
            >
              <Activity className="h-5 w-5" />
              <span className="text-sm">MedIntel OS</span>
            </Link>
          </div>

          <div className="ml-auto flex items-center gap-3 sm:gap-4">
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
              <p className="text-muted-foreground">
                Your user profile is not associated with an account. Please contact your platform
                administrator.
              </p>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
