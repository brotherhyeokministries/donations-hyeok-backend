// api/public-recent-donations.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// ==== Config ====
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  // agrega tu dominio prod si aplica
  "https://www.brotherhyeok.org",
  "https://brotherhyeok.org",
];

const EXCLUDE_EMAILS = (process.env.EXCLUDE_EMAILS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ZERO_DEC = new Set(["BIF","CLP","DJF","GNF","JPY","KMF","KRW","MGA","PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF"]);

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // si prefieres abierto para este feed público:
    // res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Origin", "https://hyeoks-site.webflow.io");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/**
 * Change #1: show only FIRST name, with a nicer fallback from email local-part.
 */
function displayName(name, email) {
  // Prefer explicit name; else derive from email local-part
  const raw = (name && String(name).trim()) || (email ? String(email).trim().split("@")[0] : "");
  if (!raw) return "Someone";
  // Normalize separators and take only the first token
  const first = raw.replace(/[._-]+/g, " ").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "Someone";
}

function fmt(amountMinor, currency = "USD") {
  const c = currency.toUpperCase();
  const val = ZERO_DEC.has(c) ? amountMinor : amountMinor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: c,
    maximumFractionDigits: ZERO_DEC.has(c) ? 0 : 2,
  }).format(val);
}

function isExcluded(email) {
  return email && EXCLUDE_EMAILS.includes(String(email).toLowerCase());
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 10));

  try {
    // Traemos suficientes eventos recientes para componer 10 limpios
    // (sube el list limit si alguna vez te quedan pocos)
    const events = await stripe.events.list({
      limit: 100,
      // Nota: podrías usar 'types' para filtrar en la API, pero aquí filtramos abajo.
    });

    const seenKeys = new Set();  // dedupe por payment_intent/session.id
    const items = [];

    for (const ev of events.data) {
      try {
        if (items.length >= limit) break;

        if (ev.type === "checkout.session.completed") {
          const s = ev.data.object;

          const email = s.customer_details?.email || "";
          if (isExcluded(email)) continue;

          // Clave única: payment_intent (si existe) o session id
          const key = s.payment_intent || s.id;
          if (!key || seenKeys.has(key)) continue;
          seenKeys.add(key);

          const name = displayName(s.customer_details?.name, email);
          const amountMinor = s.amount_total ?? s.amount_subtotal ?? 0;
          const currency = s.currency || "usd";

          const text = s.mode === "subscription"
            ? `${name} became a Partner (${fmt(amountMinor, currency)}/mo)`
            : `${name} just gave ${fmt(amountMinor, currency)}`;

          items.push({ name, text, ts: ev.created });
          continue;
        }

        // Opcional: si quieres que la PRIMERA cuota de suscripción cuente
        // aunque falte el checkout (algunos flujos), permitimos invoice.paid solo
        // cuando billing_reason = subscription_create:
        if (ev.type === "invoice.paid") {
          const inv = ev.data.object;
          if (inv.billing_reason !== "subscription_create") continue;

          const email = inv.customer_email || "";
          if (isExcluded(email)) continue;

          const key = inv.payment_intent || inv.id;
          if (!key || seenKeys.has(key)) continue;
          seenKeys.add(key);

          const name = displayName(inv.customer_name, email);
          const amountMinor = inv.amount_paid ?? inv.total ?? 0;
          const currency = inv.currency || "usd";

          const text = `${name} became a Partner (${fmt(amountMinor, currency)}/mo)`;
          items.push({ name, text, ts: ev.created });
          continue;
        }

        // Ignoramos payment_intent.succeeded / charge.succeeded para no duplicar
      } catch {
        // continúa si algún evento viene raro
        continue;
      }
    }

    // Ordenar por fecha
    items.sort((a, b) => b.ts - a.ts);

    /**
     * Change #2: extra de-dup at the end (just in case)
     * Keyed by lowercased name + text + ts to collapse near-duplicates.
     */
    const _seen = new Set();
    const out = [];
    for (const it of items) {
      const k = `${(it.name || "").toLowerCase()}|${it.text}|${it.ts}`;
      if (_seen.has(k)) continue;
      _seen.add(k);
      out.push(it);
      if (out.length >= limit) break;
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ items: out });
  } catch (err) {
    console.error("public-recent-donations error:", err);
    return res.status(500).json({ items: [] });
  }
}