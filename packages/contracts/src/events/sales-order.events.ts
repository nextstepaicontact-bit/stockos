import { z } from 'zod';

export const SalesOrderCreatedPayloadSchema = z.object({
  order_id: z.string().uuid(),
  order_number: z.string(),
  channel: z.string(),
  customer_id: z.string().optional(),
  lines: z.array(z.object({
    line_id: z.string().uuid(),
    product_id: z.string().uuid(),
    quantity_ordered: z.number().positive(),
    unit_price: z.number().positive(),
  })),
  total_amount: z.number(),
  ship_by_date: z.string().optional(),
});
export type SalesOrderCreatedPayload = z.infer<typeof SalesOrderCreatedPayloadSchema>;

export const SalesOrderAllocatedPayloadSchema = z.object({
  order_id: z.string().uuid(),
  allocations: z.array(z.object({
    allocation_id: z.string().uuid(),
    product_id: z.string().uuid(),
    location_id: z.string().uuid(),
    lot_batch_id: z.string().uuid().optional(),
    quantity: z.number().positive(),
  })),
});
export type SalesOrderAllocatedPayload = z.infer<typeof SalesOrderAllocatedPayloadSchema>;

export const SALES_ORDER_EVENTS = {
  CREATED: 'SalesOrder.Created',
  ALLOCATED: 'SalesOrder.Allocated',
  PICKING_STARTED: 'SalesOrder.PickingStarted',
  PICKED: 'SalesOrder.Picked',
  PACKED: 'SalesOrder.Packed',
  SHIPPED: 'SalesOrder.Shipped',
  DELIVERED: 'SalesOrder.Delivered',
  CANCELLED: 'SalesOrder.Cancelled',
} as const;
