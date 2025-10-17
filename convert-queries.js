// This is a conversion helper script to migrate from SQLite to PostgreSQL
// It contains the updated database queries in PostgreSQL format

import { query, prepare } from './database.js';

// Auth route helpers
export async function createUser(email, passwordHash, name) {
  const result = await query(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [email.trim(), passwordHash, name || null]
  );
  return { lastInsertRowid: result.rows[0].id };
}

export async function findUserByEmail(email) {
  return await prepare('SELECT * FROM users WHERE email = $1').get([email.trim()]);
}

// Home page queries
export async function getFeaturedAuctions(brandFilter = null) {
  let sql = `
    SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price, p.description
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    WHERE a.status = 'open' AND p.is_featured = 1
  `;
  
  const params = [];
  if (brandFilter) {
    sql += ` AND p.brand = $1`;
    params.push(brandFilter);
  }
  
  sql += ` ORDER BY a.end_time ASC LIMIT 3`;
  
  return await prepare(sql).all(params);
}

export async function getFeaturedProducts(brandFilter = null) {
  let sql = `
    SELECT p.*
    FROM products p
    WHERE p.is_featured = 1
  `;
  
  const params = [];
  if (brandFilter) {
    sql += ` AND p.brand = $1`;
    params.push(brandFilter);
  }
  
  sql += ` ORDER BY p.id DESC LIMIT 3`;
  
  return await prepare(sql).all(params);
}

export async function getAllAuctions(brandFilter = null) {
  let sql = `
    SELECT a.*, p.name as product_name, p.brand, p.image_url, p.highest_market_price
    FROM auctions a
    JOIN products p ON p.id = a.product_id
    WHERE a.status = 'open'
  `;
  
  const params = [];
  if (brandFilter) {
    sql += ` AND p.brand = $1`;
    params.push(brandFilter);
  }
  
  sql += ` ORDER BY a.end_time ASC`;
  
  return await prepare(sql).all(params);
}

export async function getPopularBrands() {
  // PostgreSQL version of the popular brands query
  return await query(`
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
}

// Product and auction queries
export async function getAuctionWithProduct(auctionId) {
  return await prepare(`
    SELECT a.*, p.*,
      a.id as auction_id,
      p.id as product_id
    FROM auctions a JOIN products p ON p.id = a.product_id WHERE a.id = $1
  `).get([auctionId]);
}

export async function getAuctionBids(auctionId) {
  return await prepare(
    `SELECT b.*, u.email FROM bids b JOIN users u ON u.id = b.user_id WHERE auction_id = $1 ORDER BY created_at DESC`
  ).all([auctionId]);
}

export async function getProductImages(productId) {
  return await prepare('SELECT * FROM product_images WHERE product_id = $1 ORDER BY display_order, id').all([productId]);
}

export async function getAuctionById(auctionId) {
  return await prepare('SELECT * FROM auctions WHERE id = $1').get([auctionId]);
}

export async function createBid(auctionId, userId, amount) {
  const timestamp = new Date().toISOString();
  await query('INSERT INTO bids (auction_id, user_id, amount, created_at) VALUES ($1, $2, $3, $4)', 
    [auctionId, userId, amount, timestamp]);
  await query('UPDATE auctions SET current_bid = $1, current_bid_user_id = $2 WHERE id = $3',
    [amount, userId, auctionId]);
}

// Product management queries
export async function getAllProducts() {
  return await prepare('SELECT * FROM products ORDER BY id DESC').all();
}

export async function getProductsWithAuctions() {
  const products = await getAllProducts();
  const result = [];
  
  for (const product of products) {
    const auctions = await prepare('SELECT * FROM auctions WHERE product_id = $1 ORDER BY id DESC').all([product.id]);
    result.push({ ...product, auctions });
  }
  
  return result;
}

export async function getProductById(productId) {
  return await prepare('SELECT * FROM products WHERE id = $1').get([productId]);
}

export async function getActiveAuction(productId) {
  return await prepare('SELECT * FROM auctions WHERE product_id = $1 AND status = $2 ORDER BY id DESC LIMIT 1').get([productId, 'open']);
}

export async function toggleProductFeature(productId) {
  const product = await getProductById(productId);
  if (!product) return null;
  
  const newFeaturedStatus = product.is_featured ? 0 : 1;
  await query('UPDATE products SET is_featured = $1 WHERE id = $2', [newFeaturedStatus, productId]);
  return newFeaturedStatus;
}

export async function updateProduct(productId, data) {
  const { brand, name, sku, size, description, image_url, highest_market_price, buy_it_now_price } = data;
  
  await query(`
    UPDATE products 
    SET brand = $1, name = $2, sku = $3, size = $4, description = $5, image_url = $6, highest_market_price = $7, buy_it_now_price = $8
    WHERE id = $9
  `, [
    brand?.trim() || '',
    name?.trim() || '',
    sku?.trim() || '',
    size?.trim() || '',
    description?.trim() || '',
    image_url?.trim() || '',
    Number(highest_market_price || 0),
    Number(buy_it_now_price || 0),
    productId
  ]);
}

// Auction management queries
export async function createAuction(data) {
  const { product_id, start_time, end_time, starting_bid } = data;
  
  const result = await query(`
    INSERT INTO auctions (product_id, start_time, end_time, starting_bid, status) 
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [product_id, start_time, end_time, starting_bid, 'open']);
  
  return { lastInsertRowid: result.rows[0].id };
}

export async function endAuction(auctionId) {
  await query('UPDATE auctions SET status = $1 WHERE id = $2', ['ended', auctionId]);
}

export async function checkExistingAuction(productId) {
  return await prepare('SELECT * FROM auctions WHERE product_id = $1 AND status = $2').get([productId, 'open']);
}

// Order management queries
export async function createOrder(data) {
  const { auction_id, user_id, amount, created_at } = data;
  
  const result = await query(
    'INSERT INTO orders (auction_id, user_id, amount, status, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [auction_id, user_id, amount, 'pending', created_at]
  );
  
  return { lastInsertRowid: result.rows[0].id };
}

export async function updateOrderStripeSession(orderId, sessionId) {
  await query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [sessionId, orderId]);
}

// Add more conversion functions as needed...