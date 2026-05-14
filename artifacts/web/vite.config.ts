import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// PORT and BASE_PATH are injected by the Replit artifact runtime at dev/preview time.
// For `vite build` (CI / generic local), they are not required and default to safe values.
const isBuild = process.argv.includes("build");

const rawPort = process.env.PORT;
let port = 5173;
if (rawPort) {
  const parsed = Number(rawPort);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  port = parsed;
} else if (!isBuild) {
  throw new Error(
    "PORT environment variable is required for dev/preview but was not provided.",
  );
}

const basePath = process.env.BASE_PATH ?? "/";
if (!process.env.BASE_PATH && !isBuild) {
  throw new Error(
    "BASE_PATH environment variable is required for dev/preview but was not provided.",
  );
}

// In production builds (vite build), Replit sets REPLIT_DOMAINS to the deployment domain.
// Construct VITE_CLERK_PROXY_URL so ClerkProvider routes through the proxy.
// Only set this during a build — the proxy middleware is disabled in dev.
const clerkProxyUrl = (() => {
  if (!isBuild) return "";
  if (process.env.REPLIT_DOMAINS) {
    const domain = process.env.REPLIT_DOMAINS.split(",")[0]?.trim();
    if (domain) return `https://${domain}/api/__clerk`;
  }
  return process.env.VITE_CLERK_PROXY_URL ?? "";
})();

// Replit provides CLERK_PUBLISHABLE_KEY (no VITE_ prefix) in production build
// environments. Vite only forwards VITE_-prefixed vars automatically, so we
// manually inject it here so ClerkProvider gets the live key in the bundle.
const clerkPublishableKey =
  process.env.VITE_CLERK_PUBLISHABLE_KEY ??
  process.env.CLERK_PUBLISHABLE_KEY ??
  "";

export default defineConfig({
  base: basePath,
  define: {
    "import.meta.env.VITE_CLERK_PROXY_URL": JSON.stringify(clerkProxyUrl),
    "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(clerkPublishableKey),
  },
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
