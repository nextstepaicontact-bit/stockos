import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { prisma, withTransaction } from '@stockos/db';
import { EventStoreRepository, OutboxRepository } from '@stockos/db/repositories';
import { RECEIVING_EVENTS, createEvent, ReceiveGoodsPayloadSchema } from '@stockos/contracts';

export const receivingRoutes: FastifyPluginAsync = async (fastify) => {
  // Create receipt (receive goods)
  fastify.post('/receipts', {
    schema: {
      description: 'Receive goods into warehouse',
      tags: ['Receiving'],
      body: {
        type: 'object',
        required: ['lines'],
        properties: {
          purchase_order_id: { type: 'string', format: 'uuid' },
          supplier_id: { type: 'string', format: 'uuid' },
          carrier: { type: 'string' },
          tracking_number: { type: 'string' },
          delivery_note_number: { type: 'string' },
          quality_check_required: { type: 'boolean', default: false },
          notes: { type: 'string' },
          lines: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['product_id', 'quantity_received'],
              properties: {
                purchase_order_line_id: { type: 'string', format: 'uuid' },
                product_id: { type: 'string', format: 'uuid' },
                variant_id: { type: 'string', format: 'uuid' },
                quantity_received: { type: 'number', minimum: 1 },
                lot_number: { type: 'string' },
                expiration_date: { type: 'string', format: 'date' },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = ReceiveGoodsPayloadSchema.parse(request.body);
    const tenantId = request.ctx.tenantId;
    const warehouseId = request.ctx.warehouseId;

    if (!tenantId || !warehouseId) {
      return reply.status(400).send({
        error_code: 'MISSING_CONTEXT',
        message: 'x-tenant-id and x-warehouse-id headers are required',
      });
    }

    const result = await withTransaction(async (tx) => {
      const eventRepo = new EventStoreRepository(tx);
      const outboxRepo = new OutboxRepository(tx);

      // Generate receipt number
      const receiptNumber = `RCV-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      // Create receipt
      const receipt = await tx.receipt.create({
        data: {
          tenantId,
          warehouseId,
          receiptNumber,
          purchaseOrderId: body.purchase_order_id,
          supplierId: body.supplier_id,
          carrier: body.carrier,
          trackingNumber: body.tracking_number,
          deliveryNoteNumber: body.delivery_note_number,
          qualityCheckReq: body.quality_check_required,
          notes: body.notes,
          status: body.quality_check_required ? 'PENDING_QC' : 'RECEIVED',
          receivedBy: request.ctx.userId,
          receivedAt: new Date(),
        },
      });

      // Create receipt lines
      const lines = await Promise.all(
        body.lines.map(async (line, index) => {
          // Create or find lot batch if lot number provided
          let lotBatchId: string | undefined;
          if (line.lot_number) {
            const existingLot = await tx.lotBatch.findFirst({
              where: {
                tenantId,
                productId: line.product_id,
                lotNumber: line.lot_number,
              },
            });

            if (existingLot) {
              lotBatchId = existingLot.id;
            } else {
              const newLot = await tx.lotBatch.create({
                data: {
                  tenantId,
                  productId: line.product_id,
                  lotNumber: line.lot_number,
                  expirationDate: line.expiration_date ? new Date(line.expiration_date) : undefined,
                  receivedAt: new Date(),
                  supplierId: body.supplier_id,
                  status: 'AVAILABLE',
                },
              });
              lotBatchId = newLot.id;
            }
          }

          return tx.receiptLine.create({
            data: {
              receiptId: receipt.id,
              lineNumber: index + 1,
              purchaseOrderLineId: line.purchase_order_line_id,
              productId: line.product_id,
              quantityReceived: line.quantity_received,
              lotNumber: line.lot_number,
              expirationDate: line.expiration_date ? new Date(line.expiration_date) : undefined,
              notes: line.notes,
              status: 'RECEIVED',
            },
          });
        })
      );

      // Create event
      const event = createEvent(
        RECEIVING_EVENTS.GOODS_RECEIVED,
        {
          receipt_id: receipt.id,
          receipt_number: receiptNumber,
          warehouse_id: warehouseId,
          purchase_order_id: body.purchase_order_id,
          supplier_id: body.supplier_id,
          quality_check_required: body.quality_check_required,
          lines: lines.map((l) => ({
            line_id: l.id,
            product_id: l.productId,
            quantity_received: l.quantityReceived,
            lot_number: l.lotNumber,
          })),
          total_quantity: lines.reduce((sum, l) => sum + l.quantityReceived, 0),
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
        aggregateType: 'Receipt',
        aggregateId: receipt.id,
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
        routingKey: 'receiving.goods.received',
        payload: event,
        tenant: { connect: { id: tenantId } },
      });

      return { receipt, lines, event };
    });

    return reply.status(201).send({
      data: {
        id: result.receipt.id,
        receipt_number: result.receipt.receiptNumber,
        status: result.receipt.status,
        lines: result.lines.map((l) => ({
          id: l.id,
          product_id: l.productId,
          quantity_received: l.quantityReceived,
          lot_number: l.lotNumber,
        })),
        received_at: result.receipt.receivedAt,
      },
      meta: {
        event_id: result.event.event_id,
        correlation_id: request.ctx.correlationId,
      },
    });
  });

  // Get receipts
  fastify.get('/receipts', {
    schema: {
      description: 'Get receipts with optional filters',
      tags: ['Receiving'],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          purchase_order_id: { type: 'string', format: 'uuid' },
          supplier_id: { type: 'string', format: 'uuid' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as {
      status?: string;
      purchase_order_id?: string;
      supplier_id?: string;
      limit?: number;
      offset?: number;
    };
    const tenantId = request.ctx.tenantId;
    const warehouseId = request.ctx.warehouseId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    const receipts = await prisma.receipt.findMany({
      where: {
        tenantId,
        ...(warehouseId && { warehouseId }),
        ...(query.status && { status: query.status }),
        ...(query.purchase_order_id && { purchaseOrderId: query.purchase_order_id }),
        ...(query.supplier_id && { supplierId: query.supplier_id }),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
      include: {
        supplier: { select: { code: true, name: true } },
        _count: { select: { lines: true } },
      },
    });

    return {
      data: receipts.map((r) => ({
        id: r.id,
        receipt_number: r.receiptNumber,
        status: r.status,
        purchase_order_id: r.purchaseOrderId,
        supplier: r.supplier,
        carrier: r.carrier,
        tracking_number: r.trackingNumber,
        line_count: r._count.lines,
        received_by: r.receivedBy,
        received_at: r.receivedAt,
        created_at: r.createdAt,
      })),
      meta: {
        total: receipts.length,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get receipt by ID
  fastify.get('/receipts/:id', {
    schema: {
      description: 'Get a specific receipt with lines',
      tags: ['Receiving'],
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

    const receipt = await prisma.receipt.findUnique({
      where: { id },
      include: {
        supplier: { select: { code: true, name: true } },
        purchaseOrder: { select: { orderNumber: true } },
        lines: {
          include: {
            product: { select: { sku: true, name: true } },
          },
        },
      },
    });

    if (!receipt) {
      return reply.status(404).send({
        error_code: 'NOT_FOUND',
        message: 'Receipt not found',
      });
    }

    return {
      data: {
        id: receipt.id,
        receipt_number: receipt.receiptNumber,
        status: receipt.status,
        purchase_order: receipt.purchaseOrder,
        supplier: receipt.supplier,
        carrier: receipt.carrier,
        tracking_number: receipt.trackingNumber,
        delivery_note_number: receipt.deliveryNoteNumber,
        quality_check_required: receipt.qualityCheckReq,
        notes: receipt.notes,
        lines: receipt.lines.map((l) => ({
          id: l.id,
          line_number: l.lineNumber,
          product: l.product,
          quantity_expected: l.quantityExpected,
          quantity_received: l.quantityReceived,
          quantity_putaway: l.quantityPutaway,
          lot_number: l.lotNumber,
          expiration_date: l.expirationDate,
          status: l.status,
          notes: l.notes,
        })),
        received_by: receipt.receivedBy,
        received_at: receipt.receivedAt,
        created_at: receipt.createdAt,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });
};
