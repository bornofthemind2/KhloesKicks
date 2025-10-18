#!/usr/bin/env node

/**
 * PostgreSQL Database Setup Script for Sneaker Auction App
 * 
 * This script helps set up the PostgreSQL database for the sneaker auction application.
 * Make sure you have PostgreSQL installed and running before executing this script.
 */

import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres', 
  password: process.env.DB_PASSWORD || '',
  // Don't specify database initially - we'll create it
};

const targetDatabase = process.env.DB_NAME || 'sneaker_auction';

async function setupDatabase() {
  console.log('🚀 Starting PostgreSQL database setup...\n');
  
  // First, connect to PostgreSQL to create the database
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL server');
    
    // Check if database exists, create if it doesn't
    const dbExists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1", 
      [targetDatabase]
    );
    
    if (dbExists.rows.length === 0) {
      console.log(`📝 Creating database: ${targetDatabase}`);
      await client.query(`CREATE DATABASE "${targetDatabase}"`);
      console.log('✅ Database created successfully');
    } else {
      console.log(`✅ Database "${targetDatabase}" already exists`);
    }
    
    await client.end();
    
    // Now connect to the specific database and create tables
    const appClient = new Client({
      ...dbConfig,
      database: targetDatabase
    });
    
    await appClient.connect();
    console.log(`✅ Connected to database: ${targetDatabase}`);
    
    // Import and run the table creation
    const { initializeTables, seedAdminUser } = await import('./database.js');
    
    console.log('📝 Creating database tables...');
    await initializeTables();
    console.log('✅ Database tables created successfully');
    
    console.log('👤 Setting up admin user...');
    await seedAdminUser();
    console.log('✅ Admin user seeded successfully');
    
    await appClient.end();
    
    console.log('\n🎉 Database setup completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('1. Update your .env file with the correct PostgreSQL credentials');
    console.log('2. Run: npm start');
    console.log('\n🔐 Default admin login:');
    console.log('   Email: admin@example.com');
    console.log('   Password: admin123');
    
  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    console.log('\n🔧 Troubleshooting:');
    console.log('1. Make sure PostgreSQL is installed and running');
    console.log('2. Check your database credentials in .env file');
    console.log('3. Ensure the PostgreSQL user has permission to create databases');
    console.log(`4. Try connecting manually: psql -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user}`);
    process.exit(1);
  }
}

// Run the setup
setupDatabase();