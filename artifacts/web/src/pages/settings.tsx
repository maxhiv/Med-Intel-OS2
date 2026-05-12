import { useGetMe } from "@workspace/api-client-react";
import { UserProfile } from "@clerk/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, ShieldCheck, Mail, Calendar } from "lucide-react";

export default function SettingsPage() {
  const { data: me } = useGetMe();

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and profile preferences.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2 bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" /> Account Information
            </CardTitle>
            <CardDescription>Your current tenant association and role.</CardDescription>
          </CardHeader>
          <CardContent>
            {me?.account ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 bg-muted/30 p-4 rounded-lg border border-border">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Organization</div>
                    <div className="font-semibold text-lg">{me.account.name}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Plan Tier</div>
                    <div className="font-medium capitalize">{me.account.planTier || 'Standard'}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Your Role</div>
                    <div className="font-medium capitalize flex items-center gap-2">
                       {me.user.role}
                       {me.isPlatformAdmin && <ShieldCheck className="h-4 w-4 text-primary" />}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Account Created</div>
                    <div className="font-medium">{new Date(me.account.createdAt || '').toLocaleDateString()}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-destructive/10 text-destructive p-4 rounded-lg border border-destructive/20">
                You are not currently assigned to any organization account. Please contact your platform administrator.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="md:col-span-2 mt-4 flex justify-center">
           <UserProfile 
             appearance={{
               elements: {
                 rootBox: "w-full shadow-none",
                 card: "shadow-none border border-border bg-card w-full",
                 navbar: "hidden",
                 navbarMobileMenuRow: "hidden",
                 pageScrollBox: "p-6",
                 headerTitle: "text-2xl font-bold text-foreground",
                 headerSubtitle: "text-muted-foreground",
                 profileSectionTitle: "text-foreground font-semibold border-b border-border pb-2",
                 profileSectionTitleText: "text-foreground",
                 profileSectionContent: "pt-4",
                 profileSectionPrimaryButton: "text-primary hover:bg-muted",
               }
             }}
           />
        </div>
      </div>
    </div>
  );
}