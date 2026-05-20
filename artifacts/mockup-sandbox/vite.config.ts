import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

// PORT + BASE_PATH are only needed when vite is serving (dev/preview).
// `vite build` writes static assets — it never opens a port, and the
// CI build pipeline shouldn't have to invent values just to satisfy
// these reads. Validate them only when the command actually uses them.
const command = process.argv.includes("build")
  ? "build"
  : process.argv.includes("preview")
  ? "preview"
  : process.argv.includes("dev") || process.argv.length <= 2
  ? "dev"
  : "build";

const needsServer = command !== "build";

const rawPort = process.env.PORT;
if (needsServer && !rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}
const port = rawPort ? Number(rawPort) : 0;
if (needsServer && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";
if (needsServer && !process.env.BASE_PATH) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    mockupPreviewPlugin(),
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
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port,
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
