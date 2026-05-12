import { SignIn } from "@clerk/react";

export default function SignInPage() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_top_right,var(--tw-gradient-stops))] from-primary/10 via-background to-background" />
      <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_bottom_left,var(--tw-gradient-stops))] from-chart-2/10 via-background to-background" />
      
      <div className="relative z-10 w-full max-w-[400px]">
        <div className="mb-8 flex justify-center">
          <div className="flex items-center gap-2 font-bold text-primary text-xl">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <span>MedIntel OS</span>
          </div>
        </div>
        <SignIn
          routing="path"
          path={`${basePath}/sign-in`}
          signUpUrl={`${basePath}/sign-up`}
          appearance={{
            elements: {
              rootBox: "w-full mx-auto",
              card: "shadow-xl border border-border bg-card/80 backdrop-blur rounded-xl",
              headerTitle: "text-foreground font-bold text-xl",
              headerSubtitle: "text-muted-foreground",
              socialButtonsBlockButton: "border-border text-foreground hover:bg-muted/50",
              socialButtonsBlockButtonText: "text-foreground font-medium",
              dividerLine: "bg-border",
              dividerText: "text-muted-foreground",
              formFieldLabel: "text-foreground font-medium",
              formFieldInput: "bg-background border-border text-foreground focus:ring-ring focus:border-ring rounded-md h-10",
              formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground font-bold h-10 transition-colors shadow-sm",
              footerActionText: "text-muted-foreground",
              footerActionLink: "text-primary hover:text-primary/90 font-medium",
              identityPreviewText: "text-foreground",
              identityPreviewEditButtonIcon: "text-muted-foreground hover:text-foreground",
            },
          }}
        />
      </div>
    </div>
  );
}
