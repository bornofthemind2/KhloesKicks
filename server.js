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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_secret';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Initialize Razorpay
const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) 
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    })
  : null;

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
  // Get featured products with active auctions
  const featuredAuctions = db.prepare(`
    SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price, p.description
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    WHERE a.status = 'open' AND p.is_featured = 1
    ORDER BY datetime(a.end_time) ASC
    LIMIT 3
  `).all();
  
  // Get all open auctions
  const auctions = db.prepare(`
    SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    WHERE a.status = 'open'
    ORDER BY datetime(a.end_time) ASC
  `).all();
  
  res.render('home', { user: req.session.user, auctions, featuredAuctions, dayjs });
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
  if (amt % 100 !== 0) return res.status(400).send('Bids must be in increments of 100');
  const min = Math.max(auction.starting_bid, auction.current_bid || 0) + 100;
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
  res.send('Payment initiated. Awaiting confirmation via webhook.');
});
app.get('/order/:id/cancel', ensureAuth, (req, res) => {
  res.send('Payment canceled.');
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
        db.prepare('INSERT INTO shipments (order_id, carrier, tracking_number, label_pdf_path, status, to_name, to_address1, to_address2, to_city, to_state, to_zip, to_country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(order.id, 'fedex', null, null, 'pending', ship.name || null, addr.line1 || null, addr.line2 || null, addr.city || null, addr.state || addr.state_province || null, addr.postal_code || null, addr.country || null);
      }
    }
  }
  res.sendStatus(200);
});

// Stripe Connect onboarding (optional)
app.get('/admin/connect', ensureAdmin, (req, res) => {
  const connectedId = getSetting('stripe_connected_account_id');
  res.render('admin/connect', { user: req.session.user, connectedId, stripeClientId: process.env.STRIPE_CONNECT_CLIENT_ID || null, error: null });
});

app.post('/admin/connect/start', ensureAdmin, (req, res) => {
  if (!process.env.STRIPE_CONNECT_CLIENT_ID) return res.status(500).send('STRIPE_CONNECT_CLIENT_ID not set');
  const redirect = encodeURIComponent(`${req.protocol}://${req.get('host')}/admin/connect/callback`);
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  const state = Math.random().toString(36).slice(2);
  // Store state if you want CSRF protection; omitted for brevity.
  const url = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${redirect}`;
  res.redirect(url);
});

app.get('/admin/connect/callback', ensureAdmin, async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  const { code, error } = req.query;
  if (error) return res.status(400).send('Stripe connect error');
  try {
    const token = await stripe.oauth.token({ grant_type: 'authorization_code', code: code });
    if (token && token.stripe_user_id) {
      setSetting('stripe_connected_account_id', token.stripe_user_id);
    }
    res.redirect('/admin/connect');
  } catch (e) {
    console.error(e);
    res.status(500).send('Stripe connect exchange failed');
  }
});

app.post('/admin/connect/disconnect', ensureAdmin, async (req, res) => {
  // For a full disconnect, you can deauthorize via stripe.oauth.deauthorize
  const connectedId = getSetting('stripe_connected_account_id');
  if (connectedId && process.env.STRIPE_CONNECT_CLIENT_ID) {
    try {
      await stripe.oauth.deauthorize({ client_id: process.env.STRIPE_CONNECT_CLIENT_ID, stripe_user_id: connectedId });
    } catch (e) {
      console.warn('Deauthorize failed or not permitted', e.message);
    }
  }
  setSetting('stripe_connected_account_id', '');
  res.redirect('/admin/connect');
});

// Admin: CSV import
app.get('/admin/import', ensureAdmin, (req, res) => {
  res.render('admin/import', { user: req.session.user, error: null, success: null });
});
app.post('/admin/import', ensureAdmin, upload.single('csv'), (req, res) => {
  if (!req.file) return res.render('admin/import', { user: req.session.user, error: 'No file', success: null });
  const buf = fs.readFileSync(req.file.path);
  const rows = parse(buf, { columns: true, skip_empty_lines: true });
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
  res.render('admin/products', { user: req.session.user, products });
});

// Product edit page
app.get('/products/:id/edit', ensureAdmin, (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).send('Product not found');
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY display_order, id').all(id);
  res.render('admin/edit-product', { user: req.session.user, product, images, error: null, success: null });
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
    return res.render('admin/edit-product', { 
      user: req.session.user, 
      product,
      images, 
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
    res.render('admin/edit-product', { 
      user: req.session.user, 
      product: updatedProduct,
      images: updatedImages, 
      error: null, 
      success: 'Product updated successfully!' 
    });
  } catch (e) {
    res.render('admin/edit-product', { 
      user: req.session.user, 
      product,
      images, 
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

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
