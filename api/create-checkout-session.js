import Stripe from "stripe";

/** CORS multi-origin */
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com" // cámbialo cuando tengas dominio
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
      interval = "month",            // para subscription
      interval_count = 1,
      twice_monthly = false,         // caso especial (si lo usas)
      anchor
    } = req.body || {};

    if (!amount || amount < 1) return res.status(400).json({ error: "Invalid amount." });

    // Añadir el session_id al success_url
    const success = success_url.includes("?")
      ? `${success_url}&session_id={CHECKOUT_SESSION_ID}`
      : `${success_url}?session_id={CHECKOUT_SESSION_ID}`;

    // Config común de Checkout
    const checkoutBase = {
      mode,
      success_url: success,
      cancel_url,
      customer_creation: "always",            // crea/actualiza Customer
      billing_address_collection: "auto",     // no forzamos dirección
      phone_number_collection: { enabled: false },
      // Pedir NOMBRE sin pedir dirección
      custom_fields: [
        {
          key: "full_name",
          label: { type: "custom", custom: "Full name" },
          type: "text",
          text: { required: true }
        }
      ],
    };

    // Flujo normal: pago único o suscripción semanal/quincenal/mensual
    if (mode === "payment" || (mode === "subscription" && !twice_monthly)) {
      const session = await stripe.checkout.sessions.create({
        ...checkoutBase,
        line_items: [{
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: { name: mode === "subscription" ? "Recurring donation" : "One-time donation" },
            ...(mode === "subscription" ? { recurring: { interval, interval_count } } : {})
          }
        }]
      });
      return res.status(200).json({ url: session.url });
    }

    // (Opcional) “1st & 15th”: primera mitad ahora; la segunda se crea en webhook
    const half = Math.floor(amount / 2) || amount;
    const session = await stripe.checkout.sessions.create({
      ...checkoutBase,
      mode: "subscription",
      subscription_data: {
        billing_cycle_anchor: anchor ? Math.floor(new Date(anchor).getTime()/1000) : "now",
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

