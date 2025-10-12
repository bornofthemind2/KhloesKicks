# Sneaker Auction Server Startup Script
Write-Host "Starting Khloe's Kicks Server..." -ForegroundColor Cyan

# Check if port 3000 is in use
$portInUse = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
if ($portInUse) {
    Write-Host "ERROR: Port 3000 is already in use by process ID $($portInUse.OwningProcess)" -ForegroundColor Red
    Write-Host "Kill the process with: Stop-Process -Id $($portInUse.OwningProcess) -Force" -ForegroundColor Yellow
    exit 1
}

# Check if .env file exists
if (-not (Test-Path ".env")) {
    Write-Host "WARNING: .env file not found. Using default configuration." -ForegroundColor Yellow
}

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "ERROR: node_modules not found. Please run 'npm install' first." -ForegroundColor Red
    exit 1
}

Write-Host "`nStarting server on http://localhost:3000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server`n" -ForegroundColor Gray

# Start the server
try {
    node server.js
} catch {
    Write-Host "`nERROR: Server crashed with error:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
