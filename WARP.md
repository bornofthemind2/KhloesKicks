# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

**Khloes Kicks** is a lightweight auction platform for premium sneakers (Nike, Adidas, Reebok, New Balance) built with Express.js, EJS templates, and SQLite. The application handles:
- 10-day auction cycles with $100 bidding increments
- User authentication and admin roles
- Stripe Checkout integration (card, ACH, PayPal, Cash App)
- FedEx shipping label generation with fallback placeholder PDFs
- CSV-based product imports (no web scraping due to ToS concerns)

## Development Commands

### Running the Server
```bash
# Development/Production (both use same command)
npm run dev
# or
npm start

# Windows-specific startup script (PowerShell)
npm run start:win
```

The server runs on `http://localhost:3000` by default (configurable via `PORT` env var).

### Initial Setup
```bash
# Install dependencies
npm install

# Configure environment
# Copy .env.example to .env and fill in required values
cp .env.example .env

# Run the server (database auto-initializes on first run)
npm run dev
```

### Database Management
- The SQLite database (`data.sqlite`) is auto-created in the project root on first run
- Schema migrations run automatically via try-catch blocks in `server.js`
- Default admin account is seeded: `admin@example.com` / `admin123` (if no users exist)

## Architecture

### Technology Stack
- **Backend**: Express.js (ES modules)
- **Database**: better-sqlite3 with WAL mode
- **Views**: EJS with express-ejs-layouts
- **Authentication**: express-session + bcryptjs
- **Payment Processing**: Stripe Checkout API + Stripe Connect for fund routing
- **Shipping**: FedEx API (OAuth-based) with placeholder PDF fallback

### Key Architectural Patterns

#### Monolithic Server Architecture
All application logic lives in a single `server.js` file (~803 lines):
- Database schema and migrations (lines 30-148)
- Route handlers for auth, auctions, admin, checkout
- Middleware for authentication and admin authorization
- Payment webhook handling for Stripe events

#### Data Model
Core tables:
- **users**: Authentication and admin flags
- **products**: Sneaker inventory with brand filtering (Nike, Adidas, Reebok, New Balance only)
- **auctions**: 10-day time-bound auctions linked to products
- **bids**: Bidding history with $100 increment enforcement
- **orders**: Checkout records (auction-based or "Buy It Now")
- **shipments**: FedEx tracking and address storage
- **settings**: Key-value store for app settings (e.g., Stripe connected account)
- **product_images**: Multi-image support for products

#### Authentication & Authorization
- `ensureAuth(req, res, next)`: Middleware requiring logged-in user
- `ensureAdmin(req, res, next)`: Middleware requiring admin role
- Session-based auth (no JWT) stored server-side via express-session

#### Payment Flow
1. User initiates checkout (auction win or "Buy It Now")
2. Stripe Checkout Session created with multi-payment options
3. Webhook (`/webhook/stripe`) receives `checkout.session.completed` event
4. Order status updated to "paid", shipping address captured
5. Admin generates FedEx label or placeholder PDF

#### Brand Filtering
The `allowedBrand()` helper enforces strict brand restrictions to avoid legal issues:
- Only Nike, Adidas, Reebok, New Balance allowed
- Applied during CSV import and product updates
- Case-insensitive substring matching

### File Structure
```
sneaker-auction/
├── server.js                    # Single-file Express app (all routes & logic)
├── package.json                 # Dependencies and scripts
├── .env.example                 # Environment variable template
├── data.sqlite                  # SQLite database (auto-created)
├── public/                      # Static assets (CSS, logo)
├── views/                       # EJS templates
│   ├── layout.ejs              # Main layout
│   ├── home.ejs                # Homepage with auction listings
│   ├── auction.ejs             # Individual auction detail page
│   ├── auth/                   # Login/register pages
│   └── admin/                  # Admin management views
│       ├── import.ejs          # CSV product import
│       ├── products.ejs        # Product listing
│       ├── edit-product.ejs    # Product editor with image management
│       ├── sales.ejs           # Orders and open bid tracking
│       └── connect.ejs         # Stripe Connect onboarding
├── uploads/                     # Temporary CSV uploads (multer)
└── labels/                      # Generated shipping labels
```

## Common Workflows

### Adding Products
1. Navigate to `/admin/import` (requires admin login)
2. Upload CSV with headers: `name, brand, sku, size, description, image_url, highest_market_price`
3. Only allowed brands pass validation during import

### Creating Auctions
POST to `/admin/auctions` with:
- `product_id`: Target product
- `starting_bid`: Minimum bid amount
Auctions automatically last 10 days from creation.

