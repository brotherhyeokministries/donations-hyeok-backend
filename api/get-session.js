import Stripe from "stripe";

const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com"
];
const allowOrigin = (req) =>
  ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : "https://hyeoks-site.webflow.io";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", allowOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")   return res.status(405).json({ error: "Method not allowed" });

  const { session_id } = req.query || {};
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    const s = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent", "subscription", "customer"]
    });

    // Leer custom field "full_name"
    let fullName = null;
    if (Array.isArray(s.custom_fields)) {
      const f = s.custom_fields.find((x) => x.key === "full_name");
      fullName = f?.text?.value || null;
    }

    return res.status(200).json({
      session: {
        id: s.id,
        mode: s.mode,
        status: s.status,
        payment_status: s.payment_status,
        amount_total: s.amount_total,
        currency: s.currency,
        customer_email: s.customer_details?.email || s.customer_email || null,
        customer_name: fullName || s.customer_details?.name || null,
        metadata: s.metadata || null,
        subscription_id: typeof s.subscription === "object" ? s.subscription.id : s.subscription || null,
        payment_intent_id: typeof s.payment_intent === "object" ? s.payment_intent.id : s.payment_intent || null
      },
      payment_intent: s.payment_intent
        ? { id: s.payment_intent.id, metadata: s.payment_intent.metadata || null }
        : null,
      subscription: s.subscription
        ? { id: s.subscription.id, metadata: s.subscription.metadata || null }
        : null
    });
  } catch (err) {
    console.error("[get-session]", err?.message);
    return res.status(500).json({ error: "Failed to retrieve session" });
  }
}