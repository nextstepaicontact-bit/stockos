import { z } from 'zod';

export const ReceiveGoodsPayloadSchema = z.object({
  purchase_order_id: z.string().uuid().optional(),
  supplier_id: z.string().uuid().optional(),
  carrier: z.string().optional(),
  tracking_number: z.string().optional(),
  delivery_note_number: z.string().optional(),
  lines: z.array(
    z.object({
      purchase_order_line_id: z.string().uuid().optional(),
      product_id: z.string().uuid(),
      variant_id: z.string().uuid().optional(),
      quantity_received: z.number().positive(),
      lot_number: z.string().optional(),
      expiration_date: z.string().optional(),
      notes: z.string().optional(),
    })
  ).min(1),
  quality_check_required: z.boolean().default(false),
  notes: z.string().optional(),
});
export type ReceiveGoodsPayload = z.infer<typeof ReceiveGoodsPayloadSchema>;

export const ConfirmPutawayPayloadSchema = z.object({
  receipt_id: z.string().uuid(),
  receipt_line_id: z.string().uuid(),
  location_id: z.string().uuid(),
  quantity: z.number().positive(),
  lot_batch_id: z.string().uuid().optional(),
});
export type ConfirmPutawayPayload = z.infer<typeof ConfirmPutawayPayloadSchema>;

export const SuggestSlottingPayloadSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().positive(),
  lot_batch_id: z.string().uuid().optional(),
  receipt_line_id: z.string().uuid().optional(),
  constraints: z.object({
    preferred_zones: z.array(z.string()).optional(),
    excluded_locations: z.array(z.string().uuid()).optional(),
    temperature_required: z.enum(['FROZEN', 'CHILLED', 'AMBIENT', 'CONTROLLED']).optional(),
  }).optional(),
});
export type SuggestSlottingPayload = z.infer<typeof SuggestSlottingPayloadSchema>;

export const RECEIVING_COMMANDS = {
  RECEIVE_GOODS: 'ReceiveGoods',
  CONFIRM_PUTAWAY: 'ConfirmPutaway',
  SUGGEST_SLOTTING: 'SuggestSlotting',
} as const;
