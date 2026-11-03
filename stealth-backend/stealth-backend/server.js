import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import DodoPayments from "dodopayments";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";

const TRIAL_DAYS = 7;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SUBSCRIPTION_EVENTS = new Map([
  ["subscription.active", "active"],
  ["subscription.updated", null],
  ["subscription.past_due", "past_due"],
  ["subscription.on_hold", "on_hold"],
  ["subscription.paused", "paused"],
  ["subscription.unpaused", "active"],
  ["subscription.renewed", "active"],
  ["subscription.plan_changed", null],
  ["subscription.cancelled", "cancelled"],
  ["subscription.failed", "failed"],
  ["subscription.expired", "expired"],
]);
const ALLOWED_STATUSES = new Set([
  "pending",
  "active",
  "past_due",
  "on_hold",
  "paused",
  "cancelled",
  "failed",
  "expired",
]);

function logFailure(message, error) {
  const reason = error?.code ?? error?.name ?? "unknown error";
  console.error(`${message} (${String(reason).slice(0, 80)})`);
}

function getHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function classifyCheckoutError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const rawCode = error?.error?.code ?? error?.code;
  const providerCode =
    typeof rawCode === "string" && /^[a-z0-9_.-]{1,80}$/i.test(rawCode)
      ? rawCode
      : null;
  const failure = (code, message) => ({ code, message, providerCode });

  if (status === 401) {
    return failure(
      "DODO_AUTHENTICATION",
      "Dodo rejected the API credentials. Verify the key and its test/live mode.",
    );
  }
  if (status === 403) {
    return failure(
      "DODO_PERMISSION",
      "The Dodo API key does not have permission to create checkout sessions.",
    );
  }
  if (status === 404) {
    return failure(
      "DODO_PRODUCT_NOT_FOUND",
      "Dodo could not find this product in the configured account and mode.",
    );
  }
  if (status === 400 || status === 422) {
    return failure(
      "DODO_CHECKOUT_REJECTED",
      "Dodo rejected the checkout configuration. Verify the product is a subscription and supports this trial.",
    );
  }
  if (status === 429) {
    return failure(
      "DODO_RATE_LIMITED",
      "Dodo is rate-limiting checkout requests. Wait and try again.",
    );
  }
  if (status !== null && status >= 500) {
    return failure("DODO_UNAVAILABLE", "Dodo encountered a server error. Retry later.");
  }
  if (error?.name === "APIConnectionError" || error?.name === "APIConnectionTimeoutError") {
    return failure(
      "DODO_CONNECTION",
      "The backend could not connect to Dodo. Check the service network and retry.",
    );
  }
  return failure(
    "CHECKOUT_PROVIDER_ERROR",
    "Checkout could not be created. Use the reference when checking backend logs.",
  );
}

