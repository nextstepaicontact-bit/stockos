export type ReservationStatus = 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';

export interface Reservation {
  id: string;
  tenantId: string;
  warehouseId: string;
  productId: string;
  variantId?: string;
  stockLevelId?: string;
  lotBatchId?: string;
  quantity: number;
  quantityFulfilled: number;
  referenceType: string;
  referenceId: string;
  referenceLineId?: string;
  status: ReservationStatus;
  expiresAt?: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IReservationRepository {
  create(reservation: Omit<Reservation, 'id' | 'createdAt' | 'updatedAt'>): Promise<Reservation>;
  findById(id: string): Promise<Reservation | null>;
  findByReference(referenceType: string, referenceId: string): Promise<Reservation[]>;
  findActive(tenantId: string, productId: string, warehouseId?: string): Promise<Reservation[]>;
  updateStatus(id: string, status: ReservationStatus): Promise<Reservation>;
  updateFulfilled(id: string, quantityFulfilled: number): Promise<Reservation>;
  findExpired(asOf: Date): Promise<Reservation[]>;
}

export interface ReservationRequest {
  tenantId: string;
  warehouseId: string;
  productId: string;
  variantId?: string;
  quantity: number;
  referenceType: string;
  referenceId: string;
  referenceLineId?: string;
  expiresAt?: Date;
  createdBy: string;
}

export class ReservationService {
  constructor(private repository: IReservationRepository) {}

  async createReservation(request: ReservationRequest): Promise<Reservation> {
    return this.repository.create({
      ...request,
      quantityFulfilled: 0,
      status: 'ACTIVE',
    });
  }

  async getReservation(id: string): Promise<Reservation | null> {
    return this.repository.findById(id);
  }

  async getReservationsForReference(
    referenceType: string,
    referenceId: string
  ): Promise<Reservation[]> {
    return this.repository.findByReference(referenceType, referenceId);
  }

  async getActiveReservations(
    tenantId: string,
    productId: string,
    warehouseId?: string
  ): Promise<Reservation[]> {
    return this.repository.findActive(tenantId, productId, warehouseId);
  }

  async getTotalReserved(
    tenantId: string,
    productId: string,
    warehouseId?: string
  ): Promise<number> {
    const reservations = await this.getActiveReservations(
      tenantId,
      productId,
      warehouseId
    );

    return reservations.reduce(
      (total, r) => total + (r.quantity - r.quantityFulfilled),
      0
    );
  }

  async fulfillReservation(
    id: string,
    quantityToFulfill: number
  ): Promise<Reservation> {
    const reservation = await this.repository.findById(id);

    if (!reservation) {
      throw new Error(`Reservation ${id} not found`);
    }

    if (reservation.status !== 'ACTIVE') {
      throw new Error(`Reservation ${id} is not active (status: ${reservation.status})`);
    }

    const remaining = reservation.quantity - reservation.quantityFulfilled;
    if (quantityToFulfill > remaining) {
      throw new Error(
        `Cannot fulfill ${quantityToFulfill} units. Only ${remaining} remaining.`
      );
    }

    const newFulfilled = reservation.quantityFulfilled + quantityToFulfill;

    // Update fulfilled quantity
    await this.repository.updateFulfilled(id, newFulfilled);

    // If fully fulfilled, update status
    if (newFulfilled >= reservation.quantity) {
      return this.repository.updateStatus(id, 'FULFILLED');
    }

    return this.repository.findById(id) as Promise<Reservation>;
  }

  async cancelReservation(id: string): Promise<Reservation> {
    const reservation = await this.repository.findById(id);

    if (!reservation) {
      throw new Error(`Reservation ${id} not found`);
    }

    if (reservation.status !== 'ACTIVE') {
      throw new Error(`Cannot cancel reservation with status: ${reservation.status}`);
    }

    return this.repository.updateStatus(id, 'CANCELLED');
  }

  async expireReservations(asOf: Date = new Date()): Promise<Reservation[]> {
    const expired = await this.repository.findExpired(asOf);
    const results: Reservation[] = [];

    for (const reservation of expired) {
      if (reservation.status === 'ACTIVE') {
        const updated = await this.repository.updateStatus(
          reservation.id,
          'EXPIRED'
        );
        results.push(updated);
      }
    }

    return results;
  }

  /**
   * Check if a quantity can be reserved considering existing reservations
   */
  async canReserve(
    tenantId: string,
    warehouseId: string,
    productId: string,
    requestedQty: number,
    availableQty: number
  ): Promise<{
    canReserve: boolean;
    currentlyReserved: number;
    wouldBeReserved: number;
    availableAfterReservation: number;
  }> {
    const currentlyReserved = await this.getTotalReserved(
      tenantId,
      productId,
      warehouseId
    );

    const wouldBeReserved = currentlyReserved + requestedQty;
    const availableAfterReservation = availableQty - wouldBeReserved;

    return {
      canReserve: availableAfterReservation >= 0,
      currentlyReserved,
      wouldBeReserved,
      availableAfterReservation,
    };
  }
}
