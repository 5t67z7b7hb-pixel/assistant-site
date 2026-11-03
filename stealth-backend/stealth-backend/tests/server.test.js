import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import DodoPayments from "dodopayments";
import { Webhook } from "standardwebhooks";
import { createApp } from "../server.js";

const webhookKey = `whsec_${randomBytes(32).toString("base64")}`;

function createFakeDodo() {
  const verifier = new DodoPayments({
    bearerToken: "test-key",
    environment: "test_mode",
    webhookKey,
  });
  const fakeDodo = {
    checkoutPayload: null,
    checkoutSessions: {
      create: async (payload) => {
        fakeDodo.checkoutPayload = payload;
        return {
          checkout_url: "https://checkout.example.test/session",
          session_id: "cks_test_123",
        };
      },
    },
    webhooks: verifier.webhooks,
  };
  return fakeDodo;
}

function signEvent(event, id) {
  const body = JSON.stringify(event);
  const timestamp = new Date();
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "webhook-signature": new Webhook(webhookKey).sign(id, timestamp, body),
    },
  };
}

describe("Dodo subscription API", () => {
  let db;
  let app;
  let server;
  let baseUrl;
  let fakeDodo;

  beforeEach(async () => {
    db = createClient({ url: "file::memory:" });
    fakeDodo = createFakeDodo();
    const service = createApp({
      env: {
        DODO_PAYMENTS_API_KEY: "test-api-key",
        DODO_PAYMENTS_WEBHOOK_KEY: webhookKey,
        DODO_PAYMENTS_ENVIRONMENT: "test_mode",
        DODO_PRODUCT_ID: "pdt_monthly_999",
        DODO_RETURN_URL: "https://site.example.test/billing/complete",
        TURSO_DATABASE_URL: "libsql://test.turso.io",
        TURSO_AUTH_TOKEN: "test-turso-token",
        APP_ALLOWED_ORIGINS: "https://site.example.test",
      },
      db,
      dodo: fakeDodo,
    });
    app = service.app;
    await service.initialize();
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (db) await db.close();
  });

  async function checkout(email = "customer@example.com") {
    const response = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://site.example.test",
      },
      body: JSON.stringify({ email }),
    });
    return { response, result: await response.json() };
  }

  async function sendEvent(type, data, id, timestamp = new Date()) {
    const event = { type, timestamp: timestamp.toISOString(), data };
    const signed = signEvent(event, id);
    return fetch(`${baseUrl}/webhooks/dodo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signed.headers },
      body: signed.body,
    });
  }

  async function entitlement(token) {
    const response = await fetch(`${baseUrl}/api/entitlements`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { response, result: await response.json() };
  }

  it("requests a seven-day Dodo trial and returns hosted checkout", async () => {
    const { response, result } = await checkout();
    assert.equal(response.status, 201);
    assert.equal(fakeDodo.checkoutPayload.subscription_data.trial_period_days, 7);
    assert.deepEqual(fakeDodo.checkoutPayload.product_cart, [
      { product_id: "pdt_monthly_999", quantity: 1 },
    ]);
    assert.equal(result.checkout_url, "https://checkout.example.test/session");
    assert.equal(result.session_id, "cks_test_123");
    assert.equal(typeof result.access_token, "string");
    assert.equal(result.access_token.length > 30, true);
  });

  it("reports not ready until Dodo and Turso configuration exists", async () => {
    const disabled = createApp({ env: {}, db: null, dodo: null });
    const unavailableServer = disabled.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => unavailableServer.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${unavailableServer.address().port}`;
      const health = await fetch(`${url}/health`);
      assert.equal(health.status, 503);
      assert.deepEqual(await health.json(), {
        status: "not_ready",
        billing_configured: false,
      });
      const checkoutResponse = await fetch(`${url}/api/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "customer@example.com" }),
      });
      assert.equal(checkoutResponse.status, 503);
    } finally {
      unavailableServer.closeAllConnections();
      await new Promise((resolve, reject) =>
        unavailableServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects invalid and duplicate email addresses", async () => {
    const invalid = await checkout("not-an-email");
    assert.equal(invalid.response.status, 400);
    assert.equal((await checkout()).response.status, 201);
    assert.equal((await checkout("CUSTOMER@example.com")).response.status, 409);
  });

  it("denies access until a signed active subscription webhook arrives", async () => {
    const { result: checkoutResult } = await checkout();
    const pending = await entitlement(checkoutResult.access_token);
    assert.equal(pending.response.status, 200);
    assert.equal(pending.result.entitled, false);

    const row = await db.execute("SELECT id FROM accounts WHERE email = ?", [
      "customer@example.com",
    ]);
    const activated = await sendEvent(
      "subscription.active",
      {
        subscription_id: "sub_trial_123",
        product_id: "pdt_monthly_999",
        status: "active",
        metadata: { app_account_id: row.rows[0].id },
      },
      "evt_active_1",
    );
    assert.equal(activated.status, 200);
    const active = await entitlement(checkoutResult.access_token);
    assert.equal(active.result.entitled, true);
    assert.equal(active.result.plan, "trial");
  });

  it("expires trial after seven days until a renewal arrives", async () => {
    const { result: checkoutResult } = await checkout();
    const row = await db.execute("SELECT id FROM accounts WHERE email = ?", [
      "customer@example.com",
    ]);
    const oldEvent = await sendEvent(
      "subscription.active",
      {
        subscription_id: "sub_expired_trial",
        product_id: "pdt_monthly_999",
        status: "active",
        metadata: { app_account_id: row.rows[0].id },
      },
      "evt_old_active",
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    assert.equal(oldEvent.status, 200);
    const expired = await entitlement(checkoutResult.access_token);
    assert.equal(expired.result.entitled, false);
  });

  it("restores paid access when an active subscription recovers after trial expiry", async () => {
    const { result: checkoutResult } = await checkout();
    const row = await db.execute("SELECT id FROM accounts WHERE email = ?", [
      "customer@example.com",
    ]);
    const trialStartedAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const subscription = {
      subscription_id: "sub_recovered",
      product_id: "pdt_monthly_999",
      status: "active",
      metadata: { app_account_id: row.rows[0].id },
    };
    await sendEvent(
      "subscription.active",
      subscription,
      "evt_trial_started",
      trialStartedAt,
    );
    const recoveryTime = new Date();
    const recovered = await sendEvent(
      "subscription.active",
      {
        ...subscription,
        next_billing_date: new Date(
          recoveryTime.getTime() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      "evt_subscription_recovered",
      recoveryTime,
    );
    assert.equal(recovered.status, 200);
    const current = await entitlement(checkoutResult.access_token);
    assert.equal(current.result.entitled, true);
    assert.equal(current.result.plan, "subscription");
  });

  it("extends access after a successful renewal and ignores duplicate webhook IDs", async () => {
    const { result: checkoutResult } = await checkout();
    const row = await db.execute("SELECT id FROM accounts WHERE email = ?", [
      "customer@example.com",
    ]);
    const subscription = {
      subscription_id: "sub_paid_123",
      product_id: "pdt_monthly_999",
      status: "active",
      metadata: { app_account_id: row.rows[0].id },
    };
    await sendEvent("subscription.active", subscription, "evt_paid_active");
    const renewal = {
      ...subscription,
      next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    assert.equal(
      (await sendEvent("subscription.renewed", renewal, "evt_renewed")).status,
      200,
    );
    const duplicate = await sendEvent("subscription.renewed", renewal, "evt_renewed");
    assert.equal((await duplicate.json()).duplicate, true);
    const current = await entitlement(checkoutResult.access_token);
    assert.equal(current.result.entitled, true);
    assert.equal(current.result.plan, "subscription");
  });

  it("rejects invalid webhook signatures", async () => {
    const response = await fetch(`${baseUrl}/webhooks/dodo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": "evt_invalid",
        "webhook-signature": "v1,invalid",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ type: "subscription.active", data: {} }),
    });
    assert.equal(response.status, 401);
  });

  it("rejects untrusted origins", async () => {
    const response = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ email: "customer@example.com" }),
    });
    assert.equal(response.status, 403);
  });

  it("revokes access on hold and prevents stale webhook resurrection", async () => {
    const { result: checkoutResult } = await checkout();
    const row = await db.execute("SELECT id FROM accounts WHERE email = ?", [
      "customer@example.com",
    ]);
    const now = new Date();
    const subscription = {
      subscription_id: "sub_on_hold",
      product_id: "pdt_monthly_999",
      metadata: { app_account_id: row.rows[0].id },
    };
    await sendEvent(
      "subscription.active",
      { ...subscription, status: "active" },
      "evt_before_hold",
      new Date(now.getTime() - 2 * 60 * 1000),
    );
    await sendEvent(
      "subscription.on_hold",
      { ...subscription, status: "on_hold" },
      "evt_on_hold",
      now,
    );
    const stale = await sendEvent(
      "subscription.active",
      { ...subscription, status: "active" },
      "evt_stale_active",
      new Date(now.getTime() - 60 * 1000),
    );
    assert.equal((await stale.json()).stale, true);
    const current = await entitlement(checkoutResult.access_token);
    assert.equal(current.result.entitled, false);
    assert.equal(current.result.subscription_status, "on_hold");
  });

  it("revokes access when the subscription changes to a different product", async () => {
    const { result: checkoutResult } = await checkout();
    const row = await db.execute("SELECT id FROM accounts WHERE email = ?", [
      "customer@example.com",
    ]);
    const subscription = {
      subscription_id: "sub_plan_change",
      product_id: "pdt_monthly_999",
      status: "active",
      metadata: { app_account_id: row.rows[0].id },
    };
    await sendEvent("subscription.active", subscription, "evt_product_start");
    const changed = await sendEvent(
      "subscription.plan_changed",
      { ...subscription, product_id: "pdt_other" },
      "evt_product_changed",
    );
    assert.equal(changed.status, 200);
    const current = await entitlement(checkoutResult.access_token);
    assert.equal(current.result.entitled, false);
  });

  it("acknowledges and deduplicates unrelated Dodo products", async () => {
    const response = await sendEvent(
      "subscription.active",
      {
        subscription_id: "sub_unrelated",
        product_id: "pdt_other",
        status: "active",
        metadata: {},
      },
      "evt_unrelated",
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).received, true);
    const duplicate = await sendEvent(
      "subscription.active",
      {
        subscription_id: "sub_unrelated",
        product_id: "pdt_other",
        status: "active",
        metadata: {},
      },
      "evt_unrelated",
    );
    assert.equal((await duplicate.json()).duplicate, true);
  });
});
