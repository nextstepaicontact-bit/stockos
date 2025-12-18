export type MovementType =
  | 'RECEIPT'
  | 'PUTAWAY'
  | 'PICK'
  | 'PACK'
  | 'SHIP'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'ADJUSTMENT_PLUS'
  | 'ADJUSTMENT_MINUS'
  | 'RETURN'
  | 'DAMAGE'
  | 'EXPIRED'
  | 'CYCLE_COUNT'
  | 'RESERVE'
  | 'UNRESERVE'
  | 'QUARANTINE_IN'
  | 'QUARANTINE_OUT'
  | 'SCRAP'
  | 'CONSUME';

export interface Movement {
  id: string;
  tenantId: string;
  warehouseId: string;
  movementType: MovementType;
  productId: string;
  variantId?: string;
  lotBatchId?: string;
  fromLocationId?: string;
  toLocationId?: string;
  quantity: number;
  uom: string;
  unitCost?: number;
  totalCost?: number;
  referenceType?: string;
  referenceId?: string;
  referenceLineId?: string;
  reasonCode?: string;
  notes?: string;
  performedBy: string;
  performedAt: Date;
  createdAt: Date;
}

export interface MovementEffect {
  stockLevelId: string;
  locationId: string;
  quantityDelta: number;
  type: 'add' | 'remove' | 'transfer';
}

export interface IMovementRepository {
  create(movement: Omit<Movement, 'id' | 'createdAt'>): Promise<Movement>;
  findById(id: string): Promise<Movement | null>;
  findByReference(
    referenceType: string,
    referenceId: string
  ): Promise<Movement[]>;
  findByProduct(
    tenantId: string,
    productId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }
  ): Promise<Movement[]>;
}

export class MovementService {
  constructor(private repository: IMovementRepository) {}

  /**
   * Determine the effect of a movement type on stock levels
   */
  getMovementEffect(movementType: MovementType): {
    fromEffect: 'decrease' | 'none';
    toEffect: 'increase' | 'none';
    affectsOnHand: boolean;
    affectsReserved: boolean;
  } {
    switch (movementType) {
      // Inbound movements - increase to_location
      case 'RECEIPT':
      case 'TRANSFER_IN':
      case 'RETURN':
      case 'ADJUSTMENT_PLUS':
      case 'QUARANTINE_OUT': // Release from quarantine
        return {
          fromEffect: 'none',
          toEffect: 'increase',
          affectsOnHand: true,
          affectsReserved: false,
        };

      // Outbound movements - decrease from_location
      case 'SHIP':
      case 'TRANSFER_OUT':
      case 'DAMAGE':
      case 'EXPIRED':
      case 'ADJUSTMENT_MINUS':
      case 'SCRAP':
      case 'CONSUME':
      case 'QUARANTINE_IN': // Move to quarantine
        return {
          fromEffect: 'decrease',
          toEffect: 'none',
          affectsOnHand: true,
          affectsReserved: false,
        };

      // Internal movements - both locations affected
      case 'PUTAWAY':
      case 'PICK':
      case 'PACK':
        return {
          fromEffect: 'decrease',
          toEffect: 'increase',
          affectsOnHand: true,
          affectsReserved: false,
        };

      // Reservation movements - affect reserved quantity
      case 'RESERVE':
        return {
          fromEffect: 'none',
          toEffect: 'none',
          affectsOnHand: false,
          affectsReserved: true,
        };

      case 'UNRESERVE':
        return {
          fromEffect: 'none',
          toEffect: 'none',
          affectsOnHand: false,
          affectsReserved: true,
        };

      // Cycle count - special handling
      case 'CYCLE_COUNT':
        return {
          fromEffect: 'none',
          toEffect: 'increase', // Or decrease depending on variance
          affectsOnHand: true,
          affectsReserved: false,
        };

      default:
        return {
          fromEffect: 'none',
          toEffect: 'none',
          affectsOnHand: false,
          affectsReserved: false,
        };
    }
  }

  /**
   * Validate that a movement has the required locations
   */
  validateMovementLocations(
    movementType: MovementType,
    fromLocationId?: string,
    toLocationId?: string
  ): { valid: boolean; error?: string } {
    const effect = this.getMovementEffect(movementType);

    if (effect.fromEffect === 'decrease' && !fromLocationId) {
      return {
        valid: false,
        error: `Movement type ${movementType} requires a from_location_id`,
      };
    }

    if (effect.toEffect === 'increase' && !toLocationId) {
      return {
        valid: false,
        error: `Movement type ${movementType} requires a to_location_id`,
      };
    }

    return { valid: true };
  }

  async recordMovement(
    movement: Omit<Movement, 'id' | 'createdAt'>
  ): Promise<Movement> {
    // Validate locations
    const validation = this.validateMovementLocations(
      movement.movementType,
      movement.fromLocationId,
      movement.toLocationId
    );

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    return this.repository.create(movement);
  }

  async getMovementHistory(
    tenantId: string,
    productId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    }
  ): Promise<Movement[]> {
    return this.repository.findByProduct(tenantId, productId, options);
  }

  async getMovementsByReference(
    referenceType: string,
    referenceId: string
  ): Promise<Movement[]> {
    return this.repository.findByReference(referenceType, referenceId);
  }

  /**
   * Calculate net quantity change for a location from movements
   */
  calculateNetChange(
    movements: Movement[],
    locationId: string
  ): number {
    return movements.reduce((net, m) => {
      const effect = this.getMovementEffect(m.movementType);

      if (m.fromLocationId === locationId && effect.fromEffect === 'decrease') {
        net -= m.quantity;
      }
      if (m.toLocationId === locationId && effect.toEffect === 'increase') {
        net += m.quantity;
      }

      return net;
    }, 0);
  }
}
