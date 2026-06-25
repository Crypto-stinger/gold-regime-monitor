import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import https from "https";
import { loadCachedDataFromDB, autoRefreshIfStale, fetchGVZData, fetchCOTData, fetchSGEData } from "./data-fetcher";
import { storage } from "./storage";
import { autoConnectAndTrade } from "./routes";
import { startGoldviewfxScheduler } from "./goldviewfx-fetcher";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { startWatchdog } from "./system-watchdog";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const jsonStr = JSON.stringify(capturedJsonResponse);
        logLine += ` :: ${jsonStr.length > 500 ? jsonStr.substring(0, 500) + '...[truncated]' : jsonStr}`;
      }

      log(logLine);
    }
  });

  next();
});

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});



(async () => {
  await setupAuth(app);
  registerAuthRoutes(app);

  const authExemptPaths = ["/api/login", "/api/logout", "/api/callback", "/api/auth/user", "/healthz", "/api/internal/batch-backtest", "/api/internal/seed-strategies"];
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api") || authExemptPaths.includes(req.path)) {
      return next();
    }
    return isAuthenticated(req, res, next);
  });

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  const shutdown = () => {
    log("Shutting down gracefully...");
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };

  if (process.env.NODE_ENV === "production") {
    process.on("SIGTERM", () => {
      log("SIGTERM received in production — ignoring to stay alive", "keepalive");
    });
  } else {
    process.on("SIGTERM", shutdown);
  }
  process.on("SIGINT", shutdown);

  process.on("unhandledRejection", (reason: any) => {
    console.error("[unhandledRejection] Caught unhandled promise rejection:", reason?.message || reason);
  });

  process.on("uncaughtException", (err: any) => {
    console.error("[uncaughtException] Caught uncaught exception:", err?.message || err);
  });

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      loadCachedDataFromDB()
        .then(async (counts) => {
          log(`Price DB loaded: ${counts.m1} M1, ${counts.m15} M15, ${counts.h1} H1, ${counts.h4} H4, ${counts.daily} Daily candles`, "startup");
          try {
            await storage.seedHistoricalTrades();
            await storage.seedCuratedStrategies();
          } catch (err: any) {
            console.error("[seed] Failed to seed data:", err.message);
          }
          const refreshed = await autoRefreshIfStale();
          if (refreshed) {
            log(`Auto-refresh complete — data updated to latest`, "startup");
          }
          try {
            await fetchGVZData();
            log(`GVZ data loaded`, "startup");
          } catch (err: any) {
            log(`GVZ fetch failed: ${err.message}`, "startup");
          }
          try {
            await fetchCOTData();
            log(`COT data loaded`, "startup");
          } catch (err: any) {
            log(`COT fetch failed: ${err.message}`, "startup");
          }
          try {
            await fetchSGEData();
            log(`SGE premium data loaded`, "startup");
          } catch (err: any) {
            log(`SGE fetch failed: ${err.message}`, "startup");
          }
        })
        .catch((err: any) => {
          log(`Failed to load/refresh price data: ${err.message}`, "startup");
        })
        .finally(async () => {
          const STARTUP_DELAY = process.env.NODE_ENV === "production" ? 60_000 : 5_000;
          console.log(`[auto-connect] Waiting ${STARTUP_DELAY / 1000}s before first connection attempt...`);
          setTimeout(async () => {
            try {
              await autoConnectAndTrade();
            } catch (err: any) {
              log(`Auto-connect failed: ${err.message}`, "startup");
            }
          }, STARTUP_DELAY);
          startGoldviewfxScheduler();
          startWatchdog();

          const DATA_REFRESH_INTERVAL = 60 * 60 * 1000;
          setInterval(async () => {
            try {
              const refreshed = await autoRefreshIfStale();
              if (refreshed) {
                log("Periodic data refresh complete — candle data updated", "auto-refresh");
              }
            } catch (err: any) {
              log(`Periodic data refresh failed: ${err.message}`, "auto-refresh");
            }
          }, DATA_REFRESH_INTERVAL);
        });

      if (process.env.NODE_ENV === "production") {
        const KEEPALIVE_INTERVAL = 4 * 60 * 1000;
        const domain = process.env.REPLIT_DOMAINS || process.env.REPL_SLUG;
        if (domain) {
          const pingUrl = `https://${domain}/healthz`;
          setInterval(() => {
            https.get(pingUrl, (res) => {
              res.resume();
              log(`Keepalive ping OK (uptime: ${Math.floor(process.uptime())}s)`, "keepalive");
            }).on("error", (err) => {
              log(`Keepalive ping failed: ${err.message}`, "keepalive");
            });
          }, KEEPALIVE_INTERVAL);
          log(`External keepalive started: ${pingUrl} (every 4 min)`, "startup");
        } else {
          log("WARNING: No REPLIT_DOMAINS found, keepalive disabled", "startup");
        }
      }
    },
  );
})();
