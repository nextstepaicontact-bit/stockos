import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '@stockos/db';

export const productsRoutes: FastifyPluginAsync = async (fastify) => {
  // Get products
  fastify.get('/', {
    schema: {
      description: 'Get products with optional filters',
      tags: ['Products'],
      querystring: {
        type: 'object',
        properties: {
          category_id: { type: 'string', format: 'uuid' },
          abc_class: { type: 'string', enum: ['A', 'B', 'C'] },
          is_active: { type: 'boolean', default: true },
          search: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as {
      category_id?: string;
      abc_class?: string;
      is_active?: boolean;
      search?: string;
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

    const products = await prisma.product.findMany({
      where: {
        tenantId,
        isActive: query.is_active ?? true,
        ...(query.category_id && { categoryId: query.category_id }),
        ...(query.abc_class && { abcClass: query.abc_class }),
        ...(query.search && {
          OR: [
            { sku: { contains: query.search, mode: 'insensitive' } },
            { name: { contains: query.search, mode: 'insensitive' } },
            { barcode: { contains: query.search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { sku: 'asc' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
      include: {
        category: { select: { name: true, path: true } },
      },
    });

    return {
      data: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        barcode: p.barcode,
        category: p.category,
        unit_of_measure: p.unitOfMeasure,
        abc_class: p.abcClass,
        xyz_class: p.xyzClass,
        reorder_point: p.reorderPoint,
        safety_stock: p.safetyStock,
        lead_time_days: p.leadTimeDays,
        is_lot_tracked: p.isLotTracked,
        is_serial_tracked: p.isSerialTracked,
        is_hazmat: p.isHazmat,
        is_active: p.isActive,
      })),
      meta: {
        total: products.length,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Get product by ID
  fastify.get('/:id', {
    schema: {
      description: 'Get a specific product',
      tags: ['Products'],
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

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: { select: { name: true, path: true } },
        variants: true,
      },
    });

    if (!product) {
      return reply.status(404).send({
        error_code: 'NOT_FOUND',
        message: 'Product not found',
      });
    }

    return {
      data: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description,
        barcode: product.barcode,
        category: product.category,
        unit_of_measure: product.unitOfMeasure,
        weight: product.weight,
        length: product.length,
        width: product.width,
        height: product.height,
        volume: product.volume,
        abc_class: product.abcClass,
        xyz_class: product.xyzClass,
        reorder_point: product.reorderPoint,
        safety_stock: product.safetyStock,
        max_stock: product.maxStock,
        lead_time_days: product.leadTimeDays,
        shelf_life_days: product.shelfLifeDays,
        temperature_required: product.temperatureRequired,
        is_lot_tracked: product.isLotTracked,
        is_serial_tracked: product.isSerialTracked,
        is_hazmat: product.isHazmat,
        is_active: product.isActive,
        variants: product.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          attributes: v.attributes,
          barcode: v.barcode,
          is_active: v.isActive,
        })),
        created_at: product.createdAt,
        updated_at: product.updatedAt,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });

  // Create product
  fastify.post('/', {
    schema: {
      description: 'Create a new product',
      tags: ['Products'],
      body: {
        type: 'object',
        required: ['sku', 'name'],
        properties: {
          sku: { type: 'string', maxLength: 100 },
          name: { type: 'string', maxLength: 255 },
          description: { type: 'string' },
          barcode: { type: 'string' },
          category_id: { type: 'string', format: 'uuid' },
          unit_of_measure: { type: 'string', default: 'UNIT' },
          weight: { type: 'number' },
          length: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          reorder_point: { type: 'number' },
          safety_stock: { type: 'number' },
          max_stock: { type: 'number' },
          lead_time_days: { type: 'number' },
          shelf_life_days: { type: 'number' },
          temperature_required: { type: 'string' },
          is_lot_tracked: { type: 'boolean', default: false },
          is_serial_tracked: { type: 'boolean', default: false },
          is_hazmat: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      sku: string;
      name: string;
      description?: string;
      barcode?: string;
      category_id?: string;
      unit_of_measure?: string;
      weight?: number;
      length?: number;
      width?: number;
      height?: number;
      reorder_point?: number;
      safety_stock?: number;
      max_stock?: number;
      lead_time_days?: number;
      shelf_life_days?: number;
      temperature_required?: string;
      is_lot_tracked?: boolean;
      is_serial_tracked?: boolean;
      is_hazmat?: boolean;
    };
    const tenantId = request.ctx.tenantId;

    if (!tenantId) {
      return reply.status(400).send({
        error_code: 'MISSING_TENANT',
        message: 'x-tenant-id header is required',
      });
    }

    // Check SKU uniqueness
    const existing = await prisma.product.findFirst({
      where: { tenantId, sku: body.sku },
    });

    if (existing) {
      return reply.status(409).send({
        error_code: 'DUPLICATE_SKU',
        message: `Product with SKU ${body.sku} already exists`,
      });
    }

    const product = await prisma.product.create({
      data: {
        tenantId,
        sku: body.sku,
        name: body.name,
        description: body.description,
        barcode: body.barcode,
        categoryId: body.category_id,
        unitOfMeasure: body.unit_of_measure ?? 'UNIT',
        weight: body.weight,
        length: body.length,
        width: body.width,
        height: body.height,
        reorderPoint: body.reorder_point,
        safetyStock: body.safety_stock,
        maxStock: body.max_stock,
        leadTimeDays: body.lead_time_days,
        shelfLifeDays: body.shelf_life_days,
        temperatureRequired: body.temperature_required,
        isLotTracked: body.is_lot_tracked ?? false,
        isSerialTracked: body.is_serial_tracked ?? false,
        isHazmat: body.is_hazmat ?? false,
        isActive: true,
      },
    });

    return reply.status(201).send({
      data: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        created_at: product.createdAt,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    });
  });

  // Update product
  fastify.patch('/:id', {
    schema: {
      description: 'Update a product',
      tags: ['Products'],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          barcode: { type: 'string' },
          reorder_point: { type: 'number' },
          safety_stock: { type: 'number' },
          max_stock: { type: 'number' },
          lead_time_days: { type: 'number' },
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    const product = await prisma.product.update({
      where: { id },
      data: {
        ...(body.name && { name: body.name as string }),
        ...(body.description !== undefined && { description: body.description as string }),
        ...(body.barcode !== undefined && { barcode: body.barcode as string }),
        ...(body.reorder_point !== undefined && { reorderPoint: body.reorder_point as number }),
        ...(body.safety_stock !== undefined && { safetyStock: body.safety_stock as number }),
        ...(body.max_stock !== undefined && { maxStock: body.max_stock as number }),
        ...(body.lead_time_days !== undefined && { leadTimeDays: body.lead_time_days as number }),
        ...(body.is_active !== undefined && { isActive: body.is_active as boolean }),
      },
    });

    return {
      data: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        updated_at: product.updatedAt,
      },
      meta: {
        correlation_id: request.ctx.correlationId,
      },
    };
  });
};
