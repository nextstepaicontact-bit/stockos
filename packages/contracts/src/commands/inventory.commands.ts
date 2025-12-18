import { z } from 'zod';

export const RecordMovementPayloadSchema = z.object({
  movement_type: z.enum([
    'RECEIPT', 'PUTAWAY', 'PICK', 'PACK', 'SHIP',
    'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_PLUS', 'ADJUSTMENT_MINUS',
    'RETURN', 'DAMAGE', 'EXPIRED', 'CYCLE_COUNT', 'RESERVE', 'UNRESERVE',
    'QUARANTINE_IN', 'QUARANTINE_OUT', 'SCRAP', 'CONSUME'
  ]),
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  lot_batch_id: z.string().uuid().optional(),
  from_location_id: z.string().uuid().optional(),
  to_location_id: z.string().uuid().optional(),
  quantity: z.number().positive(),
  uom: z.string().default('UNIT'),
  unit_cost: z.number().optional(),
  reference_type: z.string().optional(),
  reference_id: z.string().uuid().optional(),
  reference_line_id: z.string().uuid().optional(),
  reason_code: z.string().optional(),
  notes: z.string().optional(),
});
export type RecordMovementPayload = z.infer<typeof RecordMovementPayloadSchema>;

export const AdjustStockPayloadSchema = z.object({
  product_id: z.string().uuid(),
  location_id: z.string().uuid(),
  lot_batch_id: z.string().uuid().optional(),
  delta: z.number(),
  reason_code: z.string(),
  notes: z.string().optional(),
});
export type AdjustStockPayload = z.infer<typeof AdjustStockPayloadSchema>;

export const OverrideNegativeStockPayloadSchema = z.object({
  movement_id: z.string().uuid(),
  justification: z.string().min(10),
  approval_reference: z.string().optional(),
});
export type OverrideNegativeStockPayload = z.infer<typeof OverrideNegativeStockPayloadSchema>;

export const CreateReservationPayloadSchema = z.object({
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  quantity: z.number().positive(),
  reference_type: z.string(),
  reference_id: z.string().uuid(),
  reference_line_id: z.string().uuid().optional(),
  expires_at: z.string().datetime().optional(),
});
export type CreateReservationPayload = z.infer<typeof CreateReservationPayloadSchema>;

export const INVENTORY_COMMANDS = {
  RECORD_MOVEMENT: 'RecordMovement',
  ADJUST_STOCK: 'AdjustStock',
  OVERRIDE_NEGATIVE_STOCK: 'OverrideNegativeStock',
  CREATE_RESERVATION: 'CreateReservation',
  RELEASE_RESERVATION: 'ReleaseReservation',
  ALLOCATE_STOCK: 'AllocateStock',
  INITIATE_TRANSFER: 'InitiateTransfer',
  COMPLETE_TRANSFER: 'CompleteTransfer',
} as const;
