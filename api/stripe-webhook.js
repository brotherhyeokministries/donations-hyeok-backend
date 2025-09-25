// api/stripe-webhook.js
import Stripe from "stripe";
import crypto from "crypto";

/**
 * ENV requeridas en Vercel (Settings → Environment Variables)
 * - STRIPE_SECRET_KEY       = sk_live_… o sk_test_…
 * - STRIPE_WEBHOOK_SECRET   = whsec_… (del endpoint en Stripe)
 * - ZAPIER_HOOK_URL         = https://hooks.zapier.com/hooks/catch/XXXX/XXXX (opcional)
 * - FORWARD_HMAC_SECRET     = clave para firmar lo que reenviamos a Zapier (opcional pero recomendado)
 */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

// Lee el body "raw" para poder verificar la firma de Stripe
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Hash SHA-256 (para anonimizar email)
function sha256Hex(input) {
  return crypto.createHash("sha256").update(input || "", "utf8").digest("hex");
}

// Firma HMAC para reenvío a Zapier (nuestro propio sello)
function signForward(bodyString) {
  const secret = process.env.FORWARD_HMAC_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(bodyString).digest("hex");
}

export default async function handler(req, res) {
  // Comprobación rápida
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, endpoint: "stripe-webhook" });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    if (!webhookSecret) {
      // Seguridad: sin secret no podemos verificar la firma. Solo útil transitoriamente.
      // En producción SIEMPRE configura STRIPE_WEBHOOK_SECRET.
      console.warn("[stripe-webhook] STRIPE_WEBHOOK_SECRET missing – skipping verification (not recommended)");
      event = req.body; // Vercel parsea JSON si no leemos raw; OK solo temporalmente.
    } else {
      // Verificación correcta de firma (recomendado)
      const raw = await readRawBody(req);
      event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
    }
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  try {
    // Procesa eventos que nos interesan
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Datos comunes
      const payload = {
        event_type: event.type,
        session_id: session.id,
        created: event.created, // epoch seconds
        mode: session.mode, // 'payment' o 'subscription'
        is_subscription: session.mode === "subscription",
        amount_total: session.amount_total, // minor units
        currency: (session.currency || "").toUpperCase(),
        // PII minimizada:
        customer_email_hash: sha256Hex(session.customer_details?.email || ""),
        customer_name_initials: (session.customer_details?.name || "")
          .split(" ")
          .map(w => w[0])
          .join("")
          .toUpperCase()
          .slice(0, 3),
        country: session.customer_details?.address?.country || session.customer_details?.address?.country_code || null,
        // metadata propia (desde tu create-checkout-session)
        prayer_request: session.metadata?.prayer_request || "",
      };

      console.log("[stripe-webhook] checkout.session.completed", {
        session_id: payload.session_id,
        currency: payload.currency,
        amount_total: payload.amount_total,
        is_subscription: payload.is_subscription,
      });

      // Reenvío opcional a Zapier con firma propia
      if (process.env.ZAPIER_HOOK_URL) {
        const bodyString = JSON.stringify(payload);
        const headers = { "Content-Type": "application/json" };
        const signature = signForward(bodyString);
        if (signature) headers["X-Forward-Signature"] = signature;

        try {
          const resp = await fetch(process.env.ZAPIER_HOOK_URL, {
            method: "POST",
            headers,
            body: bodyString,
          });
          if (!resp.ok) {
            console.error("[stripe-webhook] Zapier forward failed", resp.status, await resp.text());
          }
        } catch (zErr) {
          console.error("[stripe-webhook] Zapier forward error", zErr?.message);
        }
      }
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const payload = {
        event_type: event.type,
        invoice_id: invoice.id,
        created: event.created,
        amount_paid: invoice.amount_paid,
        currency: (invoice.currency || "").toUpperCase(),
        customer_email_hash: sha256Hex(invoice.customer_email || ""),
        subscription: invoice.subscription || null,
      };

      console.log("[stripe-webhook] invoice.paid", {
        invoice_id: payload.invoice_id,
        amount_paid: payload.amount_paid,
        currency: payload.currency,
      });

      if (process.env.ZAPIER_HOOK_URL) {
        const bodyString = JSON.stringify(payload);
        const headers = { "Content-Type": "application/json" };
        const signature = signForward(bodyString);
        if (signature) headers["X-Forward-Signature"] = signature;
        try {
          const resp = await fetch(process.env.ZAPIER_HOOK_URL, { method: "POST", headers, body: bodyString });
          if (!resp.ok) console.error("[stripe-webhook] Zapier forward failed", resp.status, await resp.text());
        } catch (zErr) {
          console.error("[stripe-webhook] Zapier forward error", zErr?.message);
        }
      }
    }

    // Puedes añadir más tipos si los necesitas (created/updated/deleted de subscription, etc.)
    // else { console.log(`[stripe-webhook] Unhandled event ${event.type}`); }

    // Responde rápido 200 para que Stripe no reintente
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[stripe-webhook] Handler error", err);
    // 500 solo si quieres que Stripe reintente; trata de evitarlo si ya reenviaste a Zapier.
    return res.status(200).json({ received: true, note: "handled with warnings" });
  }
}

/**
 * Nota si tu proyecto es Next.js:
 * export const config = { api: { bodyParser: false } };
 * En Vercel Node Serverless (sin Next) usamos readRawBody arriba, no necesitas más.
 */