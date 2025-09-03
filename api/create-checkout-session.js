import Stripe from "stripe";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  try {
    const {
      mode = "payment",
      amount,
      currency = "USD",
      success_url = "https://your-site.com/success",
      cancel_url  = "https://your-site.com/cancel",
      interval = "month",
      interval_count = 1
    } = await req.json?.() || req.body || {};

    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Invalid amount." });
    }

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

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Stripe error" });
  }
}
