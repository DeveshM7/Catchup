import Stripe from "stripe";

export default function (amount: number) {
  const stripe = new Stripe("sk_test");
  return stripe.charges.create({ amount });
}
