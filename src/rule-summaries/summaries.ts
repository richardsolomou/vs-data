import { Ajv2020 } from "ajv/dist/2020.js";
import { resolve, validateRelease, type Ref, type Release } from "../catalogue-identity/identity.ts";
import type { CatalogueRecord } from "../catalogue-releases/catalogue.ts";
import { validate as validateMechanic } from "../validate.ts";
import factsSchema from "./facts.v1.schema.json" with { type: "json" };
import { links, parseSummary } from "./markdown.ts";
export { links, parseSummary, plain } from "./markdown.ts";
import schema from "./summaries.v2.schema.json" with { type: "json" };

// Mirrors summaries.v2.schema.json, which is the contract consumers rely on.
export type Citation =
  | { type: "app"; title: string; appVersion: string; dataBuild: number; releaseDate: string }
  | { type: "publisher"; title: string; page?: string; url: string };
/** Typed facts in a named format; VS Data checks `vs-data-facts` version `1` against its schema and `vs-data-mechanic` version `1` as mechanic fields. */
export type Facts = { format: string; version?: string; fields: Record<string, unknown> };
export type SummaryData = {
  /** Markdown in the summary grammar: paragraphs, lists, bold and `vsdata:` links (see markdown.ts). */
  summary: string;
  citations: Citation[];
  /** The open questions the summary's reading rests on. */
  interpretation?: { question: string }[];
  /** Written with no official source in reach to check it against, so `citations` is empty; replaced once one prints the rule. */
  provisional?: true;
  facts?: Facts;
};
/** Each part is summary text that opens with a paragraph. */
export type StratagemParts = { when: string; target: string; effect: string; restrictions?: string };
/** `end-of-turn` is a turn's end, after its Fight phase. */
type Phase = "command" | "movement" | "shooting" | "charge" | "fight" | "end-of-turn";
type Turn = "own" | "opponent" | "any";
type Card = "primary" | "secondary";
export type AbilityData = SummaryData & {
  ruleType: "army-rule" | "detachment-rule" | "stratagem" | "core-stratagem" | "enhancement" | "unit-ability" | "core-ability" | "weapon-ability";
  group?: string;
  /** The Detachment entry a Stratagem, Enhancement or detachment rule belongs to. */
  detachment?: Ref;
  /** The wargear entries a unit ability is the rule of. */
  wargear?: Ref[];
  /** Required for Stratagems and absent otherwise, like `stratagem`. */
  cp?: number;
  /** A Stratagem's parts as the official app gives them; its `summary` is `stratagemSummary(parts)`. */
  parts?: StratagemParts;
  /** `windows` gives each phase its turn where the phases' turns differ; `turn` is then `any`. */
  stratagem?: {
    phases: Phase[];
    turn: Turn;
    windows?: { phase: Phase; turn: Turn }[];
    type?: "battle-tactic" | "strategic-ploy" | "epic-deed" | "wargear";
    oncePerPhase?: true;
  };
};
/**
 * `parent` is the rule a numbered clarification sits under, such as 01.02.06 under Units and Models. `order` is the
 * rule's reading position in its document and `anchor` its permanent address there, each unique per document.
 * `stratagem` is the core Stratagem the rule prints, whose own record carries its CP cost.
 */
export type CoreRuleData = SummaryData & { document: string; section?: string; ruleNumber?: string; order?: number; anchor?: string; parent?: Ref; stratagem?: Ref };
export type KeywordData = SummaryData & { parameterized?: true };
/** `amendsUnlisted` names targets the catalogue has no entry for yet, by the kind they will have. */
export type FaqData = SummaryData & { publication: string; amends: Ref[]; amendsUnlisted?: { kind: string; name: string }[] };
export type MissionAwardData = SummaryData & { pack: string; card: Card; vp: number; max?: number };
/** A rule the official source prints no text for beyond its parts, such as a mission card whose rules are its awards and actions. */
export type NoTextData = { text: "none"; reason: string; citations: Citation[] };
export type MissionCardData = (SummaryData | NoTextData) & { pack: string; card: Card };
export type PackRuleData = SummaryData & { pack: string };

type DataOf = {
  ability: AbilityData;
  "core-rule": CoreRuleData;
  "core-ability": KeywordData;
  "weapon-ability": KeywordData;
  faq: FaqData;
  "mission-award": MissionAwardData;
  "mission-card": MissionCardData;
  "mission-action": PackRuleData;
  "mission-twist": PackRuleData;
};
export type SummaryKind = keyof DataOf;
export type Summary<K extends SummaryKind = SummaryKind> = { kind: K; id: string; name: string; data: DataOf[K] };

