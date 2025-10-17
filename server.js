import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import dayjs from 'dayjs';
import Stripe from 'stripe';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import winston from 'winston';
import cors from 'cors';
import Razorpay from 'razorpay';
import ShippingManager from './services/shippingManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_secret';
// Stripe will be initialized after logger is defined
let stripe = null;

// Initialize Razorpay
const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) 
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    })
  : null;

// Initialize Shipping Manager (will be created after logger is defined)
let shippingManager = null;

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'sneaker-auction' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    ...(process.env.NODE_ENV !== 'production' ? [new winston.transports.Console({
      format: winston.format.simple()
    })] : [])
  ]
});

// Initialize Stripe with proper error handling
if (process.env.STRIPE_SECRET_KEY && 
    !process.env.STRIPE_SECRET_KEY.includes('YOUR_ACTUAL') && 
    !process.env.STRIPE_SECRET_KEY.includes('1234567890')) {
  try {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    logger.info('Stripe initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Stripe:', error.message);
    stripe = null;
  }
} else {
  logger.warn('Stripe not configured - using placeholder keys. Update .env with real keys from dashboard.stripe.com/test/apikeys');
}

// Initialize Shipping Manager with logger
shippingManager = new ShippingManager(logger);

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes  
  max: 10, // limit each IP to 10 requests per windowMs for sensitive endpoints
  message: 'Too many attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// DB setup - Use cloud-appropriate database path
const dbPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/data.sqlite'  // Use /tmp for temporary storage in cloud
  : path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  is_admin INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  sku TEXT,
  size TEXT,
  description TEXT,
  image_url TEXT,
  highest_market_price INTEGER DEFAULT 0,
  is_featured INTEGER DEFAULT 0,
  buy_it_now_price INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  starting_bid INTEGER NOT NULL,
  current_bid INTEGER,
  current_bid_user_id INTEGER,
  status TEXT DEFAULT 'open',
  FOREIGN KEY(product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(auction_id) REFERENCES auctions(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER,
  product_id INTEGER,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  order_type TEXT DEFAULT 'auction',
  status TEXT DEFAULT 'pending',
  stripe_session_id TEXT,
  payment_intent_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(auction_id) REFERENCES auctions(id),
  FOREIGN KEY(product_id) REFERENCES products(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  carrier TEXT,
  tracking_number TEXT,
  label_pdf_path TEXT,
  status TEXT DEFAULT 'pending',
  to_name TEXT,
  to_address1 TEXT,
  to_address2 TEXT,
  to_city TEXT,
  to_state TEXT,
  to_zip TEXT,
  to_country TEXT,
  box_length INTEGER,
  box_width INTEGER,
  box_height INTEGER,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  image_url TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
`);

// Add is_featured column if it doesn't exist (migration)
try {
  db.exec('ALTER TABLE products ADD COLUMN is_featured INTEGER DEFAULT 0');
  console.log('Added is_featured column to products table');
} catch (e) {
  // Column already exists, ignore error
}

// Add buy_it_now_price column if it doesn't exist (migration)
try {
  db.exec('ALTER TABLE products ADD COLUMN buy_it_now_price INTEGER DEFAULT 0');
  console.log('Added buy_it_now_price column to products table');
} catch (e) {
  // Column already exists, ignore error
}

// Add product_id and order_type columns to orders if they don't exist (migration)
try {
  db.exec('ALTER TABLE orders ADD COLUMN product_id INTEGER');
  db.exec('ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT \'auction\'');
  logger.info('Added product_id and order_type columns to orders table');
} catch (e) {
  // Columns already exist, ignore error
}

// Add payment gateway columns to orders if they don't exist (migration)
try {
  db.exec('ALTER TABLE orders ADD COLUMN payment_gateway TEXT DEFAULT \'stripe\'');
  db.exec('ALTER TABLE orders ADD COLUMN gateway_transaction_id TEXT');
  db.exec('ALTER TABLE orders ADD COLUMN gateway_fees DECIMAL(10,2)');
  logger.info('Added payment gateway columns to orders table');
} catch (e) {
  // Columns already exist, ignore error
}

// Add product status and availability columns if they don't exist (migration)
try {
  db.exec('ALTER TABLE products ADD COLUMN status TEXT DEFAULT \'available\'');
  db.exec('ALTER TABLE products ADD COLUMN is_available INTEGER DEFAULT 1');
  logger.info('Added status and availability columns to products table');
} catch (e) {
  // Columns already exist, ignore error
}

// Create gateway analytics table if it doesn't exist
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway_name TEXT NOT NULL,
      transaction_count INTEGER DEFAULT 0,
      success_rate DECIMAL(5,2) DEFAULT 0,
      average_fee DECIMAL(5,2) DEFAULT 0,
      total_volume DECIMAL(15,2) DEFAULT 0,
      date DATE NOT NULL,
      UNIQUE(gateway_name, date)
    );
  `);
  logger.info('Gateway analytics table created');
} catch (e) {
  logger.error('Failed to create gateway analytics table:', e.message);
}

// Create comprehensive shipping tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipping_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      carrier TEXT NOT NULL,
      service_code TEXT NOT NULL,
      service_name TEXT NOT NULL,
      cost DECIMAL(10,2) NOT NULL,
      currency TEXT DEFAULT 'USD',
      transit_time TEXT,
      delivery_date TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id)
    );
    
    CREATE TABLE IF NOT EXISTS shipping_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      carrier TEXT NOT NULL,
      label_url TEXT,
      label_data TEXT,
      label_format TEXT DEFAULT 'PDF',
      created_at TEXT NOT NULL,
      FOREIGN KEY(shipment_id) REFERENCES shipments(id)
    );
    
    CREATE TABLE IF NOT EXISTS tracking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      event_date TEXT NOT NULL,
      event_time TEXT,
      description TEXT NOT NULL,
      location TEXT,
      status_code TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(shipment_id) REFERENCES shipments(id)
    );
    
    CREATE TABLE IF NOT EXISTS shipping_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'from' or 'to'
      name TEXT NOT NULL,
      company TEXT,
      address_line1 TEXT NOT NULL,
      address_line2 TEXT,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      country TEXT DEFAULT 'US',
      phone TEXT,
      email TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id)
    );
  `);
  logger.info('Shipping tables created successfully');
} catch (e) {
  logger.error('Failed to create shipping tables:', e.message);
}

// Add enhanced shipping columns to shipments table
try {
  db.exec('ALTER TABLE shipments ADD COLUMN service_code TEXT');
  db.exec('ALTER TABLE shipments ADD COLUMN service_name TEXT');
  db.exec('ALTER TABLE shipments ADD COLUMN shipping_cost DECIMAL(10,2)');
  db.exec('ALTER TABLE shipments ADD COLUMN weight DECIMAL(8,2)');
  db.exec('ALTER TABLE shipments ADD COLUMN insurance_value DECIMAL(10,2)');
  db.exec('ALTER TABLE shipments ADD COLUMN signature_required INTEGER DEFAULT 0');
  db.exec('ALTER TABLE shipments ADD COLUMN estimated_delivery TEXT');
  db.exec('ALTER TABLE shipments ADD COLUMN actual_delivery TEXT');
  db.exec('ALTER TABLE shipments ADD COLUMN created_at TEXT');
  db.exec('ALTER TABLE shipments ADD COLUMN updated_at TEXT');
  logger.info('Added enhanced shipping columns to shipments table');
} catch (e) {
  // Columns already exist, ignore error
}

// Create performance indexes
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
    CREATE INDEX IF NOT EXISTS idx_auctions_end_time ON auctions(end_time);
    CREATE INDEX IF NOT EXISTS idx_auctions_product_id ON auctions(product_id);
    CREATE INDEX IF NOT EXISTS idx_bids_auction_id ON bids(auction_id);
    CREATE INDEX IF NOT EXISTS idx_bids_user_id ON bids(user_id);
    CREATE INDEX IF NOT EXISTS idx_bids_created_at ON bids(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
    CREATE INDEX IF NOT EXISTS idx_products_is_featured ON products(is_featured);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_shipments_tracking_number ON shipments(tracking_number);
    CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
    CREATE INDEX IF NOT EXISTS idx_shipments_carrier ON shipments(carrier);
    CREATE INDEX IF NOT EXISTS idx_shipping_rates_order_id ON shipping_rates(order_id);
    CREATE INDEX IF NOT EXISTS idx_tracking_events_shipment_id ON tracking_events(shipment_id);
    CREATE INDEX IF NOT EXISTS idx_shipping_addresses_order_id ON shipping_addresses(order_id);
  `);
  logger.info('Database indexes created successfully');
} catch (e) {
  logger.warn('Some indexes may already exist:', e.message);
}

// Security middleware (adjusted for development)
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "https://js.stripe.com", "https://www.paypal.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://api.stripe.com"]
    }
  } : false, // Disable CSP in development for easier testing
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: isProduction 
    ? ['https://*.onrender.com', 'https://*.railway.app'] 
    : true, // Allow all origins in development
  credentials: true
}));

// Apply rate limiting (only in production)
if (process.env.NODE_ENV === 'production') {
  app.use(limiter);
  app.use('/admin', strictLimiter);
  app.use('/login', strictLimiter);
  app.use('/register', strictLimiter);
  app.use('/bid', strictLimiter);
  logger.info('Rate limiting enabled for production');
} else {
  logger.info('Rate limiting disabled for development');
}

// Express setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({ 
  secret: SESSION_SECRET, 
  resave: false, 
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Multer for CSV uploads - use /tmp in production
const uploadsDir = process.env.NODE_ENV === 'production' 
  ? '/tmp/uploads' 
  : path.join(__dirname, 'uploads');

// Ensure directories exist in production
if (process.env.NODE_ENV === 'production') {
  ['/tmp/uploads', '/tmp/labels'].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

const upload = multer({ dest: uploadsDir });

// Input validation middleware
function validateErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Validation errors:', { errors: errors.array(), ip: req.ip });
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

// Helpers
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  logger.info('Unauthorized access attempt', { ip: req.ip, path: req.path });
  res.redirect('/login');
}
function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.is_admin) return next();
  logger.warn('Admin access denied', { user: req.session.user?.email, ip: req.ip });
  res.status(403).send('Forbidden');
}

