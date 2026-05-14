import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { errorHandler } from "./middlewares/errors";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust the Replit proxy so rate-limit and req.ip work correctly
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(compression());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// CORS allowlist: comma-separated origins via CORS_ORIGINS, plus the Replit
// dev domain when present. In development with no allowlist, fall back to
// reflecting the request origin (still scoped — no wildcard with credentials).
const allowedOrigins = new Set<string>(
  (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (process.env.REPLIT_DEV_DOMAIN) {
  allowedOrigins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
}
const isDev = process.env.NODE_ENV !== "production";

app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      if (isDev && allowedOrigins.size === 0) return cb(null, true);
      return cb(new Error("origin_not_allowed"));
    },
  }),
);
// Capture the raw request body alongside JSON parsing so webhook handlers
// can verify HMAC signatures over the exact bytes the vendor signed.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(
  clerkMiddleware((req) => {
    const authorizedParties: string[] = [];
    if (process.env.REPLIT_DOMAINS) {
      for (const d of process.env.REPLIT_DOMAINS.split(",")) {
        const t = d.trim();
        if (t) authorizedParties.push(`https://${t}`);
      }
    }
    if (process.env.REPLIT_DEV_DOMAIN) {
      authorizedParties.push(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    return {
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
      ...(authorizedParties.length > 0 && { authorizedParties }),
    };
  }),
);

// Global API rate limit (per IP). Health/Clerk-proxy paths are not under /api.
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

// Tighter limit for write-heavy admin/batch endpoints
app.use(
  ["/api/batches/run", "/api/admin"],
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

app.use("/api", router);
app.use(errorHandler);

export default app;
