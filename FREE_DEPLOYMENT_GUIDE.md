# Free Deployment Options for Khloe's Kicks

## 🎯 Recommended: Railway (Best for Node.js + SQLite)

### Steps:
1. **Visit**: [railway.app](https://railway.app)
2. **Sign up** with GitHub account
3. **New Project** → **Deploy from GitHub repo**
4. **Connect this repository** or upload as ZIP
5. **Environment Variables** (in Railway dashboard):
   ```
   NODE_ENV=production
   SESSION_SECRET=khloeskicks-prod-session-2024-secure-key-v1
   SHIP_FROM_NAME=Khloe's Kicks
   SHIP_FROM_ADDRESS1=123 Sneaker Street
   SHIP_FROM_CITY=Fashion City
   SHIP_FROM_STATE=CA
   SHIP_FROM_ZIP=90210
   SHIP_FROM_COUNTRY=US
   ```
6. **Deploy** → Railway will auto-detect Node.js and deploy

### Benefits:
- ✅ $5/month (free trial available)
- ✅ Persistent storage (SQLite works perfectly)
- ✅ Fast deployment
- ✅ Custom domain support
- ✅ Auto-scaling

---

## 🆓 Alternative: Render (Completely Free)

### Steps:
1. **Visit**: [render.com](https://render.com)
2. **Sign up** with GitHub
3. **New** → **Web Service** → Connect repository
4. **Settings**:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. **Environment Variables**: Same as Railway above
6. **Create Web Service**

### Benefits:
- ✅ 100% free tier
- ✅ SSL included
- ✅ Good for testing

### Limitations:
- ❌ Spins down after inactivity (30s cold start)
- ❌ 512MB RAM limit
- ❌ Limited build minutes

---

## 🚀 Alternative: Heroku

### Steps:
1. **Install Heroku CLI**: [devcenter.heroku.com/articles/heroku-cli](https://devcenter.heroku.com/articles/heroku-cli)
2. **Login**: `heroku login`
3. **Create app**: `heroku create khloes-kicks-unique-name`
4. **Set environment variables**:
   ```bash
   heroku config:set NODE_ENV=production
   heroku config:set SESSION_SECRET=khloeskicks-prod-session-2024-secure-key-v1
   heroku config:set SHIP_FROM_NAME="Khloe's Kicks"
   # Add other variables...
   ```
5. **Deploy**: 
   ```bash
   git add .
   git commit -m "Deploy to Heroku"
   git push heroku main
   ```

### Benefits:
- ✅ Reliable platform
- ✅ Good documentation
- ✅ PostgreSQL add-on available

### Limitations:
- ❌ Requires credit card (even for free tier)
- ❌ Monthly hours limit on free plan

---

## 🔧 Post-Deployment Setup (All Platforms)

### 1. Access Admin Panel
- URL: `https://your-app-url/admin`
- **Default Login**: 
  - Email: `admin@example.com`
  - Password: `admin123`
- **⚠️ CHANGE THESE IMMEDIATELY!**

### 2. Import Products
1. Go to admin panel
2. Upload CSV with sneaker data
3. Configure featured products

### 3. Configure Payment (Optional)
Add to environment variables:
```
STRIPE_SECRET_KEY=sk_test_your_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
```

---

## 📊 Platform Comparison

| Platform | Cost | Storage | Cold Start | SSL | Custom Domain |
|----------|------|---------|------------|-----|---------------|
| Railway  | $5/mo* | Persistent | No | ✅ | ✅ |
| Render   | Free | Ephemeral | 30s | ✅ | ✅ (paid) |
| Heroku   | Free* | Ephemeral | Yes | ✅ | ✅ (paid) |

*Railway has generous free trial; Heroku requires credit card

---

## 🎯 Quick Start Recommendation

**For immediate testing**: Use **Render** (100% free, no credit card)
**For production**: Use **Railway** (better performance, persistent data)

Both platforms will automatically:
- ✅ Install dependencies (`npm install`)
- ✅ Start your application (`npm start`) 
- ✅ Provide HTTPS URL
- ✅ Handle scaling