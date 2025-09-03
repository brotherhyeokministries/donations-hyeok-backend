import Stripe from "stripe";

const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com"
];
function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : "https://hyeoks-site.webflow.io";
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", getAllowedOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")   return res.status(405).json({ error: "Method not allowed" });

  const { session_id } = req.query || {};
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent", "subscription", "customer"]
    });

    // Extraer full_name de custom_fields
    let fullName = null;
    if (Array.isArray(session.custom_fields)) {
      const f = session.custom_fields.find(f => f.key === "full_name");
      fullName = f?.text?.value || null;
    }

    const data = {
      id: session.id,
      mode: session.mode,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: session.customer_details?.email || session.customer_email || null,
      customer_name: fullName || session.customer_details?.name || null,
      subscription_id: typeof session.subscription === "object" ? session.subscription.id : session.subscription || null,
      payment_intent_id: typeof session.payment_intent === "object" ? session.payment_intent.id : session.payment_intent || null
    };

    return res.status(200).json({ session: data });
  } catch (err) {
    console.error("[get-session]", err?.message);
    return res.status(500).json({ error: "Failed to retrieve session" });
  }
}
