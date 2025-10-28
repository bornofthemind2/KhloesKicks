import Database from 'better-sqlite3';
import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Configure logger for database operations
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'sneaker-auction-db' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    ...(process.env.NODE_ENV !== 'production' ? [new winston.transports.Console({
      format: winston.format.simple()
    })] : [])
  ]
});

// Database configuration
const dbPath = process.env.DATABASE_URL || path.join(process.cwd(), 'sneaker_auction.db');

// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Create SQLite database connection
const db = new Database(dbPath, {
  verbose: process.env.NODE_ENV !== 'production' ? console.log : null,
  fileMustExist: false
});

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 1000');
db.pragma('foreign_keys = ON');

// Database health check
function checkDatabaseHealth() {
  try {
    const stmt = db.prepare('SELECT 1 as health_check');
    const result = stmt.get();
    return result.health_check === 1;
  } catch (error) {
    logger.error('Database health check failed:', error.message);
    return false;
  }
}

// Database query wrapper with error handling
export function query(text, params = []) {
  try {
    const start = Date.now();
    let result;

    if (text.trim().toUpperCase().startsWith('SELECT') || text.trim().toUpperCase().startsWith('PRAGMA')) {
      const stmt = db.prepare(text);
      result = { rows: stmt.all(params), rowCount: stmt.reader ? 1 : 0 };
    } else {
      const stmt = db.prepare(text);
      const info = stmt.run(params);
      result = {
        rows: [],
        rowCount: info.changes,
        lastInsertRowid: info.lastInsertRowid
      };
    }

    const duration = Date.now() - start;
    if (duration > 1000) {
      logger.warn('Slow query detected', {
        query: text.substring(0, 100),
        duration,
        rows: result.rowCount
      });
    }

    return result;
  } catch (error) {
    logger.error('Database query error:', {
      error: error.message,
      query: text.substring(0, 100),
      params: params.slice(0, 5) // Only log first 5 params for security
    });
    throw error;
  }
}

// Database transaction wrapper
export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Helper function to prepare statements
export function prepare(sql) {
  const stmt = db.prepare(sql);
  return {
    get: (params = []) => {
      try {
        return stmt.get(Array.isArray(params) ? params : [params]) || null;
      } catch (error) {
        logger.error('Prepared statement get error:', { sql: sql.substring(0, 100), error: error.message });
        throw error;
      }
    },
    all: (params = []) => {
      try {
        return stmt.all(Array.isArray(params) ? params : [params]);
      } catch (error) {
        logger.error('Prepared statement all error:', { sql: sql.substring(0, 100), error: error.message });
        throw error;
      }
    },
    run: (params = []) => {
      try {
        const info = stmt.run(Array.isArray(params) ? params : [params]);
        return {
          lastInsertRowid: info.lastInsertRowid || null,
          changes: info.changes || 0
        };
      } catch (error) {
        logger.error('Prepared statement run error:', { sql: sql.substring(0, 100), error: error.message });
        throw error;
      }
    }
  };
}

// Initialize database tables
export function initializeTables() {
  try {
    // Users table
    query(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Products table
    query(`
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
        buy_it_now_price INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Auctions table
    query(`
      CREATE TABLE IF NOT EXISTS auctions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        starting_bid INTEGER NOT NULL,
        current_bid INTEGER,
        current_bid_user_id INTEGER,
        status TEXT DEFAULT 'open',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
      );
    `);

    // Bids table
    query(`
      CREATE TABLE IF NOT EXISTS bids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auction_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        created_at DATETIME NOT NULL,
        FOREIGN KEY(auction_id) REFERENCES auctions(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    // Orders table
    query(`
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
        payment_gateway TEXT DEFAULT 'stripe',
        gateway_transaction_id TEXT,
        gateway_fees REAL DEFAULT 0,
        created_at DATETIME NOT NULL,
        FOREIGN KEY(auction_id) REFERENCES auctions(id),
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    // Shipments table
    query(`
      CREATE TABLE IF NOT EXISTS shipments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        carrier TEXT,
        service_code TEXT,
        tracking_number TEXT,
        label_pdf_path TEXT,
        status TEXT DEFAULT 'pending',
        shipping_cost REAL DEFAULT 0,
        weight INTEGER DEFAULT 0,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );
    `);

    // Settings table
    query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Product images table
    query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        created_at DATETIME NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
    `);

    // Gateway analytics table
    query(`
      CREATE TABLE IF NOT EXISTS gateway_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gateway_name TEXT NOT NULL,
        transaction_count INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        average_fee REAL DEFAULT 0,
        total_volume REAL DEFAULT 0,
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Shipping addresses table
    query(`
      CREATE TABLE IF NOT EXISTS shipping_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        name TEXT,
        address_line1 TEXT,
        address_line2 TEXT,
        city TEXT,
        state TEXT,
        postal_code TEXT,
        country TEXT,
        phone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
    `);

    // Shipping labels table
    query(`
      CREATE TABLE IF NOT EXISTS shipping_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shipment_id INTEGER NOT NULL,
        carrier TEXT NOT NULL,
        label_url TEXT,
        label_format TEXT DEFAULT 'PDF',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
      );
    `);

    // Create indexes for better performance
    query(`CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);`);
    query(`CREATE INDEX IF NOT EXISTS idx_auctions_end_time ON auctions(end_time);`);
    query(`CREATE INDEX IF NOT EXISTS idx_products_featured ON products(is_featured);`);
    query(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);`);
    query(`CREATE INDEX IF NOT EXISTS idx_bids_auction_id ON bids(auction_id);`);

    logger.info('Database tables initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database tables:', error);
    throw error;
  }
}

// Seed admin user if none exists
export function seedAdminUser() {
  try {
    const userCount = query('SELECT COUNT(*) as count FROM users');

    if (userCount.rows[0].count === 0) {
      // Import bcrypt dynamically
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync('admin123', 10);

      query(
        'INSERT INTO users (email, password_hash, name, is_admin) VALUES (?, ?, ?, ?)',
        ['admin@example.com', hash, 'Admin', 1]
      );

      logger.info('Seeded admin user: admin@example.com / admin123');
    }
  } catch (error) {
    logger.error('Failed to seed admin user:', error);
    throw error;
  }
}

// Graceful shutdown
export function closeConnection() {
  try {
    db.close();
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Error closing database connection:', error);
  }
}

// Handle process termination
process.on('SIGINT', closeConnection);
process.on('SIGTERM', closeConnection);

export default db;