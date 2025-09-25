// api/public-recent-donations.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// Dominios permitidos para el widget (ajusta si tienes más)
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://www.hyeok.org",              // si lo usas
];

function cors(res, origin) {
  if (ALLOWED_ORIGINS.includes(origin || "")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // si quieres abrirlo para cualquiera, cambia a "*"
    res.setHeader("Access-Control-Allow-Origin", "https://hyeoks-site.webflow.io");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const ZERO_DEC = new Set(["JPY","KRW","VND","CLP","XOF","XAF","KMF","DJF","GNF","PYG","RWF","UGX","VUV"]);
function fmt(amount, currency="USD") {
  const iso = currency.toUpperCase();
  const value = ZERO_DEC.has(iso) ? amount : amount / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: iso,
    maximumFractionDigits: ZERO_DEC.has(iso) ? 0 : 2,
  }).format(value);
}

const EXCLUDED_EMAILS = [
  // añade/quitá los tuyos; en minúsculas
  //"jedidiah.interaction@gmail.com",
  //"hello@jedicreate.com",
];

export default async function handler(req, res) {
  cors(res, req.headers.origin);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const limit = Number.parseInt(req.query.limit, 10) || 10;

  try {
    // Traemos eventos recientes y construimos una lista de donaciones
    // (puedes subir el límite si necesitas más profundidad)
    const evts = await stripe.events.list({ limit: 50 });

    const items = [];
    const seen = new Set(); // para intentar dedupe básico

    for (const e of evts.data) {
      const t = e.type;
      const o = e.data?.object ?? {};

      // Preferimos checkout.session.completed porque trae name/email limpios
      if (t === "checkout.session.completed") {
        const name = o.customer_details?.name || o.customer?.name || "Someone";
        const email = (o.customer_details?.email || "").toLowerCase();
        if (EXCLUDED_EMAILS.includes(email)) continue;

        const isSub =
          o.mode === "subscription" ||
          !!o.subscription ||
          o.payment_status === "paid" && o.total_details?.breakdown?.recurring;

        const amount = o.amount_total ?? o.amount_subtotal ?? 0;
        const currency = o.currency || "usd";

        const text = isSub
          ? `${name} became a Partner (${fmt(amount, currency)}/mo)`
          : `${name} just gave ${fmt(amount, currency)}`;

        // Dedupe por payment_intent o session id
        const key = o.payment_intent || o.id;
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({ name, text, ts: e.created });
        continue;
      }

      // Fallback: payment_intent.succeeded (por si hay casos sin Checkout)
      if (t === "payment_intent.succeeded") {
        const pi = o;
        const email = (pi.charges?.data?.[0]?.billing_details?.email || "").toLowerCase();
        if (EXCLUDED_EMAILS.includes(email)) continue;

        const name =
          pi.charges?.data?.[0]?.billing_details?.name ||
          pi.customer?.name ||
          "Someone";

        const amount = pi.amount_received ?? pi.amount ?? 0;
        const currency = pi.currency || "usd";
        const key = pi.id;
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({
          name,
          text: `${name} just gave ${fmt(amount, currency)}`,
          ts: e.created,
        });
        continue;
      }

      // También puedes admitir `invoice.paid` si quieres mostrar renovaciones
      if (t === "invoice.paid" && o.billing_reason === "subscription_create") {
        const subCustomerName = o.customer_name || o.customer_email || "Someone";
        const amount = o.amount_paid ?? o.total ?? 0;
        const currency = o.currency || "usd";
        const key = o.id;
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({
          name: subCustomerName,
          text: `${subCustomerName} became a Partner (${fmt(amount, currency)}/mo)`,
          ts: e.created,
        });
        continue;
      }
    }

    // Ordenamos por más recientes y limitamos
    items.sort((a, b) => b.ts - a.ts);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ items: items.slice(0, limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load donations" });
  }
}