// Fraud detection helper
function detectSuspiciousActivity(req, action, details = {}) {
  const suspiciousPatterns = {
    rapidRequests: req.rateLimit?.current > 50,
    newUserHighValue: details.amount > 1000 && req.session.user?.created_recently,
    unusualHours: new Date().getHours() < 6 || new Date().getHours() > 23
  };
  
  if (Object.values(suspiciousPatterns).some(Boolean)) {
    logger.warn('Suspicious activity detected', {
      action,
      user: req.session.user?.email,
      ip: req.ip,
      patterns: suspiciousPatterns,
      details
    });
  }
}
function allowedBrand(brand) {
  const b = String(brand || '').toLowerCase();
  return [
    'nike', 'adidas', 'reebok', 'new balance',
    'jordan', 'yeezy', 'off-white', 'supreme', 
    'travis scott', 'balenciaga', 'golden goose',
    'fragment', 'sacai', 'human race'
  ].some(x => b === x || b.includes(x));
}

// Settings helpers
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (existing) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

// Seed admin if none
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (email, password_hash, name, is_admin) VALUES (?,?,?,1)')
    .run('admin@example.com', hash, 'Admin');
  console.log('Seeded admin user: admin@example.com / admin123');
}

// Auth routes
app.get('/register', (req, res) => {
  res.render('auth/register', { user: req.session.user, error: null });
});
app.post('/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.render('auth/register', { user: null, error: 'Email and password required' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const info = db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?,?,?)')
      .run(email.trim(), hash, name || null);
    req.session.user = { id: info.lastInsertRowid, email, name, is_admin: 0 };
    res.redirect('/');
  } catch (e) {
    res.render('auth/register', { user: null, error: 'Email already in use' });
  }
});
app.get('/login', (req, res) => {
  res.render('auth/login', { user: req.session.user, error: null });
});
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.render('auth/login', { user: null, error: 'Invalid credentials' });
  }
  req.session.user = { id: u.id, email: u.email, name: u.name, is_admin: !!u.is_admin };
  res.redirect('/');
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Home: list open auctions
app.get('/', (req, res) => {
  const brandFilter = req.query.brand;
  
  // Get featured products with active auctions (filter by brand if specified)
  let featuredAuctionsQuery = `
    SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price, p.description
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    WHERE a.status = 'open' AND p.is_featured = 1
  `;
  
  if (brandFilter) {
    featuredAuctionsQuery += ` AND p.brand = ?`;
  }
  
  featuredAuctionsQuery += `
    ORDER BY datetime(a.end_time) ASC
    LIMIT 3
  `;
  
  const featuredAuctions = brandFilter 
    ? db.prepare(featuredAuctionsQuery).all(brandFilter)
    : db.prepare(featuredAuctionsQuery).all();
  
  // Fallback: featured products even if they don't currently have an open auction
  let featuredProductsQuery = `
    SELECT p.*
    FROM products p
    WHERE p.is_featured = 1
  `;
  
  if (brandFilter) {
    featuredProductsQuery += ` AND p.brand = ?`;
  }
  
  featuredProductsQuery += `
    ORDER BY p.id DESC
    LIMIT 3
  `;
  
  const featuredProducts = brandFilter 
    ? db.prepare(featuredProductsQuery).all(brandFilter)
    : db.prepare(featuredProductsQuery).all();

  // Get all open auctions (filter by brand if specified)
  let auctionsQuery = `
    SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    WHERE a.status = 'open'
  `;
  
  if (brandFilter) {
    auctionsQuery += ` AND p.brand = ?`;
  }
  
  auctionsQuery += `
    ORDER BY datetime(a.end_time) ASC
  `;
  
  const auctions = brandFilter 
    ? db.prepare(auctionsQuery).all(brandFilter)
    : db.prepare(auctionsQuery).all();
  
  // Get popular brands with one product each
  const popularBrands = db.prepare(`
    WITH brand_counts AS (
      SELECT brand, COUNT(*) as product_count
      FROM products 
      GROUP BY brand
      HAVING COUNT(*) > 0
      ORDER BY COUNT(*) DESC
      LIMIT 6
    )
    SELECT DISTINCT p.*, bc.product_count
    FROM brand_counts bc
    JOIN products p ON p.brand = bc.brand
    WHERE p.id = (
      SELECT id FROM products p2 
      WHERE p2.brand = bc.brand 
      ORDER BY p2.highest_market_price DESC, p2.id DESC 
      LIMIT 1
    )
    ORDER BY bc.product_count DESC, p.highest_market_price DESC
  `).all();
  
  res.render('home', { 
    user: req.session.user, 
    auctions, 
    featuredAuctions, 
    featuredProducts, 
    popularBrands, 
    brandFilter, 
    dayjs 
  });
});

// Product/Auction detail
app.get('/auction/:id', (req, res) => {
  const id = Number(req.params.id);
  const auction = db.prepare(`
    SELECT a.*, p.*,
      a.id as auction_id,
      p.id as product_id
    FROM auctions a JOIN products p ON p.id = a.product_id WHERE a.id = ?
  `).get(id);
  if (!auction) return res.status(404).send('Auction not found');
  const bids = db.prepare(`SELECT b.*, u.email FROM bids b JOIN users u ON u.id = b.user_id WHERE auction_id = ? ORDER BY datetime(created_at) DESC`).all(id);
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order, id').all(auction.product_id);
  res.render('auction', { user: req.session.user, auction, bids, images, dayjs });
});

// Place bid
app.post('/auction/:id/bid', ensureAuth, (req, res) => {
  const id = Number(req.params.id);
  const { amount } = req.body;
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(id);
  if (!auction) return res.status(404).send('Not found');
  const now = dayjs();
  if (dayjs(auction.end_time).isBefore(now) || auction.status !== 'open') {
    return res.status(400).send('Auction ended');
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).send('Invalid amount');
  if (amt % 5 !== 0) return res.status(400).send('Bids must be in increments of 5');
  const min = Math.max(auction.starting_bid, auction.current_bid || 0) + 5;
  if (amt < min) return res.status(400).send(`Minimum next bid is ${min}`);

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO bids (auction_id, user_id, amount, created_at) VALUES (?,?,?,?)')
      .run(id, req.session.user.id, amt, dayjs().toISOString());
    db.prepare('UPDATE auctions SET current_bid = ?, current_bid_user_id = ? WHERE id = ?')
      .run(amt, req.session.user.id, id);
  });
  tx();
  res.redirect('/auction/' + id);
});

// Checkout for winning bidder (or allow immediate checkout by current highest)
app.post('/checkout/:auctionId', ensureAuth, async (req, res) => {
  const auctionId = Number(req.params.auctionId);
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
  if (!auction) return res.status(404).send('Not found');
  if (!auction.current_bid || auction.current_bid_user_id !== req.session.user.id) {
    return res.status(400).send('Only current highest bidder can checkout');
  }
  if (!stripe) return res.status(500).send('Stripe not configured');

  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(auction.product_id);
  const connectedId = getSetting('stripe_connected_account_id');
  // Create order placeholder
  const orderRes = db.prepare('INSERT INTO orders (auction_id, user_id, amount, status, created_at) VALUES (?,?,?,?,?)')
    .run(auctionId, req.session.user.id, auction.current_bid, 'pending', dayjs().toISOString());
  const orderId = orderRes.lastInsertRowid;

  try {
    const sessionCreate = {
      mode: 'payment',
      payment_method_types: ['card', 'us_bank_account'],
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${prod.brand} ${prod.name} (Auction #${auctionId})` },
          unit_amount: auction.current_bid * 100
        },
        quantity: 1
      }],
      success_url: `${req.protocol}://${req.get('host')}/order/${orderId}/success`,
      cancel_url: `${req.protocol}://${req.get('host')}/order/${orderId}/cancel`
    };

    if (connectedId) {
      // Route funds to connected account
      sessionCreate.payment_intent_data = {
        transfer_data: { destination: connectedId }
      };
    }

    const session = await stripe.checkout.sessions.create(sessionCreate);
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
    res.redirect(session.url);
  } catch (e) {
    console.error(e);
    res.status(500).send('Stripe error');
  }
});

// Buy It Now - Direct purchase bypassing auction
app.post('/buy-now/:productId', ensureAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  
  if (!product) return res.status(404).send('Product not found');
  if (!product.buy_it_now_price || product.buy_it_now_price <= 0) {
    return res.status(400).send('Buy It Now not available for this product');
  }
  if (!stripe) return res.status(500).send('Stripe not configured');
  
  const connectedId = getSetting('stripe_connected_account_id');
  
  // Create order placeholder for Buy It Now
  const orderRes = db.prepare('INSERT INTO orders (product_id, user_id, amount, order_type, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(productId, req.session.user.id, product.buy_it_now_price, 'buy_now', 'pending', dayjs().toISOString());
  const orderId = orderRes.lastInsertRowid;
  
  try {
    const sessionCreate = {
      mode: 'payment',
      payment_method_types: ['card', 'cashapp', 'us_bank_account', 'paypal'],
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${product.brand} ${product.name} - Buy It Now`,
            description: product.description || 'Premium sneaker'
          },
          unit_amount: product.buy_it_now_price * 100
        },
        quantity: 1
      }],
      success_url: `${req.protocol}://${req.get('host')}/order/${orderId}/success`,
      cancel_url: `${req.protocol}://${req.get('host')}/order/${orderId}/cancel`
    };
    
    if (connectedId) {
      sessionCreate.payment_intent_data = {
        transfer_data: { destination: connectedId }
      };
    }
    
    const session = await stripe.checkout.sessions.create(sessionCreate);
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
    res.redirect(session.url);
  } catch (e) {
    console.error(e);
    res.status(500).send('Stripe error: ' + e.message);
  }
});

