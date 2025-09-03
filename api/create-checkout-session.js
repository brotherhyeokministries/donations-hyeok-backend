import Stripe from "stripe";

/** Allow these origins (add your custom domain when ready) */
const ALLOWED_ORIGINS = [
  "https://hyeoks-site.webflow.io",
  "https://tudominio.com" // replace when you have your domain
];
const allowOrigin = (req) =>
  ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : "https://hyeoks-site.webflow.io";

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", allowOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    const {
      mode = "payment",            // "payment" | "subscription"
      amount,                      // minor units (USD: 500 = $5.00)
      currency = "USD",
      success_url = "https://hyeoks-site.webflow.io/donate/success",
      cancel_url  = "https://hyeoks-site.webflow.io/donate/cancel",
      // for subscriptions:
      interval = "month",          // "week" | "month" | "year"
      interval_count = 1
    } = req.body || {};

    if (!amount || amount < 1) return res.status(400).json({ error: "Invalid amount." });

    // Ensure success_url receives the session id
    const success = success_url.includes("?")
      ? `${success_url}&session_id={CHECKOUT_SESSION_ID}`
      : `${success_url}?session_id={CHECKOUT_SESSION_ID}`;

    // Common Checkout config (applies to both modes)
    const base = {
      mode,
      success_url: success,
      cancel_url,
      billing_address_collection: "auto", // do NOT force address
      // Show a "Full name" field in Checkout
      custom_fields: [
        {
          key: "full_name",
          label: { type: "custom", custom: "Full name" },
          type: "text",
          optional: false,
          text: { minimum_length: 1, maximum_length: 120 }
        }
      ]
    };

    // ---- ONE-TIME ----
    if (mode === "payment") {
      const session = await stripe.checkout.sessions.create({
        ...base,
        customer_creation: "always", // allowed only in "payment" mode
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
      });
      return res.status(200).json({ url: session.url });
    }

    // ---- SUBSCRIPTION ----
    const session = await stripe.checkout.sessions.create({
      ...base,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amount,
            product_data: { name: "Recurring donation" },
            recurring: { interval, interval_count } // weekly/biweekly/monthly/yearly from the frontend
          }
        }
      ]
    });
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error("[Stripe error]", err?.message, err);
    return res.status(500).json({ error: err?.raw?.message || err?.message || "Stripe error" });
  }
}