### Managing Stripe Integration
1. Set `STRIPE_SECRET_KEY` in `.env` for basic checkout
2. For fund routing to connected accounts:
   - Set `STRIPE_CONNECT_CLIENT_ID`
   - Visit `/admin/connect` to initiate OAuth
   - Connected account ID stored in `settings` table
3. Configure webhook endpoint with `STRIPE_WEBHOOK_SECRET` for payment confirmation

### Shipping Label Generation
Admin workflow (POST `/admin/orders/:id/create-label`):
- **Live FedEx**: Requires all env vars set (`FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET`, `FEDEX_ACCOUNT_NUMBER`, `SHIP_FROM_*` address)
- **Fallback**: Generates placeholder PDF using pdfkit if any credentials missing
- Labels saved to `labels/` directory
- Tracking numbers and addresses stored in `shipments` table

## Environment Variables

Required for production:
```
SESSION_SECRET              # Session encryption key
STRIPE_SECRET_KEY           # Stripe API key (sk_test_... or sk_live_...)
STRIPE_WEBHOOK_SECRET       # Webhook signature verification (whsec_...)
```

Optional features:
```
STRIPE_CONNECT_CLIENT_ID    # For Stripe Connect fund routing
PORT                        # Server port (default: 3000)

# FedEx integration (all required for live labels)
FEDEX_CLIENT_ID
FEDEX_CLIENT_SECRET
FEDEX_ACCOUNT_NUMBER
SHIP_FROM_NAME
SHIP_FROM_ADDRESS1
SHIP_FROM_ADDRESS2
SHIP_FROM_CITY
SHIP_FROM_STATE
SHIP_FROM_ZIP
SHIP_FROM_COUNTRY
```

## Important Constraints & Design Decisions

### Brand Restrictions
The application explicitly avoids scraping StockX or Google due to Terms of Service violations. Product data must be imported via CSV or partner APIs. Brand validation enforces only premium sneaker brands.

### Bidding Rules
- Increments: Exactly $100 (enforced server-side)
- Minimum bid: Current bid + $100 (or starting bid if no bids)
- Only current highest bidder can initiate checkout before auction end

### Order Types
Two distinct purchase flows:
1. **auction**: Traditional bidding with 10-day duration
2. **buy_now**: Immediate purchase at fixed price (if `buy_it_now_price` > 0)

Both types stored in `orders` table with `order_type` field.

### Featured Products
Products can be marked as "featured" (`is_featured = 1`) for homepage prominence. Toggle via POST `/products/:id/toggle-featured`.

### Multi-Image Support
Products support multiple images via `product_images` table:
- API endpoints: `/api/products/:id/images` (GET, POST, DELETE)
- Images ordered by `display_order` field
- Primary image stored in `products.image_url` for backward compatibility

## Database Conventions

### Timestamps
All timestamps use ISO 8601 format via `dayjs().toISOString()`:
- `auctions`: `start_time`, `end_time`
- `bids`: `created_at`
- `orders`: `created_at`
- `product_images`: `created_at`

### Money Handling
All currency values stored as **integer cents** (not dollars):
- `products.highest_market_price`
- `products.buy_it_now_price`
- `auctions.starting_bid`, `auctions.current_bid`
- `orders.amount`

Stripe amounts converted: `amount * 100` for API calls.

### Foreign Key Relationships
- `auctions.product_id` → `products.id`
- `bids.auction_id` → `auctions.id`
- `bids.user_id` → `users.id`
- `orders.auction_id` → `auctions.id` (nullable for buy_now orders)
- `orders.product_id` → `products.id` (nullable for auction orders)
- `orders.user_id` → `users.id`
- `shipments.order_id` → `orders.id`
- `product_images.product_id` → `products.id` (CASCADE DELETE)

## Testing Notes

**No formal test suite exists.** To verify functionality:

1. **Manual Testing**: Run server and test flows in browser
2. **Database Inspection**: Query `data.sqlite` directly with SQLite CLI
3. **Webhook Testing**: Use Stripe CLI for webhook forwarding:
   ```bash
   stripe listen --forward-to localhost:3000/webhook/stripe
   ```

When adding features:
- Maintain the monolithic architecture unless refactoring is explicitly requested
- Preserve session-based auth patterns
- Follow existing naming conventions (snake_case for DB, camelCase for JS)
- Ensure admin routes use `ensureAdmin` middleware
- Test brand validation for any product modification endpoints
