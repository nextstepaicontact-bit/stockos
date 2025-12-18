import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-company' },
    update: {},
    create: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Demo Company',
      slug: 'demo-company',
      settings: {
        timezone: 'America/New_York',
        currency: 'USD',
        language: 'en',
      },
    },
  });
  console.log(`Created tenant: ${tenant.name}`);

  // Create warehouse
  const warehouse = await prisma.warehouse.upsert({
    where: {
      tenantId_code: {
        tenantId: tenant.id,
        code: 'WH-001',
      },
    },
    update: {},
    create: {
      id: '22222222-2222-2222-2222-222222222222',
      tenantId: tenant.id,
      code: 'WH-001',
      name: 'Main Distribution Center',
      address: {
        street: '123 Warehouse Lane',
        city: 'Atlanta',
        state: 'GA',
        zip: '30301',
        country: 'US',
      },
      timezone: 'America/New_York',
      settings: {
        allowNegativeStock: false,
        requireLotTracking: true,
      },
    },
  });
  console.log(`Created warehouse: ${warehouse.name}`);

  // Create zones and locations
  const zones = ['A', 'B', 'C', 'RECV', 'SHIP', 'QC'];
  const locationTypes: Record<string, string> = {
    A: 'PICK',
    B: 'PICK',
    C: 'BULK',
    RECV: 'RECEIVING',
    SHIP: 'SHIPPING',
    QC: 'QUARANTINE',
  };

  for (const zone of zones) {
    const aisleCount = zone === 'RECV' || zone === 'SHIP' || zone === 'QC' ? 1 : 3;
    const rackCount = zone === 'RECV' || zone === 'SHIP' || zone === 'QC' ? 2 : 5;
    const shelfCount = zone === 'RECV' || zone === 'SHIP' || zone === 'QC' ? 1 : 4;

    for (let aisle = 1; aisle <= aisleCount; aisle++) {
      for (let rack = 1; rack <= rackCount; rack++) {
        for (let shelf = 1; shelf <= shelfCount; shelf++) {
          const code = `${zone}-${String(aisle).padStart(2, '0')}-${String(rack).padStart(2, '0')}-${String(shelf).padStart(2, '0')}`;
          await prisma.location.upsert({
            where: {
              tenantId_warehouseId_code: {
                tenantId: tenant.id,
                warehouseId: warehouse.id,
                code,
              },
            },
            update: {},
            create: {
              tenantId: tenant.id,
              warehouseId: warehouse.id,
              code,
              zone,
              aisle: String(aisle).padStart(2, '0'),
              rack: String(rack).padStart(2, '0'),
              shelf: String(shelf).padStart(2, '0'),
              type: locationTypes[zone],
              temperatureZone: 'AMBIENT',
              maxWeight: 500,
              maxVolume: 2.5,
              maxItems: 100,
              pickSequence: aisle * 100 + rack * 10 + shelf,
              isActive: true,
              allowMixedProducts: zone !== 'QC',
              allowMixedLots: zone !== 'QC',
              isHazmatCertified: zone === 'C',
            },
          });
        }
      }
    }
  }
  console.log('Created locations');

  // Create categories
  const electronics = await prisma.category.upsert({
    where: {
      tenantId_path: {
        tenantId: tenant.id,
        path: 'electronics',
      },
    },
    update: {},
    create: {
      id: '33333333-3333-3333-3333-333333333333',
      tenantId: tenant.id,
      name: 'Electronics',
      path: 'electronics',
      level: 0,
    },
  });

  const phones = await prisma.category.upsert({
    where: {
      tenantId_path: {
        tenantId: tenant.id,
        path: 'electronics/phones',
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Phones',
      path: 'electronics/phones',
      parentId: electronics.id,
      level: 1,
    },
  });

  const accessories = await prisma.category.upsert({
    where: {
      tenantId_path: {
        tenantId: tenant.id,
        path: 'electronics/accessories',
      },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Accessories',
      path: 'electronics/accessories',
      parentId: electronics.id,
      level: 1,
    },
  });
  console.log('Created categories');

  // Create products
  const products = [
    {
      id: '44444444-4444-4444-4444-444444444444',
      sku: 'PHONE-001',
      name: 'Smartphone Pro X',
      categoryId: phones.id,
      abcClass: 'A',
      xyzClass: 'X',
      reorderPoint: 50,
      safetyStock: 20,
      leadTimeDays: 14,
      isLotTracked: true,
      isSerialTracked: true,
    },
    {
      id: '55555555-5555-5555-5555-555555555555',
      sku: 'PHONE-002',
      name: 'Budget Phone Basic',
      categoryId: phones.id,
      abcClass: 'B',
      xyzClass: 'Y',
      reorderPoint: 100,
      safetyStock: 30,
      leadTimeDays: 7,
      isLotTracked: true,
      isSerialTracked: false,
    },
    {
      id: '66666666-6666-6666-6666-666666666666',
      sku: 'CASE-001',
      name: 'Premium Phone Case',
      categoryId: accessories.id,
      abcClass: 'B',
      xyzClass: 'X',
      reorderPoint: 200,
      safetyStock: 50,
      leadTimeDays: 5,
      isLotTracked: false,
      isSerialTracked: false,
    },
    {
      id: '77777777-7777-7777-7777-777777777777',
      sku: 'CHRG-001',
      name: 'Fast Charger 65W',
      categoryId: accessories.id,
      abcClass: 'A',
      xyzClass: 'X',
      reorderPoint: 150,
      safetyStock: 40,
      leadTimeDays: 10,
      isLotTracked: true,
      isSerialTracked: false,
    },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: {
        tenantId_sku: {
          tenantId: tenant.id,
          sku: product.sku,
        },
      },
      update: {},
      create: {
        ...product,
        tenantId: tenant.id,
        unitOfMeasure: 'UNIT',
        isHazmat: false,
        isActive: true,
      },
    });
  }
  console.log('Created products');

  // Create supplier
  const supplier = await prisma.supplier.upsert({
    where: {
      tenantId_code: {
        tenantId: tenant.id,
        code: 'SUPP-001',
      },
    },
    update: {},
    create: {
      id: '88888888-8888-8888-8888-888888888888',
      tenantId: tenant.id,
      code: 'SUPP-001',
      name: 'Tech Supplies Inc.',
      contactName: 'John Smith',
      email: 'orders@techsupplies.com',
      phone: '+1-555-0100',
      address: {
        street: '456 Supplier Ave',
        city: 'San Jose',
        state: 'CA',
        zip: '95101',
        country: 'US',
      },
      leadTimeDays: 7,
      rating: 4.5,
    },
  });
  console.log(`Created supplier: ${supplier.name}`);

  // Create user
  await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: tenant.id,
        email: 'admin@demo-company.com',
      },
    },
    update: {},
    create: {
      id: '99999999-9999-9999-9999-999999999999',
      tenantId: tenant.id,
      email: 'admin@demo-company.com',
      name: 'Admin User',
      role: 'ADMIN',
      permissions: ['*'],
      warehouseIds: [warehouse.id],
    },
  });
  console.log('Created admin user');

  // Create some initial stock
  const pickLocation = await prisma.location.findFirst({
    where: {
      tenantId: tenant.id,
      warehouseId: warehouse.id,
      zone: 'A',
    },
  });

  if (pickLocation) {
    for (const product of products) {
      await prisma.stockLevel.upsert({
        where: {
          tenantId_warehouseId_productId_locationId_lotBatchId: {
            tenantId: tenant.id,
            warehouseId: warehouse.id,
            productId: product.id,
            locationId: pickLocation.id,
            lotBatchId: null as unknown as string,
          },
        },
        update: {},
        create: {
          tenantId: tenant.id,
          warehouseId: warehouse.id,
          productId: product.id,
          locationId: pickLocation.id,
          quantityOnHand: 100,
          quantityReserved: 0,
          quantityAvailable: 100,
          quantityInbound: 0,
          quantityOutbound: 0,
        },
      });
    }
    console.log('Created initial stock levels');
  }

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
