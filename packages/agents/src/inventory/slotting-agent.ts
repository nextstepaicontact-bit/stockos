import type { EventEnvelope } from '@stockos/contracts';
import { RECEIVING_EVENTS, createEvent } from '@stockos/contracts';
import { BaseAgent, type AgentContext, type AgentResult } from '../runtime/base-agent.js';
import { prisma } from '@stockos/db';
import { SlottingScorer, type SlottingCandidate, type SlottingContext } from '@stockos/domain/rules';

export class SlottingAgent extends BaseAgent {
  readonly name = 'SlottingAgent';
  readonly description = 'Suggests optimal storage locations for received goods';
  readonly subscribesTo = [
    RECEIVING_EVENTS.GOODS_RECEIVED,
    'SlottingSuggestionRequested',
  ];

  private scorer = new SlottingScorer();

  protected async process(
    event: EventEnvelope,
    context: AgentContext
  ): Promise<AgentResult> {
    const payload = event.payload as {
      receipt_id: string;
      warehouse_id: string;
      lines: Array<{
        line_id: string;
        product_id: string;
        quantity_received: number;
        lot_batch_id?: string;
      }>;
    };

    context.logger.info('Processing slotting for receipt', {
      receiptId: payload.receipt_id,
      lineCount: payload.lines.length,
    });

    try {
      const suggestions: Array<{
        lineId: string;
        productId: string;
        suggestedLocations: Array<{
          locationId: string;
          locationCode: string;
          score: number;
          zone: string;
        }>;
      }> = [];

      for (const line of payload.lines) {
        const lineSuggestions = await this.suggestLocationsForLine(
          context.tenantId,
          payload.warehouse_id,
          line,
          context
        );
        suggestions.push(lineSuggestions);
      }

      // Create slotting suggestion event
      const suggestionEvent = createEvent(
        'SlottingSuggestionsGenerated',
        {
          receipt_id: payload.receipt_id,
          warehouse_id: payload.warehouse_id,
          suggestions,
          generated_at: new Date().toISOString(),
        },
        {
          correlationId: context.correlationId,
          causationId: event.event_id,
          actor: event.actor,
          tenantId: context.tenantId,
          warehouseId: payload.warehouse_id,
        }
      );

      return this.createSuccessResult(
        `Generated slotting suggestions for ${payload.lines.length} lines`,
        { suggestions },
        [suggestionEvent]
      );
    } catch (error) {
      context.logger.error('Failed to generate slotting suggestions', error);
      return this.createFailureResult(
        'Failed to generate slotting suggestions',
        [error instanceof Error ? error.message : 'Unknown error']
      );
    }
  }

  private async suggestLocationsForLine(
    tenantId: string,
    warehouseId: string,
    line: {
      line_id: string;
      product_id: string;
      quantity_received: number;
      lot_batch_id?: string;
    },
    context: AgentContext
  ): Promise<{
    lineId: string;
    productId: string;
    suggestedLocations: Array<{
      locationId: string;
      locationCode: string;
      score: number;
      zone: string;
    }>;
  }> {
    // Get product details
    const product = await prisma.product.findUnique({
      where: { id: line.product_id },
      select: {
        abcClass: true,
        temperatureRequired: true,
        isHazmat: true,
      },
    });

    // Get available locations
    const locations = await prisma.location.findMany({
      where: {
        tenantId,
        warehouseId,
        isActive: true,
        type: { in: ['BULK', 'PICK'] },
      },
      include: {
        stockLevels: {
          select: {
            quantityOnHand: true,
          },
        },
      },
    });

    // Build candidates
    const candidates: SlottingCandidate[] = locations.map(loc => ({
      location: {
        id: loc.id,
        tenantId: loc.tenantId,
        warehouseId: loc.warehouseId,
        code: loc.code,
        zone: loc.zone,
        aisle: loc.aisle ?? undefined,
        rack: loc.rack ?? undefined,
        shelf: loc.shelf ?? undefined,
        bin: loc.bin ?? undefined,
        type: loc.type as 'BULK' | 'PICK',
        temperatureZone: loc.temperatureZone as 'AMBIENT' | 'CHILLED' | 'FROZEN' | 'CONTROLLED',
        maxWeight: loc.maxWeight ? Number(loc.maxWeight) : undefined,
        maxVolume: loc.maxVolume ? Number(loc.maxVolume) : undefined,
        maxItems: loc.maxItems ?? undefined,
        pickSequence: loc.pickSequence ?? undefined,
        isActive: loc.isActive,
        allowMixedProducts: loc.allowMixedProducts,
        allowMixedLots: loc.allowMixedLots,
        isHazmatCertified: loc.isHazmatCertified,
        createdAt: loc.createdAt,
        updatedAt: loc.updatedAt,
      },
      currentUtilization: this.calculateUtilization(loc),
      distanceFromDock: loc.pickSequence ?? 999,
      pickFrequency: this.estimatePickFrequency(loc.zone),
    }));

    // Build slotting context
    const slottingContext: SlottingContext = {
      productAbcClass: (product?.abcClass as 'A' | 'B' | 'C') ?? undefined,
      temperatureRequired: product?.temperatureRequired as 'AMBIENT' | 'CHILLED' | 'FROZEN' | 'CONTROLLED' | undefined,
      isHazmat: product?.isHazmat ?? false,
      quantityToStore: line.quantity_received,
    };

    // Score locations
    const scored = this.scorer.scoreLocations(candidates, slottingContext);
    const top3 = scored.slice(0, 3);

    return {
      lineId: line.line_id,
      productId: line.product_id,
      suggestedLocations: top3.map(s => ({
        locationId: s.location.id,
        locationCode: s.location.code,
        score: Math.round(s.score * 100) / 100,
        zone: s.location.zone,
      })),
    };
  }

  private calculateUtilization(location: {
    maxItems: number | null;
    stockLevels: { quantityOnHand: number }[];
  }): number {
    if (!location.maxItems) return 0;
    const totalItems = location.stockLevels.reduce(
      (sum, sl) => sum + sl.quantityOnHand,
      0
    );
    return (totalItems / location.maxItems) * 100;
  }

  private estimatePickFrequency(zone: string): number {
    // A zones are typically high-frequency pick areas
    // B zones are medium, C zones are bulk storage
    const frequencyMap: Record<string, number> = {
      A: 80,
      B: 50,
      C: 20,
      RECV: 10,
      SHIP: 10,
      QC: 5,
    };
    return frequencyMap[zone] ?? 30;
  }
}
