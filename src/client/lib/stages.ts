// The VC pipeline vocabulary. Stage keys are stored in the DB; labels are for
// display only (keys use underscores, e.g. partner_meeting → "Partner meeting").
export const STAGES = [
  "sourced",
  "screening",
  "partner_meeting",
  "diligence",
  "term_sheet",
  "invested",
  "passed",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<string, string> = {
  sourced: "Sourced",
  screening: "Screening",
  partner_meeting: "Partner meeting",
  diligence: "Diligence",
  term_sheet: "Term sheet",
  invested: "Invested",
  passed: "Passed",
};

export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;
