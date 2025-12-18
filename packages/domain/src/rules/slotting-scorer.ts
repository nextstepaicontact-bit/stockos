import type { Location, LocationType, TemperatureZone } from '../entities/location.js';
import type { ABCClass } from '../entities/product.js';

export interface SlottingCandidate {
  location: Location;
  currentUtilization: number;
  distanceFromDock: number;
  pickFrequency: number;
}

export interface SlottingContext {
  productAbcClass?: ABCClass;
  temperatureRequired?: TemperatureZone;
  isHazmat: boolean;
  quantityToStore: number;
  preferredZones?: string[];
  excludedLocations?: string[];
}

export interface SlottingWeights {
  abcVelocity: number;
  proximity: number;
  capacity: number;
  temperature: number;
  fefo: number;
  hazard: number;
}

export const DEFAULT_SLOTTING_WEIGHTS: SlottingWeights = {
  abcVelocity: 0.30,
  proximity: 0.25,
  capacity: 0.20,
  temperature: 0.10,
  fefo: 0.10,
  hazard: 0.05,
};

export interface ScoredLocation {
  location: Location;
  score: number;
  breakdown: {
    abcVelocityScore: number;
    proximityScore: number;
    capacityScore: number;
    temperatureScore: number;
    fefoScore: number;
    hazardScore: number;
  };
}

export class SlottingScorer {
  private weights: SlottingWeights;

  constructor(weights: Partial<SlottingWeights> = {}) {
    this.weights = { ...DEFAULT_SLOTTING_WEIGHTS, ...weights };
  }

  scoreLocations(
    candidates: SlottingCandidate[],
    context: SlottingContext
  ): ScoredLocation[] {
    const validCandidates = candidates.filter(c =>
      this.isLocationValid(c.location, context)
    );

    const scored = validCandidates.map(candidate => {
      const breakdown = {
        abcVelocityScore: this.scoreAbcVelocity(candidate, context),
        proximityScore: this.scoreProximity(candidate, candidates),
        capacityScore: this.scoreCapacity(candidate),
        temperatureScore: this.scoreTemperature(candidate.location, context),
        fefoScore: this.scoreFefo(candidate.location),
        hazardScore: this.scoreHazard(candidate.location, context),
      };

      const score =
        breakdown.abcVelocityScore * this.weights.abcVelocity +
        breakdown.proximityScore * this.weights.proximity +
        breakdown.capacityScore * this.weights.capacity +
        breakdown.temperatureScore * this.weights.temperature +
        breakdown.fefoScore * this.weights.fefo +
        breakdown.hazardScore * this.weights.hazard;

      return {
        location: candidate.location,
        score,
        breakdown,
      };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  private isLocationValid(location: Location, context: SlottingContext): boolean {
    if (!location.isActive) return false;

    // Check excluded locations
    if (context.excludedLocations?.includes(location.id)) return false;

    // Check preferred zones
    if (context.preferredZones?.length && !context.preferredZones.includes(location.zone)) {
      return false;
    }

    // Check temperature compatibility
    if (context.temperatureRequired) {
      if (context.temperatureRequired !== 'AMBIENT' &&
          location.temperatureZone !== context.temperatureRequired) {
        return false;
      }
    }

    // Check hazmat
    if (context.isHazmat && !location.isHazmatCertified) {
      return false;
    }

    return true;
  }

  private scoreAbcVelocity(candidate: SlottingCandidate, context: SlottingContext): number {
    // A-class items should be in high-frequency pick locations
    // Score based on match between product velocity and location pick frequency
    const abcMultiplier = context.productAbcClass === 'A' ? 1.0 :
                         context.productAbcClass === 'B' ? 0.6 : 0.3;

    const maxFrequency = 100; // Normalize
    const normalizedFrequency = Math.min(candidate.pickFrequency / maxFrequency, 1);

    // A items want high frequency locations, C items don't care as much
    if (context.productAbcClass === 'A') {
      return normalizedFrequency;
    } else if (context.productAbcClass === 'C') {
      // C items prefer low-frequency locations (save prime spots for A items)
      return 1 - normalizedFrequency;
    }
    return 0.5; // B items are neutral
  }

  private scoreProximity(
    candidate: SlottingCandidate,
    allCandidates: SlottingCandidate[]
  ): number {
    // Closer to dock = higher score
    const maxDistance = Math.max(...allCandidates.map(c => c.distanceFromDock));
    if (maxDistance === 0) return 1;
    return 1 - (candidate.distanceFromDock / maxDistance);
  }

  private scoreCapacity(candidate: SlottingCandidate): number {
    // Prefer locations with available capacity
    // 0% utilized = 1.0, 100% utilized = 0.0
    return 1 - (candidate.currentUtilization / 100);
  }

  private scoreTemperature(location: Location, context: SlottingContext): number {
    // Perfect match = 1.0, no requirement = 0.5 (neutral)
    if (!context.temperatureRequired) return 0.5;
    return location.temperatureZone === context.temperatureRequired ? 1.0 : 0.0;
  }

  private scoreFefo(location: Location): number {
    // Pick locations are better for FEFO management
    const fefoFriendlyTypes: LocationType[] = ['PICK', 'STAGING'];
    return fefoFriendlyTypes.includes(location.type) ? 1.0 : 0.5;
  }

  private scoreHazard(location: Location, context: SlottingContext): number {
    if (!context.isHazmat) return 1.0; // Non-hazmat can go anywhere
    return location.isHazmatCertified ? 1.0 : 0.0;
  }
}

export function suggestSlotting(
  candidates: SlottingCandidate[],
  context: SlottingContext,
  topN: number = 3,
  weights?: Partial<SlottingWeights>
): ScoredLocation[] {
  const scorer = new SlottingScorer(weights);
  const scored = scorer.scoreLocations(candidates, context);
  return scored.slice(0, topN);
}
