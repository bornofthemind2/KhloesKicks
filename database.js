import pg from 'pg';
import winston from 'winston';

const { Pool } = pg;

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

// Database connection configuration
const dbConfig = {
  // Use DATABASE_URL if available (Render PostgreSQL format)
  connectionString: process.env.DATABASE_URL,
  // Fallback to individual environment variables
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sneaker_auction',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  // SSL configuration for production - more robust for Render
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false,
    // Additional SSL options for better compatibility
    ca: process.env.DATABASE_SSL_CA,
    cert: process.env.DATABASE_SSL_CERT,
    key: process.env.DATABASE_SSL_KEY
  } : false,
  // Connection pool settings - adjusted for Render
  max: process.env.NODE_ENV === 'production' ? 10 : 20,
  min: process.env.NODE_ENV === 'production' ? 2 : 0,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: process.env.NODE_ENV === 'production' ? 10000 : 2000,
  acquireTimeoutMillis: process.env.NODE_ENV === 'production' ? 60000 : 60000,
};

// Create connection pool
const pool = new Pool(dbConfig);

// Handle pool events
pool.on('connect', (client) => {
  logger.info('Connected to PostgreSQL database');
  // Set statement timeout for production
  if (process.env.NODE_ENV === 'production') {
    client.query('SET statement_timeout = 30000'); // 30 seconds
  }
});

pool.on('error', (err, client) => {
  logger.error('PostgreSQL pool error:', err);
  // In production, try to reconnect on pool errors
  if (process.env.NODE_ENV === 'production') {
    logger.info('Attempting to reconnect to database...');
    setTimeout(() => {
      // The pool will automatically try to create new connections
    }, 5000);
  }
});

pool.on('remove', (client) => {
  logger.debug('Client removed from pool');
});

// Database query wrapper with error handling and retry logic
export async function query(text, params = [], maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      const start = Date.now();
      const res = await client.query(text, params);
      const duration = Date.now() - start;

      if (duration > 1000) {
        logger.warn('Slow query detected', {
          query: text.substring(0, 100),
          duration,
          rows: res.rowCount
        });
      }

      return res;
    } catch (error) {
      lastError = error;
      logger.warn(`Database query error (attempt ${attempt}/${maxRetries}):`, {
        error: error.message,
        query: text.substring(0, 100),
        params: params.slice(0, 5) // Only log first 5 params for security
      });

      // Check if error is retryable
      const isRetryableError = error.code === 'ECONNREFUSED' ||
                              error.code === 'ENOTFOUND' ||
                              error.code === 'ETIMEDOUT' ||
                              error.code === 'ECONNRESET' ||
                              error.message.includes('connection');

      if (!isRetryableError || attempt === maxRetries) {
        throw error;
      }

      // Wait before retrying (exponential backoff)
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      logger.info(`Retrying query in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally {
      client.release();
    }
  }

  throw lastError;
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

// Helper function to prepare statements (PostgreSQL doesn't need explicit preparation)
export function prepare(sql) {
  return {
    get: async (params = []) => {
      const result = await query(sql, Array.isArray(params) ? params : [params]);
      return result.rows[0] || null;
    },
    all: async (params = []) => {
      const result = await query(sql, Array.isArray(params) ? params : [params]);
      return result.rows;
    },
    run: async (params = []) => {
      const result = await query(sql, Array.isArray(params) ? params : [params]);
      return {
        lastInsertRowid: result.rows[0]?.id || null,
        changes: result.rowCount || 0
      };
    }
  };
}

// Initialize database tables
export async function initializeTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        brand VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        sku VARCHAR(255),
        size VARCHAR(50),
        description TEXT,
        image_url TEXT,
        highest_market_price INTEGER DEFAULT 0,
        is_featured INTEGER DEFAULT 0,
        buy_it_now_price INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS auctions (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        starting_bid INTEGER NOT NULL,
        current_bid INTEGER,
        current_bid_user_id INTEGER,
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS bids (
        id SERIAL PRIMARY KEY,
        auction_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL,
        FOREIGN KEY(auction_id) REFERENCES auctions(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        auction_id INTEGER,
        product_id INTEGER,
        user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        order_type VARCHAR(50) DEFAULT 'auction',
        status VARCHAR(50) DEFAULT 'pending',
        stripe_session_id TEXT,
        payment_intent_id TEXT,
        payment_gateway VARCHAR(50) DEFAULT 'stripe',
        gateway_transaction_id TEXT,
        gateway_fees DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP NOT NULL,
        FOREIGN KEY(auction_id) REFERENCES auctions(id),
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS shipments (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        carrier VARCHAR(100),
        service_code VARCHAR(50),
        tracking_number VARCHAR(255),
        label_pdf_path TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        shipping_cost DECIMAL(10,2) DEFAULT 0,
        weight INTEGER DEFAULT 0,
        to_name VARCHAR(255),
        to_address1 VARCHAR(255),
        to_address2 VARCHAR(255),
        to_city VARCHAR(100),
        to_state VARCHAR(50),
        to_zip VARCHAR(20),
        to_country VARCHAR(50),
        box_length INTEGER,
        box_width INTEGER,
        box_height INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS product_images (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS gateway_analytics (
        id SERIAL PRIMARY KEY,
        gateway_name VARCHAR(50) NOT NULL,
        transaction_count INTEGER DEFAULT 0,
        success_rate DECIMAL(5,2) DEFAULT 0,
        average_fee DECIMAL(10,2) DEFAULT 0,
        total_volume DECIMAL(15,2) DEFAULT 0,
        date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS shipping_addresses (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL,
        type VARCHAR(20) NOT NULL,
        name VARCHAR(255),
        address_line1 VARCHAR(255),
        address_line2 VARCHAR(255),
        city VARCHAR(100),
        state VARCHAR(50),
        postal_code VARCHAR(20),
        country VARCHAR(50),
        phone VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS shipping_labels (
        id SERIAL PRIMARY KEY,
        shipment_id INTEGER NOT NULL,
        carrier VARCHAR(50) NOT NULL,
        label_url TEXT,
        label_format VARCHAR(20) DEFAULT 'PDF',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
      );
    `);

    // Create indexes for better performance
    await query(`CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_auctions_end_time ON auctions(end_time);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_products_featured ON products(is_featured);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_bids_auction_id ON bids(auction_id);`);

    logger.info('Database tables initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize database tables:', error);
    throw error;
  }
}

// Seed admin user if none exists
export async function seedAdminUser() {
  try {
    const userCount = await query('SELECT COUNT(*) as count FROM users');
    
    if (userCount.rows[0].count === '0') {
      // Import bcrypt dynamically
      const bcrypt = await import('bcryptjs');
      const hash = bcrypt.default.hashSync('admin123', 10);
      
      await query(
        'INSERT INTO users (email, password_hash, name, is_admin) VALUES ($1, $2, $3, $4)',
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
export async function closeConnection() {
  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (error) {
    logger.error('Error closing database connections:', error);
  }
}

// Handle process termination
process.on('SIGINT', closeConnection);
process.on('SIGTERM', closeConnection);

export default pool;