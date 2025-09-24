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

/** Locales válidos como primer segmento de la ruta */
const ALLOWED_LOCALES = new Set(["en-us", "kr", "ja", "es", "pt-br"]);

/** Paths base (sin locale) */
const SUCCESS_PATH = "/donate/success";
const CANCEL_PATH  = "/payment";

/** Config permitida */
const ALLOWED = {
  modes: new Set(["payment", "subscription"]),
  currencies: new Set(["USD"]),          // si en el futuro habilitas otras, añádelas aquí
  intervals: new Set(["week", "month", "year"])
};

/** Detecta locale a partir del Referer (primer segmento de la ruta) */
function detectLocale(req) {
  try {
    const ref = req.headers.referer || req.headers.referrer;
    if (!ref) return null;
    const u = new URL(ref);
    // u.pathname p.ej.: "/kr/donate"  -> ["", "kr", "donate"]
    const segments = u.pathname.split("/").filter(Boolean);
    if (!segments.length) return null;
    const candidate = segments[0].toLowerCase();
    return ALLOWED_LOCALES.has(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Construye URL segura: origin + (locale? `/${locale}` : "") + path */
function buildUrl(origin, localeOrNull, path) {
  const base = new URL(origin);
  const prefix = localeOrNull ? `/${localeOrNull}` : "";
  // Asegura una sola barra
  base.pathname = `${prefix}${path}`.replace(/\/{2,}/g, "/");
  return base.toString();
}

/** Agrega el query param CHECKOUT_SESSION_ID a la success url */
function addSessionIdParam(urlStr) {
  const u = new URL(urlStr);
  u.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  return u.toString();
}

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
      prayer_request = "",
      locale: locale_hint
    } = req.body || {};

    // --- SERVER-SIDE VALIDATION ---
    if (!ALLOWED.modes.has(mode))           return res.status(400).json({ error: "Invalid mode" });
    if (!ALLOWED.currencies.has(currency))  return res.status(400).json({ error: "Invalid currency" });
    if (!ALLOWED.intervals.has(interval))   return res.status(400).json({ error: "Invalid interval" });
    if (!Number.isInteger(interval_count) || interval_count < 1 || interval_count > 12)
      return res.status(400).json({ error: "Invalid interval_count" });

    // Sin tope superior: aceptar donaciones altas
    if (!Number.isInteger(amount) || amount < 1)
      return res.status(400).json({ error: "Invalid amount" });

    // Sanitizar prayer (máx 140 chars por UX)
    const cleanPrayer = String(prayer_request || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 140);

    // === Locale-aware success/cancel (no confiamos en el cliente) ===
    const origin = allowOrigin(req);
    // Prefer a validated client-provided locale hint; fallback to Referer
    const hinted = (typeof locale_hint === "string" ? locale_hint.toLowerCase() : null);
    const locale = hinted && ALLOWED_LOCALES.has(hinted) ? hinted : detectLocale(req);
    const successUrl = addSessionIdParam(buildUrl(origin, locale, SUCCESS_PATH));
    const cancelUrl  = buildUrl(origin, locale, CANCEL_PATH);

    // Metadata común
    const baseMetadata = {
      source: "webflow",
      gift_type: mode === "payment" ? "one-time" : "monthly",
      ...(cleanPrayer ? { prayer_request: cleanPrayer } : {})
    };

    // Config base de Checkout
    const base = {
      mode,
      success_url: successUrl,
      cancel_url: cancelUrl,
      billing_address_collection: "auto",
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