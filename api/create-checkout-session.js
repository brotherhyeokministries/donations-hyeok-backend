import Stripe from "stripe";

/** CORS: permite staging y (luego) tu dominio propio */
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com" // <-- cámbialo cuando tengas tu dominio final
];

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : "https://hyeoks-site.webflow.io";
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    const {
      mode = "payment",              // "payment" | "subscription"
      amount,                        // minor units (USD: 500 = $5.00)
      currency = "USD",
      success_url = "https://hyeoks-site.webflow.io/success",
      cancel_url  = "https://hyeoks-site.webflow.io/cancel",
      interval = "month",            // solo si mode === "subscription"
      interval_count = 1,
      twice_monthly = false,         // caso especial 1st & 15th (si lo usas)
      anchor
    } = req.body || {};

    if (!amount || amount < 1) return res.status(400).json({ error: "Invalid amount." });

    // Añade session_id para que la Success page pueda leer datos
    const success = success_url.includes("?")
      ? `${success_url}&session_id={CHECKOUT_SESSION_ID}`
      : `${success_url}?session_id={CHECKOUT_SESSION_ID}`;

    // Config común de Checkout
    const checkoutBase = {
      mode,
      success_url: success,
      cancel_url,

      // 👉 Pide Name + Address (incluye campo "Name")
      billing_address_collection: "required",

      // Crea/actualiza Customer asociado (útil para suscripción y recibos)
      customer_creation: "always",
    };

    // Pago único o suscripción semanal/quincenal/mensual
    if (mode === "payment" || (mode === "subscription" && !twice_monthly)) {
      const session = await stripe.checkout.sessions.create({
        ...checkoutBase,
        line_items: [{
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: {
              name: mode === "subscription" ? "Recurring donation" : "One-time donation"
            },
            ...(mode === "subscription"
              ? { recurring: { interval, interval_count } }
              : {})
          }
        }]
      });
      return res.status(200).json({ url: session.url });
    }

    // (Opcional) Caso “1st & 15th”: primera mitad; la segunda se crearía en un webhook
    const half = Math.floor(amount / 2) || amount;
    const session = await stripe.checkout.sessions.create({
      ...checkoutBase,
      mode: "subscription",
      subscription_data: {
        billing_cycle_anchor: anchor ? Math.floor(new Date(anchor).getTime() / 1000) : "now",
        proration_behavior: "none",
        metadata: { split_plan: "first_half" }
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: half,
          product_data: { name: "Recurring donation (1/2)" },
          recurring: { interval: "month", interval_count: 1 }
        }
      }],
      metadata: { twice_monthly: "true", original_amount: String(amount) }
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[Stripe error]", err?.message, err);
    const msg = err?.raw?.message || err?.message || "Stripe error";
    return res.status(500).json({ error: msg });
  }
}