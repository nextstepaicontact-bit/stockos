import { z } from 'zod';

export const PurchaseOrderCreatedPayloadSchema = z.object({
  po_id: z.string().uuid(),
  po_number: z.string(),
  supplier_id: z.string().uuid(),
  lines: z.array(z.object({
    line_id: z.string().uuid(),
    product_id: z.string().uuid(),
    quantity_ordered: z.number().positive(),
    unit_price: z.number().positive(),
  })),
  total_amount: z.number(),
  expected_delivery_date: z.string().optional(),
});
export type PurchaseOrderCreatedPayload = z.infer<typeof PurchaseOrderCreatedPayloadSchema>;

export const PurchaseOrderApprovedPayloadSchema = z.object({
  po_id: z.string().uuid(),
  po_number: z.string(),
  approved_by: z.string(),
  approved_at: z.string().datetime(),
});
export type PurchaseOrderApprovedPayload = z.infer<typeof PurchaseOrderApprovedPayloadSchema>;

export const PURCHASE_ORDER_EVENTS = {
  CREATED: 'PurchaseOrder.Created',
  APPROVED: 'PurchaseOrder.Approved',
  SENT: 'PurchaseOrder.Sent',
  ACKNOWLEDGED: 'PurchaseOrder.Acknowledged',
  PARTIALLY_RECEIVED: 'PurchaseOrder.PartiallyReceived',
  FULLY_RECEIVED: 'PurchaseOrder.FullyReceived',
  CANCELLED: 'PurchaseOrder.Cancelled',
} as const;
