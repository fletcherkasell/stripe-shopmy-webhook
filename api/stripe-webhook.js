import Stripe from "stripe";
import getRawBody from "raw-body";

// Vercel Serverless Function: keep raw body for Stripe signature verification
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
const SHOPMY_KEY = process.env.SHOPMY_BRAND_DEV_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function postToShopMy(path, payload) {
  const res = await fetch(`https://api.shopmy.us/api/Affiliates/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SHOPMY_KEY}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`ShopMy ${path} failed: ${res.status} ${await res.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end("Method Not Allowed");

  let event;
  try {
    const raw = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // We react to refund-related events
  if (["refund.created", "refund.updated", "charge.refunded"].includes(event.type)) {
    try {
      // Figure out the charge id from the event
      const chargeId = event.type.startsWith("refund.")
        ? event.data.object.charge
        : event.data.object.id;

      // Fetch the charge so we can calculate current totals
      const charge = await stripe.charges.retrieve(chargeId);
      const original = charge.amount || 0;           // cents
      const refunded = charge.amount_refunded || 0;  // cents
      const currency = (charge.currency || "usd").toUpperCase();

      // Use your own order id if you store it in metadata; else fallback to charge id
      const order_id = String((charge.metadata && charge.metadata.order_id) || charge.id);

      if (refunded >= original && original > 0) {
        // fully refunded ⇒ cancel
        await postToShopMy("cancel", { order_id });
      } else {
        // partial refund ⇒ update
        const newTotal = ((original - refunded) / 100).toFixed(2);
        await postToShopMy("update", {
          order_id,
          currency,
          new_order_amount: newTotal
        });
      }
    } catch (e) {
      console.error("ShopMy sync error:", e);
      return res.status(500).end("Internal Error");
    }
  }

  return res.status(200).end("ok");
}
