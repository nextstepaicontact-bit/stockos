import { z } from 'zod';

// Inventory.GoodsReceived
export const GoodsReceivedPayloadSchema = z.object({
  receipt_id: z.string().uuid(),
  receipt_number: z.string(),
  purchase_order_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  lines: z.array(
    z.object({
      line_id: z.string().uuid(),
      product_id: z.string().uuid(),
      variant_id: z.string().uuid().optional(),
      quantity_received: z.number().positive(),
      lot_batch_id: z.string().uuid().optional(),
      lot_number: z.string().optional(),
      expiration_date: z.string().optional(),
    })
  ),
  received_by: z.string(),
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
});
export type GoodsReceivedPayload = z.infer<typeof GoodsReceivedPayloadSchema>;

// Inventory.PutawayCompleted
export const PutawayCompletedPayloadSchema = z.object({
  putaway_id: z.string().uuid(),
  receipt_id: z.string().uuid(),
  receipt_line_id: z.string().uuid(),
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().optional(),
  lot_batch_id: z.string().uuid().optional(),
  location_id: z.string().uuid(),
  location_code: z.string(),
  quantity: z.number().positive(),
  movement_id: z.string().uuid(),
  slotting_score: z.number().min(0).max(1).optional(),
  decision_trace: z.record(z.unknown()).optional(),
});
export type PutawayCompletedPayload = z.infer<typeof PutawayCompletedPayloadSchema>;

// Inventory.MovementRecorded
export const MovementRecordedPayloadSchema = z.object({
  movement_id: z.string().uuid(),
  sequence_number: z.number().int().positive(),
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
  quantity: z.number(),
  unit_cost: z.number().optional(),
  reference_type: z.string().optional(),
  reference_id: z.string().uuid().optional(),
  reason_code: z.string().optional(),
  balance_after: z.object({
    on_hand: z.number(),
    reserved: z.number(),
    allocated: z.number(),
    available: z.number(),
  }).optional(),
});
export type MovementRecordedPayload = z.infer<typeof MovementRecordedPayloadSchema>;

// Inventory.StockNegativeAttempted
export const StockNegativeAttemptedPayloadSchema = z.object({
  product_id: z.string().uuid(),
  location_id: z.string().uuid(),
  requested_quantity: z.number(),
  available_quantity: z.number(),
  movement_type: z.string(),
  reference_type: z.string().optional(),
  reference_id: z.string().uuid().optional(),
});
export type StockNegativeAttemptedPayload = z.infer<typeof StockNegativeAttemptedPayloadSchema>;

// Inventory.StockAdjusted
export const StockAdjustedPayloadSchema = z.object({
  adjustment_id: z.string().uuid(),
  movement_id: z.string().uuid(),
  product_id: z.string().uuid(),
  location_id: z.string().uuid(),
  lot_batch_id: z.string().uuid().optional(),
  old_quantity: z.number(),
  new_quantity: z.number(),
  delta: z.number(),
  reason_code: z.string(),
  notes: z.string().optional(),
  override_applied: z.boolean().default(false),
  override_justification: z.string().optional(),
});
export type StockAdjustedPayload = z.infer<typeof StockAdjustedPayloadSchema>;

// Event type constants
export const INVENTORY_EVENTS = {
  GOODS_RECEIVED: 'Inventory.GoodsReceived',
  PUTAWAY_COMPLETED: 'Inventory.PutawayCompleted',
  MOVEMENT_RECORDED: 'Inventory.MovementRecorded',
  STOCK_ADJUSTED: 'Inventory.StockAdjusted',
  STOCK_NEGATIVE_ATTEMPTED: 'Inventory.StockNegativeAttempted',
  STOCK_NEGATIVE_OVERRIDDEN: 'Inventory.StockNegativeOverridden',
  TRANSFER_INITIATED: 'Inventory.TransferInitiated',
  TRANSFER_COMPLETED: 'Inventory.TransferCompleted',
  RESERVATION_CREATED: 'Inventory.ReservationCreated',
  RESERVATION_RELEASED: 'Inventory.ReservationReleased',
  ALLOCATION_CREATED: 'Inventory.AllocationCreated',
} as const;
