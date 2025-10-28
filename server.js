import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bodyParser from 'body-parser';
import expressLayouts from 'express-ejs-layouts';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { query, prepare, initializeTables, seedAdminUser } from './database.js';

// Compatibility shim: some parts of the codebase use `db.prepare(sql).get(...)` with
// `?` placeholders (sqlite style). The project uses PostgreSQL via `prepare()` which
// expects $1, $2 style placeholders. Provide a small `db` wrapper that converts
// `?` => $n and delegates to the existing `prepare()` helper so we don't need to
// update many call sites immediately.
function convertQuestionToDollar(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
}

const db = {
  prepare(sql) {
    const converted = convertQuestionToDollar(sql);
    const stmt = prepare(converted);
    return {
      get(...params) {
        // support get([params]) or get(p1, p2, ...)
        let p = [];
        if (params.length === 1 && Array.isArray(params[0])) p = params[0];
        else if (params.length === 0) p = [];
        else p = params;
        return stmt.get(p);
      },
      all(...params) {
        let p = [];
        if (params.length === 1 && Array.isArray(params[0])) p = params[0];
        else if (params.length === 0) p = [];
        else p = params;
        return stmt.all(p);
      },
      run(...params) {
        let p = [];
        if (params.length === 1 && Array.isArray(params[0])) p = params[0];
        else if (params.length === 0) p = [];
        else p = params;
        return stmt.run(p);
      }
    };
  }
};
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

