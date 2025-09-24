// /api/public-recent-donations.js
import Stripe from "stripe";
// ==== Demo-friendly email exclude list ======================================
// Set to true to hide specific donors by email (below). 
// For launch, set false or comment out this whole section.
const ENABLE_EMAIL_EXCLUDE = true;

// Hardcoded emails to exclude in demos
const DEMO_EXCLUDE_EMAILS = [
  "hello@jedicreate.com",
  "otro@dominio.com"
];

// ==== Helper ================================================================
function parseCsvSet(v) {
  if (!v || typeof v !== "string") return new Set();
  return new Set(
    v.split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.toLowerCase())
  );
}

// ENV-based list (for production, from Vercel env var)
const ENV_EXCLUDE_EMAILS = parseCsvSet(process.env.EXCLUDE_DONOR_EMAILS);

// Combine ENV + DEMO (if toggle enabled)
const EXCLUDE_EMAILS = new Set([
  ...ENV_EXCLUDE_EMAILS,
  ...(ENABLE_EMAIL_EXCLUDE ? DEMO_EXCLUDE_EMAILS.map(e => e.toLowerCase()) : [])
]);

/** Dominios que pueden leer este feed (ajusta con tu dominio propio cuando lo tengas) */
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com"
];

const allowOrigin = (req) =>
  ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : "https://hyeoks-site.webflow.io";

/** Para pruebas: si defines esta env var en Vercel, verás TODO (sin consentimiento) */
const SHOW_ALL_FOR_TEST = process.env.SHOW_ALL_FOR_TEST === "true";

/** Util: anonimizar nombre → "Andrés" o "Andrés P." */
function formatDisplayName(name) {
  if (!name || typeof name !== "string") return "Someone";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "Someone";
  const first = parts[0];
  const last = parts[1] || "";
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

/** Util: formatear monto en USD con símbolo */
function formatAmountUsd(cents) {
  const n = (cents || 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", allowOrigin(req));
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    // lee ?limit= (por defecto 10, máx 50)
    const url = new URL(req.url, `https://${req.headers.host}`);
    const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 50)) : 10;

    // 1) Traer sesiones de Checkout pagadas recientemente (últimas 50)
    //    Usamos Sessions para tener payment_status, amount_total, mode y customer_details.name
    const sessions = await stripe.checkout.sessions.list({
      limit: 50
    });

    // 2) Filtrar solo pagadas y con consentimiento público en metadata
    const items = (sessions?.data || [])
      .filter(s => s.payment_status === "paid")
      .filter(s => {
        if (EXCLUDE_EMAILS.size === 0) return true;
        const email = (s.customer_details?.email || "").toLowerCase();
        if (email && EXCLUDE_EMAILS.has(email)) return false;
        return true;
      })
      .filter(s => {
        if (SHOW_ALL_FOR_TEST) return true; // para pruebas: muestra todo
        const consent = (s.metadata && s.metadata.public_consent) || "";
        return String(consent).toLowerCase() === "true";
      })
      .map(s => {
        const name = formatDisplayName(s.customer_details?.name || "");
        const amountCents = s.amount_total || 0;
        const amountText = formatAmountUsd(amountCents);
        const isMonthly = s.mode === "subscription";
        return {
          name,
          text: isMonthly ? `${name} became a Partner (${amountText}/mo)` 
                          : `${name} just gave ${amountText}`,
          ts: s.created || 0
        };
      })
      // 3) Ordenar por más recientes y limitar a 20 para el feed
      .sort((a,b) => b.ts - a.ts)
      .slice(0, limit);

    // 4) Cache/CDN headers (opcional): 60s
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=60");

    return res.status(200).json({ items });
  } catch (err) {
    console.error("[public-recent-donations] error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}