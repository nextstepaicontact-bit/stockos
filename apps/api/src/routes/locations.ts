import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '@stockos/db';

export const locationsRoutes: FastifyPluginAsync = async (fastify) => {
  // Get locations
  fastify.get('/', {
    schema: {
      description: 'Get locations with optional filters',
      tags: ['Locations'],
      querystring: {
        type: 'object',
        properties: {
          zone: { type: 'string' },
          type: { type: 'string' },
          is_active: { type: 'boolean', default: true },
          limit: { type: 'number', default: 100 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as {
      zone?: string;
      type?: string;
      is_active?: boolean;
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

    const locations = await prisma.location.findMany({
      where: {
        tenantId,
        ...(warehouseId && { warehouseId }),
        isActive: query.is_active ?? true,
        ...(query.zone && { zone: query.zone }),
        ...(query.type && { type: query.type }),
      },
      orderBy: [{ zone: 'asc' }, { code: 'asc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    });

    return {
      data: locations.map((l) => ({
        id: l.id,
        code: l.code,
        zone: l.zone,
        aisle: l.aisle,
        rack: l.rack,
        shelf: l.shelf,
        bin: l.bin,
        type: l.type,
        temperature_zone: l.temperatureZone,
        max_weight: l.maxWeight,
        max_volume: l.maxVolume,
        max_items: l.maxItems,
        pick_sequence: l.pickSequence,
        is_active: l.isActive,
        allow_mixed_products: l.allowMixedProducts,
        allow_mixed_lots: l.allowMixedLots,
        is_hazmat_certified: l.isHazmatCertified,
      })),
      meta: {
        total: locations.length,
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get location by ID
  fastify.get('/:id', {
    schema: {
      description: 'Get a specific location with current stock',
      tags: ['Locations'],
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

    const location = await prisma.location.findUnique({
      where: { id },
      include: {
        stockLevels: {
          where: { quantityOnHand: { gt: 0 } },
          include: {
            product: { select: { sku: true, name: true } },
            lotBatch: { select: { lotNumber: true, expirationDate: true } },
          },
        },
      },
    });

    if (!location) {
      return reply.status(404).send({
        error_code: 'NOT_FOUND',
        message: 'Location not found',
      });
    }

    return {
      data: {
        id: location.id,
        code: location.code,
        zone: location.zone,
        aisle: location.aisle,
        rack: location.rack,
        shelf: location.shelf,
        bin: location.bin,
        type: location.type,
        temperature_zone: location.temperatureZone,
        max_weight: location.maxWeight,
        max_volume: location.maxVolume,
        max_items: location.maxItems,
        pick_sequence: location.pickSequence,
        is_active: location.isActive,
        allow_mixed_products: location.allowMixedProducts,
        allow_mixed_lots: location.allowMixedLots,
        is_hazmat_certified: location.isHazmatCertified,
        current_stock: location.stockLevels.map((s) => ({
          product: s.product,
          lot_batch: s.lotBatch,
          quantity_on_hand: s.quantityOnHand,
          quantity_reserved: s.quantityReserved,
          quantity_available: s.quantityAvailable,
        })),
        total_items: location.stockLevels.reduce(
          (sum, s) => sum + s.quantityOnHand,
          0
        ),
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get zones summary
  fastify.get('/zones/summary', {
    schema: {
      description: 'Get summary of zones with stock counts',
      tags: ['Locations'],
    },
  }, async (request, reply) => {
    const tenantId = request.ctx.tenantId;
    const warehouseId = request.ctx.warehouseId;

    if (!tenantId || !warehouseId) {
      return reply.status(400).send({
        error_code: 'MISSING_CONTEXT',
        message: 'x-tenant-id and x-warehouse-id headers are required',
      });
    }

    const zones = await prisma.location.groupBy({
      by: ['zone', 'type'],
      where: {
        tenantId,
        warehouseId,
        isActive: true,
      },
      _count: { id: true },
    });

    const stockByZone = await prisma.stockLevel.groupBy({
      by: ['locationId'],
      where: {
        tenantId,
        warehouseId,
        quantityOnHand: { gt: 0 },
      },
      _sum: { quantityOnHand: true },
    });

    // Get location zones for stock
    const locationZones = await prisma.location.findMany({
      where: {
        id: { in: stockByZone.map((s) => s.locationId) },
      },
      select: { id: true, zone: true },
    });

    const zoneMap = new Map(locationZones.map((l) => [l.id, l.zone]));

    const stockSummary = stockByZone.reduce(
      (acc, s) => {
        const zone = zoneMap.get(s.locationId) ?? 'UNKNOWN';
        acc[zone] = (acc[zone] ?? 0) + (s._sum.quantityOnHand ?? 0);
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      data: {
        zones: zones.map((z) => ({
          zone: z.zone,
          type: z.type,
          location_count: z._count.id,
          total_stock: stockSummary[z.zone] ?? 0,
        })),
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });
};
