import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '@stockos/db';
import { StockLevelRepository } from '@stockos/db/repositories';

const StockQuerySchema = z.object({
  warehouse_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  lot_batch_id: z.string().uuid().optional(),
  include_zero: z.coerce.boolean().default(false),
});

export const inventoryRoutes: FastifyPluginAsync = async (fastify) => {
  // Get stock levels
  fastify.get('/stock', {
    schema: {
      description: 'Get stock levels with optional filters',
      tags: ['Inventory'],
      querystring: {
        type: 'object',
        properties: {
          warehouse_id: { type: 'string', format: 'uuid' },
          product_id: { type: 'string', format: 'uuid' },
          location_id: { type: 'string', format: 'uuid' },
          lot_batch_id: { type: 'string', format: 'uuid' },
          include_zero: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const query = StockQuerySchema.parse(request.query);
    const tenantId = request.ctx.tenantId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    const repo = new StockLevelRepository(prisma);
    const stocks = await repo.findMany({
      tenantId,
      warehouseId: query.warehouse_id,
      productId: query.product_id,
      locationId: query.location_id,
      lotBatchId: query.lot_batch_id,
      includeZeroStock: query.include_zero,
    });

    return {
      data: stocks.map(s => ({
        id: s.id,
        warehouse_id: s.warehouseId,
        product_id: s.productId,
        variant_id: s.variantId,
        location_id: s.locationId,
        lot_batch_id: s.lotBatchId,
        quantity_on_hand: s.quantityOnHand,
        quantity_reserved: s.quantityReserved,
        quantity_available: s.quantityAvailable,
        quantity_inbound: s.quantityInbound,
        quantity_outbound: s.quantityOutbound,
        last_movement_at: s.lastMovementAt,
        product: (s as any).product,
        location: (s as any).location,
        lot_batch: (s as any).lotBatch,
      })),
      meta: {
        total: stocks.length,
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get stock summary for a product
  fastify.get('/stock/summary/:productId', {
    schema: {
      description: 'Get stock summary for a product across all locations',
      tags: ['Inventory'],
      params: {
        type: 'object',
        required: ['productId'],
        properties: {
          productId: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          warehouse_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { productId } = request.params as { productId: string };
    const { warehouse_id } = request.query as { warehouse_id?: string };
    const tenantId = request.ctx.tenantId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    const stockLevels = await prisma.stockLevel.aggregate({
      where: {
        tenantId,
        productId,
        ...(warehouse_id && { warehouseId: warehouse_id }),
      },
      _sum: {
        quantityOnHand: true,
        quantityReserved: true,
        quantityAvailable: true,
        quantityInbound: true,
        quantityOutbound: true,
      },
      _count: {
        locationId: true,
      },
    });

    const lotCount = await prisma.stockLevel.groupBy({
      by: ['lotBatchId'],
      where: {
        tenantId,
        productId,
        ...(warehouse_id && { warehouseId: warehouse_id }),
        lotBatchId: { not: null },
      },
    });

    return {
      data: {
        product_id: productId,
        warehouse_id: warehouse_id,
        total_on_hand: stockLevels._sum.quantityOnHand ?? 0,
        total_reserved: stockLevels._sum.quantityReserved ?? 0,
        total_available: stockLevels._sum.quantityAvailable ?? 0,
        total_inbound: stockLevels._sum.quantityInbound ?? 0,
        total_outbound: stockLevels._sum.quantityOutbound ?? 0,
        location_count: stockLevels._count.locationId,
        lot_count: lotCount.length,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Check availability
  fastify.post('/stock/availability', {
    schema: {
      description: 'Check stock availability for multiple products',
      tags: ['Inventory'],
      body: {
        type: 'object',
        required: ['warehouse_id', 'items'],
        properties: {
          warehouse_id: { type: 'string', format: 'uuid' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['product_id', 'quantity'],
              properties: {
                product_id: { type: 'string', format: 'uuid' },
                variant_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'number', minimum: 1 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      warehouse_id: string;
      items: Array<{ product_id: string; variant_id?: string; quantity: number }>;
    };
    const tenantId = request.ctx.tenantId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    const results = await Promise.all(
      body.items.map(async (item) => {
        const stock = await prisma.stockLevel.aggregate({
          where: {
            tenantId,
            warehouseId: body.warehouse_id,
            productId: item.product_id,
            variantId: item.variant_id ?? null,
          },
          _sum: {
            quantityAvailable: true,
          },
        });

        const available = stock._sum.quantityAvailable ?? 0;

        return {
          product_id: item.product_id,
          variant_id: item.variant_id,
          requested: item.quantity,
          available,
          is_available: available >= item.quantity,
          shortfall: Math.max(0, item.quantity - available),
        };
      })
    );

    const allAvailable = results.every((r) => r.is_available);

    return {
      data: {
        warehouse_id: body.warehouse_id,
        all_available: allAvailable,
        items: results,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });
};