// Order status pages
app.get('/order/:id/success', ensureAuth, (req, res) => {
  const orderId = Number(req.params.id);
  
  // Get order details
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.session.user.id);
  if (!order) {
    return res.status(404).send('Order not found');
  }
  
  // Get product details
  let product = null;
  if (order.auction_id) {
    // Auction-based order
    const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(order.auction_id);
    if (auction) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(auction.product_id);
    }
  } else if (order.product_id) {
    // Direct buy-now order
    product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  }
  
  res.render('order-success', { 
    user: req.session.user, 
    order, 
    product,
    dayjs
  });
});

app.get('/order/:id/cancel', ensureAuth, (req, res) => {
  const orderId = Number(req.params.id);
  
  // Get order details (optional - may not exist if user canceled before order creation)
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.session.user.id);
  
  // Get product details if order exists
  let product = null;
  if (order) {
    if (order.auction_id) {
      const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(order.auction_id);
      if (auction) {
        product = db.prepare('SELECT * FROM products WHERE id = ?').get(auction.product_id);
      }
    } else if (order.product_id) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    }
  }
  
  res.render('order-cancel', { 
    user: req.session.user, 
    order, 
    product,
    dayjs
  });
});

// Razorpay order creation
app.post('/payment/razorpay/create-order', ensureAuth, async (req, res) => {
  if (!razorpay) {
    return res.status(500).json({ error: 'Razorpay not configured' });
  }

  try {
    const { amount, currency = 'USD', auctionId, productId } = req.body;
    const userId = req.session.user.id;

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Create Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to smallest currency unit
      currency: currency,
      receipt: `receipt_${Date.now()}_${userId}`,
      payment_capture: 1,
      notes: {
        auction_id: auctionId,
        product_id: productId,
        user_id: userId
      }
    });

    // Create pending order in database
    const orderId = db.prepare(
      'INSERT INTO orders (auction_id, product_id, user_id, amount, order_type, status, payment_gateway, gateway_transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      auctionId || null,
      productId || null,
      userId,
      amount,
      auctionId ? 'auction' : 'buy_now',
      'pending',
      'razorpay',
      razorpayOrder.id,
      new Date().toISOString()
    ).lastInsertRowid;

    logger.info('Razorpay order created', {
      orderId,
      razorpayOrderId: razorpayOrder.id,
      amount,
      user: req.session.user.email
    });

    res.json({
      success: true,
      orderId,
      razorpayOrder: {
        id: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency
      }
    });
  } catch (error) {
    logger.error('Razorpay order creation failed', {
      error: error.message,
      user: req.session.user.email
    });
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// Razorpay payment verification
app.post('/payment/razorpay/verify', ensureAuth, async (req, res) => {
  if (!razorpay) {
    return res.status(500).json({ error: 'Razorpay not configured' });
  }

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Verify payment signature
    const crypto = await import('crypto');
    const expectedSignature = crypto.default
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      logger.warn('Razorpay signature verification failed', {
        expected: expectedSignature,
        received: razorpay_signature,
        user: req.session.user.email
      });
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Update order status
    const order = db.prepare('SELECT * FROM orders WHERE gateway_transaction_id = ? AND user_id = ?')
      .get(razorpay_order_id, req.session.user.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Fetch payment details from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const fees = payment.fee ? payment.fee / 100 : 0; // Convert from paise to currency

    // Update order with payment confirmation
    db.prepare(
      'UPDATE orders SET status = ?, gateway_transaction_id = ?, gateway_fees = ? WHERE id = ?'
    ).run('paid', razorpay_payment_id, fees, order.id);

    // Update gateway analytics
    updateGatewayAnalytics('razorpay', order.amount, fees, true);

    logger.info('Razorpay payment verified', {
      orderId: order.id,
      paymentId: razorpay_payment_id,
      amount: order.amount,
      fees,
      user: req.session.user.email
    });

    res.json({ success: true, orderId: order.id });
  } catch (error) {
    logger.error('Razorpay payment verification failed', {
      error: error.message,
      user: req.session.user.email
    });
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// Gateway analytics helper function
function updateGatewayAnalytics(gatewayName, amount, fees, success) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get existing analytics for today
    const existing = db.prepare(
      'SELECT * FROM gateway_analytics WHERE gateway_name = ? AND date = ?'
    ).get(gatewayName, today);

    if (existing) {
      // Update existing record
      const newCount = existing.transaction_count + 1;
      const newVolume = existing.total_volume + amount;
      const newSuccessRate = success 
        ? ((existing.success_rate * existing.transaction_count) + 100) / newCount
        : (existing.success_rate * existing.transaction_count) / newCount;
      const newAvgFee = ((existing.average_fee * existing.transaction_count) + fees) / newCount;

      db.prepare(
        'UPDATE gateway_analytics SET transaction_count = ?, success_rate = ?, average_fee = ?, total_volume = ? WHERE id = ?'
      ).run(newCount, newSuccessRate, newAvgFee, newVolume, existing.id);
    } else {
      // Create new record
      db.prepare(
        'INSERT INTO gateway_analytics (gateway_name, transaction_count, success_rate, average_fee, total_volume, date) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(gatewayName, 1, success ? 100 : 0, fees, amount, today);
    }
  } catch (error) {
    logger.error('Failed to update gateway analytics', { error: error.message });
  }
}

// Stripe webhook (set STRIPE_WEBHOOK_SECRET)
app.post('/webhook/stripe', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed', err);
    return res.sendStatus(400);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(session.id);
    if (order) {
      db.prepare('UPDATE orders SET status = ?, payment_intent_id = ? WHERE id = ?')
        .run('paid', session.payment_intent || null, order.id);

      // Capture shipping details into a shipment record (if provided by Checkout)
      const ship = session.shipping_details || session.customer_details || null;
      if (ship && ship.address) {
        const addr = ship.address;
        
        // Store shipping address
        db.prepare(`
          INSERT INTO shipping_addresses (
            order_id, type, name, address_line1, address_line2, 
            city, state, postal_code, country, phone, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          order.id,
          'to',
          ship.name || 'Customer',
          addr.line1 || null,
          addr.line2 || null,
          addr.city || null,
          addr.state || addr.state_province || null,
          addr.postal_code || null,
          addr.country || 'US',
          ship.phone || null,
          dayjs().toISOString()
        );
        
        // Auto-generate shipping label if enabled
        if (process.env.AUTO_GENERATE_LABELS === 'true') {
          setTimeout(async () => {
            try {
              await autoGenerateShippingLabel(order.id);
            } catch (error) {
              logger.error('Auto shipping label generation failed:', {
                orderId: order.id,
                error: error.message
              });
            }
          }, 2000); // Small delay to ensure all data is committed
        }
      }
    }
  }
  res.sendStatus(200);
});

// Helper function for automatic shipping label generation
async function autoGenerateShippingLabel(orderId) {
  try {
    logger.info('Starting auto shipping label generation', { orderId });
    
    // Check if shipment already exists
    const existingShipment = db.prepare('SELECT id FROM shipments WHERE order_id = ?').get(orderId);
    if (existingShipment) {
      logger.info('Shipment already exists, skipping auto-generation', { orderId });
      return;
    }
    
    // Get order details
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = \'paid\'').get(orderId);
    if (!order) {
      throw new Error('Order not found or not paid');
    }
    
    // Get product details
    let product = null;
    if (order.auction_id) {
      const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(order.auction_id);
      if (auction) {
        product = db.prepare('SELECT * FROM products WHERE id = ?').get(auction.product_id);
      }
    } else if (order.product_id) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    }
    
    if (!product) {
      throw new Error('Product not found');
    }
    
    // Get shipping address
    const shippingAddress = db.prepare(`
      SELECT * FROM shipping_addresses 
      WHERE order_id = ? AND type = 'to' 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(orderId);
    
    if (!shippingAddress) {
      throw new Error('No shipping address found');
    }
    
    // Build addresses
    const fromAddress = {
      name: process.env.SHIP_FROM_NAME || 'Khloe\'s Kicks',
      line1: process.env.SHIP_FROM_ADDRESS1 || '123 Sneaker Street',
      line2: process.env.SHIP_FROM_ADDRESS2 || '',
      city: process.env.SHIP_FROM_CITY || 'Fashion City',
      state: process.env.SHIP_FROM_STATE || 'CA',
      zip: process.env.SHIP_FROM_ZIP || '90210',
      country: process.env.SHIP_FROM_COUNTRY || 'US',
      phone: process.env.SHIP_FROM_PHONE || '5551234567'
    };
    
    const toAddress = {
      name: shippingAddress.name,
      line1: shippingAddress.address_line1,
      line2: shippingAddress.address_line2,
      city: shippingAddress.city,
      state: shippingAddress.state,
      zip: shippingAddress.postal_code,
      country: shippingAddress.country || 'US',
      phone: shippingAddress.phone || '5551234567'
    };
    
    // Build shipment details
    const shipmentDetails = shippingManager.buildShipmentDetails(
      order, product, fromAddress, toAddress
    );
    
    // Create optimal shipment
    const labelResult = await shippingManager.createOptimalShipment(shipmentDetails);
    
    // Create shipment record
    const shipmentId = db.prepare(`
      INSERT INTO shipments (
        order_id, carrier, service_code, tracking_number, 
        shipping_cost, weight, status, to_name, to_address1, to_address2, 
        to_city, to_state, to_zip, to_country, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      labelResult.carrier,
      'AUTO',
      labelResult.trackingNumber,
      labelResult.cost,
      shipmentDetails.weight,
      'created',
      toAddress.name,
      toAddress.line1,
      toAddress.line2 || null,
      toAddress.city,
      toAddress.state,
      toAddress.zip,
      toAddress.country,
      dayjs().toISOString(),
      dayjs().toISOString()
    ).lastInsertRowid;
    
    // Store shipping label if available
    if (labelResult.labelUrl) {
      db.prepare(`
        INSERT INTO shipping_labels (shipment_id, carrier, label_url, label_format, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        shipmentId,
        labelResult.carrier,
        labelResult.labelUrl,
        'PDF',
        dayjs().toISOString()
      );
    }
    
    logger.info('Auto shipping label generated successfully', {
      orderId,
      shipmentId,
      carrier: labelResult.carrier,
      trackingNumber: labelResult.trackingNumber,
      cost: labelResult.cost
    });
    
    // Send shipping notification email (if email is configured)
    if (process.env.SMTP_HOST && process.env.FROM_EMAIL) {
      try {
        const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(order.user_id);
        if (user?.email) {
          await sendShippingNotification({
            orderId,
            trackingNumber: labelResult.trackingNumber,
            carrier: labelResult.carrier,
            customerEmail: user.email,
            customerName: user.name,
            productName: `${product.brand} ${product.name}`
          });
        }
      } catch (emailError) {
        logger.warn('Failed to send shipping notification email', {
          orderId,
          error: emailError.message
        });
      }
    }
    
    return {
      success: true,
      shipmentId,
      trackingNumber: labelResult.trackingNumber,
      carrier: labelResult.carrier,
      cost: labelResult.cost
    };
    
  } catch (error) {
    logger.error('Auto shipping label generation failed', {
      orderId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// Simple email notification function (placeholder)
async function sendShippingNotification(details) {
  logger.info('Shipping notification would be sent', {
    to: details.customerEmail,
    trackingNumber: details.trackingNumber,
    carrier: details.carrier
  });
  
  // In a real implementation, you would use a service like:
  // - NodeMailer with SMTP
  // - SendGrid API
  // - AWS SES
  // - Mailgun API
  
  // Example email content:
  const emailContent = `
    Hi ${details.customerName || 'Customer'},
    
    Great news! Your order #${details.orderId} for ${details.productName} has shipped!
    
    Tracking Information:
    Carrier: ${details.carrier.toUpperCase()}
    Tracking Number: ${details.trackingNumber}
    
    Track your package: ${process.env.BASE_URL || 'http://localhost:3000'}/track/${details.trackingNumber}
    
    Thanks for shopping with Khloe's Kicks!
  `;
  
  // TODO: Implement actual email sending
  console.log('Email notification (placeholder):', {
    to: details.customerEmail,
    subject: `Your order #${details.orderId} has shipped!`,
    content: emailContent
  });
}

// Helper function to get Stripe Connect account details
async function getStripeConnectAccountDetails(accountId) {
  if (!stripe || !accountId) return null;
  
  try {
    const account = await stripe.accounts.retrieve(accountId);
    return {
      id: account.id,
      email: account.email,
      displayName: account.display_name || account.business_profile?.name,
      country: account.country,
      currency: account.default_currency,
      payoutsEnabled: account.payouts_enabled,
      chargesEnabled: account.charges_enabled,
      detailsSubmitted: account.details_submitted,
      type: account.type
    };
  } catch (error) {
    logger.error('Failed to retrieve Stripe account details:', error);
    return null;
  }
}

// Admin route to test Stripe Connect integration
app.get('/admin/connect/test', ensureAdmin, async (req, res) => {
  const connectedId = getSetting('stripe_connected_account_id');
  
  if (!connectedId) {
    return res.json({ 
      success: false, 
      error: 'No connected Stripe account found' 
    });
  }
  
  try {
    const accountDetails = await getStripeConnectAccountDetails(connectedId);
    
    if (!accountDetails) {
      return res.json({ 
        success: false, 
        error: 'Failed to retrieve account details from Stripe' 
      });
    }
    
    res.json({
      success: true,
      account: accountDetails,
      integration: {
        canProcessPayments: accountDetails.chargesEnabled && accountDetails.payoutsEnabled,
        readyForProduction: accountDetails.detailsSubmitted,
        accountType: accountDetails.type
      }
    });
    
  } catch (error) {
    logger.error('Stripe Connect test failed:', error);
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Stripe Connect onboarding (optional)
app.get('/admin/connect', ensureAdmin, async (req, res) => {
  const connectedId = getSetting('stripe_connected_account_id');
  const connectionData = getSetting('stripe_connection_data');
  const clientId = process.env.STRIPE_CLIENT_ID || 'acct_1SHckxHd2ZDTrw8M';
  
  let parsedConnectionData = null;
  try {
    parsedConnectionData = connectionData ? JSON.parse(connectionData) : null;
  } catch (e) {
    logger.warn('Failed to parse Stripe connection data', e);
  }
  
  // Get detailed account info from Stripe if connected
  let accountDetails = null;
  if (connectedId) {
    accountDetails = await getStripeConnectAccountDetails(connectedId);
  }
  
  res.render('admin/connect', { 
    user: req.session.user, 
    connectedId, 
    connectionData: parsedConnectionData,
    accountDetails,
    stripeClientId: clientId, 
    error: req.query.error || null,
    success: req.query.success || null,
    disconnected: req.query.disconnected || null
  });
});

app.post('/admin/connect/start', ensureAdmin, (req, res) => {
  // Use your Stripe client ID
  const clientId = process.env.STRIPE_CLIENT_ID || 'acct_1SHckxHd2ZDTrw8M';
  if (!clientId) return res.status(500).send('Stripe Connect not configured');
  
  const redirect = encodeURIComponent(`${req.protocol}://${req.get('host')}/admin/connect/callback`);
  const state = Math.random().toString(36).slice(2);
  
  // Store state for CSRF protection
  req.session.stripeConnectState = state;
  
  const url = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${redirect}&state=${state}`;
  
  logger.info('Stripe Connect initiated', {
    clientId,
    redirectUri: redirect,
    admin: req.session.user.email
  });
  
  res.redirect(url);
});

app.get('/admin/connect/callback', ensureAdmin, async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  const { code, error, state } = req.query;
  
  if (error) {
    logger.error('Stripe Connect OAuth error:', error);
    return res.status(400).send(`Stripe Connect error: ${error}`);
  }
  
  if (!code) return res.status(400).send('No authorization code received');
  
  // Validate state for CSRF protection
  if (!state || state !== req.session.stripeConnectState) {
    logger.warn('Stripe Connect state mismatch', { 
      expected: req.session.stripeConnectState, 
      received: state 
    });
    return res.status(400).send('Invalid state parameter');
  }
  
  try {
    const token = await stripe.oauth.token({ 
      grant_type: 'authorization_code', 
      code: code 
    });
    
    if (token && token.stripe_user_id) {
      // Save the connected account details
      const connectionData = {
        accountId: token.stripe_user_id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenType: token.token_type,
        scope: token.scope,
        connectedAt: new Date().toISOString(),
        connectedBy: req.session.user.email
      };
      
      // Save to settings
      setSetting('stripe_connected_account_id', token.stripe_user_id);
      setSetting('stripe_connection_data', JSON.stringify(connectionData));
      
      logger.info('Stripe Connect successful', {
        accountId: token.stripe_user_id,
        scope: token.scope,
        connectedBy: req.session.user.email
      });
      
      // Clear the state from session
      delete req.session.stripeConnectState;
      
      res.redirect('/admin/connect?success=1&account=' + token.stripe_user_id);
    } else {
      res.redirect('/admin/connect?error=no_account');
    }
  } catch (e) {
    logger.error('Stripe Connect token exchange error:', e);
    res.status(500).send('Stripe connect exchange failed');
  }
});

app.post('/admin/connect/disconnect', ensureAdmin, async (req, res) => {
  // For a full disconnect, you can deauthorize via stripe.oauth.deauthorize
  const connectedId = getSetting('stripe_connected_account_id');
  const clientId = process.env.STRIPE_CLIENT_ID || 'acct_1SHckxHd2ZDTrw8M';
  
  if (connectedId && clientId) {
    try {
      await stripe.oauth.deauthorize({ 
        client_id: clientId, 
        stripe_user_id: connectedId 
      });
      
      logger.info('Stripe Connect disconnected', {
        accountId: connectedId,
        disconnectedBy: req.session.user.email
      });
    } catch (e) {
      logger.warn('Stripe deauthorize failed or not permitted', {
        error: e.message,
        accountId: connectedId
      });
    }
  }
  
  // Clear all Stripe connection settings
  setSetting('stripe_connected_account_id', '');
  setSetting('stripe_connection_data', '');
  
  res.redirect('/admin/connect?disconnected=1');
});

// Admin: CSV import
app.get('/admin/import', ensureAdmin, (req, res) => {
  res.render('admin/import', { user: req.session.user, error: null, success: null });
});
app.post('/admin/import', ensureAdmin, upload.single('csv'), (req, res) => {
  if (!req.file) return res.render('admin/import', { user: req.session.user, error: 'No file', success: null });
  const buf = fs.readFileSync(req.file.path);
  const rows = parse(buf, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true, bom: true });
  let added = 0;
  const insert = db.prepare('INSERT INTO products (brand, name, sku, size, description, image_url, highest_market_price) VALUES (?,?,?,?,?,?,?)');
  for (const r of rows) {
    const brand = (r.brand || '').trim();
    if (!allowedBrand(brand)) continue;
    insert.run(
      brand,
      (r.name || '').trim(),
      (r.sku || '').trim(),
      (r.size || '').trim(),
      (r.description || '').trim(),
      (r.image_url || '').trim(),
      Number(r.highest_market_price || 0)
    );
    added++;
  }
  res.render('admin/import', { user: req.session.user, error: null, success: `Imported ${added} products` });
});

// Admin: create auction for a product
app.post('/admin/auctions', ensureAdmin, (req, res) => {
  const { product_id, starting_bid } = req.body;

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(Number(product_id));
  if (!product) {
    return res.status(404).send('Product not found');
  }

  const start = dayjs();
  const end = start.add(10, 'day');
  db.prepare('INSERT INTO auctions (product_id, start_time, end_time, starting_bid, status) VALUES (?,?,?,?,?)')
    .run(Number(product_id), start.toISOString(), end.toISOString(), Number(starting_bid || 0), 'open');
  res.redirect('/');
});

// Admin sales page
app.get('/admin/sales', ensureAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, a.id as auction_id, p.name as product_name, p.brand, u.email as buyer_email
    FROM orders o
    JOIN auctions a ON a.id = o.auction_id
    JOIN products p ON p.id = a.product_id
    JOIN users u ON u.id = o.user_id
    ORDER BY datetime(o.created_at) DESC
  `).all();
  const openBids = db.prepare(`
    SELECT a.id as auction_id, p.name as product_name, p.brand, a.current_bid, u.email as leader_email, a.end_time
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    LEFT JOIN users u ON u.id = a.current_bid_user_id
    WHERE a.status = 'open'
    ORDER BY datetime(a.end_time) ASC
  `).all();
  res.render('admin/sales', { user: req.session.user, orders, openBids, dayjs });
});

// Admin payment analytics page
app.get('/admin/analytics', ensureAdmin, (req, res) => {
  try {
    // Get gateway analytics for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const analytics = db.prepare(`
      SELECT 
        gateway_name,
        SUM(transaction_count) as total_transactions,
        AVG(success_rate) as avg_success_rate,
        AVG(average_fee) as avg_fee_rate,
        SUM(total_volume) as total_volume,
        MAX(date) as last_transaction_date
      FROM gateway_analytics 
      WHERE date >= ?
      GROUP BY gateway_name
      ORDER BY total_volume DESC
    `).all(thirtyDaysAgo.toISOString().split('T')[0]);

    // Get daily analytics for charts
    const dailyAnalytics = db.prepare(`
      SELECT 
        date,
        gateway_name,
        transaction_count,
        success_rate,
        total_volume
      FROM gateway_analytics
      WHERE date >= ?
      ORDER BY date DESC, gateway_name
    `).all(thirtyDaysAgo.toISOString().split('T')[0]);

    // Get recent orders by gateway
    const recentOrders = db.prepare(`
      SELECT 
        o.id,
        o.payment_gateway,
        o.amount,
        o.gateway_fees,
        o.status,
        o.created_at,
        u.email as user_email,
        p.name as product_name,
        p.brand
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN auctions a ON a.id = o.auction_id
      LEFT JOIN products p ON p.id = COALESCE(a.product_id, o.product_id)
      WHERE o.created_at >= datetime('now', '-30 days')
      ORDER BY o.created_at DESC
      LIMIT 100
    `).all();

    res.render('admin/analytics', { 
      user: req.session.user, 
      analytics, 
      dailyAnalytics, 
      recentOrders, 
      dayjs 
    });
  } catch (error) {
    logger.error('Failed to load payment analytics', { error: error.message });
    res.status(500).send('Failed to load analytics');
  }
});

// CSV Export Products
app.get('/admin/export/products', ensureAdmin, (req, res) => {
  try {
    const products = db.prepare(`
      SELECT 
        id,
        brand,
        name,
        sku,
        size,
        description,
        image_url,
        highest_market_price,
        is_featured,
        buy_it_now_price
      FROM products 
      ORDER BY brand, name
    `).all();

    // Convert to CSV format
    const csvHeaders = ['id', 'brand', 'name', 'sku', 'size', 'description', 'image_url', 'highest_market_price', 'is_featured', 'buy_it_now_price'];
    let csvContent = csvHeaders.join(',') + '\n';
    
    products.forEach(product => {
      const row = csvHeaders.map(header => {
        let value = product[header] || '';
        // Escape commas and quotes in CSV
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csvContent += row.join(',') + '\n';
    });

    // Set headers for file download
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `products-export-${timestamp}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    logger.info('CSV export requested', { 
      admin: req.session.user.email, 
      productsCount: products.length,
      filename 
    });
    
    res.send(csvContent);
  } catch (error) {
    logger.error('CSV export failed', { error: error.message, admin: req.session.user.email });
    res.status(500).send('Export failed: ' + error.message);
  }
});

// CSV Export Orders/Sales
app.get('/admin/export/orders', ensureAdmin, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT 
        o.id,
        o.order_type,
        p.brand,
        p.name as product_name,
        p.sku,
        p.size,
        o.amount,
        o.status,
        u.email as buyer_email,
        o.created_at,
        o.stripe_session_id,
        s.carrier as shipping_carrier,
        s.tracking_number,
        s.status as shipping_status
      FROM orders o
      LEFT JOIN auctions a ON a.id = o.auction_id
      LEFT JOIN products p ON p.id = COALESCE(a.product_id, o.product_id)
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN shipments s ON s.order_id = o.id
      ORDER BY datetime(o.created_at) DESC
    `).all();

    // Convert to CSV format
    const csvHeaders = ['id', 'order_type', 'brand', 'product_name', 'sku', 'size', 'amount', 'status', 'buyer_email', 'created_at', 'stripe_session_id', 'shipping_carrier', 'tracking_number', 'shipping_status'];
    let csvContent = csvHeaders.join(',') + '\n';
    
    orders.forEach(order => {
      const row = csvHeaders.map(header => {
        let value = order[header] || '';
        // Escape commas and quotes in CSV
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csvContent += row.join(',') + '\n';
    });

    // Set headers for file download
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `orders-export-${timestamp}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    logger.info('Orders CSV export requested', { 
      admin: req.session.user.email, 
      ordersCount: orders.length,
      filename 
    });
    
    res.send(csvContent);
  } catch (error) {
    logger.error('Orders CSV export failed', { error: error.message, admin: req.session.user.email });
    res.status(500).send('Export failed: ' + error.message);
  }
});

// CSV Export Auctions
app.get('/admin/export/auctions', ensureAdmin, (req, res) => {
  try {
    const auctions = db.prepare(`
      SELECT 
        a.id,
        p.brand,
        p.name as product_name,
        p.sku,
        p.size,
        a.start_time,
        a.end_time,
        a.starting_bid,
        a.current_bid,
        a.status,
        u.email as current_bidder_email,
        p.highest_market_price
      FROM auctions a
      JOIN products p ON p.id = a.product_id
      LEFT JOIN users u ON u.id = a.current_bid_user_id
      ORDER BY datetime(a.created_at) DESC
    `).all();

    // Convert to CSV format
    const csvHeaders = ['id', 'brand', 'product_name', 'sku', 'size', 'start_time', 'end_time', 'starting_bid', 'current_bid', 'status', 'current_bidder_email', 'highest_market_price'];
    let csvContent = csvHeaders.join(',') + '\n';
    
    auctions.forEach(auction => {
      const row = csvHeaders.map(header => {
        let value = auction[header] || '';
        // Escape commas and quotes in CSV
        if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
          value = '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
      });
      csvContent += row.join(',') + '\n';
    });

    // Set headers for file download
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `auctions-export-${timestamp}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    logger.info('Auctions CSV export requested', { 
      admin: req.session.user.email, 
      auctionsCount: auctions.length,
      filename 
    });
    
    res.send(csvContent);
  } catch (error) {
    logger.error('Auctions CSV export failed', { error: error.message, admin: req.session.user.email });
    res.status(500).send('Export failed: ' + error.message);
  }
});

// Admin: create shipping label (FedEx or placeholder)
app.post('/admin/orders/:id/create-label', ensureAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'paid') return res.status(400).send('Order not paid');

  const existingShip = db.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY id DESC').get(orderId);
  const to = existingShip || {};

  const haveFedexCreds = !!(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET && process.env.FEDEX_ACCOUNT_NUMBER);
  const haveToAddress = !!(to.to_name && to.to_address1 && to.to_city && to.to_state && to.to_zip && to.to_country);
  const haveFromAddress = !!(process.env.SHIP_FROM_NAME && process.env.SHIP_FROM_ADDRESS1 && process.env.SHIP_FROM_CITY && process.env.SHIP_FROM_STATE && process.env.SHIP_FROM_ZIP && process.env.SHIP_FROM_COUNTRY);

  // Try real FedEx label first if all inputs present; otherwise fallback to placeholder
  if (haveFedexCreds && haveToAddress && haveFromAddress) {
    try {
      // 1) OAuth token
      const tokenResp = await fetch('https://apis.fedex.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.FEDEX_CLIENT_ID,
          client_secret: process.env.FEDEX_CLIENT_SECRET
        })
      });
      const tokenData = await tokenResp.json();
      if (!tokenResp.ok || !tokenData.access_token) throw new Error('FedEx OAuth failed');

      // 2) Create shipment (simplified, may need adjustment based on your FedEx account)
      const shipReq = {
        labelResponseOptions: 'URL_ONLY',
        requestedShipment: {
          shipper: {
            contact: { personName: process.env.SHIP_FROM_NAME },
            address: {
              streetLines: [process.env.SHIP_FROM_ADDRESS1, process.env.SHIP_FROM_ADDRESS2 || ''].filter(Boolean),
              city: process.env.SHIP_FROM_CITY,
              stateOrProvinceCode: process.env.SHIP_FROM_STATE,
              postalCode: process.env.SHIP_FROM_ZIP,
              countryCode: process.env.SHIP_FROM_COUNTRY
            }
          },
          recipients: [{
            contact: { personName: to.to_name },
            address: {
              streetLines: [to.to_address1, to.to_address2 || ''].filter(Boolean),
              city: to.to_city,
              stateOrProvinceCode: to.to_state,
              postalCode: to.to_zip,
              countryCode: to.to_country
            }
          }],
          serviceType: 'FEDEX_GROUND',
          packagingType: 'YOUR_PACKAGING',
          shipDatestamp: new Date().toISOString().slice(0,10),
          requestedPackageLineItems: [{
            weight: { units: 'LB', value: 2 }
          }]
        },
        accountNumber: { value: process.env.FEDEX_ACCOUNT_NUMBER }
      };

      const shipResp = await fetch('https://apis.fedex.com/ship/v1/shipments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.access_token}`
        },
        body: JSON.stringify(shipReq)
      });
      const shipData = await shipResp.json();
      if (!shipResp.ok) throw new Error('FedEx shipment failed');

      const tracking = shipData?.output?.transactionShipments?.[0]?.masterTrackingNumber || 'UNKNOWN';
      const labelUrl = shipData?.output?.transactionShipments?.[0]?.pieceResponses?.[0]?.packageDocuments?.[0]?.url || null;

      const labelDir = process.env.NODE_ENV === 'production' ? '/tmp/labels' : path.join(__dirname, 'labels');
      if (!fs.existsSync(labelDir)) fs.mkdirSync(labelDir, { recursive: true });
      const labelPath = path.join(labelDir, `label_order_${orderId}.txt`);
      // For URL_ONLY, save URL reference; alternatively fetch the file and save as PDF/PNG
      fs.writeFileSync(labelPath, `Label URL: ${labelUrl || 'N/A'}`);

      db.prepare('INSERT INTO shipments (order_id, carrier, tracking_number, label_pdf_path, status, to_name, to_address1, to_address2, to_city, to_state, to_zip, to_country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(orderId, 'fedex', tracking, labelPath, 'created', to.to_name || null, to.to_address1 || null, to.to_address2 || null, to.to_city || null, to.to_state || null, to.to_zip || null, to.to_country || null);

      return res.redirect('/admin/sales');
    } catch (e) {
      console.warn('FedEx label attempt failed, falling back to placeholder:', e.message);
    }
  }

  // Placeholder label
  const labelDir = process.env.NODE_ENV === 'production' ? '/tmp/labels' : path.join(__dirname, 'labels');
  if (!fs.existsSync(labelDir)) fs.mkdirSync(labelDir, { recursive: true });
  const labelPath = path.join(labelDir, `label_order_${orderId}.pdf`);
  const doc = new PDFDocument({ size: 'A4' });
  const stream = fs.createWriteStream(labelPath);
  doc.pipe(stream);
  doc.fontSize(20).text('Shipping Label (Placeholder)', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Order #${orderId}`);
  doc.text(`Carrier: FedEx (set FEDEX_CLIENT_ID/SECRET/ACCOUNT_NUMBER and SHIP_FROM_* for live labels)`);
  doc.text(`Tracking: TBD`);
  doc.end();
  stream.on('finish', () => {
    db.prepare('INSERT INTO shipments (order_id, carrier, tracking_number, label_pdf_path, status) VALUES (?,?,?,?,?)')
      .run(orderId, 'fedex', 'TBD', labelPath, 'created');
    res.redirect('/admin/sales');
  });
});

// Uline suggestion utility endpoint (returns URL to search)
app.get('/admin/uline-suggestion', ensureAdmin, (req, res) => {
  const { length, width, height } = req.query;
  const L = Math.max(1, Number(length || 12) + 2);
  const W = Math.max(1, Number(width || 8) + 2);
  const H = Math.max(1, Number(height || 5) + 2);
  const query = `${L}x${W}x${H}`;
  const url = `https://www.uline.com/BL_4283/Corrugated-Boxes?keywords=${encodeURIComponent(query)}`;
  res.json({ recommended: { length: L, width: W, height: H }, url });
});

// Views
app.get('/admin', ensureAdmin, (req, res) => res.redirect('/admin/sales'));

// Minimal pages
app.get('/products', ensureAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  
  // Get auction data for each product
  const productsWithAuctions = products.map(product => {
    const auctions = db.prepare('SELECT * FROM auctions WHERE product_id = ? ORDER BY id DESC').all(product.id);
    return { ...product, auctions };
  });
  
  res.render('admin/products', { user: req.session.user, products: productsWithAuctions });
});

// Product edit page
app.get('/products/:id/edit', ensureAdmin, (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).send('Product not found');
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order, id').all(id);
  
  // Check for active auction for this product
  const activeAuction = db.prepare('SELECT * FROM auctions WHERE product_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(id, 'open');
  
  res.render('admin/edit-product', { 
    user: req.session.user, 
    product, 
    images, 
    activeAuction, 
    error: null, 
    success: null 
  });
});

// Toggle featured status
app.post('/products/:id/toggle-featured', ensureAdmin, (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).send('Product not found');
  
  const newFeaturedStatus = product.is_featured ? 0 : 1;
  db.prepare('UPDATE products SET is_featured = ? WHERE id = ?').run(newFeaturedStatus, id);
  
  res.redirect('/products');
});

// Update product
app.post('/products/:id/edit', ensureAdmin, (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).send('Product not found');
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order, id').all(id);
  
  const { brand, name, sku, size, description, image_url, highest_market_price, buy_it_now_price } = req.body;
  const brandTrimmed = (brand || '').trim();
  
  if (!allowedBrand(brandTrimmed)) {
    const activeAuction = db.prepare('SELECT * FROM auctions WHERE product_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(id, 'open');
    return res.render('admin/edit-product', { 
      user: req.session.user, 
      product,
      images, 
      activeAuction,
      error: 'Brand must be one of: Nike, Adidas, Reebok, New Balance', 
      success: null 
    });
  }
  
  try {
    db.prepare(`
      UPDATE products 
      SET brand = ?, name = ?, sku = ?, size = ?, description = ?, image_url = ?, highest_market_price = ?, buy_it_now_price = ?
      WHERE id = ?
    `).run(
      brandTrimmed,
      (name || '').trim(),
      (sku || '').trim(),
      (size || '').trim(),
      (description || '').trim(),
      (image_url || '').trim(),
      Number(highest_market_price || 0),
      Number(buy_it_now_price || 0),
      id
    );
    
    const updatedProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    const updatedImages = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order, id').all(id);
    const activeAuction = db.prepare('SELECT * FROM auctions WHERE product_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(id, 'open');
    res.render('admin/edit-product', { 
      user: req.session.user, 
      product: updatedProduct,
      images: updatedImages, 
      activeAuction,
      error: null, 
      success: 'Product updated successfully!' 
    });
  } catch (e) {
    const activeAuction = db.prepare('SELECT * FROM auctions WHERE product_id = ? AND status = ? ORDER BY id DESC LIMIT 1').get(id, 'open');
    res.render('admin/edit-product', { 
      user: req.session.user, 
      product,
      images, 
      activeAuction,
      error: 'Failed to update product: ' + e.message, 
      success: null 
    });
  }
});

// Get product images
app.get('/api/products/:id/images', ensureAdmin, (req, res) => {
  const productId = Number(req.params.id);
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order, id').all(productId);
  res.json({ images });
});

// Add product image
app.post('/api/products/:id/images', ensureAdmin, (req, res) => {
  const productId = Number(req.params.id);
  const { image_url } = req.body;
  
  if (!image_url || !image_url.trim()) {
    return res.status(400).json({ error: 'Image URL is required' });
  }
  
  try {
    const maxOrder = db.prepare('SELECT MAX(display_order) as max FROM product_images WHERE product_id = ?').get(productId);
    const nextOrder = (maxOrder?.max || 0) + 1;
    
    const info = db.prepare('INSERT INTO product_images (product_id, image_url, display_order, created_at) VALUES (?, ?, ?, ?)')
      .run(productId, image_url.trim(), nextOrder, new Date().toISOString());
    
    res.json({ success: true, imageId: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add image: ' + e.message });
  }
});

// Delete product image
app.delete('/api/products/:productId/images/:imageId', ensureAdmin, (req, res) => {
  const imageId = Number(req.params.imageId);
  
  try {
    db.prepare('DELETE FROM product_images WHERE id = ?').run(imageId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete image: ' + e.message });
  }
});

// API: Create auction
app.post('/api/auctions', ensureAdmin, (req, res) => {
  const { product_id, starting_bid, duration, reserve_price } = req.body;
  
  if (!product_id || !starting_bid || !duration) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const productId = Number(product_id);
  const startingBid = Number(starting_bid);
  const durationDays = Number(duration);
  
  // Check if product exists
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  // Check if product already has an active auction
  const existingAuction = db.prepare('SELECT * FROM auctions WHERE product_id = ? AND status = ?').get(productId, 'open');
  if (existingAuction) {
    return res.status(400).json({ error: 'Product already has an active auction' });
  }
  
  try {
    const start = dayjs();
    const end = start.add(durationDays, 'day');
    
    const auctionData = {
      product_id: productId,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      starting_bid: startingBid,
      status: 'open'
    };
    
    const result = db.prepare(`
      INSERT INTO auctions (product_id, start_time, end_time, starting_bid, status) 
      VALUES (?, ?, ?, ?, ?)
    `).run(productId, auctionData.start_time, auctionData.end_time, startingBid, 'open');
    
    logger.info('Auction created', {
      auctionId: result.lastInsertRowid,
      productId,
      startingBid,
      duration: durationDays,
      createdBy: req.session.user.email
    });
    
    res.json({ 
      success: true, 
      auctionId: result.lastInsertRowid,
      message: 'Auction created successfully'
    });
  } catch (e) {
    logger.error('Failed to create auction', { error: e.message, productId, startingBid });
    res.status(500).json({ error: 'Failed to create auction: ' + e.message });
  }
});

// API: End auction
app.post('/api/auctions/:id/end', ensureAdmin, (req, res) => {
  const auctionId = Number(req.params.id);
  
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
  if (!auction) {
    return res.status(404).json({ error: 'Auction not found' });
  }
  
  if (auction.status !== 'open') {
    return res.status(400).json({ error: 'Auction is not active' });
  }
  
  try {
    db.prepare('UPDATE auctions SET status = ? WHERE id = ?').run('ended', auctionId);
    
    logger.info('Auction ended manually', {
      auctionId,
      endedBy: req.session.user.email
    });
    
    res.json({ success: true, message: 'Auction ended successfully' });
  } catch (e) {
    logger.error('Failed to end auction', { error: e.message, auctionId });
    res.status(500).json({ error: 'Failed to end auction: ' + e.message });
  }
});

// API: Mark product as sold out
app.post('/api/products/:id/sold-out', ensureAdmin, (req, res) => {
  const productId = Number(req.params.id);
  
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  try {
    // Update product status to sold out and mark as unavailable
    db.prepare('UPDATE products SET status = ?, is_available = ? WHERE id = ?').run('sold_out', 0, productId);
    
    // End any active auctions for this product
    db.prepare('UPDATE auctions SET status = ? WHERE product_id = ? AND status = ?').run('ended', productId, 'open');
    
    logger.info('Product marked as sold out', {
      productId,
      productName: `${product.brand} ${product.name}`,
      markedBy: req.session.user.email
    });
    
    res.json({ success: true, message: 'Product marked as sold out' });
  } catch (e) {
    logger.error('Failed to mark product as sold out', { error: e.message, productId });
    res.status(500).json({ error: 'Failed to mark as sold out: ' + e.message });
  }
});

// API: Toggle product availability
app.post('/api/products/:id/toggle-availability', ensureAdmin, (req, res) => {
  const productId = Number(req.params.id);
  
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  try {
    const newAvailability = product.is_available ? 0 : 1;
    const newStatus = newAvailability ? 'available' : 'unavailable';
    
    db.prepare('UPDATE products SET is_available = ?, status = ? WHERE id = ?').run(newAvailability, newStatus, productId);
    
    logger.info('Product availability toggled', {
      productId,
      productName: `${product.brand} ${product.name}`,
      newAvailability: !!newAvailability,
      toggledBy: req.session.user.email
    });
    
    res.json({ 
      success: true, 
      available: !!newAvailability,
      message: `Product is now ${newAvailability ? 'available' : 'unavailable'}` 
    });
  } catch (e) {
    logger.error('Failed to toggle product availability', { error: e.message, productId });
    res.status(500).json({ error: 'Failed to toggle availability: ' + e.message });
  }
});

// ===== SHIPPING ROUTES =====

// Admin Shipping Dashboard
app.get('/admin/shipping', ensureAdmin, async (req, res) => {
  try {
    // Get pending shipments (paid orders without shipments)
    const pendingShipments = db.prepare(`
      SELECT o.*, 
        u.email as buyer_email,
        p.name as product_name, p.brand,
        s.to_city, s.to_state
      FROM orders o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN auctions a ON a.id = o.auction_id
      LEFT JOIN products p ON p.id = COALESCE(a.product_id, o.product_id)
      LEFT JOIN shipments s ON s.order_id = o.id
      WHERE o.status = 'paid' AND s.id IS NULL
      ORDER BY o.created_at DESC
    `).all();

    // Get active shipments
    const activeShipments = db.prepare(`
      SELECT s.*, o.id as order_id
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
      WHERE s.status NOT IN ('delivered', 'cancelled')
      ORDER BY s.created_at DESC
    `).all();

    // Get in-transit shipments
    const inTransitShipments = activeShipments.filter(s => 
      ['in_transit', 'out_for_delivery', 'shipped'].includes(s.status)
    );

    // Get delivered today count
    const today = dayjs().format('YYYY-MM-DD');
    const deliveredToday = db.prepare(`
      SELECT COUNT(*) as count
      FROM shipments
      WHERE status = 'delivered' AND DATE(actual_delivery) = ?
    `).get(today)?.count || 0;

    // Get available carriers
    const availableCarriers = shippingManager.getAvailableCarriers();

    res.render('admin/shipping', {
      user: req.session.user,
      pendingShipments,
      activeShipments,
      inTransitShipments,
      deliveredToday,
      availableCarriers,
      dayjs
    });
  } catch (error) {
    logger.error('Error loading shipping dashboard:', error);
    res.status(500).send('Error loading shipping dashboard');
  }
});

// Get shipping rates
app.post('/admin/shipping/rates', ensureAdmin, async (req, res) => {
  try {
    const { orderId, weight, length, width, height, toName, toAddress1, toAddress2, toCity, toState, toZip } = req.body;

    // Build from address (from environment)
    const fromAddress = {
      name: process.env.SHIP_FROM_NAME || 'Khloe\'s Kicks',
      line1: process.env.SHIP_FROM_ADDRESS1 || '123 Sneaker Street',
      line2: process.env.SHIP_FROM_ADDRESS2 || '',
      city: process.env.SHIP_FROM_CITY || 'Fashion City',
      state: process.env.SHIP_FROM_STATE || 'CA',
      zip: process.env.SHIP_FROM_ZIP || '90210',
      country: process.env.SHIP_FROM_COUNTRY || 'US'
    };

    // Build to address
    const toAddress = {
      name: toName,
      line1: toAddress1,
      line2: toAddress2,
      city: toCity,
      state: toState,
      zip: toZip,
      country: 'US'
    };

    const shipmentDetails = {
      fromAddress,
      toAddress,
      weight: parseFloat(weight) || 2.0,
      dimensions: {
        length: parseInt(length) || 14,
        width: parseInt(width) || 10,
        height: parseInt(height) || 5
      }
    };

    const rates = await shippingManager.getAllRates(shipmentDetails);
    
    // Store rates for this order
    if (orderId) {
      const orderIdNum = parseInt(orderId);
      for (const rate of rates) {
        db.prepare(`
          INSERT INTO shipping_rates (order_id, carrier, service_code, service_name, cost, currency, transit_time, delivery_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderIdNum,
          rate.carrier,
          rate.service,
          rate.serviceName,
          rate.cost,
          rate.currency,
          rate.transitTime,
          rate.deliveryDate,
          dayjs().toISOString()
        );
      }
    }

    res.json(rates);
  } catch (error) {
    logger.error('Error getting shipping rates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create shipment
app.post('/admin/shipping/create', ensureAdmin, async (req, res) => {
  try {
    const { orderId, selectedRate, weight, length, width, height, toName, toPhone, toAddress1, toAddress2, toCity, toState, toZip } = req.body;
    
    const orderIdNum = parseInt(orderId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = \'paid\'').get(orderIdNum);
    
    if (!order) {
      return res.status(400).json({ error: 'Order not found or not paid' });
    }

    // Get product details
    let product = null;
    if (order.auction_id) {
      const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(order.auction_id);
      if (auction) {
        product = db.prepare('SELECT * FROM products WHERE id = ?').get(auction.product_id);
      }
    } else if (order.product_id) {
      product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    }

    if (!product) {
      return res.status(400).json({ error: 'Product not found' });
    }

    // Parse selected rate (format: "carrier:service")
    const [carrier, serviceCode] = selectedRate.split(':');

    // Build addresses
    const fromAddress = {
      name: process.env.SHIP_FROM_NAME || 'Khloe\'s Kicks',
      line1: process.env.SHIP_FROM_ADDRESS1 || '123 Sneaker Street',
      line2: process.env.SHIP_FROM_ADDRESS2 || '',
      city: process.env.SHIP_FROM_CITY || 'Fashion City',
      state: process.env.SHIP_FROM_STATE || 'CA',
      zip: process.env.SHIP_FROM_ZIP || '90210',
      country: process.env.SHIP_FROM_COUNTRY || 'US',
      phone: process.env.SHIP_FROM_PHONE || '5551234567'
    };

    const toAddress = {
      name: toName,
      line1: toAddress1,
      line2: toAddress2,
      city: toCity,
      state: toState,
      zip: toZip,
      country: 'US',
      phone: toPhone || '5551234567'
    };

    const shipmentDetails = {
      fromAddress,
      toAddress,
      weight: parseFloat(weight) || 2.0,
      dimensions: {
        length: parseInt(length) || 14,
        width: parseInt(width) || 10,
        height: parseInt(height) || 5
      },
      serviceCode,
      serviceType: serviceCode,
      value: order.amount / 100,
      itemDescription: `${product.brand} ${product.name}`
    };

    // Create shipping label
    const labelResult = await shippingManager.createShippingLabel(carrier, shipmentDetails);
    
    // Create shipment record
    const shipmentId = db.prepare(`
      INSERT INTO shipments (
        order_id, carrier, service_code, service_name, tracking_number, 
        shipping_cost, weight, status, to_name, to_address1, to_address2, 
        to_city, to_state, to_zip, to_country, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderIdNum,
      labelResult.carrier,
      serviceCode,
      serviceCode, // Will be updated with proper name
      labelResult.trackingNumber,
      labelResult.cost,
      parseFloat(weight) || 2.0,
      'created',
      toName,
      toAddress1,
      toAddress2 || null,
      toCity,
      toState,
      toZip,
      'US',
      dayjs().toISOString(),
      dayjs().toISOString()
    ).lastInsertRowid;

    // Store shipping label
    if (labelResult.labelUrl) {
      db.prepare(`
        INSERT INTO shipping_labels (shipment_id, carrier, label_url, label_format, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        shipmentId,
        labelResult.carrier,
        labelResult.labelUrl,
        'PDF',
        dayjs().toISOString()
      );
    }

    // Store shipping address
    db.prepare(`
      INSERT INTO shipping_addresses (
        order_id, type, name, address_line1, address_line2, 
        city, state, postal_code, country, phone, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderIdNum,
      'to',
      toName,
      toAddress1,
      toAddress2 || null,
      toCity,
      toState,
      toZip,
      'US',
      toPhone || null,
      dayjs().toISOString()
    );

    logger.info('Shipment created successfully', {
      orderId: orderIdNum,
      shipmentId,
      carrier: labelResult.carrier,
      trackingNumber: labelResult.trackingNumber
    });

    res.json({ success: true, shipmentId, trackingNumber: labelResult.trackingNumber });
  } catch (error) {
    logger.error('Error creating shipment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test carrier connection
app.post('/admin/shipping/test/:carrier', ensureAdmin, async (req, res) => {
  try {
    const { carrier } = req.params;
    const service = shippingManager.getCarrierService(carrier);
    
    if (!service) {
      return res.json({ success: false, error: 'Carrier not configured' });
    }

    // Test authentication
    await service.authenticate();
    res.json({ success: true, message: `${carrier.toUpperCase()} connection successful` });
  } catch (error) {
    logger.error(`Error testing ${req.params.carrier}:`, error);
    res.json({ success: false, error: error.message });
  }
});

// Refresh tracking information
app.post('/admin/shipping/tracking/:shipmentId/refresh', ensureAdmin, async (req, res) => {
  try {
    const shipmentId = parseInt(req.params.shipmentId);
    const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
    
    if (!shipment) {
      return res.status(404).json({ error: 'Shipment not found' });
    }

    if (!shipment.tracking_number) {
      return res.status(400).json({ error: 'No tracking number available' });
    }

    // Get tracking information
    const trackingInfo = await shippingManager.trackPackage(shipment.carrier, shipment.tracking_number);
    
    // Update shipment status
    db.prepare(`
      UPDATE shipments 
      SET status = ?, estimated_delivery = ?, updated_at = ?
      WHERE id = ?
    `).run(
      trackingInfo.status.toLowerCase(),
      trackingInfo.estimatedDelivery,
      dayjs().toISOString(),
      shipmentId
    );

    // Store tracking events
    for (const event of trackingInfo.events) {
      // Check if event already exists
      const existingEvent = db.prepare(`
        SELECT id FROM tracking_events 
        WHERE shipment_id = ? AND event_date = ? AND event_time = ? AND description = ?
      `).get(shipmentId, event.date, event.time, event.description);

      if (!existingEvent) {
        db.prepare(`
          INSERT INTO tracking_events (shipment_id, event_date, event_time, description, location, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          shipmentId,
          event.date,
          event.time || null,
          event.description,
          event.location || null,
          dayjs().toISOString()
        );
      }
    }

    logger.info('Tracking refreshed successfully', {
      shipmentId,
      trackingNumber: shipment.tracking_number,
      status: trackingInfo.status,
      eventsCount: trackingInfo.events.length
    });

    res.json({ success: true, trackingInfo });
  } catch (error) {
    logger.error('Error refreshing tracking:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get order details for shipping
app.get('/admin/shipping/order/:orderId', ensureAdmin, (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Get shipping address if exists
    const shippingAddress = db.prepare(`
      SELECT * FROM shipping_addresses 
      WHERE order_id = ? AND type = 'to' 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(orderId);

    res.json({ 
      ...order, 
      shipping_address: shippingAddress ? {
        name: shippingAddress.name,
        phone: shippingAddress.phone,
        line1: shippingAddress.address_line1,
        line2: shippingAddress.address_line2,
        city: shippingAddress.city,
        state: shippingAddress.state,
        zip: shippingAddress.postal_code
      } : null
    });
  } catch (error) {
    logger.error('Error getting order details:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk shipment processing
app.post('/admin/shipping/bulk', ensureAdmin, async (req, res) => {
  try {
    const { orderIds } = req.body;
    const results = { successful: 0, failed: 0, errors: [] };

    for (const orderId of orderIds) {
      try {
        const orderIdNum = parseInt(orderId);
        const order = db.prepare('SELECT * FROM orders WHERE id = ? AND status = \'paid\'').get(orderIdNum);
        
        if (!order) {
          results.failed++;
          results.errors.push(`Order ${orderId}: Not found or not paid`);
          continue;
        }

        // Check if shipment already exists
        const existingShipment = db.prepare('SELECT id FROM shipments WHERE order_id = ?').get(orderIdNum);
        if (existingShipment) {
          results.failed++;
          results.errors.push(`Order ${orderId}: Shipment already exists`);
          continue;
        }

        // Get product details
        let product = null;
        if (order.auction_id) {
          const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(order.auction_id);
          if (auction) {
            product = db.prepare('SELECT * FROM products WHERE id = ?').get(auction.product_id);
          }
        } else if (order.product_id) {
          product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
        }

        if (!product) {
          results.failed++;
          results.errors.push(`Order ${orderId}: Product not found`);
          continue;
        }

        // Use default shipping address or skip if not available
        const shippingAddress = db.prepare(`
          SELECT * FROM shipping_addresses 
          WHERE order_id = ? AND type = 'to' 
          ORDER BY created_at DESC 
          LIMIT 1
        `).get(orderIdNum);

        if (!shippingAddress) {
          results.failed++;
          results.errors.push(`Order ${orderId}: No shipping address`);
          continue;
        }

        // Build shipment details with defaults
        const fromAddress = {
          name: process.env.SHIP_FROM_NAME || 'Khloe\'s Kicks',
          line1: process.env.SHIP_FROM_ADDRESS1 || '123 Sneaker Street',
          line2: process.env.SHIP_FROM_ADDRESS2 || '',
          city: process.env.SHIP_FROM_CITY || 'Fashion City',
          state: process.env.SHIP_FROM_STATE || 'CA',
          zip: process.env.SHIP_FROM_ZIP || '90210',
          country: process.env.SHIP_FROM_COUNTRY || 'US',
          phone: process.env.SHIP_FROM_PHONE || '5551234567'
        };

        const toAddress = {
          name: shippingAddress.name,
          line1: shippingAddress.address_line1,
          line2: shippingAddress.address_line2,
          city: shippingAddress.city,
          state: shippingAddress.state,
          zip: shippingAddress.postal_code,
          country: shippingAddress.country || 'US',
          phone: shippingAddress.phone || '5551234567'
        };

        const shipmentDetails = shippingManager.buildShipmentDetails(
          order, product, fromAddress, toAddress
        );

        // Use optimal shipment creation
        const labelResult = await shippingManager.createOptimalShipment(shipmentDetails);
        
        // Create shipment record
        const shipmentId = db.prepare(`
          INSERT INTO shipments (
            order_id, carrier, service_code, tracking_number, 
            shipping_cost, weight, status, to_name, to_address1, to_address2, 
            to_city, to_state, to_zip, to_country, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderIdNum,
          labelResult.carrier,
          'AUTO',
          labelResult.trackingNumber,
          labelResult.cost,
          shipmentDetails.weight,
          'created',
          toAddress.name,
          toAddress.line1,
          toAddress.line2 || null,
          toAddress.city,
          toAddress.state,
          toAddress.zip,
          toAddress.country,
          dayjs().toISOString(),
          dayjs().toISOString()
        ).lastInsertRowid;

        // Store shipping label if available
        if (labelResult.labelUrl) {
          db.prepare(`
            INSERT INTO shipping_labels (shipment_id, carrier, label_url, label_format, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            shipmentId,
            labelResult.carrier,
            labelResult.labelUrl,
            'PDF',
            dayjs().toISOString()
          );
        }

        results.successful++;
        
        logger.info('Bulk shipment created', {
          orderId: orderIdNum,
          shipmentId,
          carrier: labelResult.carrier,
          trackingNumber: labelResult.trackingNumber
        });

      } catch (error) {
        results.failed++;
        results.errors.push(`Order ${orderId}: ${error.message}`);
        logger.error(`Bulk shipment error for order ${orderId}:`, error);
      }
    }

    res.json(results);
  } catch (error) {
    logger.error('Error processing bulk shipments:', error);
    res.status(500).json({ error: error.message });
  }
});

// Shipment details page
app.get('/admin/shipping/details/:shipmentId', ensureAdmin, (req, res) => {
  try {
    const shipmentId = parseInt(req.params.shipmentId);
    
    // Get shipment details
    const shipment = db.prepare(`
      SELECT s.*, o.id as order_id, o.amount, o.created_at as order_date,
        u.email as buyer_email, p.name as product_name, p.brand
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
      JOIN users u ON u.id = o.user_id
      LEFT JOIN auctions a ON a.id = o.auction_id
      LEFT JOIN products p ON p.id = COALESCE(a.product_id, o.product_id)
      WHERE s.id = ?
    `).get(shipmentId);

    if (!shipment) {
      return res.status(404).send('Shipment not found');
    }

    // Get tracking events
    const trackingEvents = db.prepare(`
      SELECT * FROM tracking_events 
      WHERE shipment_id = ? 
      ORDER BY event_date DESC, event_time DESC
    `).all(shipmentId);

    // Get shipping labels
    const labels = db.prepare(`
      SELECT * FROM shipping_labels 
      WHERE shipment_id = ? 
      ORDER BY created_at DESC
    `).all(shipmentId);

    res.render('admin/shipment-details', {
      user: req.session.user,
      shipment,
      trackingEvents,
      labels,
      dayjs
    });
  } catch (error) {
    logger.error('Error loading shipment details:', error);
    res.status(500).send('Error loading shipment details');
  }
});

// ===== CUSTOMER TRACKING ROUTES =====

// Public tracking page
app.get('/track/:trackingNumber?', (req, res) => {
  const { trackingNumber } = req.params;
  res.render('track', { 
    user: req.session.user,
    trackingNumber: trackingNumber || null,
    trackingInfo: null,
    error: null
  });
});

// Track package API
app.post('/track', async (req, res) => {
  try {
    const { trackingNumber } = req.body;
    
    if (!trackingNumber) {
      return res.render('track', {
        user: req.session.user,
        trackingNumber: null,
        trackingInfo: null,
        error: 'Please enter a tracking number'
      });
    }

    // Find shipment by tracking number
    const shipment = db.prepare('SELECT * FROM shipments WHERE tracking_number = ?').get(trackingNumber);
    
    if (!shipment) {
      return res.render('track', {
        user: req.session.user,
        trackingNumber,
        trackingInfo: null,
        error: 'Tracking number not found'
      });
    }

    // Get fresh tracking information
    const trackingInfo = await shippingManager.trackPackage(shipment.carrier, trackingNumber);
    
    // Get order details
    const order = db.prepare(`
      SELECT o.*, p.name as product_name, p.brand
      FROM orders o
      LEFT JOIN auctions a ON a.id = o.auction_id
      LEFT JOIN products p ON p.id = COALESCE(a.product_id, o.product_id)
      WHERE o.id = ?
    `).get(shipment.order_id);

    // Get stored tracking events for timeline
    const storedEvents = db.prepare(`
      SELECT * FROM tracking_events 
      WHERE shipment_id = ? 
      ORDER BY event_date ASC, event_time ASC
    `).all(shipment.id);

    res.render('track', {
      user: req.session.user,
      trackingNumber,
      trackingInfo: {
        ...trackingInfo,
        shipment,
        order,
        storedEvents
      },
      error: null,
      dayjs
    });
  } catch (error) {
    logger.error('Error tracking package:', error);
    res.render('track', {
      user: req.session.user,
      trackingNumber: req.body.trackingNumber || null,
      trackingInfo: null,
      error: 'Error retrieving tracking information'
    });
  }
});

// Customer order tracking (requires login)
app.get('/my-orders', ensureAuth, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT o.*, 
        p.name as product_name, p.brand,
        s.tracking_number, s.carrier, s.status as shipping_status,
        s.estimated_delivery, s.actual_delivery
      FROM orders o
      LEFT JOIN auctions a ON a.id = o.auction_id
      LEFT JOIN products p ON p.id = COALESCE(a.product_id, o.product_id)
      LEFT JOIN shipments s ON s.order_id = o.id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `).all(req.session.user.id);

    res.render('my-orders', {
      user: req.session.user,
      orders,
      dayjs
    });
  } catch (error) {
    logger.error('Error loading user orders:', error);
    res.status(500).send('Error loading orders');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