/** One rules version's rule summaries. */
export type Summaries = {
  get<K extends SummaryKind>(kind: K, id: string): Summary<K> | undefined;
  /** FAQ records that amend `rule`, in ID order. */
  amendedBy(rule: Ref): Summary<"faq">[];
};
export type SummariesValidation = { ok: true; summaries: Summaries } | { ok: false; errors: string[] };

export const KINDS: SummaryKind[] = ["ability", "core-rule", "core-ability", "weapon-ability", "faq", "mission-award", "mission-card", "mission-action", "mission-twist"];

const ajv = new Ajv2020({ allErrors: true }).addSchema(schema).addSchema(factsSchema);
const checkData = new Map(KINDS.map((kind) => [kind, ajv.getSchema(`${schema.$id}#/$defs/${kind}`)!]));
const checkFacts = new Map(
  ["plain", "ability-fields", "stratagem", "enhancement-fields", "mission-award"].map((shape) => [shape, ajv.getSchema(`${factsSchema.$id}#/$defs/${shape}`)!]),
);
// Which `vs-data-facts` shape a record's fields take: its kind's, or for an ability its rule type's.
function factsShape(kind: SummaryKind, data: SummaryData): string {
  if (kind === "mission-award") return "mission-award";
  const ruleType = (data as AbilityData).ruleType;
  if (kind === "ability" && ruleType === "enhancement") return "enhancement-fields";
  if (kind === "ability" && STRATAGEMS.has(ruleType)) return "stratagem";
  if (kind === "ability" || kind === "core-ability" || kind === "weapon-ability") return "ability-fields";
  return "plain";
}

type Choices = { choices: { conditions: { kind: string }[]; effects: Record<string, unknown>[]; option?: string }[]; default: number };
type CombatFacts = { readings: (Partial<Choices> & { shown?: Choices | null; fallback?: Choices })[]; trees: ({ reading: number } | { yes: number; no: number })[][]; contexts: Record<string, number> };

/** The index rules of a `combat` block, which the schema cannot express: each points at an entry that exists. */
function combatErrors(combat: CombatFacts): string[] {
  const errors: string[] = [];
  const sets = combat.readings.flatMap((r, i) => [
    ...(r.choices ? [[`readings/${i}`, { choices: r.choices, default: r.default! }] as const] : []),
    ...(r.shown ? [[`readings/${i}/shown`, r.shown] as const] : []),
    ...(r.fallback ? [[`readings/${i}/fallback`, r.fallback] as const] : []),
  ]);
  for (const [at, set] of sets) {
    if (set.default > set.choices.length) errors.push(`${at}/default is past its choices`);
    set.choices.forEach((c, j) => {
      if (c.conditions.some((p) => p.kind === "option") && !c.option) errors.push(`${at}/choices/${j} names its option without an option`);
      c.effects.forEach((e, k) => {
        if (e.weaponAbility !== undefined && e.weaponAbility === e.lostWeaponAbility) errors.push(`${at}/choices/${j}/effects/${k} gives and removes ${e.weaponAbility}`);
        if (e.weaponHas !== undefined && e.weaponHas === e.weaponLacks) errors.push(`${at}/choices/${j}/effects/${k} applies to weapons with and without ${e.weaponHas}`);
        const lacked = e.weaponLacks !== undefined && [e.weaponAbility, e.lostWeaponAbility].find((ability) => ability === e.weaponLacks);
        if (lacked) errors.push(`${at}/choices/${j}/effects/${k} changes ${lacked} on weapons without it`);
        if (e.role === "defender" && e.weaponHas === "PSYCHIC" && e.feelNoPain !== undefined) errors.push(`${at}/choices/${j}/effects/${k} states a Feel No Pain against Psychic Attacks as feelNoPain`);
      });
    });
  }
  combat.trees.forEach((tree, t) =>
    tree.forEach((node, n) => {
      if ("reading" in node) {
        if (node.reading >= combat.readings.length) errors.push(`trees/${t}/${n} names a reading that does not exist`);
      } else if (node.yes >= tree.length || node.no >= tree.length || node.yes <= n || node.no <= n) errors.push(`trees/${t}/${n} branches outside its tree or backwards`);
    }),
  );
  for (const [context, tree] of Object.entries(combat.contexts)) if (tree >= combat.trees.length) errors.push(`contexts/${context} names a tree that does not exist`);
  return errors;
}
const key = ({ kind, id }: Ref) => `${kind}:${id}`;
const STRATAGEMS = new Set<AbilityData["ruleType"]>(["stratagem", "core-stratagem"]);
const PART_LABELS = { when: "When", target: "Target", effect: "Effect", restrictions: "Restrictions" } as const;

/** A Stratagem's summary: its parts in order, each a paragraph that opens with its bold label. */
export function stratagemSummary(parts: StratagemParts): string {
  return (Object.keys(PART_LABELS) as (keyof StratagemParts)[])
    .filter((part) => parts[part] !== undefined)
    .map((part) => `**${PART_LABELS[part]}:** ${parts[part]}`)
    .join("\n\n");
}

