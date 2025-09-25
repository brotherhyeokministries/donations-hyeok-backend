// /api/public-recent-donations.js
import Stripe from "stripe";

/**
 * SECURITY / CONFIG
 * - Uses env allowlist for CORS (fallback to your Webflow domain)
 * - Excludes test/demo emails via ENV (CSV)
 * - Shows only Checkout Sessions with payment_status === "paid"
 * - Honors metadata.public_consent === "true" unless SHOW_ALL_FOR_TEST=true
 * - Dedupes items by payment_intent || session id
 * - Proper currency formatting, including zero-decimal currencies
 */

const STRIPE_API_VERSION = "2024-06-20";

// ---- CORS allowlist ----
const DEFAULT_ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  // add your prod domains here:
  "https://www.brotherhyeok.org",
  "https://brotherhyeok.org",
];

// Optionally manage CORS at runtime via env: CORS_ALLOWED_ORIGINS="https://a.com,https://b.com"
const ENV_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = ENV_ALLOWED_ORIGINS.length
  ? ENV_ALLOWED_ORIGINS
  : DEFAULT_ALLOWED_ORIGINS;

// ---- Email exclusion (CSV in env) ----
function parseCsvSet(v) {
  if (!v || typeof v !== "string") return new Set();
  return new Set(
    v.split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
const EXCLUDE_EMAILS = parseCsvSet(process.env.EXCLUDE_DONOR_EMAILS);

// When true, bypass consent (useful in staging). Keep CORS strict even in tests.
const SHOW_ALL_FOR_TEST = String(process.env.SHOW_ALL_FOR_TEST || "").toLowerCase() === "true";

// Zero-decimal currencies per Stripe
const ZERO_DEC = new Set([
  "BIF","CLP","DJF","GNF","JPY","KMF","KRW","MGA","PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF"
]);

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Fallback to your main staging origin; you can set "*" if you truly want it public.
    res.setHeader("Access-Control-Allow-Origin", DEFAULT_ALLOWED_ORIGINS[0]);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function displayName(name, email) {
  const n = (name || "").trim();
  if (n) return n;
  const e = (email || "").trim();
  if (e) {
    const pretty = e.split("@")[0]
      .replace(/[._-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");
    return pretty || "Someone";
  }
  return "Someone";
}

function formatAmount(minorUnits, currency = "USD") {
  const c = (currency || "USD").toUpperCase();
  const value = ZERO_DEC.has(c) ? minorUnits : (minorUnits || 0) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: c,
    maximumFractionDigits: ZERO_DEC.has(c) ? 0 : 2,
  }).format(value);
}

function isExcludedEmail(email) {
  if (!email) return false;
  return EXCLUDE_EMAILS.has(String(email).toLowerCase());
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });

  // Parse & clamp ?limit= (default 10, max 50)
  let limit = 10;
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const param = parseInt(url.searchParams.get("limit") || "10", 10);
    if (Number.isFinite(param)) limit = Math.max(1, Math.min(param, 50));
  } catch {
    // ignore; keep default
  }

  try {
    // 1) List recent Checkout Sessions (up to 50). We’ll filter locally.
    const sessionsRes = await stripe.checkout.sessions.list({ limit: 50 });

    // 2) Build items: paid only, consent, not excluded, deduped
    const seen = new Set();
    const items = [];

    for (const s of sessionsRes.data || []) {
      try {
        if (items.length >= limit) break;

        if (s.payment_status !== "paid") continue;

        const email = s.customer_details?.email || "";
        if (isExcludedEmail(email)) continue;

        if (!SHOW_ALL_FOR_TEST) {
          const consent = String(s.metadata?.public_consent || "").toLowerCase();
          if (consent !== "true") continue;
        }

        // de-dupe key: prefer payment_intent, fallback to session id
        const key = s.payment_intent || s.id;
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const name = displayName(s.customer_details?.name, email);
        const amountMinor = s.amount_total ?? s.amount_subtotal ?? 0;
        const currency = s.currency || "USD";

        const text = s.mode === "subscription"
          ? `${name} became a Partner (${formatAmount(amountMinor, currency)}/mo)`
          : `${name} just gave ${formatAmount(amountMinor, currency)}`;

        items.push({
          name,
          text,
          ts: s.created || Math.floor(Date.now() / 1000)
        });
      } catch {
        continue;
      }
    }

    // 3) Sort & limit (already bounded by loop, but keep it)
    items.sort((a, b) => b.ts - a.ts);
    const out = items.slice(0, limit);

    // 4) Small cache (CDN + browser). Adjust as you like.
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=60");
    return res.status(200).json({ items: out });
  } catch (err) {
    console.error("[public-recent-donations] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
