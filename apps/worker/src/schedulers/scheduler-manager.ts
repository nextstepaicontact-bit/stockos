import { CronJob } from 'cron';
import { randomUUID } from 'crypto';
import { logger } from '@stockos/observability';
import { prisma } from '@stockos/db';
import { EventStoreRepository, OutboxRepository } from '@stockos/db/repositories';
import { createEvent } from '@stockos/contracts';

interface ScheduledJob {
  name: string;
  cron: string;
  eventType: string;
  payload: Record<string, unknown>;
  tenantScope: 'all' | 'specific';
}

const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: 'lot-expiry-check',
    cron: '0 0 * * *', // Daily at midnight
    eventType: 'ScheduledExpiryCheck',
    payload: { check_type: 'FULL' },
    tenantScope: 'all',
  },
  {
    name: 'abc-xyz-analysis',
    cron: '0 2 1 * *', // Monthly on 1st at 2 AM
    eventType: 'ScheduledAbcXyzAnalysis',
    payload: { analysis_period_days: 90 },
    tenantScope: 'all',
  },
  {
    name: 'safety-stock-recalc',
    cron: '0 3 * * 0', // Weekly on Sunday at 3 AM
    eventType: 'ScheduledSafetyStockRecalc',
    payload: { service_level: 0.95 },
    tenantScope: 'all',
  },
  {
    name: 'demand-forecast',
    cron: '0 4 * * 0', // Weekly on Sunday at 4 AM
    eventType: 'ScheduledDemandForecast',
    payload: { forecast_days: 30 },
    tenantScope: 'all',
  },
  {
    name: 'outbox-cleanup',
    cron: '0 5 * * *', // Daily at 5 AM
    eventType: 'internal:outbox-cleanup',
    payload: { days_to_keep: 7 },
    tenantScope: 'all',
  },
];

export class SchedulerManager {
  private jobs: CronJob[] = [];

  start(): void {
    for (const jobConfig of SCHEDULED_JOBS) {
      const job = new CronJob(
        jobConfig.cron,
        () => this.executeJob(jobConfig),
        null,
        true,
        'UTC'
      );

      this.jobs.push(job);

      logger.info('Scheduled job registered', {
        name: jobConfig.name,
        cron: jobConfig.cron,
        nextRun: job.nextDate().toISO(),
      });
    }
  }

  stop(): void {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
  }

  private async executeJob(jobConfig: ScheduledJob): Promise<void> {
    const jobLogger = logger.child({ job: jobConfig.name });
    const correlationId = randomUUID();

    jobLogger.info('Executing scheduled job', {
      correlationId,
      eventType: jobConfig.eventType,
    });

    try {
      // Handle internal jobs
      if (jobConfig.eventType.startsWith('internal:')) {
        await this.handleInternalJob(jobConfig, jobLogger);
        return;
      }

      // Get all tenants or specific tenant
      const tenants = await prisma.tenant.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
      });

      for (const tenant of tenants) {
        try {
          // Get warehouses for tenant
          const warehouses = await prisma.warehouse.findMany({
            where: { tenantId: tenant.id, isActive: true },
            select: { id: true },
          });

          for (const warehouse of warehouses) {
            // Create event
            const event = createEvent(
              jobConfig.eventType,
              {
                ...jobConfig.payload,
                warehouse_id: warehouse.id,
                triggered_by: 'scheduler',
                job_name: jobConfig.name,
              },
              {
                correlationId,
                actor: { type: 'SYSTEM', id: 'scheduler' },
                tenantId: tenant.id,
                warehouseId: warehouse.id,
              }
            );

            // Store event
            const eventRepo = new EventStoreRepository(prisma);
            await eventRepo.append({
              tenantId: tenant.id,
              eventId: event.event_id,
              eventType: event.event_type,
              aggregateType: 'ScheduledJob',
              aggregateId: jobConfig.name,
              correlationId: event.correlation_id,
              occurredAt: new Date(event.occurred_at),
              payload: event.payload,
              metadata: { actor: event.actor },
              tenant: { connect: { id: tenant.id } },
            });

            // Add to outbox
            const outboxRepo = new OutboxRepository(prisma);
            await outboxRepo.create({
              tenantId: tenant.id,
              eventId: event.event_id,
              eventType: event.event_type,
              routingKey: `scheduled.${jobConfig.name.replace(/-/g, '.')}`,
              payload: event,
              tenant: { connect: { id: tenant.id } },
            });

            jobLogger.debug('Created scheduled event', {
              tenantId: tenant.id,
              warehouseId: warehouse.id,
              eventId: event.event_id,
            });
          }
        } catch (error) {
          jobLogger.error('Failed to create event for tenant', error, {
            tenantId: tenant.id,
          });
        }
      }

      jobLogger.info('Scheduled job completed', {
        correlationId,
        tenantsProcessed: tenants.length,
      });
    } catch (error) {
      jobLogger.error('Scheduled job failed', error, { correlationId });
    }
  }

  private async handleInternalJob(
    jobConfig: ScheduledJob,
    jobLogger: ReturnType<typeof logger.child>
  ): Promise<void> {
    switch (jobConfig.eventType) {
      case 'internal:outbox-cleanup': {
        const daysToKeep = (jobConfig.payload.days_to_keep as number) ?? 7;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const deleted = await prisma.outboxMessage.deleteMany({
          where: {
            status: 'PUBLISHED',
            publishedAt: { lt: cutoffDate },
          },
        });

        jobLogger.info('Outbox cleanup completed', {
          deletedCount: deleted.count,
          cutoffDate,
        });
        break;
      }

      default:
        jobLogger.warn('Unknown internal job', {
          eventType: jobConfig.eventType,
        });
    }
  }
}
