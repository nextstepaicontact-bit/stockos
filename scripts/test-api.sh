#!/bin/bash
# Script to test API endpoints

BASE_URL="http://localhost:3000"
TENANT_ID="11111111-1111-1111-1111-111111111111"
WAREHOUSE_ID="22222222-2222-2222-2222-222222222222"

echo "Testing StockOS API..."
echo ""

# Health check
echo "1. Health check..."
curl -s "$BASE_URL/health" | jq .
echo ""

# Get stock levels
echo "2. Get stock levels..."
curl -s "$BASE_URL/api/v1/inventory/stock" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-warehouse-id: $WAREHOUSE_ID" | jq .
echo ""

# Get products
echo "3. Get products..."
curl -s "$BASE_URL/api/v1/products" \
  -H "x-tenant-id: $TENANT_ID" | jq .
echo ""

# Get locations
echo "4. Get locations..."
curl -s "$BASE_URL/api/v1/locations" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-warehouse-id: $WAREHOUSE_ID" | jq .
echo ""

# Check availability
echo "5. Check stock availability..."
curl -s "$BASE_URL/api/v1/inventory/stock/availability" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $TENANT_ID" \
  -H "x-warehouse-id: $WAREHOUSE_ID" \
  -d '{
    "warehouse_id": "'$WAREHOUSE_ID'",
    "items": [
      {"product_id": "44444444-4444-4444-4444-444444444444", "quantity": 10}
    ]
  }' | jq .
echo ""

echo "API tests complete!"
