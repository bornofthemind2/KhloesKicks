# Khloes Kicks

This project provides a lightweight auction site for premium sneakers (e.g., Nike, Adidas, Reebok, New Balance) with:
- User accounts and login
- Auctions that last 10 days
- Bidding increments of $100
- Checkout using Stripe (card + ACH, requires your keys)
- Admin sales page to view bidders, purchases, and ship orders
- FedEx shipment label creation (uses your FedEx API keys if provided; falls back to a placeholder PDF)
- Uline box suggestion links based on product dimensions
- Product data import via CSV (instead of scraping StockX/Google, which likely violates their Terms)

## Important
- Do not scrape StockX.com or Google.com; it may violate their Terms of Service. Use CSV import or partner APIs instead.
- Provide your own credentials for payment and shipping.

## Quick Start
1. Install Node.js LTS.
2. From the project directory:
   - npm install
   - Copy .env.example to .env and fill in values
   - npm run dev
3. Visit http://localhost:3000
4. Admin → Payments to connect your Stripe account (optional but recommended).

## Environment Variables (.env)
- SESSION_SECRET=replace_me
- STRIPE_SECRET_KEY=sk_live_or_test
- STRIPE_WEBHOOK_SECRET=whsec_...
- STRIPE_CONNECT_CLIENT_ID=ca_... (for Stripe Connect OAuth onboarding)
- FEDEX_CLIENT_ID=...
- FEDEX_CLIENT_SECRET=...

If Stripe/FedEx keys are not set, relevant features will be limited (test/dummy flows for labels).

## CSV Import Format
Headers (case-insensitive):
- name, brand, sku, size, description, image_url, highest_market_price

Brand filter is applied server-side to allowed brands: Nike, Adidas, Reebok, New Balance.

## Scripts
- npm run dev: Run server
- npm start: Run server

## Notes
- ACH requires additional setup in Stripe and may not be available by default.
- Stripe Checkout collects shipping address; the webhook stores it for shipments.
- To route funds to a connected account, set STRIPE_CONNECT_CLIENT_ID and complete onboarding under Admin → Payments.
- The FedEx API requires OAuth credentials and specific shipment details. This app includes a fallback label if not configured.
