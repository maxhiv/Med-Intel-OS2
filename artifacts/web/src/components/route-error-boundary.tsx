import { Component, type ErrorInfo, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Top-level error boundary for the app's route tree.
 *
 * Without this, any uncaught render-time error inside a route component
 * (e.g. a null-property access in pages/facilities/detail.tsx) blanks the
 * entire page — React unmounts the whole tree because there's no parent
 * boundary to recover into. With this in place the user sees the actual
 * error message + stack instead of a white screen, and a "Try again"
 * button that re-mounts the subtree.
 */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // eslint-disable-next-line no-console
    console.error("RouteErrorBoundary caught:", error, info?.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null, info: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-3xl mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" /> Something went wrong on this page
            </CardTitle>
            <CardDescription>
              The page below crashed during render. Details are below — paste these
              into the chat if you need help debugging.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                Error
              </div>
              <pre className="text-sm bg-muted p-3 rounded whitespace-pre-wrap break-words">
                {this.state.error.message}
              </pre>
            </div>
            {this.state.error.stack ? (
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Stack
                </div>
                <pre className="text-xs bg-muted p-3 rounded max-h-64 overflow-auto whitespace-pre-wrap">
                  {this.state.error.stack}
                </pre>
              </div>
            ) : null}
            {this.state.info?.componentStack ? (
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
                  Component stack
                </div>
                <pre className="text-xs bg-muted p-3 rounded max-h-64 overflow-auto whitespace-pre-wrap">
                  {this.state.info.componentStack}
                </pre>
              </div>
            ) : null}
            <div className="flex gap-2 pt-2">
              <Button variant="default" onClick={this.handleReset}>
                Try again
              </Button>
              <Button variant="outline" onClick={() => window.location.assign("/dashboard")}>
                Back to dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
