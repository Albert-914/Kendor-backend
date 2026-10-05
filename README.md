# Kendor backend

Takes an order, collects payment with Paystack, then asks your supplier to deliver the data or airtime.

```
Kendor app -> POST /api/orders        server saves the order, starts a Paystack payment
Customer pays (MoMo or card) on Paystack
Paystack  -> POST /api/paystack/webhook   server checks the signature and the amount
Server    -> supplier API             sends the data
Kendor app -> GET /api/orders/:ref    shows delivered / processing / failed
```

No packages to install. It needs Node 22.13 or newer.

## Try it (mock mode, no money)

```
npm test          # runs the full order flow with fake payments and a fake supplier
npm start         # starts the server on port 3000
```

## Going live, in this order

1. **Host it.** Any Node host works (Render, Railway, Fly). Start command: `npm start`.
   Use a persistent disk for `DB_PATH`, or the orders disappear when the server restarts.
2. **Paystack.** Put your TEST secret key in `PAYSTACK_SECRET_KEY`, set `PAYMENT_MODE=live`.
   In the Paystack dashboard, set the webhook URL to `https://YOUR-HOST/api/paystack/webhook`.
3. **Supplier.** When Datapot (or another supplier) sends their API details, open `supplier.js`,
   change the lines marked `TODO` to match their documentation, then set `SUPPLIER_MODE=http`,
   `SUPPLIER_API_URL` and `SUPPLIER_API_KEY`.
4. **Test with small real orders** on your own numbers. Then switch Paystack to the live key.
5. Set `ADMIN_TOKEN` to a long random password.

## Rules the server follows

- Prices come only from `catalog.js`. The app can never set its own price.
- A paid order is delivered once, even if Paystack repeats the webhook.
- If the amount paid does not match the order, nothing is delivered.
- If the supplier does not answer (timeout), the order goes to `review`. Check with the
  supplier before refunding or retrying, because the data may have been sent.
- Orders the supplier clearly refuses are `failed`. Refund the customer in Paystack, or retry
  with `POST /api/admin/orders/KD-XXXX/retry` and header `X-Admin-Token`.

## Not built yet

- Result checker vouchers (BECE/WASSCE): depends on what the supplier offers.
- Automatic refunds.
- Connecting the Kendor screens to these routes.

## Never share

Your `PAYSTACK_SECRET_KEY`, `SUPPLIER_API_KEY` and `ADMIN_TOKEN`. Keep them only in the host's settings.
