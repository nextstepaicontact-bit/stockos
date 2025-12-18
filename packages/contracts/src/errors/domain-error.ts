import { ERROR_CODES, type ErrorDefinition } from './error-codes.js';

export class DomainError extends Error {
  constructor(
    public readonly errorCode: ErrorDefinition,
    message: string,
    public readonly messageFr?: string,
    public readonly details?: Record<string, unknown>,
    public readonly remediation?: string
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toResponse(correlationId: string) {
    return {
      error_code: this.errorCode.code,
      message: this.message,
      message_fr: this.messageFr,
      details: this.details,
      remediation: this.remediation,
      retriable: this.errorCode.retriable,
      http_status: this.errorCode.http,
      correlation_id: correlationId,
      timestamp: new Date().toISOString(),
    };
  }
}

export class InsufficientStockError extends DomainError {
  constructor(
    productId: string,
    locationId: string,
    requestedQty: number,
    availableQty: number
  ) {
    super(
      ERROR_CODES.INSUFFICIENT_STOCK,
      `Insufficient stock: requested ${requestedQty}, available ${availableQty}`,
      `Stock insuffisant: demandé ${requestedQty}, disponible ${availableQty}`,
      {
        product_id: productId,
        location_id: locationId,
        requested_quantity: requestedQty,
        available_quantity: availableQty,
      },
      'Reduce quantity or request override with manager approval'
    );
  }
}

export class NegativeStockBlockedError extends DomainError {
  constructor(productId: string, locationId: string, resultingQty: number) {
    super(
      ERROR_CODES.NEGATIVE_STOCK_BLOCKED,
      `Operation would result in negative stock: ${resultingQty}`,
      `L'opération résulterait en stock négatif: ${resultingQty}`,
      {
        product_id: productId,
        location_id: locationId,
        resulting_quantity: resultingQty,
      },
      'Request admin override with justification'
    );
  }
}

export class ProductNotFoundError extends DomainError {
  constructor(productId: string) {
    super(
      ERROR_CODES.PRODUCT_NOT_FOUND,
      `Product ${productId} not found`,
      `Produit ${productId} introuvable`,
      { product_id: productId }
    );
  }
}

export class LocationNotFoundError extends DomainError {
  constructor(locationId: string) {
    super(
      ERROR_CODES.LOCATION_NOT_FOUND,
      `Location ${locationId} not found`,
      `Emplacement ${locationId} introuvable`,
      { location_id: locationId }
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string, originalCommandType: string) {
    super(
      ERROR_CODES.IDEMPOTENCY_CONFLICT,
      `Idempotency key already used with different payload`,
      `Clé d'idempotence déjà utilisée avec un payload différent`,
      {
        idempotency_key: idempotencyKey,
        original_command_type: originalCommandType,
      }
    );
  }
}
