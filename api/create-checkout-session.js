// /api/create-checkout-session.js
import Stripe from "stripe";
import crypto from "crypto";

/** Allow these origins (add your custom domain when ready) */
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com" // replace when you have your domain
];
const allowOrigin = (req) =>
  ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : "https://hyeoks-site.webflow.io";

const SUCCESS_URL = "https://hyeoks-site.webflow.io/donate/success";
const CANCEL_URL  = "https://hyeoks-site.webflow.io/donate/cancel";

const ALLOWED = {
  modes: new Set(["payment", "subscription"]),
  currencies: new Set(["USD"]),
  intervals: new Set(["week", "month", "year"])
};

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", allowOrigin(req));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    const {
      mode = "payment",            // "payment" | "subscription"
      amount,                      // minor units (USD: 500 = $5.00)
      currency = "USD",
      // for subscriptions:
      interval = "month",          // "week" | "month" | "year"
      interval_count = 1,
      // optional from Webflow UI:
      prayer_request = ""
    } = req.body || {};

    // --- SERVER-SIDE VALIDATION ---
    if (!ALLOWED.modes.has(mode))        return res.status(400).json({ error: "Invalid mode" });
    if (!ALLOWED.currencies.has(currency)) return res.status(400).json({ error: "Invalid currency" });
    if (!ALLOWED.intervals.has(interval))  return res.status(400).json({ error: "Invalid interval" });
    if (!Number.isInteger(interval_count) || interval_count < 1 || interval_count > 12)
      return res.status(400).json({ error: "Invalid interval_count" });

    // SIN TOPE SUPERIOR: aceptar donaciones altas
    if (!Number.isInteger(amount) || amount < 1)
      return res.status(400).json({ error: "Invalid amount" });

    // Sanitize & cap prayer (140 chars por UX, no afecta montos)
    const cleanPrayer = String(prayer_request || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 140);

    // success_url con session id (lado servidor, no confiamos en el cliente)
    const success = `${SUCCESS_URL}${SUCCESS_URL.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;

    // Metadata común
    const baseMetadata = {
      source: "webflow",
      gift_type: mode === "payment" ? "one-time" : "monthly",
      ...(cleanPrayer ? { prayer_request: cleanPrayer } : {})
    };

    // Config base de Checkout
    const base = {
      mode,
      success_url: success,
      cancel_url: CANCEL_URL,
      billing_address_collection: "auto",
      // Campo visible en Checkout (tu "Full name")
      custom_fields: [
        {
          key: "full_name",
          label: { type: "custom", custom: "Full name" },
          type: "text",
          optional: false,
          text: { minimum_length: 1, maximum_length: 120 }
        }
      ],
      metadata: baseMetadata,
      submit_type: "donate"
      // No fijamos payment_method_types; Stripe mostrará Apple/Google Pay, Link,
      // PayPal, Amazon Pay, Crypto, etc., según disponibilidad y Dashboard.
    };

    // Idempotencia
    const idemKey = req.headers["idempotency-key"] || crypto.randomUUID();

    // ---- ONE-TIME ----
    if (mode === "payment") {
      const session = await stripe.checkout.sessions.create({
        ...base,
        customer_creation: "always",
        payment_intent_data: { metadata: baseMetadata },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amount,
              product_data: { name: "One-time donation" }
            }
          }
        ]
      }, { idempotencyKey: idemKey });

      return res.status(200).json({ url: session.url });
    }

    // ---- SUBSCRIPTION ----
    const session = await stripe.checkout.sessions.create({
      ...base,
      subscription_data: { metadata: baseMetadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: { name: "Recurring donation" },
            recurring: { interval, interval_count }
          }
        }
      ]
    }, { idempotencyKey: idemKey });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[Stripe error]", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}