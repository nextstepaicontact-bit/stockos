export interface ErrorDefinition {
  code: string;
  http: number;
  retriable: boolean;
}

export const ERROR_CODES = {
  // Validation (400)
  VALIDATION_FAILED: { code: 'VALIDATION_FAILED', http: 400, retriable: false },
  INVALID_QUANTITY: { code: 'INVALID_QUANTITY', http: 400, retriable: false },
  INVALID_LOCATION: { code: 'INVALID_LOCATION', http: 400, retriable: false },
  INVALID_PRODUCT: { code: 'INVALID_PRODUCT', http: 400, retriable: false },
  INVALID_LOT: { code: 'INVALID_LOT', http: 400, retriable: false },
  MISSING_REQUIRED_FIELD: { code: 'MISSING_REQUIRED_FIELD', http: 400, retriable: false },

  // Authorization (401, 403)
  UNAUTHORIZED: { code: 'UNAUTHORIZED', http: 401, retriable: false },
  FORBIDDEN: { code: 'FORBIDDEN', http: 403, retriable: false },
  INSUFFICIENT_ROLE: { code: 'INSUFFICIENT_ROLE', http: 403, retriable: false },

  // Not Found (404)
  PRODUCT_NOT_FOUND: { code: 'PRODUCT_NOT_FOUND', http: 404, retriable: false },
  LOCATION_NOT_FOUND: { code: 'LOCATION_NOT_FOUND', http: 404, retriable: false },
  ORDER_NOT_FOUND: { code: 'ORDER_NOT_FOUND', http: 404, retriable: false },
  LOT_NOT_FOUND: { code: 'LOT_NOT_FOUND', http: 404, retriable: false },
  WAREHOUSE_NOT_FOUND: { code: 'WAREHOUSE_NOT_FOUND', http: 404, retriable: false },

  // Conflict (409)
  INSUFFICIENT_STOCK: { code: 'INSUFFICIENT_STOCK', http: 409, retriable: false },
  NEGATIVE_STOCK_BLOCKED: { code: 'NEGATIVE_STOCK_BLOCKED', http: 409, retriable: false },
  ALREADY_ALLOCATED: { code: 'ALREADY_ALLOCATED', http: 409, retriable: false },
  DUPLICATE_MOVEMENT: { code: 'DUPLICATE_MOVEMENT', http: 409, retriable: false },
  OPTIMISTIC_LOCK_CONFLICT: { code: 'OPTIMISTIC_LOCK_CONFLICT', http: 409, retriable: true },
  IDEMPOTENCY_CONFLICT: { code: 'IDEMPOTENCY_CONFLICT', http: 409, retriable: false },
  LOT_EXPIRED: { code: 'LOT_EXPIRED', http: 409, retriable: false },
  LOT_QUARANTINED: { code: 'LOT_QUARANTINED', http: 409, retriable: false },

  // Rate Limit (429)
  RATE_LIMIT_EXCEEDED: { code: 'RATE_LIMIT_EXCEEDED', http: 429, retriable: true },

  // Server (500, 503)
  INTERNAL_ERROR: { code: 'INTERNAL_ERROR', http: 500, retriable: true },
  DATABASE_ERROR: { code: 'DATABASE_ERROR', http: 500, retriable: true },
  SERVICE_UNAVAILABLE: { code: 'SERVICE_UNAVAILABLE', http: 503, retriable: true },
  DOWNSTREAM_TIMEOUT: { code: 'DOWNSTREAM_TIMEOUT', http: 504, retriable: true },
} as const;
