#!/bin/bash
set -e

echo "Setting up StockOS development environment..."

# Check for required tools
command -v node >/dev/null 2>&1 || { echo "Node.js is required but not installed. Aborting." >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required. Installing..."; npm install -g pnpm; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required but not installed. Aborting." >&2; exit 1; }

# Start infrastructure
echo "Starting infrastructure services..."
docker compose -f docker/docker-compose.yml up -d postgres rabbitmq redis

# Wait for PostgreSQL
echo "Waiting for PostgreSQL to be ready..."
until docker exec stockos-postgres pg_isready -U stockos 2>/dev/null; do
  sleep 1
done
echo "PostgreSQL is ready!"

# Wait for RabbitMQ
echo "Waiting for RabbitMQ to be ready..."
until docker exec stockos-rabbitmq rabbitmq-diagnostics check_running 2>/dev/null; do
  sleep 2
done
echo "RabbitMQ is ready!"

# Install dependencies
echo "Installing dependencies..."
pnpm install

# Generate Prisma client
echo "Generating Prisma client..."
cd packages/db
pnpm db:generate

# Run migrations
echo "Running database migrations..."
pnpm db:push

# Seed database
echo "Seeding database..."
pnpm db:seed

cd ../..

echo ""
echo "Development environment setup complete!"
echo ""
echo "Available commands:"
echo "  pnpm dev:api    - Start API server in development mode"
echo "  pnpm dev:worker - Start worker in development mode"
echo "  pnpm dev        - Start both API and worker"
echo ""
echo "Services:"
echo "  API:      http://localhost:3000"
echo "  API Docs: http://localhost:3000/docs"
echo "  RabbitMQ: http://localhost:15672 (user: stockos, pass: stockos_dev)"
echo ""
