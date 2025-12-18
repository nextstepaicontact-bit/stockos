import type { FastifyPluginAsync } from 'fastify';
import { prisma, withTransaction } from '@stockos/db';
import { EventStoreRepository, OutboxRepository } from '@stockos/db/repositories';
import { SALES_ORDER_EVENTS, createEvent } from '@stockos/contracts';

export const ordersRoutes: FastifyPluginAsync = async (fastify) => {
  // Create sales order
  fastify.post('/sales', {
    schema: {
      description: 'Create a new sales order',
      tags: ['Orders'],
      body: {
        type: 'object',
        required: ['lines'],
        properties: {
          external_order_id: { type: 'string' },
          channel: { type: 'string', default: 'DIRECT' },
          priority: { type: 'number', default: 5 },
          customer_name: { type: 'string' },
          customer_email: { type: 'string' },
          shipping_address: { type: 'object' },
          billing_address: { type: 'object' },
          shipping_method: { type: 'string' },
          requested_date: { type: 'string', format: 'date' },
          notes: { type: 'string' },
          lines: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['product_id', 'quantity'],
              properties: {
                product_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'number', minimum: 1 },
                unit_price: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      external_order_id?: string;
      channel?: string;
      priority?: number;
      customer_name?: string;
      customer_email?: string;
      shipping_address?: object;
      billing_address?: object;
      shipping_method?: string;
      requested_date?: string;
      notes?: string;
      lines: Array<{
        product_id: string;
        quantity: number;
        unit_price?: number;
      }>;
    };
    const tenantId = request.ctx.tenantId;
    const warehouseId = request.ctx.warehouseId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    const result = await withTransaction(async (tx) => {
      const eventRepo = new EventStoreRepository(tx);
      const outboxRepo = new OutboxRepository(tx);

      // Generate order number
      const orderNumber = `SO-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      // Calculate total
      let totalAmount = 0;
      for (const line of body.lines) {
        if (line.unit_price) {
          totalAmount += line.unit_price * line.quantity;
        }
      }

      // Create order
      const order = await tx.salesOrder.create({
        data: {
          tenantId,
          orderNumber,
          externalOrderId: body.external_order_id,
          channel: body.channel ?? 'DIRECT',
          status: 'PENDING',
          priority: body.priority ?? 5,
          customerName: body.customer_name,
          customerEmail: body.customer_email,
          shippingAddress: body.shipping_address,
          billingAddress: body.billing_address,
          shippingMethod: body.shipping_method,
          requestedDate: body.requested_date ? new Date(body.requested_date) : undefined,
          totalAmount: totalAmount > 0 ? totalAmount : undefined,
          notes: body.notes,
          createdBy: request.ctx.userId ?? 'api',
        },
      });

      // Create order lines
      const lines = await Promise.all(
        body.lines.map(async (line, index) => {
          return tx.salesOrderLine.create({
            data: {
              salesOrderId: order.id,
              lineNumber: index + 1,
              productId: line.product_id,
              quantityOrdered: line.quantity,
              unitPrice: line.unit_price,
              status: 'PENDING',
            },
          });
        })
      );

      // Create event
      const event = createEvent(
        SALES_ORDER_EVENTS.ORDER_PLACED,
        {
          order_id: order.id,
          order_number: orderNumber,
          warehouse_id: warehouseId,
          channel: body.channel ?? 'DIRECT',
          priority: body.priority ?? 5,
          customer_name: body.customer_name,
          lines: lines.map((l) => ({
            line_id: l.id,
            product_id: l.productId,
            quantity: l.quantityOrdered,
          })),
          total_quantity: lines.reduce((sum, l) => sum + l.quantityOrdered, 0),
          total_amount: totalAmount,
        },
        {
          correlationId: request.ctx.correlationId,
          actor: {
            type: 'USER',
            id: request.ctx.userId ?? 'api',
          },
          tenantId,
          warehouseId,
        }
      );

      // Store event
      await eventRepo.append({
        tenantId,
        eventId: event.event_id,
        eventType: event.event_type,
        aggregateType: 'SalesOrder',
        aggregateId: order.id,
        correlationId: event.correlation_id,
        occurredAt: new Date(event.occurred_at),
        payload: event.payload,
        metadata: { actor: event.actor },
        tenant: { connect: { id: tenantId } },
      });

      // Add to outbox
      await outboxRepo.create({
        tenantId,
        eventId: event.event_id,
        eventType: event.event_type,
        routingKey: 'orders.sales.placed',
        payload: event,
        tenant: { connect: { id: tenantId } },
      });

      return { order, lines, event };
    });

    return reply.status(201).send({
      data: {
        id: result.order.id,
        order_number: result.order.orderNumber,
        status: result.order.status,
        lines: result.lines.map((l) => ({
          id: l.id,
          product_id: l.productId,
          quantity: l.quantityOrdered,
        })),
        created_at: result.order.createdAt,
      },
      meta: {
        event_id: result.event.event_id,
        correlation_id: request.ctx.correlationId,
      },
    });
  });

  // Get sales orders
  fastify.get('/sales', {
    schema: {
      description: 'Get sales orders with optional filters',
      tags: ['Orders'],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          channel: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as {
      status?: string;
      channel?: string;
      limit?: number;
      offset?: number;
    };
    const tenantId = request.ctx.tenantId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    const orders = await prisma.salesOrder.findMany({
      where: {
        tenantId,
        ...(query.status && { status: query.status }),
        ...(query.channel && { channel: query.channel }),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
      include: {
        _count: { select: { lines: true } },
      },
    });

    return {
      data: orders.map((o) => ({
        id: o.id,
        order_number: o.orderNumber,
        external_order_id: o.externalOrderId,
        status: o.status,
        channel: o.channel,
        priority: o.priority,
        customer_name: o.customerName,
        line_count: o._count.lines,
        total_amount: o.totalAmount,
        requested_date: o.requestedDate,
        promised_date: o.promisedDate,
        shipped_date: o.shippedDate,
        created_at: o.createdAt,
      })),
      meta: {
        total: orders.length,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get sales order by ID
  fastify.get('/sales/:id', {
    schema: {
      description: 'Get a specific sales order with lines',
      tags: ['Orders'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const order = await prisma.salesOrder.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            product: { select: { sku: true, name: true } },
          },
        },
      },
    });

    if (!order) {
      return reply.status(404).send({
        error_code: 'NOT_FOUND',
        message: 'Order not found',
      });
    }

    return {
      data: {
        id: order.id,
        order_number: order.orderNumber,
        external_order_id: order.externalOrderId,
        status: order.status,
        channel: order.channel,
        priority: order.priority,
        customer_name: order.customerName,
        customer_email: order.customerEmail,
        shipping_address: order.shippingAddress,
        billing_address: order.billingAddress,
        shipping_method: order.shippingMethod,
        requested_date: order.requestedDate,
        promised_date: order.promisedDate,
        shipped_date: order.shippedDate,
        total_amount: order.totalAmount,
        notes: order.notes,
        lines: order.lines.map((l) => ({
          id: l.id,
          line_number: l.lineNumber,
          product: l.product,
          quantity_ordered: l.quantityOrdered,
          quantity_reserved: l.quantityReserved,
          quantity_picked: l.quantityPicked,
          quantity_shipped: l.quantityShipped,
          unit_price: l.unitPrice,
          status: l.status,
        })),
        created_by: order.createdBy,
        created_at: order.createdAt,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });
};