// Initialize PostgreSQL database with retry logic
async function initializeDatabase(maxRetries = 10, retryDelay = 5000) {
  let retries = 0;

  while (retries < maxRetries) {
    try {
      logger.info(`Attempting database initialization (attempt ${retries + 1}/${maxRetries})`);
      await initializeTables();
      await seedAdminUser();
      logger.info('Database initialized successfully');
      return;
    } catch (error) {
      retries++;
      logger.warn(`Database initialization failed (attempt ${retries}/${maxRetries}):`, error.message);

      if (retries >= maxRetries) {
        logger.error('Failed to initialize database after maximum retries:', error);
        process.exit(1);
      }

      logger.info(`Retrying database initialization in ${retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

// Initialize database on startup
await initializeDatabase();



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
async function getSetting(key) {
  const row = await prepare('SELECT value FROM settings WHERE key = $1').get([key]);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  const existing = await prepare('SELECT value FROM settings WHERE key = $1').get([key]);
  if (existing) {
    await prepare('UPDATE settings SET value = $1 WHERE key = $2').run([value, key]);
  } else {
    await prepare('INSERT INTO settings (key, value) VALUES ($1, $2)').run([key, value]);
  }
}

// Auth routes
app.get('/register', (req, res) => {
  res.render('auth/register', { user: req.session.user, error: null });
});
app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.render('auth/register', { user: null, error: 'Email and password required' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = await query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email.trim(), hash, name || null]
    );
    req.session.user = { id: result.rows[0].id, email, name, is_admin: 0 };
    res.redirect('/');
  } catch (e) {
    res.render('auth/register', { user: null, error: 'Email already in use' });
  }
});
app.get('/login', (req, res) => {
  res.render('auth/login', { user: req.session.user, error: null });
});
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const u = await prepare('SELECT * FROM users WHERE email = $1').get([email.trim()]);
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
app.get('/', async (req, res) => {
  try {
    const brandFilter = req.query.brand;
    
    // Get featured products with active auctions (filter by brand if specified)
    let featuredAuctionsQuery = `
      SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price, p.description
      FROM auctions a
      JOIN products p ON p.id = a.product_id
      WHERE a.status = 'open' AND p.is_featured = 1
    `;
    
    const featuredAuctionsParams = [];
    if (brandFilter) {
      featuredAuctionsQuery += ` AND p.brand = $1`;
      featuredAuctionsParams.push(brandFilter);
    }
    
    featuredAuctionsQuery += `
      ORDER BY a.end_time ASC
      LIMIT 3
    `;
    
    const featuredAuctions = await prepare(featuredAuctionsQuery).all(featuredAuctionsParams);
    
    // Fallback: featured products even if they don't currently have an open auction
    let featuredProductsQuery = `
      SELECT p.*
      FROM products p
      WHERE p.is_featured = 1
    `;
    
    const featuredProductsParams = [];
    if (brandFilter) {
      featuredProductsQuery += ` AND p.brand = $1`;
      featuredProductsParams.push(brandFilter);
    }
    
    featuredProductsQuery += `
      ORDER BY p.id DESC
      LIMIT 3
    `;
    
    const featuredProducts = await prepare(featuredProductsQuery).all(featuredProductsParams);

    // Get all open auctions (filter by brand if specified)
    let auctionsQuery = `
      SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price
      FROM auctions a
      JOIN products p ON p.id = a.product_id
      WHERE a.status = 'open'
    `;
    
    const auctionsParams = [];
    if (brandFilter) {
      auctionsQuery += ` AND p.brand = $1`;
      auctionsParams.push(brandFilter);
    }
    
    auctionsQuery += `
      ORDER BY a.end_time ASC
    `;
    
    const auctions = await prepare(auctionsQuery).all(auctionsParams);
    
    // Get popular brands with one product each
    const popularBrandsResult = await query(`
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
    `);
    
    const popularBrands = popularBrandsResult.rows;
    
    res.render('home', { 
      user: req.session.user, 
      auctions, 
      featuredAuctions, 
      featuredProducts, 
      popularBrands, 
      brandFilter, 
      dayjs 
    });
  } catch (error) {
    logger.error('Error loading home page:', error);
    res.status(500).send('Internal server error');
  }
});

// Product/Auction detail
app.get('/auction/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const auction = await prepare(`
      SELECT a.*, p.*,
        a.id as auction_id,
        p.id as product_id
      FROM auctions a JOIN products p ON p.id = a.product_id WHERE a.id = $1
    `).get([id]);
    
    if (!auction) return res.status(404).send('Auction not found');
    
    const bids = await prepare(
      `SELECT b.*, u.email FROM bids b JOIN users u ON u.id = b.user_id WHERE auction_id = $1 ORDER BY created_at DESC`
    ).all([id]);
    
    const images = await prepare('SELECT * FROM product_images WHERE product_id = $1 ORDER BY display_order, id').all([auction.product_id]);
    
    res.render('auction', { user: req.session.user, auction, bids, images, dayjs });
  } catch (error) {
    logger.error('Error loading auction:', error);
    res.status(500).send('Internal server error');
  }
});

// Place bid
app.post('/auction/:id/bid', ensureAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { amount } = req.body;
    const auction = await prepare('SELECT * FROM auctions WHERE id = $1').get([id]);
    
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

    // Use PostgreSQL transaction
    await query('INSERT INTO bids (auction_id, user_id, amount, created_at) VALUES ($1, $2, $3, $4)', 
      [id, req.session.user.id, amt, dayjs().toISOString()]);
    await query('UPDATE auctions SET current_bid = $1, current_bid_user_id = $2 WHERE id = $3',
      [amt, req.session.user.id, id]);
    
    res.redirect('/auction/' + id);
  } catch (error) {
    logger.error('Error placing bid:', error);
    res.status(500).send('Internal server error');
  }
});

// Checkout for winning bidder (or allow immediate checkout by current highest)
app.post('/checkout/:auctionId', ensureAuth, async (req, res) => {
  try {
    const auctionId = Number(req.params.auctionId);
    const auction = await prepare('SELECT * FROM auctions WHERE id = $1').get([auctionId]);
    
    if (!auction) return res.status(404).send('Not found');
    if (!auction.current_bid || auction.current_bid_user_id !== req.session.user.id) {
      return res.status(400).send('Only current highest bidder can checkout');
    }
    if (!stripe) return res.status(500).send('Stripe not configured');

    const prod = await prepare('SELECT * FROM products WHERE id = $1').get([auction.product_id]);
    const connectedId = await getSetting('stripe_connected_account_id');
    
    // Create order placeholder
    const orderResult = await query(
      'INSERT INTO orders (auction_id, user_id, amount, status, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [auctionId, req.session.user.id, auction.current_bid, 'pending', dayjs().toISOString()]
    );
    const orderId = orderResult.rows[0].id;

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
    await query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [session.id, orderId]);
    res.redirect(session.url);
  } catch (e) {
    logger.error('Stripe checkout error:', e);
    res.status(500).send('Stripe error');
  }
  } catch (error) {
    logger.error('Error in checkout:', error);
    res.status(500).send('Internal server error');
  }
});

// Buy It Now - Direct purchase bypassing auction
app.post('/buy-now/:productId', ensureAuth, async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const product = await prepare('SELECT * FROM products WHERE id = $1').get([productId]);
    
    if (!product) return res.status(404).send('Product not found');
    if (!product.buy_it_now_price || product.buy_it_now_price <= 0) {
      return res.status(400).send('Buy It Now not available for this product');
    }
    if (!stripe) return res.status(500).send('Stripe not configured');
    
    const connectedId = await getSetting('stripe_connected_account_id');
    
    // Create order placeholder for Buy It Now
    const orderResult = await query(
      'INSERT INTO orders (product_id, user_id, amount, order_type, status, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [productId, req.session.user.id, product.buy_it_now_price, 'buy_now', 'pending', dayjs().toISOString()]
    );
    const orderId = orderResult.rows[0].id;
  
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
    await query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [session.id, orderId]);
    res.redirect(session.url);
  } catch (e) {
    logger.error('Buy It Now error:', e);
    res.status(500).send('Stripe error: ' + e.message);
  }
  } catch (error) {
    logger.error('Error in buy-now:', error);
    res.status(500).send('Internal server error');
  }
});

// Order status pages
app.get('/order/:id/success', ensureAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  
  try {
    // Get order details
    const order = await prepare('SELECT * FROM orders WHERE id = $1 AND user_id = $2').get([orderId, req.session.user.id]);
    if (!order) {
      return res.status(404).send('Order not found');
    }
    
    // Get product details
    let product = null;
    if (order.auction_id) {
      // Auction-based order
      const auction = await prepare('SELECT * FROM auctions WHERE id = $1').get([order.auction_id]);
      if (auction) {
        product = await prepare('SELECT * FROM products WHERE id = $1').get([auction.product_id]);
      }
    } else if (order.product_id) {
      // Direct buy-now order
      product = await prepare('SELECT * FROM products WHERE id = $1').get([order.product_id]);
    }
    
    res.render('order-success', { 
      user: req.session.user, 
      order, 
      product,
      dayjs
    });
  } catch (error) {
    logger.error('Error loading order success page:', error);
    res.status(500).send('Internal server error');
  }
});

app.get('/order/:id/cancel', ensureAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  
  try {
    // Get order details (optional - may not exist if user canceled before order creation)
    const order = await prepare('SELECT * FROM orders WHERE id = $1 AND user_id = $2').get([orderId, req.session.user.id]);
    
    // Get product details if order exists
    let product = null;
    if (order) {
      if (order.auction_id) {
        const auction = await prepare('SELECT * FROM auctions WHERE id = $1').get([order.auction_id]);
        if (auction) {
          product = await prepare('SELECT * FROM products WHERE id = $1').get([auction.product_id]);
        }
      } else if (order.product_id) {
        product = await prepare('SELECT * FROM products WHERE id = $1').get([order.product_id]);
      }
    }
    
    res.render('order-cancel', { 
      user: req.session.user, 
      order, 
      product,
      dayjs
    });
  } catch (error) {
    logger.error('Error loading order cancel page:', error);
    res.status(500).send('Internal server error');
  }
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
    const orderResult = await query(
      'INSERT INTO orders (auction_id, product_id, user_id, amount, order_type, status, payment_gateway, gateway_transaction_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [
        auctionId || null,
        productId || null,
        userId,
        amount,
        auctionId ? 'auction' : 'buy_now',
        'pending',
        'razorpay',
        razorpayOrder.id,
        new Date().toISOString()
      ]
    );
    const orderId = orderResult.rows[0].id;

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
    const order = await prepare('SELECT * FROM orders WHERE gateway_transaction_id = $1 AND user_id = $2')
      .get([razorpay_order_id, req.session.user.id]);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Fetch payment details from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const fees = payment.fee ? payment.fee / 100 : 0; // Convert from paise to currency

    // Update order with payment confirmation
    await prepare(
      'UPDATE orders SET status = $1, gateway_transaction_id = $2, gateway_fees = $3 WHERE id = $4'
    ).run(['paid', razorpay_payment_id, fees, order.id]);

    // Update gateway analytics
    await updateGatewayAnalytics('razorpay', order.amount, fees, true);

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
async function updateGatewayAnalytics(gatewayName, amount, fees, success) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get existing analytics for today
    const existing = await prepare(
      'SELECT * FROM gateway_analytics WHERE gateway_name = $1 AND date = $2'
    ).get([gatewayName, today]);

    if (existing) {
      // Update existing record
      const newCount = existing.transaction_count + 1;
      const newVolume = parseFloat(existing.total_volume) + amount;
      const newSuccessRate = success 
        ? ((existing.success_rate * existing.transaction_count) + 100) / newCount
        : (existing.success_rate * existing.transaction_count) / newCount;
      const newAvgFee = ((parseFloat(existing.average_fee) * existing.transaction_count) + fees) / newCount;

      await prepare(
        'UPDATE gateway_analytics SET transaction_count = $1, success_rate = $2, average_fee = $3, total_volume = $4 WHERE id = $5'
      ).run([newCount, newSuccessRate, newAvgFee, newVolume, existing.id]);
    } else {
      // Create new record
      await prepare(
        'INSERT INTO gateway_analytics (gateway_name, transaction_count, success_rate, average_fee, total_volume, date) VALUES ($1, $2, $3, $4, $5, $6)'
      ).run([gatewayName, 1, success ? 100 : 0, fees, amount, today]);
    }
  } catch (error) {
    logger.error('Failed to update gateway analytics', { error: error.message });
  }
}

// Stripe webhook (set STRIPE_WEBHOOK_SECRET)
app.post('/webhook/stripe', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
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
    try {
      const session = event.data.object;
      const order = await prepare('SELECT * FROM orders WHERE stripe_session_id = $1').get([session.id]);
      if (order) {
        await prepare('UPDATE orders SET status = $1, payment_intent_id = $2 WHERE id = $3')
          .run(['paid', session.payment_intent || null, order.id]);

      // Capture shipping details into a shipment record (if provided by Checkout)
      const ship = session.shipping_details || session.customer_details || null;
      if (ship && ship.address) {
        const addr = ship.address;
        
        // Store shipping address
        await prepare(`
          INSERT INTO shipping_addresses (
            order_id, type, name, address_line1, address_line2, 
            city, state, postal_code, country, phone, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `).run([
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
        ]);
        
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
    } catch (error) {
      logger.error('Error processing Stripe webhook:', error);
    }
  }
  res.sendStatus(200);
});

// Helper function for automatic shipping label generation
async function autoGenerateShippingLabel(orderId) {
  try {
    logger.info('Starting auto shipping label generation', { orderId });
    
    // Check if shipment already exists
    const existingShipment = await prepare('SELECT id FROM shipments WHERE order_id = $1').get([orderId]);
    if (existingShipment) {
      logger.info('Shipment already exists, skipping auto-generation', { orderId });
      return;
    }
    
    // Get order details
    const order = await prepare('SELECT * FROM orders WHERE id = $1 AND status = $2').get([orderId, 'paid']);
    if (!order) {
      throw new Error('Order not found or not paid');
    }
    
    // Get product details
    let product = null;
    if (order.auction_id) {
      const auction = await prepare('SELECT * FROM auctions WHERE id = $1').get([order.auction_id]);
      if (auction) {
        product = await prepare('SELECT * FROM products WHERE id = $1').get([auction.product_id]);
      }
    } else if (order.product_id) {
      product = await prepare('SELECT * FROM products WHERE id = $1').get([order.product_id]);
    }
    
    if (!product) {
      throw new Error('Product not found');
    }
    
    // Get shipping address
    const shippingAddress = await prepare(`
      SELECT * FROM shipping_addresses 
      WHERE order_id = $1 AND type = $2 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get([orderId, 'to']);
    
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
    const shipmentResult = await query(`
      INSERT INTO shipments (
        order_id, carrier, service_code, tracking_number, 
        shipping_cost, weight, status, to_name, to_address1, to_address2, 
        to_city, to_state, to_zip, to_country, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id
    `, [
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
    ]);
    const shipmentId = shipmentResult.rows[0].id;
    
    // Store shipping label if available
    if (labelResult.labelUrl) {
      await prepare(`
        INSERT INTO shipping_labels (shipment_id, carrier, label_url, label_format, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `).run([
        shipmentId,
        labelResult.carrier,
        labelResult.labelUrl,
        'PDF',
        dayjs().toISOString()
      ]);
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
        const user = await prepare('SELECT email, name FROM users WHERE id = $1').get([order.user_id]);
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
  const connectedId = await getSetting('stripe_connected_account_id');
  
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
  const connectedId = await getSetting('stripe_connected_account_id');
  const connectionData = await getSetting('stripe_connection_data');
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
      await setSetting('stripe_connected_account_id', token.stripe_user_id);
      await setSetting('stripe_connection_data', JSON.stringify(connectionData));
      
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
  const connectedId = await getSetting('stripe_connected_account_id');
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
  await setSetting('stripe_connected_account_id', '');
  await setSetting('stripe_connection_data', '');
  
  res.redirect('/admin/connect?disconnected=1');
});

// Admin: CSV import
app.get('/admin/import', ensureAdmin, (req, res) => {
  res.render('admin/import', { user: req.session.user, error: null, success: null });
});
app.post('/admin/import', ensureAdmin, upload.single('csv'), async (req, res) => {
  if (!req.file) return res.render('admin/import', { user: req.session.user, error: 'No file', success: null });
  try {
    const buf = fs.readFileSync(req.file.path);
    const rows = parse(buf, { columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true, bom: true });
    let added = 0;
    
    for (const r of rows) {
      const brand = (r.brand || '').trim();
      if (!allowedBrand(brand)) continue;
      
      await prepare('INSERT INTO products (brand, name, sku, size, description, image_url, highest_market_price) VALUES ($1, $2, $3, $4, $5, $6, $7)').run([
        brand,
        (r.name || '').trim(),
        (r.sku || '').trim(),
        (r.size || '').trim(),
        (r.description || '').trim(),
        (r.image_url || '').trim(),
        Number(r.highest_market_price || 0)
      ]);
      added++;
    }
    res.render('admin/import', { user: req.session.user, error: null, success: `Imported ${added} products` });
  } catch (error) {
    logger.error('Import error:', error);
    res.render('admin/import', { user: req.session.user, error: 'Import failed: ' + error.message, success: null });
  }
});

// Admin: create auction for a product
app.post('/admin/auctions', ensureAdmin, async (req, res) => {
  try {
    const { product_id, starting_bid } = req.body;

    const product = await prepare('SELECT id FROM products WHERE id = $1').get([Number(product_id)]);
    if (!product) {
      return res.status(404).send('Product not found');
    }

    const start = dayjs();
    const end = start.add(10, 'day');
    await prepare('INSERT INTO auctions (product_id, start_time, end_time, starting_bid, status) VALUES ($1, $2, $3, $4, $5)')
      .run([Number(product_id), start.toISOString(), end.toISOString(), Number(starting_bid || 0), 'open']);
    res.redirect('/');
  } catch (error) {
    logger.error('Error creating auction:', error);
    res.status(500).send('Internal server error');
  }
});

// Admin sales page
app.get('/admin/sales', ensureAdmin, async (req, res) => {
  try {
    const orders = await prepare(`
      SELECT o.*, a.id as auction_id, p.name as product_name, p.brand, u.email as buyer_email
      FROM orders o
      JOIN auctions a ON a.id = o.auction_id
      JOIN products p ON p.id = a.product_id
      JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
    `).all();
    const openBids = await prepare(`
      SELECT a.id as auction_id, p.name as product_name, p.brand, a.current_bid, u.email as leader_email, a.end_time
      FROM auctions a
      JOIN products p ON p.id = a.product_id
      LEFT JOIN users u ON u.id = a.current_bid_user_id
      WHERE a.status = 'open'
      ORDER BY a.end_time ASC
    `).all();
    res.render('admin/sales', { user: req.session.user, orders, openBids, dayjs });
  } catch (error) {
    logger.error('Error loading admin sales:', error);
    res.status(500).send('Internal server error');
  }
});

// Admin payment analytics page
app.get('/admin/analytics', ensureAdmin, async (req, res) => {
  try {
    // Get gateway analytics for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];
    
    const analytics = await prepare(`
      SELECT 
        gateway_name,
        SUM(transaction_count) as total_transactions,
        AVG(success_rate) as avg_success_rate,
        AVG(average_fee) as avg_fee_rate,
        SUM(total_volume) as total_volume,
        MAX(date) as last_transaction_date
      FROM gateway_analytics 
      WHERE date >= $1
      GROUP BY gateway_name
      ORDER BY total_volume DESC
    `).all([thirtyDaysAgoStr]);

    // Get daily analytics for charts
    const dailyAnalytics = await prepare(`
      SELECT 
        date,
        gateway_name,
        transaction_count,
        success_rate,
        total_volume
      FROM gateway_analytics
      WHERE date >= $1
      ORDER BY date DESC, gateway_name
    `).all([thirtyDaysAgoStr]);

    // Get recent orders by gateway
    const recentOrders = await prepare(`
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
      WHERE o.created_at >= $1::timestamp
      ORDER BY o.created_at DESC
      LIMIT 100
    `).all([thirtyDaysAgoStr]);

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
app.get('/admin/export/products', ensureAdmin, async (req, res) => {
  try {
    const result = await query(`
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
    `);
    
    const products = result.rows;

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
app.get('/admin/export/orders', ensureAdmin, async (req, res) => {
  try {
    const result = await query(`
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
      ORDER BY o.created_at DESC
    `);
    
    const orders = result.rows;

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
app.get('/admin/export/auctions', ensureAdmin, async (req, res) => {
  try {
    const result = await query(`
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
      ORDER BY a.created_at DESC
    `);
    
    const auctions = result.rows;

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
app.get('/products', ensureAdmin, async (req, res) => {
  try {
    const products = await prepare('SELECT * FROM products ORDER BY id DESC').all();
    
    // Get auction data for each product
    const productsWithAuctions = [];
    for (const product of products) {
      const auctions = await prepare('SELECT * FROM auctions WHERE product_id = $1 ORDER BY id DESC').all([product.id]);
      productsWithAuctions.push({ ...product, auctions });
    }
    
    res.render('admin/products', { user: req.session.user, products: productsWithAuctions });
  } catch (error) {
    logger.error('Error loading products:', error);
    res.status(500).send('Internal server error');
  }
});

// Product edit page
app.get('/products/:id/edit', ensureAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const product = await prepare('SELECT * FROM products WHERE id = $1').get([id]);
    if (!product) return res.status(404).send('Product not found');
    
    const images = await prepare('SELECT * FROM product_images WHERE product_id = $1 ORDER BY display_order, id').all([id]);
    
    // Check for active auction for this product
    const activeAuction = await prepare('SELECT * FROM auctions WHERE product_id = $1 AND status = $2 ORDER BY id DESC LIMIT 1').get([id, 'open']);
    
    res.render('admin/edit-product', { 
      user: req.session.user, 
      product, 
      images, 
      activeAuction, 
      error: null, 
      success: null 
    });
  } catch (error) {
    logger.error('Error loading product edit page:', error);
    res.status(500).send('Internal server error');
  }
});

// Toggle featured status
app.post('/products/:id/toggle-featured', ensureAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const product = await prepare('SELECT * FROM products WHERE id = $1').get([id]);
    if (!product) return res.status(404).send('Product not found');
    
    const newFeaturedStatus = product.is_featured ? 0 : 1;
    await query('UPDATE products SET is_featured = $1 WHERE id = $2', [newFeaturedStatus, id]);
    
    res.redirect('/products');
  } catch (error) {
    logger.error('Error toggling featured status:', error);
    res.status(500).send('Internal server error');
  }
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
app.post('/api/auctions', ensureAdmin, async (req, res) => {
  try {
    const { product_id, starting_bid, duration, reserve_price } = req.body;
    
    if (!product_id || !starting_bid || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const productId = Number(product_id);
    const startingBid = Number(starting_bid);
    const durationDays = Number(duration);
    
    // Check if product exists
    const product = await prepare('SELECT * FROM products WHERE id = $1').get([productId]);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    // Check if product already has an active auction
    const existingAuction = await prepare('SELECT * FROM auctions WHERE product_id = $1 AND status = $2').get([productId, 'open']);
    if (existingAuction) {
      return res.status(400).json({ error: 'Product already has an active auction' });
    }
    
    const start = dayjs();
    const end = start.add(durationDays, 'day');
    
    const result = await query(`
      INSERT INTO auctions (product_id, start_time, end_time, starting_bid, status) 
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, [productId, start.toISOString(), end.toISOString(), startingBid, 'open']);
    
    const auctionId = result.rows[0].id;
    
    logger.info('Auction created', {
      auctionId,
      productId,
      startingBid,
      duration: durationDays,
      createdBy: req.session.user.email
    });
    
    res.json({ 
      success: true, 
      auctionId,
      message: 'Auction created successfully'
    });
  } catch (e) {
    logger.error('Failed to create auction', { error: e.message });
    res.status(500).json({ error: 'Failed to create auction: ' + e.message });
  }
});

// API: End auction
app.post('/api/auctions/:id/end', ensureAdmin, async (req, res) => {
  try {
    const auctionId = Number(req.params.id);
    
    const auction = await prepare('SELECT * FROM auctions WHERE id = $1').get([auctionId]);
    if (!auction) {
      return res.status(404).json({ error: 'Auction not found' });
    }
    
    if (auction.status !== 'open') {
      return res.status(400).json({ error: 'Auction is not active' });
    }
    
    await query('UPDATE auctions SET status = $1 WHERE id = $2', ['ended', auctionId]);
    
    logger.info('Auction ended manually', {
      auctionId,
      endedBy: req.session.user.email
    });
    
    res.json({ success: true, message: 'Auction ended successfully' });
  } catch (e) {
    logger.error('Failed to end auction', { error: e.message, auctionId: req.params.id });
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
