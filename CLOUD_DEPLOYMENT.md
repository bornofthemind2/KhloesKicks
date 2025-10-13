# Google Cloud Deployment Guide

## Important Database Notice
⚠️ **SQLite Limitation**: This application currently uses SQLite, which won't persist data on Google App Engine since the file system is ephemeral. Each deployment will reset the database.

For production use, consider migrating to:
- Google Cloud SQL (PostgreSQL/MySQL)
- Google Firestore
- Google Cloud Spanner

## Prerequisites

1. **Install Google Cloud CLI**:
   ```powershell
   # Download and install from: https://cloud.google.com/sdk/docs/install-windows
   # Or use PowerShell:
   (New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe", "$env:TEMP\GoogleCloudSDKInstaller.exe")
   & $env:TEMP\GoogleCloudSDKInstaller.exe
   ```

2. **Authenticate and set up project**:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   gcloud app create --region=us-central
   ```

## Environment Variables Setup

1. **Edit `app.yaml`** and replace the placeholder values with your actual credentials:
   ```yaml
   env_variables:
     SESSION_SECRET: "your-actual-session-secret-here"
     STRIPE_SECRET_KEY: "sk_live_or_test_your_key"
     STRIPE_WEBHOOK_SECRET: "whsec_your_webhook_secret"
     # Add other variables as needed
   ```

2. **Required Variables**:
   - `SESSION_SECRET`: Generate a strong random string
   - `STRIPE_SECRET_KEY`: Your Stripe secret key
   - `STRIPE_WEBHOOK_SECRET`: Your Stripe webhook secret

3. **Optional Variables**:
   - FedEx credentials for shipping labels
   - Shipping address information

## Deployment Steps

1. **Deploy to App Engine**:
   ```bash
   gcloud app deploy
   ```

2. **View your app**:
   ```bash
   gcloud app browse
   ```

3. **View logs**:
   ```bash
   gcloud app logs tail -s default
   ```

## Post-Deployment Setup

1. **Access the admin panel** at `https://your-app-url/admin`
2. **Default admin credentials**:
   - Email: `admin@example.com`
   - Password: `admin123`
   - ⚠️ Change these immediately after first login!

3. **Import products** via CSV upload in the admin panel
4. **Configure Stripe webhooks** to point to `https://your-app-url/webhook/stripe`

## Important Notes

- The database will be reset on each deployment
- File uploads (CSV, labels) are stored temporarily and may be lost
- For production use, implement persistent storage solutions
- Consider using Google Cloud Storage for file uploads
- Set up proper SSL/TLS certificates for production

## Scaling Configuration

The app is configured with:
- Min instances: 0 (scales to zero when not in use)
- Max instances: 10
- Auto-scaling based on CPU utilization

## Troubleshooting

1. **Check logs**: `gcloud app logs tail -s default`
2. **Check app status**: `gcloud app versions list`
3. **Environment variables**: Verify they're set correctly in `app.yaml`
4. **Database issues**: Remember SQLite resets on each deployment

For persistent data, migrate to Cloud SQL or Firestore.