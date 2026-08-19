import type {
  Criterion,
  DirectedPair,
  DirectedPairReward,
  PairwiseEvaluationJob,
  SlotPairReward,
} from "./types.js";

export function pairEvaluationKey(
  criterionId: string,
  pair: DirectedPair,
  repetition: number,
): string {
  return JSON.stringify([criterionId, pair.a, pair.b, repetition]);
}

export function planPairwiseEvaluations(
  pairs: readonly DirectedPair[],
  criteria: readonly Criterion[],
  repetitions: number,
): PairwiseEvaluationJob[] {
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error("repetitions must be a positive integer");
  }
  const jobs: PairwiseEvaluationJob[] = [];
  for (const pair of pairs) {
    if (pair.a === pair.b) throw new Error(`Cannot score self-comparison ${pair.a}`);
    for (const criterion of criteria) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const swapped = repetition % 2 === 1;
        jobs.push({
          pair,
          criterion,
          repetition,
          swapped,
          slotAIndex: swapped ? pair.b : pair.a,
          slotBIndex: swapped ? pair.a : pair.b,
        });
      }
    }
  }
  return jobs;
}

export function mapSlotRewardToCandidateOrder(
  job: Pick<PairwiseEvaluationJob, "swapped">,
  reward: SlotPairReward,
): DirectedPairReward {
  return job.swapped
    ? { candidateA: reward.slotB, candidateB: reward.slotA }
    : { candidateA: reward.slotA, candidateB: reward.slotB };
}

export function averageDirectedRewards(
  rewards: readonly DirectedPairReward[],
): DirectedPairReward {
  if (rewards.length === 0) throw new Error("Cannot average an empty reward list");
  let candidateA = 0;
  let candidateB = 0;
  for (const reward of rewards) {
    assertUnitInterval(reward.candidateA, "candidateA");
    assertUnitInterval(reward.candidateB, "candidateB");
    candidateA += reward.candidateA;
    candidateB += reward.candidateB;
  }
  return {
    candidateA: candidateA / rewards.length,
    candidateB: candidateB / rewards.length,
  };
}

export async function scoreDirectedPair(args: {
  pair: DirectedPair;
  candidates: readonly string[];
  criteria: readonly Criterion[];
  repetitions: number;
  scoreSlots(job: PairwiseEvaluationJob, slotA: string, slotB: string): Promise<SlotPairReward>;
}): Promise<DirectedPairReward> {
  for (const index of [args.pair.a, args.pair.b]) {
    if (!Number.isInteger(index) || index < 0 || index >= args.candidates.length) {
      throw new Error(`Candidate index out of range: ${index}`);
    }
  }

  const jobs = planPairwiseEvaluations([args.pair], args.criteria, args.repetitions);
  const rewards = await Promise.all(
    jobs.map(async (job) => {
      const slotReward = await args.scoreSlots(
        job,
        args.candidates[job.slotAIndex],
        args.candidates[job.slotBIndex],
      );
      return mapSlotRewardToCandidateOrder(job, slotReward);
    }),
  );
  return averageDirectedRewards(rewards);
}

function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} reward must be within [0, 1], got ${value}`);
  }
}