/**
 * Validates rule summary records against the identity release of their rules version. Every rule a
 * summary links to or an FAQ amends must be current and listed in the record's identity references, so a
 * release reports it in `dependsOn` and `unresolvedReferences`.
 */
export function validateSummaries(identityValue: unknown, records: CatalogueRecord[]): SummariesValidation {
  const identityResult = validateRelease(identityValue);
  if (!identityResult.ok) return { ok: false, errors: identityResult.errors.map((e) => `identity ${e}`) };
  const identity: Release = identityResult.release;
  const entries = new Map(identity.entries.map((entry) => [key(entry), entry]));
  const errors: string[] = [];
  const byKey = new Map<string, Summary>();

  for (const record of records) {
    const at = key(record);
    if (record.rulesVersion.edition !== identity.rulesVersion.edition || record.rulesVersion.update !== identity.rulesVersion.update) {
      errors.push(`${at} belongs to a different rules version`);
      continue;
    }
    const check = checkData.get(record.kind as SummaryKind);
    if (!check) {
      errors.push(`${at} is not a rule summary kind`);
      continue;
    }
    if (!check(record.data)) {
      errors.push(...(check.errors ?? []).map((e) => `${at} data${e.instancePath} ${e.message}`));
      continue;
    }
    const entry = entries.get(at);
    if (!entry || entry.retired) {
      errors.push(`${at} is ${resolve(identity, record).status} in the identity release`);
      continue;
    }
    if (byKey.has(at)) errors.push(`${at} has more than one record`);
    const summary = { kind: record.kind as SummaryKind, id: record.id, name: entry.name, data: record.data as SummaryData };
    byKey.set(at, summary as Summary);
    if ((record.data as { text?: string }).text === "none") continue;

    if (summary.kind === "ability") {
      const { ruleType, cp, stratagem, detachment, wargear, parts } = summary.data as AbilityData;
      if (STRATAGEMS.has(ruleType)) {
        if (cp === undefined) errors.push(`${at} is a Stratagem with no CP cost`);
      } else if (cp !== undefined || stratagem || parts) errors.push(`${at} is not a Stratagem but has a CP cost, Stratagem timing or Stratagem parts`);
      if (parts && STRATAGEMS.has(ruleType)) {
        for (const [part, text] of Object.entries(parts)) {
          const parsed = parseSummary(text);
          if (!parsed.ok) errors.push(`${at} parts/${part} ${parsed.error}`);
          else if (!("paragraph" in parsed.blocks[0]!)) errors.push(`${at} parts/${part} does not open with a paragraph`);
        }
        if (summary.data.summary !== stratagemSummary(parts)) errors.push(`${at} summary is not its Stratagem parts joined`);
      }
      const { phases = [], turn, windows } = stratagem ?? {};
      if (windows && (windows.map((w) => w.phase).join() !== phases.join() || turn !== "any" || new Set(windows.map((w) => w.turn)).size < 2))
        errors.push(`${at} Stratagem windows must give each of its phases, in order, turns that differ, with turn any`);
      if (detachment) {
        const target = entries.get(key(detachment));
        if (ruleType !== "stratagem" && ruleType !== "enhancement" && ruleType !== "detachment-rule") errors.push(`${at} names a Detachment but is not a Stratagem, Enhancement or detachment rule`);
        else if (!target || target.retired) errors.push(`${at} names ${key(detachment)}, which is not current in the identity release`);
        else if (!entry.references?.some((r) => key(r) === key(detachment))) errors.push(`${at} names ${key(detachment)} but its identity entry does not reference it`);
      }
      if (wargear && ruleType !== "unit-ability") errors.push(`${at} names wargear but is not a unit ability`);
      for (const item of wargear ?? []) {
        const target = entries.get(key(item));
        if (!target || target.retired) errors.push(`${at} names ${key(item)}, which is not current in the identity release`);
        else if (!entry.references?.some((r) => key(r) === key(item))) errors.push(`${at} names ${key(item)} but its identity entry does not reference it`);
      }
    }
    const parent = summary.kind === "core-rule" ? (summary.data as CoreRuleData).parent : undefined;
    if (parent) {
      const target = entries.get(key(parent));
      if (parent.kind !== "core-rule" || key(parent) === at) errors.push(`${at} parent must be another core-rule`);
      else if (!target || target.retired) errors.push(`${at} parent ${key(parent)} is not current in the identity release`);
      else if (!entry.references?.some((r) => key(r) === key(parent))) errors.push(`${at} parent ${key(parent)} is not a reference of its identity entry`);
    }
    const printed = summary.kind === "core-rule" ? (summary.data as CoreRuleData).stratagem : undefined;
    if (printed) {
      const target = entries.get(key(printed));
      if (!target || target.retired) errors.push(`${at} prints ${key(printed)}, which is not current in the identity release`);
      else if (!entry.references?.some((r) => key(r) === key(printed))) errors.push(`${at} prints ${key(printed)} but its identity entry does not reference it`);
    }
    const { summary: text, facts } = summary.data;
    const parsed = parseSummary(text);
    if (!parsed.ok) errors.push(`${at} summary ${parsed.error}`);
    // A summary may link its own rule's name, which needs no reference.
    const named = [...(parsed.ok ? links(parsed.blocks) : []), ...((summary.data as FaqData).amends ?? [])].filter((ref) => key(ref) !== at);
    for (const ref of named) {
      const target = entries.get(key(ref));
      if (!target || target.retired) errors.push(`${at} names ${key(ref)}, which is not current in the identity release`);
      else if (!entry.references?.some((r) => key(r) === key(ref))) errors.push(`${at} names ${key(ref)} but its identity entry does not reference it`);
    }
    if (facts?.format === "vs-data-facts") {
      const check = checkFacts.get(factsShape(summary.kind, summary.data))!;
      if (facts.version !== "1") errors.push(`${at} facts use vs-data-facts version ${facts.version ?? "(none)"}, not 1`);
      else if (!check(facts.fields)) errors.push(...(check.errors ?? []).map((e) => `${at} facts${e.instancePath} ${e.message}`));
      else {
        const rounds = (facts.fields.award as { rounds?: number[] } | undefined)?.rounds ?? [];
        if (rounds.some((r, i) => i > 0 && r <= rounds[i - 1])) errors.push(`${at} facts/award/rounds are not in ascending order`);
        const combat = facts.fields.combat as CombatFacts | { unresolved: string } | undefined;
        if (combat && !("unresolved" in combat)) errors.push(...combatErrors(combat).map((e) => `${at} facts/combat/${e}`));
        const modes = ((facts.fields.givenWeapon as { profiles?: { mode?: string }[] } | undefined)?.profiles ?? []).flatMap((p) => (p.mode ? [p.mode] : []));
        for (const mode of new Set(modes.filter((m, i) => modes.indexOf(m) !== i))) errors.push(`${at} facts/givenWeapon names the mode ${mode} twice`);
        // Rules the facts name are references of the record, as its summary links are.
        for (const ref of (facts.fields.references as Ref[] | undefined) ?? []) {
          const target = entries.get(key(ref));
          if (!target || target.retired) errors.push(`${at} facts name ${key(ref)}, which is not current in the identity release`);
          else if (key(ref) !== at && !entry.references?.some((r) => key(r) === key(ref))) errors.push(`${at} facts name ${key(ref)} but its identity entry does not reference it`);
        }
      }
    }
    if (facts?.format === "vs-data-mechanic" && facts.version === "1") {
      const mechanic = validateMechanic({ ...facts.fields, formatVersion: 1, id: record.id, name: entry.name, rulesVersion: record.rulesVersion, source: record.source });
      if (!mechanic.ok) errors.push(...mechanic.errors.map((e) => `${at} facts${e}`));
    }
  }

  // A clarification's parent is a rule of its own, never another clarification: one level. A document's rules each
  // hold their own reading position and address, and a printed Stratagem is a core Stratagem.
  const held = new Map<string, string>();
  for (const [at, s] of byKey) {
    if (s.kind !== "core-rule") continue;
    const { document, order, anchor, parent, stratagem } = s.data as CoreRuleData;
    if (parent && key(parent) !== at && (byKey.get(key(parent))?.data as CoreRuleData | undefined)?.parent) errors.push(`${at} parent ${key(parent)} has a parent of its own`);
    for (const [field, value] of [["order", order], ["anchor", anchor]] as const) {
      if (value === undefined) continue;
      const slot = JSON.stringify([document, field, value]);
      if (held.has(slot)) errors.push(`${at} ${field} ${value} is ${held.get(slot)}'s in ${document}`);
      else held.set(slot, at);
    }
    const ruleType = stratagem && (byKey.get(key(stratagem))?.data as AbilityData | undefined)?.ruleType;
    if (ruleType && ruleType !== "core-stratagem") errors.push(`${at} prints ${key(stratagem!)}, which is not a core Stratagem`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const faqs = [...byKey.values()].filter((s): s is Summary<"faq"> => s.kind === "faq").sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    ok: true,
    summaries: {
      get: <K extends SummaryKind>(kind: K, id: string) => byKey.get(key({ kind, id })) as Summary<K> | undefined,
      amendedBy: (rule) => faqs.filter((faq) => faq.data.amends.some((r) => key(r) === key(rule))),
    },
  };
}