function parseDate(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateIso(value) {
  const parsed = parseDate(value);
  return parsed ? parsed.toISOString() : null;
}

function getConfig(env) {
  const allowedOrigins = new Set(
    (env.APP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
  const environment = env.DODO_PAYMENTS_ENVIRONMENT ?? "test_mode";
  if (!["live_mode", "test_mode"].includes(environment)) {
    throw new Error("DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode");
  }
  const tursoUrl = env.TURSO_DATABASE_URL ?? "";
  if (
    tursoUrl &&
    !tursoUrl.startsWith("libsql://") &&
    !tursoUrl.startsWith("https://")
  ) {
    throw new Error("TURSO_DATABASE_URL must use libsql:// or https://");
  }
  const returnUrl = env.DODO_RETURN_URL ?? "";
  let validReturnUrl = false;
  try {
    validReturnUrl = new URL(returnUrl).protocol === "https:";
  } catch {
    validReturnUrl = false;
  }

  return {
    apiKey: env.DODO_PAYMENTS_API_KEY ?? "",
    webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY ?? "",
    productId: env.DODO_PRODUCT_ID ?? "",
    returnUrl,
    returnUrlReady: validReturnUrl,
    environment,
    tursoUrl,
    tursoAuthToken: env.TURSO_AUTH_TOKEN ?? "",
    allowedOrigins,
  };
}

function isBillingConfigured(config) {
  return Boolean(
    config.apiKey &&
      config.webhookKey &&
      config.productId &&
      config.returnUrlReady &&
      config.tursoUrl &&
      config.tursoAuthToken,
  );
}

function createTursoClient(config) {
  if (!config.tursoUrl || !config.tursoAuthToken) return null;
  return createClient({
    url: config.tursoUrl,
    authToken: config.tursoAuthToken,
  });
}

function createDodoClient(config) {
  if (!config.apiKey || !config.webhookKey) return null;
  return new DodoPayments({
    bearerToken: config.apiKey,
    environment: config.environment,
    webhookKey: config.webhookKey,
  });
}

async function initializeDatabase(db) {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS subscriptions (
        subscription_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        product_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trial_ends_at TEXT,
        paid_through TEXT,
        grace_ends_at TEXT,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        last_event_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS device_trials (
        device_id_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
        trial_claimed_at TEXT,
        pending_mode TEXT,
        pending_started_at TEXT,
        pending_checkout_url TEXT,
        pending_session_id TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS webhook_events (
        webhook_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS subscriptions_account_idx ON subscriptions(account_id, last_event_at)",
    ],
    "write",
  );
}

function findCurrentEntitlement(rows, productId, now = Date.now()) {
  for (const subscription of rows) {
    if (subscription.product_id !== productId) continue;
    const trialEnd = parseDate(subscription.trial_ends_at);
    const paidThrough = parseDate(subscription.paid_through);
    const graceEnd = parseDate(subscription.grace_ends_at);
    const { status } = subscription;

    if (status === "active" && paidThrough && now < paidThrough.getTime()) {
      return {
        entitled: true,
        plan: "subscription",
        subscription_status: status,
        access_ends_at: paidThrough.toISOString(),
      };
    }
    if (status === "active" && trialEnd && now < trialEnd.getTime()) {
      return {
        entitled: true,
        plan: "trial",
        subscription_status: status,
        access_ends_at: trialEnd.toISOString(),
      };
    }
    if (status === "past_due" && graceEnd && now < graceEnd.getTime()) {
      return {
        entitled: true,
        plan: "payment_grace",
        subscription_status: status,
        access_ends_at: graceEnd.toISOString(),
      };
    }
    if (
      status === "cancelled" &&
      Number(subscription.cancel_at_period_end) === 1 &&
      paidThrough &&
      now < paidThrough.getTime()
    ) {
      return {
        entitled: true,
        plan: "subscription",
        subscription_status: status,
        access_ends_at: paidThrough.toISOString(),
      };
    }
  }
  return {
    entitled: false,
    plan: "inactive",
    subscription_status: rows[0]?.status ?? "pending",
    access_ends_at: null,
  };
}

function createApp(options = {}) {
  const config = getConfig(options.env ?? process.env);
  const db = options.db ?? createTursoClient(config);
  const dodo = options.dodo ?? createDodoClient(config);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.path.startsWith("/api/") || req.path === "/webhooks/dodo") {
      res.setHeader("Cache-Control", "no-store");
    }

    const origin = req.get("Origin");
    if (origin && req.path.startsWith("/api/")) {
      const normalizedOrigin = origin.replace(/\/+$/, "");
      if (!config.allowedOrigins.has(normalizedOrigin)) {
        return res.status(403).json({ error: "Origin is not allowed" });
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS" && req.path.startsWith("/api/")) {
      return res.status(204).end();
    }
    return next();
  });

  const checkoutLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many checkout attempts. Try again later." },
  });

  app.get("/health", (_req, res) => {
    const ready = Boolean(isBillingConfigured(config) && db && dodo);
    return res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "not_ready",
      billing_configured: ready,
    });
  });

  app.post(
    "/api/billing/checkout",
    checkoutLimiter,
    express.json({ limit: "16kb", strict: true }),
    async (req, res) => {
      if (!isBillingConfigured(config) || !db || !dodo) {
        return res.status(503).json({
          error: "Subscription checkout is not configured",
        });
      }

      const email =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: "A valid email address is required" });
      }

      const accountId = randomUUID();
      const accessToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(accessToken).digest("hex");
      const createdAt = new Date().toISOString();
      try {
        await db.execute({
          sql: "INSERT INTO accounts (id, email, token_hash, created_at) VALUES (?, ?, ?, ?)",
          args: [accountId, email, tokenHash, createdAt],
        });
      } catch (error) {
        if (
          error?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
          error?.extendedCode === "SQLITE_CONSTRAINT_UNIQUE"
        ) {
          return res
            .status(409)
            .json({ error: "An account already exists for this email" });
        }
        logFailure("Could not save billing account", error);
        return res.status(500).json({ error: "Unable to start checkout" });
      }

      try {
        const session = await dodo.checkoutSessions.create({
          product_cart: [{ product_id: config.productId, quantity: 1 }],
          subscription_data: { trial_period_days: TRIAL_DAYS },
          customer: { email },
          metadata: { app_account_id: accountId },
          return_url: config.returnUrl,
        });
        if (
          typeof session.checkout_url !== "string" ||
          !session.checkout_url.startsWith("https://") ||
          typeof session.session_id !== "string" ||
          !session.session_id
        ) {
          console.error("Dodo returned an invalid checkout session");
          try {
            await db.execute({
              sql: "DELETE FROM accounts WHERE id = ? AND token_hash = ?",
              args: [accountId, tokenHash],
            });
          } catch (cleanupError) {
            logFailure("Could not remove invalid-checkout account", cleanupError);
          }
          return res.status(502).json({ error: "Invalid checkout session from provider" });
        }
        return res.status(201).json({
          checkout_url: session.checkout_url,
          session_id: session.session_id,
          access_token: accessToken,
          token_storage: "Store this token securely; it cannot be recovered.",
        });
      } catch (error) {
        try {
          await db.execute({
            sql: "DELETE FROM accounts WHERE id = ? AND token_hash = ?",
            args: [accountId, tokenHash],
          });
        } catch (cleanupError) {
          logFailure("Could not remove failed-checkout account", cleanupError);
        }
        const reference = randomUUID();
        const diagnosis = classifyCheckoutError(error);
        const providerRequestId =
          getHeader(error?.headers, "x-request-id") ??
          getHeader(error?.headers, "request-id");
        console.error(
          JSON.stringify({
            event: "dodo_checkout_failed",
            reference,
            code: diagnosis.code,
            provider_status: Number.isInteger(error?.status) ? error.status : null,
            provider_code: diagnosis.providerCode ?? null,
            provider_request_id:
              typeof providerRequestId === "string"
                ? providerRequestId.slice(0, 100)
                : null,
            environment: config.environment,
          }),
        );
        return res.status(502).json({
          error: diagnosis.message,
          code: diagnosis.code,
          reference,
          ...(Number.isInteger(error?.status)
            ? { provider_status: error.status }
            : {}),
          ...(diagnosis.providerCode ? { provider_code: diagnosis.providerCode } : {}),
        });
      }
    },
  );

  app.post(
    "/api/billing/device-checkout",
    checkoutLimiter,
    express.json({ limit: "16kb", strict: true }),
    async (req, res) => {
      if (!isBillingConfigured(config) || !db || !dodo) {
        return res.status(503).json({
          error: "Subscription checkout is not configured",
        });
      }

      const submittedDeviceId =
        typeof req.body?.device_id === "string" ? req.body.device_id : "";
      const mode = req.body?.mode;
      const email =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(submittedDeviceId)) {
        return res.status(400).json({ error: "A valid device identifier is required" });
      }
      if (mode !== "trial" && mode !== "subscription") {
        return res.status(400).json({ error: "A valid checkout mode is required" });
      }
      if (!EMAIL_PATTERN.test(email)) {
        return res.status(400).json({ error: "A valid billing email is required" });
      }

      const deviceIdHash = createHash("sha256").update(submittedDeviceId).digest("hex");
      const now = new Date().toISOString();
      const accessToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(accessToken).digest("hex");
      let tx;
      let accountId;
      let device;
      let createdDevice = false;
      let claimedTrialNow = false;
      let checkoutMode = mode;

      try {
        tx = await db.transaction("write");
        const deviceResult = await tx.execute({
          sql: "SELECT * FROM device_trials WHERE device_id_hash = ?",
          args: [deviceIdHash],
        });
        device = deviceResult.rows[0] ?? null;

        if (device) {
          accountId = device.account_id;
          const subscriptions = await tx.execute({
            sql: `SELECT product_id, status, trial_ends_at, paid_through, grace_ends_at,
                         cancel_at_period_end
                  FROM subscriptions
                  WHERE account_id = ?
                  ORDER BY last_event_at DESC`,
            args: [accountId],
          });
          const entitlement = findCurrentEntitlement(
            subscriptions.rows,
            config.productId,
          );
          await tx.execute({
            sql: "UPDATE accounts SET token_hash = ? WHERE id = ?",
            args: [tokenHash, accountId],
          });

          if (entitlement.entitled) {
            await tx.commit();
            return res.json({ ...entitlement, access_token: accessToken });
          }
          if (device.pending_checkout_url) {
            await tx.commit();
            return res.json({
              checkout_url: device.pending_checkout_url,
              session_id: device.pending_session_id,
              mode: device.pending_mode,
              access_token: accessToken,
            });
          }
          if (device.pending_mode === "creating") {
            const pendingStartedAt = parseDate(device.pending_started_at);
            if (
              pendingStartedAt &&
              Date.now() - pendingStartedAt.getTime() < 2 * 60 * 1000
            ) {
              await tx.rollback();
              return res.status(409).json({
                code: "CHECKOUT_IN_PROGRESS",
                error: "Checkout is being prepared. Try again shortly.",
              });
            }
          }
          if (
            mode === "trial" &&
            (device.trial_claimed_at || subscriptions.rows.length > 0)
          ) {
            await tx.commit();
            return res.status(409).json({
              code: "TRIAL_ALREADY_USED",
              error: "This device has already used its free trial.",
              access_token: accessToken,
            });
          }

          claimedTrialNow = mode === "trial" && !device.trial_claimed_at;
          checkoutMode = mode;
          await tx.execute({
            sql: `UPDATE device_trials
                  SET trial_claimed_at = CASE
                        WHEN ? = 1 THEN ?
                        ELSE trial_claimed_at
                      END,
                      pending_mode = ?,
                      pending_started_at = ?
                  WHERE device_id_hash = ?`,
            args: [claimedTrialNow ? 1 : 0, now, mode, now, deviceIdHash],
          });
        } else {
          accountId = randomUUID();
          const internalEmail = `device-${deviceIdHash}@device.lightning.invalid`;
          await tx.execute({
            sql: "INSERT INTO accounts (id, email, token_hash, created_at) VALUES (?, ?, ?, ?)",
            args: [accountId, internalEmail, tokenHash, now],
          });
          await tx.execute({
            sql: `INSERT INTO device_trials (
                    device_id_hash, account_id, trial_claimed_at, pending_mode,
                    pending_started_at, pending_checkout_url, pending_session_id,
                    created_at
                  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
            args: [
              deviceIdHash,
              accountId,
              mode === "trial" ? now : null,
              mode,
              now,
              now,
            ],
          });
          createdDevice = true;
          claimedTrialNow = mode === "trial";
        }
        await tx.commit();
      } catch (error) {
        if (tx) {
          try {
            await tx.rollback();
          } catch (rollbackError) {
            logFailure("Could not roll back device checkout reservation", rollbackError);
          }
        }
        logFailure("Could not reserve device checkout", error);
        return res.status(500).json({ error: "Unable to start checkout" });
      } finally {
        if (tx) await tx.close();
      }

      try {
        const session = await dodo.checkoutSessions.create({
          product_cart: [{ product_id: config.productId, quantity: 1 }],
          ...(checkoutMode === "trial"
            ? { subscription_data: { trial_period_days: TRIAL_DAYS } }
            : {}),
          customer: { email },
          metadata: { app_account_id: accountId },
          return_url: config.returnUrl,
        });
        if (
          typeof session.checkout_url !== "string" ||
          !session.checkout_url.startsWith("https://") ||
          typeof session.session_id !== "string" ||
          !session.session_id
        ) {
          console.error("Dodo returned an invalid device checkout session");
          throw new Error("Invalid checkout session");
        }
        await db.execute({
          sql: `UPDATE device_trials
                SET pending_started_at = NULL,
                    pending_checkout_url = ?,
                    pending_session_id = ?
                WHERE device_id_hash = ? AND account_id = ?`,
          args: [session.checkout_url, session.session_id, deviceIdHash, accountId],
        });
        return res.status(201).json({
          checkout_url: session.checkout_url,
          session_id: session.session_id,
          mode: checkoutMode,
          access_token: accessToken,
          token_storage: "Store this token securely; it cannot be recovered.",
        });
      } catch (error) {
        try {
          if (createdDevice) {
            await db.batch(
              [
                {
                  sql: "DELETE FROM device_trials WHERE device_id_hash = ? AND account_id = ?",
                  args: [deviceIdHash, accountId],
                },
                {
                  sql: "DELETE FROM accounts WHERE id = ? AND token_hash = ?",
                  args: [accountId, tokenHash],
                },
              ],
              "write",
            );
          } else {
            await db.execute({
              sql: `UPDATE device_trials
                    SET trial_claimed_at = CASE
                          WHEN ? = 1 THEN NULL
                          ELSE trial_claimed_at
                        END,
                        pending_mode = NULL,
                        pending_started_at = NULL,
                        pending_checkout_url = NULL,
                        pending_session_id = NULL
                    WHERE device_id_hash = ? AND account_id = ?`,
              args: [claimedTrialNow ? 1 : 0, deviceIdHash, accountId],
            });
          }
        } catch (cleanupError) {
          logFailure("Could not clear failed device checkout", cleanupError);
        }
        const reference = randomUUID();
        const diagnosis = classifyCheckoutError(error);
        const providerRequestId =
          getHeader(error?.headers, "x-request-id") ??
          getHeader(error?.headers, "request-id");
        console.error(
          JSON.stringify({
            event: "dodo_device_checkout_failed",
            reference,
            code: diagnosis.code,
            provider_status: Number.isInteger(error?.status) ? error.status : null,
            provider_code: diagnosis.providerCode ?? null,
            provider_request_id:
              typeof providerRequestId === "string"
                ? providerRequestId.slice(0, 100)
                : null,
            environment: config.environment,
          }),
        );
        return res.status(502).json({
          error: diagnosis.message,
          code: diagnosis.code,
          reference,
          ...(Number.isInteger(error?.status)
            ? { provider_status: error.status }
            : {}),
          ...(diagnosis.providerCode ? { provider_code: diagnosis.providerCode } : {}),
        });
      }
    },
  );

  app.get("/api/entitlements", async (req, res) => {
    if (!db || !config.productId) {
      return res.status(503).json({ error: "Entitlement service is not configured" });
    }
    const authorization = req.get("Authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) {
      return res.status(401).json({ error: "A bearer access token is required" });
    }

    const tokenHash = createHash("sha256").update(match[1]).digest("hex");
    try {
      const accountResult = await db.execute({
        sql: "SELECT id FROM accounts WHERE token_hash = ?",
        args: [tokenHash],
      });
      const account = accountResult.rows[0];
      if (!account) {
        return res.status(401).json({ error: "Invalid access token" });
      }
      const result = await db.execute({
        sql: `SELECT product_id, status, trial_ends_at, paid_through, grace_ends_at,
                     cancel_at_period_end
              FROM subscriptions
              WHERE account_id = ?
              ORDER BY last_event_at DESC`,
        args: [account.id],
      });
      const now = Date.now();
      for (const subscription of result.rows) {
        if (subscription.product_id !== config.productId) continue;
        const trialEnd = parseDate(subscription.trial_ends_at);
        const paidThrough = parseDate(subscription.paid_through);
        const graceEnd = parseDate(subscription.grace_ends_at);
        const status = subscription.status;

        if (status === "active" && paidThrough && now < paidThrough.getTime()) {
          return res.json({
            entitled: true,
            plan: "subscription",
            subscription_status: status,
            access_ends_at: paidThrough.toISOString(),
          });
        }
        if (status === "active" && trialEnd && now < trialEnd.getTime()) {
          return res.json({
            entitled: true,
            plan: "trial",
            subscription_status: status,
            access_ends_at: trialEnd.toISOString(),
          });
        }
        if (status === "past_due" && graceEnd && now < graceEnd.getTime()) {
          return res.json({
            entitled: true,
            plan: "payment_grace",
            subscription_status: status,
            access_ends_at: graceEnd.toISOString(),
          });
        }
        if (
          status === "cancelled" &&
          Number(subscription.cancel_at_period_end) === 1 &&
          paidThrough &&
          now < paidThrough.getTime()
        ) {
          return res.json({
            entitled: true,
            plan: "subscription",
            subscription_status: status,
            access_ends_at: paidThrough.toISOString(),
          });
        }
      }

      return res.json({
        entitled: false,
        plan: "inactive",
        subscription_status: result.rows[0]?.status ?? "pending",
        access_ends_at: null,
      });
    } catch (error) {
      logFailure("Entitlement lookup failed", error);
      return res.status(503).json({ error: "Unable to check access right now" });
    }
  });

  app.post(
    "/webhooks/dodo",
    express.raw({ type: "application/json", limit: "16kb" }),
    async (req, res) => {
      if (!config.apiKey || !config.webhookKey || !db || !dodo) {
        return res.status(503).json({ error: "Webhook processing is not configured" });
      }
      const webhookId = req.get("webhook-id");
      if (!webhookId) {
        return res.status(400).json({ error: "Missing webhook-id header" });
      }
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: "Expected an application/json payload" });
      }

      let event;
      try {
        event = await dodo.webhooks.unwrap(req.body.toString("utf8"), {
          headers: {
            "webhook-id": webhookId,
            "webhook-signature": req.get("webhook-signature") ?? "",
            "webhook-timestamp": req.get("webhook-timestamp") ?? "",
          },
        });
      } catch (error) {
        logFailure("Dodo webhook signature verification failed", error);
        return res.status(401).json({ error: "Invalid webhook signature" });
      }

      const eventType = event.type;
      if (!SUBSCRIPTION_EVENTS.has(eventType)) {
        return res.json({ received: true });
      }
      const data = event.data;
      const subscriptionId = data?.subscription_id;
      const productId = data?.product_id;
      const eventTime = parseDate(event.timestamp);
      const metadata = data?.metadata;
      let accountId =
        metadata && typeof metadata.app_account_id === "string"
          ? metadata.app_account_id
          : null;
      if (!subscriptionId || !productId || !eventTime) {
        return res.status(400).json({ error: "Invalid subscription event" });
      }

      let tx;
      try {
        tx = await db.transaction("write");
        const seen = await tx.execute({
          sql: "SELECT 1 FROM webhook_events WHERE webhook_id = ?",
          args: [webhookId],
        });
        if (seen.rows.length) {
          await tx.rollback();
          return res.json({ received: true, duplicate: true });
        }
        const previousResult = await tx.execute({
          sql: "SELECT * FROM subscriptions WHERE subscription_id = ?",
          args: [subscriptionId],
        });
        const previous = previousResult.rows[0];
        if (productId !== config.productId && !previous) {
          await tx.execute({
            sql: "INSERT INTO webhook_events (webhook_id, received_at) VALUES (?, ?)",
            args: [webhookId, new Date().toISOString()],
          });
          await tx.commit();
          return res.json({ received: true });
        }
        accountId ??= previous?.account_id ?? null;
        if (!accountId) {
          await tx.rollback();
          return res
            .status(400)
            .json({ error: "Subscription event is missing app account metadata" });
        }
        const accountResult = await tx.execute({
          sql: "SELECT id FROM accounts WHERE id = ?",
          args: [accountId],
        });
        if (!accountResult.rows.length) {
          await tx.rollback();
          return res.status(400).json({ error: "Unknown app account" });
        }

        await tx.execute({
          sql: "INSERT INTO webhook_events (webhook_id, received_at) VALUES (?, ?)",
          args: [webhookId, new Date().toISOString()],
        });

        const previousTime = parseDate(previous?.last_event_at);
        if (previousTime && eventTime < previousTime) {
          await tx.commit();
          return res.json({ received: true, stale: true });
        }
        const mappedStatus = SUBSCRIPTION_EVENTS.get(eventType);
        const status = mappedStatus ?? data.status;
        if (!ALLOWED_STATUSES.has(status)) {
          await tx.rollback();
          return res.status(400).json({ error: "Unsupported subscription status" });
        }

        let trialEndsAt = previous?.trial_ends_at ?? null;
        let paidThrough = previous?.paid_through ?? null;
        let graceEndsAt = previous?.grace_ends_at ?? null;
        const cancelAtPeriodEnd =
          data.cancel_at_next_billing_date ??
          Boolean(previous?.cancel_at_period_end);
        const nextBillingDate = parseDate(data.next_billing_date);

        if (eventType === "subscription.active" && !trialEndsAt) {
          const expectedTrialEnd = new Date(
            eventTime.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
          );
          trialEndsAt = new Date(
            nextBillingDate
              ? Math.min(expectedTrialEnd.getTime(), nextBillingDate.getTime())
              : expectedTrialEnd.getTime(),
          ).toISOString();
        } else if (
          eventType === "subscription.active" &&
          trialEndsAt &&
          eventTime >= new Date(trialEndsAt) &&
          nextBillingDate
        ) {
          paidThrough = nextBillingDate.toISOString();
        }
        if (eventType === "subscription.renewed" && nextBillingDate) {
          paidThrough = nextBillingDate.toISOString();
          graceEndsAt = null;
        }
        if (eventType === "subscription.past_due") {
          graceEndsAt = dateIso(data.past_due_ends_at);
        }
        if (
          eventType === "subscription.cancelled" ||
          eventType === "subscription.expired"
        ) {
          paidThrough =
            cancelAtPeriodEnd && nextBillingDate
              ? nextBillingDate.toISOString()
              : null;
        }

        await tx.execute({
          sql: `INSERT INTO subscriptions (
                  subscription_id, account_id, product_id, status, trial_ends_at,
                  paid_through, grace_ends_at, cancel_at_period_end, last_event_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(subscription_id) DO UPDATE SET
                  account_id = excluded.account_id,
                  product_id = excluded.product_id,
                  status = excluded.status,
                  trial_ends_at = excluded.trial_ends_at,
                  paid_through = excluded.paid_through,
                  grace_ends_at = excluded.grace_ends_at,
                  cancel_at_period_end = excluded.cancel_at_period_end,
                  last_event_at = excluded.last_event_at`,
          args: [
            subscriptionId,
            accountId,
            productId,
            status,
            trialEndsAt,
            paidThrough,
            graceEndsAt,
            cancelAtPeriodEnd ? 1 : 0,
            eventTime.toISOString(),
          ],
        });
        await tx.execute({
          sql: `UPDATE device_trials
                SET pending_mode = NULL,
                    pending_started_at = NULL,
                    pending_checkout_url = NULL,
                    pending_session_id = NULL
                WHERE account_id = ?`,
          args: [accountId],
        });
        await tx.commit();
        return res.json({ received: true });
      } catch (error) {
        if (tx) {
          try {
            await tx.rollback();
          } catch (rollbackError) {
            logFailure("Could not roll back Dodo webhook transaction", rollbackError);
          }
        }
        logFailure("Could not process Dodo subscription webhook", error);
        return res.status(500).json({ error: "Unable to process webhook" });
      } finally {
        if (tx) await tx.close();
      }
    },
  );

  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large" });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    logFailure("Unhandled request error", error);
    return res.status(500).json({ error: "Internal server error" });
  });

  return { app, db, initialize: () => (db ? initializeDatabase(db) : Promise.resolve()) };
}

async function startServer() {
  const { app, db, initialize } = createApp();
  if (!db) {
    console.warn("Turso is not configured; database routes will remain unavailable.");
  } else {
    await initialize();
  }
  const port = Number(process.env.PORT ?? "4242");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }
  app.listen(port, "0.0.0.0", () => {
    console.log(`Lightning billing service listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    logFailure("Could not start billing service", error);
    process.exitCode = 1;
  });
}

export { createApp, getConfig, initializeDatabase, isBillingConfigured };
