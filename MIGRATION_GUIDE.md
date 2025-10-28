# PostgreSQL Migration Guide

This guide documents the migration from SQLite to PostgreSQL for the Khloe's Kicks application.

## ✅ Completed Steps

1. **Package Dependencies**: Updated `package.json` to use `pg` instead of `better-sqlite3`
2. **Database Configuration**: Created `database.js` with PostgreSQL connection pool and helper functions
3. **Render Configuration**: Updated `render.yaml` to include PostgreSQL database service
4. **Database Schema**: Created PostgreSQL-compatible table schemas with proper data types
5. **Connection Management**: Implemented connection pooling and error handling
6. **Initial Auth Routes**: Updated register and login routes to use PostgreSQL syntax

## 🔄 In Progress

The following areas still need to be converted from SQLite to PostgreSQL syntax:

### Database Query Conversions Needed:

1. **Home Route Queries** (lines ~293-388):
   - Featured auctions query
   - Featured products query  
   - All auctions query
   - Popular brands query (already PostgreSQL compatible)

2. **Auction Management** (lines ~391-620):
   - Auction details query
   - Bid placement logic
   - Auction checkout process

3. **Product Management** (lines ~621+):
   - Product listing queries
   - Product editing queries
   - Image management queries
   - CSV import functionality

4. **Admin Routes**:
   - Sales queries
   - Shipping queries
   - Analytics queries
   - Product export functionality

### Key Syntax Changes Required:

- **Parameter Placeholders**: `?` → `$1, $2, $3...`
- **AUTOINCREMENT**: `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`
- **Date Functions**: `datetime()` → PostgreSQL date functions
- **Prepared Statements**: Convert `.prepare().get()` to async await pattern
- **Return Values**: Handle `result.rows[0]` instead of direct return

## 📋 Migration Strategy

### Phase 1: Core Authentication (✅ Complete)
- User registration/login
- Session management
- Basic database connection

### Phase 2: Essential Routes (🔄 Next)
- Home page data loading
- Product browsing
- Basic auction functionality

### Phase 3: Admin Features
- Product management
- Auction controls
- CSV import/export
- Analytics

### Phase 4: Advanced Features
- Payment processing
- Shipping management
- Email notifications

## 🚀 Deployment Instructions

### Local Development
1. Install PostgreSQL locally
2. Set environment variables:
   ```
   DATABASE_URL=./sneaker_auction.db
   NODE_ENV=development
   ```

### Render Deployment
1. The `render.yaml` is configured to automatically create PostgreSQL database
2. Environment variable `DATABASE_URL` will be auto-populated
3. Database tables will be created automatically on first startup

## ⚠️ Important Notes

- **Data Migration**: Existing SQLite data will need to be exported and imported to PostgreSQL
- **Testing**: Thorough testing required for each converted route
- **Performance**: PostgreSQL queries may need optimization for production use
- **Indexes**: All necessary indexes are created during table initialization

## 🔧 Quick Start

To continue the migration:

1. Run the existing code - it will create the PostgreSQL tables
2. Convert routes one by one using the patterns in `convert-queries.js`
3. Test each route after conversion
4. Update the `prepare()` calls to use PostgreSQL parameter syntax

## 🐛 Known Issues

- Some routes still use SQLite syntax and will throw errors
- Date/time handling may need adjustment for PostgreSQL
- Transaction logic needs to be updated for async/await pattern

## 📝 Next Steps

1. Convert remaining database queries to PostgreSQL
2. Test all functionality thoroughly
3. Import existing data from SQLite to PostgreSQL
4. Deploy and verify production functionality