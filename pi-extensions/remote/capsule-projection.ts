import { CAPSULE_MAX_BYTES, type Capsule } from "../lib/context-capsule.js";

/** The bounded, host-generated shape exposed to remote control clients. */
export type CapsuleProjection = {
  capsuleId: string;
  schemaVersion: number;
  revision: number;
  objective: string;
  constraints: string[];
  decisions: Capsule["decisions"];
  resources: Capsule["resources"];
  observedChanges: Capsule["observedChanges"];
  validation: Capsule["validation"];
  blockers: string[];
  risks: string[];
  nextAction: string;
  redactions: Capsule["exclusions"];
  truncated: boolean;
  maxPayloadBytes: number;
};

export function projectCapsule(capsule: Capsule): CapsuleProjection {
  return {
    capsuleId: capsule.capsuleId,
    schemaVersion: capsule.schemaVersion,
    revision: capsule.revision,
    objective: capsule.objective,
    constraints: capsule.constraints.map((value) => value),
    decisions: capsule.decisions.map((value) => ({ ...value })),
    resources: capsule.resources.map((value) => ({ ...value })),
    observedChanges: capsule.observedChanges.map((value) => ({ ...value })),
    validation: capsule.validation.map((value) => ({ ...value })),
    blockers: capsule.blockers.map((value) => value),
    risks: capsule.risks.map((value) => value),
    nextAction: capsule.nextAction,
    redactions: capsule.exclusions.map((value) => ({ ...value })),
    truncated: capsule.exclusions.some((value) => value.category === "oversized"),
    maxPayloadBytes: CAPSULE_MAX_BYTES,
  };
}
