import Stripe from "stripe";

const ALLOWED_ORIGIN = "*"; // para depurar; luego pon: "https://hyeoks-site.webflow.io"

export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    // Vercel (Node) ya parsea JSON cuando hay header Content-Type: application/json
    const {
      mode = "payment",
      amount,
      currency = "USD",
      success_url = "https://example.com/success",
      cancel_url  = "https://example.com/cancel",
      interval = "month",
      interval_count = 1,
      twice_monthly = false,
      anchor
    } = req.body || {};

    console.log("[REQ]", { mode, amount, currency, interval, interval_count, twice_monthly, hasAnchor: !!anchor });

    if (!amount || amount < 1) return res.status(400).json({ error: "Invalid amount." });

    if (mode === "payment" || (mode === "subscription" && !twice_monthly)) {
      const session = await stripe.checkout.sessions.create({
        mode,
        success_url,
        cancel_url,
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
      console.log("[SESSION]", session.id);
      return res.status(200).json({ url: session.url });
    }

    // Caso "1st & 15th": primera mitad; la segunda la harías en webhook
    const half = Math.floor(amount / 2) || amount;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      success_url,
      cancel_url,
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
    console.log("[SESSION_SPLIT]", session.id);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("[Stripe error]", err?.message, err);
    const msg = err?.raw?.message || err?.message || "Stripe error";
    return res.status(500).json({ error: msg });
  }
}
