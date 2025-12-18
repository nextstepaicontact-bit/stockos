import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { prisma, withTransaction } from '@stockos/db';
import { MovementRepository, EventStoreRepository, OutboxRepository } from '@stockos/db/repositories';
import { INVENTORY_EVENTS, createEvent, RecordMovementPayloadSchema } from '@stockos/contracts';

export const movementRoutes: FastifyPluginAsync = async (fastify) => {
  // Record a movement
  fastify.post('/', {
    schema: {
      description: 'Record an inventory movement',
      tags: ['Movements'],
      body: {
        type: 'object',
        required: ['movement_type', 'product_id', 'quantity'],
        properties: {
          movement_type: { type: 'string' },
          product_id: { type: 'string', format: 'uuid' },
          variant_id: { type: 'string', format: 'uuid' },
          lot_batch_id: { type: 'string', format: 'uuid' },
          from_location_id: { type: 'string', format: 'uuid' },
          to_location_id: { type: 'string', format: 'uuid' },
          quantity: { type: 'number', minimum: 1 },
          uom: { type: 'string', default: 'UNIT' },
          unit_cost: { type: 'number' },
          reference_type: { type: 'string' },
          reference_id: { type: 'string', format: 'uuid' },
          reason_code: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = RecordMovementPayloadSchema.parse(request.body);
    const tenantId = request.ctx.tenantId;
    const warehouseId = request.ctx.warehouseId;

    if (!tenantId || !warehouseId) {
      return reply.status(400).send({
        error_code: 'MISSING_CONTEXT',
        message: 'x-tenant-id and x-warehouse-id headers are required',
      });
    }

    const result = await withTransaction(async (tx) => {
      const movementRepo = new MovementRepository(tx);
      const eventRepo = new EventStoreRepository(tx);
      const outboxRepo = new OutboxRepository(tx);

      // Create movement
      const movement = await movementRepo.create({
        tenantId,
        warehouseId,
        movementType: body.movement_type,
        productId: body.product_id,
        variantId: body.variant_id,
        lotBatchId: body.lot_batch_id,
        fromLocationId: body.from_location_id,
        toLocationId: body.to_location_id,
        quantity: body.quantity,
        uom: body.uom,
        unitCost: body.unit_cost,
        totalCost: body.unit_cost ? body.unit_cost * body.quantity : undefined,
        referenceType: body.reference_type,
        referenceId: body.reference_id,
        referenceLineId: body.reference_line_id,
        reasonCode: body.reason_code,
        notes: body.notes,
        performedBy: request.ctx.userId ?? 'api',
        performedAt: new Date(),
        tenant: { connect: { id: tenantId } },
        warehouse: { connect: { id: warehouseId } },
        product: { connect: { id: body.product_id } },
        ...(body.variant_id && { variant: { connect: { id: body.variant_id } } }),
        ...(body.lot_batch_id && { lotBatch: { connect: { id: body.lot_batch_id } } }),
        ...(body.from_location_id && { fromLocation: { connect: { id: body.from_location_id } } }),
        ...(body.to_location_id && { toLocation: { connect: { id: body.to_location_id } } }),
      });

      // Create event
      const event = createEvent(
        INVENTORY_EVENTS.MOVEMENT_RECORDED,
        {
          movement_id: movement.id,
          movement_type: body.movement_type,
          product_id: body.product_id,
          variant_id: body.variant_id,
          lot_batch_id: body.lot_batch_id,
          from_location_id: body.from_location_id,
          to_location_id: body.to_location_id,
          quantity: body.quantity,
          warehouse_id: warehouseId,
          reference_type: body.reference_type,
          reference_id: body.reference_id,
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
        aggregateType: 'Movement',
        aggregateId: movement.id,
        correlationId: event.correlation_id,
        causationId: event.causation_id,
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
        routingKey: `inventory.movement.${body.movement_type.toLowerCase()}`,
        payload: event,
        tenant: { connect: { id: tenantId } },
      });

      return { movement, event };
    });

    return reply.status(201).send({
      data: {
        id: result.movement.id,
        movement_type: result.movement.movementType,
        product_id: result.movement.productId,
        quantity: result.movement.quantity,
        created_at: result.movement.createdAt,
      },
      meta: {
        event_id: result.event.event_id,
        correlation_id: request.ctx.correlationId,
      },
    });
  });

  // Get movements
  fastify.get('/', {
    schema: {
      description: 'Get movements with optional filters',
      tags: ['Movements'],
      querystring: {
        type: 'object',
        properties: {
          product_id: { type: 'string', format: 'uuid' },
          location_id: { type: 'string', format: 'uuid' },
          movement_type: { type: 'string' },
          start_date: { type: 'string', format: 'date-time' },
          end_date: { type: 'string', format: 'date-time' },
          limit: { type: 'number', default: 50, maximum: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as {
      product_id?: string;
      location_id?: string;
      movement_type?: string;
      start_date?: string;
      end_date?: string;
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

    const movements = await prisma.movement.findMany({
      where: {
        tenantId,
        ...(warehouseId && { warehouseId }),
        ...(query.product_id && { productId: query.product_id }),
        ...(query.location_id && {
          OR: [
            { fromLocationId: query.location_id },
            { toLocationId: query.location_id },
          ],
        }),
        ...(query.movement_type && { movementType: query.movement_type }),
        ...(query.start_date || query.end_date
          ? {
              createdAt: {
                ...(query.start_date && { gte: new Date(query.start_date) }),
                ...(query.end_date && { lte: new Date(query.end_date) }),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
      include: {
        product: { select: { sku: true, name: true } },
        fromLocation: { select: { code: true } },
        toLocation: { select: { code: true } },
        lotBatch: { select: { lotNumber: true } },
      },
    });

    return {
      data: movements.map(m => ({
        id: m.id,
        movement_type: m.movementType,
        product_id: m.productId,
        product_sku: m.product.sku,
        product_name: m.product.name,
        from_location_id: m.fromLocationId,
        from_location_code: m.fromLocation?.code,
        to_location_id: m.toLocationId,
        to_location_code: m.toLocation?.code,
        lot_batch_id: m.lotBatchId,
        lot_number: m.lotBatch?.lotNumber,
        quantity: m.quantity,
        uom: m.uom,
        reference_type: m.referenceType,
        reference_id: m.referenceId,
        performed_by: m.performedBy,
        performed_at: m.performedAt,
        created_at: m.createdAt,
      })),
      meta: {
        total: movements.length,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get movement by ID
  fastify.get('/:id', {
    schema: {
      description: 'Get a specific movement',
      tags: ['Movements'],
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

    const movement = await prisma.movement.findUnique({
      where: { id },
      include: {
        product: { select: { sku: true, name: true } },
        fromLocation: { select: { code: true, zone: true } },
        toLocation: { select: { code: true, zone: true } },
        lotBatch: { select: { lotNumber: true, expirationDate: true } },
      },
    });

    if (!movement) {
      return reply.status(404).send({
        error_code: 'NOT_FOUND',
        message: 'Movement not found',
      });
    }

    return {
      data: {
        id: movement.id,
        movement_type: movement.movementType,
        product: movement.product,
        from_location: movement.fromLocation,
        to_location: movement.toLocation,
        lot_batch: movement.lotBatch,
        quantity: movement.quantity,
        uom: movement.uom,
        unit_cost: movement.unitCost,
        total_cost: movement.totalCost,
        reference_type: movement.referenceType,
        reference_id: movement.referenceId,
        reason_code: movement.reasonCode,
        notes: movement.notes,
        performed_by: movement.performedBy,
        performed_at: movement.performedAt,
        created_at: movement.createdAt,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });
};
