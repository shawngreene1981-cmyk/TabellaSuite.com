# Tabella shipping and payments service

A small Cloudflare Worker that keeps the Shippo and Stripe keys on the server. It returns live shipping rates and runs Tabella payments through Stripe Connect (code in `stripe.js`).

## What it does now

- `GET /health` shows whether the Shippo key is set, and whether it is a test or live key.
- `POST /rates` takes a ship-from address, a ship-to address and a packed box, and returns Shippo's rates, cheapest first.
- `GET /` shows a small test form while `SHOW_TEST_PAGE` is `"true"`.

Labels, tracking updates and delivery confirmation come next, once rates work.

## Deploy (about 15 minutes)

1. Sign in to Cloudflare (free plan is fine) and open **Workers & Pages**.
2. Choose **Create**, then import this GitHub repository. Set the root directory to `shipping-worker`.
3. Deploy. Cloudflare gives you an address like `tabella-shipping.<your-name>.workers.dev`.
4. Open the Worker's **Settings > Variables and Secrets**. Add a **Secret** named `SHIPPO_API_KEY` and paste your Shippo **test** key (it starts with `shippo_test_`). Save, then deploy again if asked.
5. Visit `https://<your worker address>/health`. It should say `"key":"test"`.
6. Visit `https://<your worker address>/` and try a box with two real addresses.

## Before switching to the live key

- Set `SHOW_TEST_PAGE` to `"false"`.
- Add a check so only signed-in Tabella users can ask for rates. Today anyone who knows the address can, which costs nothing with a test key but costs about a cent per request with a live one.
- Never put the key in this repository, the website, or a shared document.

## Payments (Stripe Connect, sandbox)

Shoppers pay Tabella. After a payment, the Worker sends each dealer and mall their share:
commission is 9% of the sold price, the mall gets 4%, Tabella keeps 5%, and the dealer gets the rest.
If an item has no mall (online-only dealer), Tabella keeps the full 9%. Card processing is its own line on the buyer's receipt.

- `GET /pay/test` is a test page (sandbox key and `SHOW_TEST_PAGE` only): sign up a test dealer, check it, buy an item.
- `POST /pay/account` creates a dealer or mall account and returns Stripe's sign-up link.
- `POST /pay/onboarding-link` gives a fresh sign-up link. `GET /pay/account-status?account=acct_...` says whether they can be paid.
- `POST /pay/checkout` makes a Stripe Checkout page for one or more items.
- `POST /pay/webhook` is called by Stripe after payment and makes the transfers.

### Set up (about 10 minutes)

1. Secrets on this Worker: `STRIPE_SECRET_KEY` (sandbox `sk_test_...` key).
2. In Stripe (Tabella sandbox): **Developers > Webhooks > Add destination**. Event: `checkout.session.completed`.
   Endpoint: `https://<worker address>/pay/webhook`. Copy its signing secret (`whsec_...`) into a Worker secret named `STRIPE_WEBHOOK_SECRET`.
3. `/health` should show `"stripe":"test"`.

### Before live payments

- Checkout must take prices from Tabella's own inventory on the server, not from the page. Until then the Worker refuses live checkout.
- A live key is refused unless `ALLOW_LIVE_PAYMENTS` is `"true"`.
- Add sign-in so only Tabella users can create accounts and checkouts.
- Turn off `SHOW_TEST_PAGE`.
