// /api/public-recent-donations.js
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2022-11-15', // or keep your account default
});

// Zero-decimal currencies per Stripe docs
const ZERO_DEC = new Set([
  'BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF'
]);

function formatAmount(amount, currency = 'USD') {
  const upper = (currency || 'USD').toUpperCase();
  const value = ZERO_DEC.has(upper) ? amount : amount / 100;
  // Show like $1,000.00 / ₩10,000 / ¥1,000
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: upper,
    maximumFractionDigits: ZERO_DEC.has(upper) ? 0 : 2,
  }).format(value);
}

function nameFromEmail(email) {
  if (!email) return 'Someone';
  const local = email.split('@')[0] || '';
  // Try “john.doe” → “John D.”
  const parts = local.replace(/[^a-zA-Z.\-_\s]/g, ' ').split(/[._\-\s]+/).filter(Boolean);
  if (!parts.length) return 'Someone';
  const first = parts[0];
  const lastInitial = parts[1]?.[0] ? (parts[1][0].toUpperCase() + '.') : '';
  return `${first[0].toUpperCase()}${first.slice(1)}${lastInitial ? ' ' + lastInitial : ''}`;
}

function buildItem({ email, amount, currency, type, created, interval }) {
  const name = nameFromEmail(email);
  const when = created * 1000; // unix -> ms
  if (type === 'subscription') {
    const amt = formatAmount(amount, currency);
    const label = interval === 'month' ? 'mo' : interval || 'mo';
    return {
      name,
      text: `${name} became a Partner (${amt}/${label})`,
      ts: Math.floor(when / 1000)
    };
  }
  // one-time payment
  return {
    name,
    text: `${name} just gave ${formatAmount(amount, currency)}`,
    ts: Math.floor(when / 1000)
  };
}

export default async function handler(req, res) {
  try {
    // Pull more than we need so we can filter & still get 10 good ones
    // We’ll look at the freshest events first.
    const events = await stripe.events.list({
      limit: 50,
      // If you want to be explicit:
      // types: ['checkout.session.completed','payment_intent.succeeded','invoice.paid']
    });

    const items = [];

    for (const evt of events.data) {
      try {
        switch (evt.type) {
          case 'checkout.session.completed': {
            const s = evt.data.object;
            // Distinguish subscription vs one-time
            const isSub = s.mode === 'subscription' || s.subscription;
            const customerEmail = s.customer_details?.email || s.customer_email;

            if (isSub) {
              // For subscriptions via Checkout, the amount/currency come from the first plan item
              // when available; fallback to display items if present.
              const subId = s.subscription;
              let amount = null, currency = s.currency || 'USD', interval = 'month';

              // Best effort: fetch subscription for exact price
              if (subId) {
                const sub = await stripe.subscriptions.retrieve(subId);
                const price = sub.items?.data?.[0]?.price;
                if (price) {
                  interval = price.recurring?.interval || 'month';
                  currency = price.currency || currency;
                  amount = price.unit_amount ?? amount;
                }
              }

              // Fallback if amount not found
              if (amount == null) {
                const line = s.display_items?.[0];
                if (line?.amount && line?.currency) {
                  amount = line.amount;
                  currency = line.currency;
                }
              }

              if (amount != null) {
                items.push(buildItem({
                  email: customerEmail,
                  amount,
                  currency,
                  type: 'subscription',
                  interval,
                  created: evt.created
                }));
              }
              break;
            } else {
              // One-time (payment) via Checkout
              const amount = s.amount_total ?? s.amount_subtotal ?? null;
              const currency = s.currency || 'USD';
              const email = s.customer_details?.email || s.customer_email;
              if (amount != null) {
                items.push(buildItem({
                  email,
                  amount,
                  currency,
                  type: 'payment',
                  created: evt.created
                }));
              }
              break;
            }
          }

          case 'payment_intent.succeeded': {
            // Covers one-time payments outside Checkout, just in case
            const pi = evt.data.object;
            items.push(buildItem({
              email: pi.receipt_email || pi.charges?.data?.[0]?.billing_details?.email,
              amount: pi.amount_received ?? pi.amount ?? 0,
              currency: pi.currency || 'USD',
              type: 'payment',
              created: evt.created
            }));
            break;
          }

          case 'invoice.paid': {
            // Recurring renewals—usually you *don’t* want renewals in the homepage ticker.
            // If you DO want them, uncomment below:
            /*
            const inv = evt.data.object;
            const amount = inv.amount_paid;
            const currency = inv.currency || 'USD';
            const email = inv.customer_email || inv.customer_shipping?.name || null;
            items.push(buildItem({
              email,
              amount,
              currency,
              type: 'payment',
              created: evt.created
            }));
            */
            break;
          }

          default:
            break;
        }
      } catch (inner) {
        // Ignore a single event parsing error and keep going
        continue;
      }
    }

    // Sort newest first and keep the latest 10
    items.sort((a, b) => b.ts - a.ts);
    res.setHeader('Cache-Control', 'public, max-age=30'); // tiny cache is fine
    return res.status(200).json({ items: items.slice(0, 10) });
  } catch (err) {
    console.error('recent-donations error', err);
    return res.status(500).json({ items: [] });
  }
}