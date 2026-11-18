# Tabella shipping service

A small Cloudflare Worker that keeps the Shippo API key on the server and returns live shipping rates to Tabella pages.

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
