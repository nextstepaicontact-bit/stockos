# PowerShell script for Windows development setup
$ErrorActionPreference = "Stop"

Write-Host "Setting up StockOS development environment..." -ForegroundColor Cyan

# Check for required tools
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is required but not installed. Please install Node.js 20+ and try again." -ForegroundColor Red
    exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "pnpm is required. Installing..." -ForegroundColor Yellow
    npm install -g pnpm
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker is required but not installed. Please install Docker Desktop and try again." -ForegroundColor Red
    exit 1
}

# Start infrastructure
Write-Host "Starting infrastructure services..." -ForegroundColor Green
docker compose -f docker/docker-compose.yml up -d postgres rabbitmq redis

# Wait for PostgreSQL
Write-Host "Waiting for PostgreSQL to be ready..." -ForegroundColor Yellow
$maxAttempts = 30
$attempt = 0
while ($attempt -lt $maxAttempts) {
    $result = docker exec stockos-postgres pg_isready -U stockos 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "PostgreSQL is ready!" -ForegroundColor Green
        break
    }
    Start-Sleep -Seconds 1
    $attempt++
}

if ($attempt -eq $maxAttempts) {
    Write-Host "Timeout waiting for PostgreSQL" -ForegroundColor Red
    exit 1
}

# Wait for RabbitMQ
Write-Host "Waiting for RabbitMQ to be ready..." -ForegroundColor Yellow
$attempt = 0
while ($attempt -lt $maxAttempts) {
    $result = docker exec stockos-rabbitmq rabbitmq-diagnostics check_running 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "RabbitMQ is ready!" -ForegroundColor Green
        break
    }
    Start-Sleep -Seconds 2
    $attempt++
}

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Green
pnpm install

# Generate Prisma client
Write-Host "Generating Prisma client..." -ForegroundColor Green
Push-Location packages/db
pnpm db:generate

# Run migrations
Write-Host "Running database migrations..." -ForegroundColor Green
pnpm db:push

# Seed database
Write-Host "Seeding database..." -ForegroundColor Green
pnpm db:seed

Pop-Location

Write-Host ""
Write-Host "Development environment setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Available commands:" -ForegroundColor Cyan
Write-Host "  pnpm dev:api    - Start API server in development mode"
Write-Host "  pnpm dev:worker - Start worker in development mode"
Write-Host "  pnpm dev        - Start both API and worker"
Write-Host ""
Write-Host "Services:" -ForegroundColor Cyan
Write-Host "  API:      http://localhost:3000"
Write-Host "  API Docs: http://localhost:3000/docs"
Write-Host "  RabbitMQ: http://localhost:15672 (user: stockos, pass: stockos_dev)"
Write-Host ""
