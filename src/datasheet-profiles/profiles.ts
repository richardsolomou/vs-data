import { Ajv2020 } from "ajv/dist/2020.js";
import { resolve, validateRelease, type Entry, type Ref, type Release } from "../catalogue-identity/identity.ts";
import type { CatalogueRecord } from "../catalogue-releases/catalogue.ts";
import { links as summaryLinks, parseSummary } from "../rule-summaries/markdown.ts";
import schema from "./profiles.v1.schema.json" with { type: "json" };

// Mirrors profiles.v1.schema.json, which is the contract consumers rely on.
/** A field the record leaves out: no official source prints it, its target has no ID, or its value has no form here. */
export type Gap = { field: string; reason: "no-source" | "no-target" | "unrepresentable" };
/** A roll of this value or more, so `3` means 3+. */
export type Roll = number;
/** A fixed amount, or dice such as `D6`, `2D3` or `D6+1`. */
export type Amount = number | string;
/**
 * `against` limits the save to ranged or melee attacks; `conditional` means another rule of the datasheet sets when it
 * applies, and `summary` says when, in the rule summary grammar without links.
 */
export type InvulnerableSave = { roll: Roll; against?: "ranged" | "melee"; conditional?: true; summary?: string };
/** One base: none (`hull`), one of no standard size (`unique`), round, oval, or a flying base whose size is not printed. */
export type Base = "hull" | "unique" | { diameter: number; approximate?: true; flying?: true } | { length: number; width: number; approximate?: true; flying?: true } | { flyingBase: "large" | "small" };
/** A base, or the bases the source lists without saying which model takes which. */
export type BaseChoice = Base | { alternatives: Base[] };
/** A base, replaced by another for models that carry any of some wargear. */
export type EquippedBase = BaseChoice | { size: BaseChoice; withWargear: { wargear: string[]; size: BaseChoice }[] };
/** A profile's base size, for every model it describes or for each of its models. */
export type BaseSize = EquippedBase | { byModel: { models: string[]; size: EquippedBase }[] };
/** Where a value was printed, as a record's `source` gives it. */
export type Source = { title: string; page?: string; url?: string; revision?: string };
/** A profile with neither `models` nor a model gap applies to the whole unit. `null` means the datasheet gives no value. */
export type UnitProfileData = {
  unit: string;
  models?: string[];
  movement?: number | null | { atLeast: number };
  toughness?: number;
  save?: Roll;
  wounds?: number;
  leadership?: Roll;
  objectiveControl?: number | null;
  /** One save, or a list with a different save against ranged and against melee attacks, each naming its `against`. */
  invulnerableSave?: InvulnerableSave | InvulnerableSave[];
  baseSize?: BaseSize;
  /** The source that prints the base size, where it is not the record's own source. */
  baseSizeSource?: Source;
  gaps?: Gap[];
};
/** `skill` is the ballistic or weapon skill; `null` means the weapon makes no hit roll. */
export type WeaponProfileData = {
  unit: string;
  wargear?: string;
  range?: number | "melee";
  attacks?: Amount;
  skill?: Roll | null;
  strength?: number;
  armourPenetration?: number;
  damage?: Amount;
  keywords?: string[];
  gaps?: Gap[];
};
/**
 * Units this unit may join while a roster condition holds: those in `units` or holding every one of `keywords` and none of
 * `excludedKeywords`, where
 * the roster meets `when` and both units hold `shared`.
 */
export type ConditionalAttachment = {
  role: "leads" | "supports";
  units?: string[];
  keywords?: string[];
  excludedKeywords?: string[];
  when?: { faction?: string; detachment?: string; withoutDetachment?: string; withUnit?: string; withoutUnit?: string };
  shared?: string;
};
/**
 * Units this unit may be joined in place of: a unit that may join one of `units` in a role may join this unit in that
 * role, where it is `role` when given, holds every one of `keywords` and none of `excludedKeywords`.
 */
export type StandIn = { units: string[]; role?: "leads" | "supports"; keywords?: string[]; excludedKeywords?: string[] };
/**
 * How many leader (`leads`) and support (`supports`) units this bodyguard takes in place of one each, from a Starting
 * Strength of `startingStrength` where given; `distinct` when no two of them may be the same unit, and `limits` on how
 * many of them may hold every one of a set of keywords.
 */
export type AttachmentCapacity = { leads?: number; supports?: number; startingStrength?: number; distinct?: true; limits?: { keywords: string[]; max: number }[] };
/**
 * A unit this one may join as part of it, outside the leader and support roles: one in `units` or holding every one of
 * `keywords`, led by a unit holding every one of `ledBy`. `required` when it must join one if it can, and `exclusive`
 * when the unit it joins may have no other joined unit holding one of these keywords.
 */
export type Joining = { units?: string[]; keywords?: string[]; ledBy?: string[]; required?: true; exclusive?: string[] };
/**
 * Bodyguard units (`units`) this unit may lead even when one other leader unit already leads them, where that other unit
 * is one of `besideUnits` or holds one of `besideKeywords`, or is any leader unit where both are omitted.
 */
export type BesideLeader = { units: string[]; besideUnits?: string[]; besideKeywords?: string[] };
/**
 * The units this unit may join as a Leader (`leads`) or as a support attachment (`supports`), those it may join only in
 * some rosters (`conditional`), the bodyguard units it may lead beside one other leader unit (`withAnotherLeader`), and
 * the units it may join as part of them (`joins`). As a bodyguard, the units it may be joined in place of (`insteadOf`)
 * and how many units it takes (`capacity`).
 */
export type AttachmentData = {
  unit: string;
  leads?: string[];
  supports?: string[];
  conditional?: ConditionalAttachment[];
  withAnotherLeader?: BesideLeader[];
  joins?: Joining[];
  insteadOf?: StandIn[];
  capacity?: AttachmentCapacity;
  gaps?: Gap[];
};
/** The roster an attachment is asked about; an omitted field is empty. `keywords` gives units' keywords by unit ID. */
export type AttachmentContext = { faction?: string; detachments?: string[]; units?: string[]; keywords?: Record<string, string[]> };
/** Each unit's attachment record, by unit ID. */
export type AttachmentLookup = (unit: string) => AttachmentData | undefined;
/** A bodyguard unit and the units attached to or joined with it, with its Starting Strength where it matters. */
export type AttachedUnit = { bodyguard: string; startingStrength?: number; leaders?: string[]; supports?: string[]; joined?: string[] };

type TransportPool = { limit: number; count: "models" | "units"; selectors: string[]; maxWounds?: number };
export type TransportProfileData = {
  unit: string;
  capacity?: {
    loads: TransportPool[][];
    /** A pool that replaces the first load's first pool while the transport carries `wargear`, or its unit includes `model`. */
    whenEquipped?: (({ wargear: string; model?: never } | { model: string; wargear?: never }) & { pool: TransportPool })[];
    excluded?: { selectors: string[]; except?: string[] }[];
    space?: { selectors?: string[]; moreWoundsThan?: number; size: number }[];
  };
  /** How many embarked models can shoot as if on the battlefield. */
  firingDeck?: number;
  gaps?: Gap[];
};

type DataOf = { "unit-profile": UnitProfileData; "weapon-profile": WeaponProfileData; attachment: AttachmentData; "transport-profile": TransportProfileData };
export type ProfileKind = keyof DataOf;
export type Profile<K extends ProfileKind = ProfileKind> = { id: string; name: string; data: DataOf[K] };

/** One rules version's datasheet profiles, indexed by the unit they describe. */
export type Profiles = {
  get<K extends ProfileKind>(kind: K, id: string): Profile<K> | undefined;
  all<K extends ProfileKind>(kind: K): Profile<K>[];
  /** Records of a kind that describe a unit, in ID order. */
  of<K extends ProfileKind>(kind: K, unit: string): Profile<K>[];
  /** Units whose attachment records name `unit` in `leads` or `supports`, in ID order; conditional entries need {@link canAttach}. */
  attachedBy(unit: string, role: "leads" | "supports"): string[];
};

export type ProfilesValidation = { ok: true; profiles: Profiles } | { ok: false; errors: string[] };

export const KINDS: ProfileKind[] = ["unit-profile", "weapon-profile", "attachment", "transport-profile"];
const REQUIRED: Record<ProfileKind, string[]> = {
  "unit-profile": ["movement", "toughness", "save", "wounds", "leadership", "objectiveControl"],
  "weapon-profile": ["wargear", "range", "attacks", "skill", "strength", "armourPenetration", "damage"],
  attachment: [],
  "transport-profile": ["capacity"],
};

/** The models and wargear a base size names. */
function baseRefs(size: BaseSize | undefined): Ref[] {
  if (!size || typeof size !== "object") return [];
  if ("byModel" in size) return size.byModel.flatMap((entry) => [...entry.models.map((id) => ({ kind: "model", id })), ...baseRefs(entry.size)]);
  return "withWargear" in size ? size.withWargear.flatMap((entry) => entry.wargear.map((id) => ({ kind: "wargear", id }))) : [];
}

const ajv = new Ajv2020({ allErrors: true }).addSchema(schema);
const checkData = new Map(KINDS.map((kind) => [kind, ajv.getSchema(`${schema.$id}#/$defs/${kind}`)!]));
const key = (kind: string, id: string) => `${kind}:${id}`;

function namedRefs(kind: ProfileKind, data: any): Ref[] {
  const refs = (k: string, ids: string[] = []) => ids.map((id) => ({ kind: k, id }));
  const unit = refs("unit", [data.unit]);
  if (kind === "unit-profile") return [...unit, ...refs("model", data.models), ...baseRefs(data.baseSize)];
  if (kind === "weapon-profile") return [...unit, ...refs("wargear", data.wargear ? [data.wargear] : [])];
  if (kind === "transport-profile") {
    const equipped = (data as TransportProfileData).capacity?.whenEquipped ?? [];
    return [...unit, ...refs("wargear", equipped.flatMap(({ wargear }) => wargear ?? [])), ...refs("model", equipped.flatMap(({ model }) => model ?? []))];
  }
  const conditional: ConditionalAttachment[] = data.conditional ?? [];
  const named = [...(data.withAnotherLeader ?? []).flatMap((b: BesideLeader) => [...b.units, ...(b.besideUnits ?? [])]), ...(data.insteadOf ?? []).flatMap((s: StandIn) => s.units), ...(data.joins ?? []).flatMap((j: Joining) => j.units ?? [])];
  return [
    ...unit,
    ...refs("unit", [...(data.leads ?? []), ...(data.supports ?? []), ...named]),
    ...conditional.flatMap(({ units = [], when = {} }) => [
      ...refs("unit", [...units, ...[when.withUnit, when.withoutUnit].filter((id) => id !== undefined)]),
      ...refs("faction", [when.faction].filter((id) => id !== undefined)),
      ...refs("detachment", [when.detachment, when.withoutDetachment].filter((id) => id !== undefined)),
    ]),
  ];
}

const holds = (context: AttachmentContext, unit: string, keyword: string) =>
  (context.keywords?.[unit] ?? []).some((k) => k.toUpperCase() === keyword.toUpperCase());

/**
 * Whether the attachment's unit may join `target` in `role` within the roster `context`: unconditionally through
 * `leads` or `supports`, through a conditional entry whose targets, roster condition and shared keyword all hold, or,
 * given `attachmentOf`, as it may join a unit `target` stands in for. Keywords compare ignoring case.
 */
export function canAttach(attachment: AttachmentData, role: "leads" | "supports", target: string, context: AttachmentContext = {}, attachmentOf?: AttachmentLookup): boolean {
  return joinsDirectly(attachment, role, target, context) || joinsInstead(attachment, role, target, context, attachmentOf, new Set([target]));
}

function joinsDirectly(attachment: AttachmentData, role: "leads" | "supports", target: string, context: AttachmentContext): boolean {
  // A unit never joins itself, whichever entry names it, as validation insists for entries that name units.
  if (target === attachment.unit) return false;
  if (attachment[role]?.includes(target)) return true;
  const { faction, detachments = [], units = [] } = context;
  return (attachment.conditional ?? []).some(
    ({ role: entryRole, units: named, keywords, excludedKeywords = [], when = {}, shared }) =>
      entryRole === role &&
      (named?.includes(target) || (keywords !== undefined && keywords.every((k) => holds(context, target, k)) && !excludedKeywords.some((k) => holds(context, target, k)))) &&
      (when.faction === undefined || when.faction === faction) &&
      (when.detachment === undefined || detachments.includes(when.detachment)) &&
      (when.withoutDetachment === undefined || !detachments.includes(when.withoutDetachment)) &&
      (when.withUnit === undefined || units.includes(when.withUnit)) &&
      (when.withoutUnit === undefined || !units.includes(when.withoutUnit)) &&
      (shared === undefined || (holds(context, attachment.unit, shared) && holds(context, target, shared))),
  );
}

/** Whether the unit may join `target` as it may join a unit `target` stands in for; `seen` stops stand-ins naming each other. */
function joinsInstead(attachment: AttachmentData, role: "leads" | "supports", target: string, context: AttachmentContext, attachmentOf: AttachmentLookup | undefined, seen: Set<string>): boolean {
  if (target === attachment.unit || !attachmentOf) return false;
  return (attachmentOf(target)?.insteadOf ?? []).some(
    ({ units, role: only, keywords = [], excludedKeywords = [] }) =>
      (only === undefined || only === role) &&
      keywords.every((k) => holds(context, attachment.unit, k)) &&
      !excludedKeywords.some((k) => holds(context, attachment.unit, k)) &&
      units.some((other) => !seen.has(other) && (joinsDirectly(attachment, role, other, context) || joinsInstead(attachment, role, other, context, attachmentOf, new Set([...seen, other])))),
  );
}

/**
 * Whether the core rules make the attachment's unit join a bodyguard before the battle: a support unit, one with
 * `supports` or a `supports` entry of `conditional` whose `when` holds in this roster, must be attached to one.
 */
export function mustAttach(attachment: AttachmentData, context: AttachmentContext = {}): boolean {
  const { faction, detachments = [], units = [] } = context;
  return (
    (attachment.supports?.length ?? 0) > 0 ||
    (attachment.conditional ?? []).some(
      ({ role, when = {} }) =>
        role === "supports" &&
        (when.faction === undefined || when.faction === faction) &&
        (when.detachment === undefined || detachments.includes(when.detachment)) &&
        (when.withoutDetachment === undefined || !detachments.includes(when.withoutDetachment)) &&
        (when.withUnit === undefined || units.includes(when.withUnit)) &&
        (when.withoutUnit === undefined || !units.includes(when.withoutUnit)),
    )
  );
}

/**
 * What is wrong with one attached unit, as problem codes: `attachment-target` for a leader or support unit that may not
 * join its bodyguard in that role, `attachment-full` for more leader or support units than the bodyguard takes,
 * `attachment-duplicate` for two of the same unit where that is refused, `attachment-limit` for more attached units
 * holding a capacity limit's keywords than it allows, `join-target` for a joined unit that may not join it and
 * `join-exclusive` for a joined unit sharing the bodyguard with one it refuses. By default a bodyguard takes one leader
 * and one support unit.
 */
export function attachedUnitProblems(attached: AttachedUnit, context: AttachmentContext, attachmentOf: AttachmentLookup): string[] {
  const { bodyguard, startingStrength, leaders = [], supports = [], joined = [] } = attached;
  const problems = new Set<string>();
  const members = [...leaders.map((unit) => ({ unit, role: "leads" as const })), ...supports.map((unit) => ({ unit, role: "supports" as const }))];
  for (const { unit, role } of members) {
    const record = attachmentOf(unit);
    if (!record || !canAttach(record, role, bodyguard, context, attachmentOf)) problems.add("attachment-target");
  }
  const capacity = attachmentOf(bodyguard)?.capacity;
  const raised = capacity !== undefined && (capacity.startingStrength === undefined || (startingStrength ?? 0) >= capacity.startingStrength);
  const room = raised ? (capacity.leads ?? 1) : 1;
  // A leader that may join beside the other of two leader units makes room for both, never two of the same unit.
  const beside =
    leaders.length === 2 &&
    room < 2 &&
    leaders.some((unit, at) => {
      const other = leaders[1 - at]!;
      const record = attachmentOf(unit);
      // Its bodyguard, or a unit the bodyguard stands in for that admits this leader.
      const on = (u: string) => u === bodyguard || (record !== undefined && joinsInstead({ ...record, leads: [u], conditional: [] }, "leads", bodyguard, context, attachmentOf, new Set([bodyguard])));
      return (record?.withAnotherLeader ?? []).some(
        ({ units, besideUnits, besideKeywords }) =>
          units.some(on) &&
          ((besideUnits === undefined && besideKeywords === undefined) || besideUnits?.includes(other) || (besideKeywords ?? []).some((k) => holds(context, other, k))),
      );
    });
  const leadersAllowed = beside ? 2 : room;
  if (leaders.length > leadersAllowed || supports.length > (raised ? (capacity.supports ?? 1) : 1)) problems.add("attachment-full");
  const units = members.map(({ unit }) => unit);
  if (((raised && capacity.distinct) || beside) && new Set(units).size < units.length) problems.add("attachment-duplicate");
  for (const { keywords, max } of raised ? (capacity.limits ?? []) : []) {
    if (units.filter((unit) => keywords.every((k) => holds(context, unit, k))).length > max) problems.add("attachment-limit");
  }
  const joinings = joined.map((unit) =>
    (attachmentOf(unit)?.joins ?? []).find(
      (j) =>
        ((j.units === undefined && j.keywords === undefined) || j.units?.includes(bodyguard) || (j.keywords !== undefined && j.keywords.every((k) => holds(context, bodyguard, k)))) &&
        (j.ledBy === undefined || leaders.some((leader) => j.ledBy!.every((k) => holds(context, leader, k)))),
    ),
  );
  if (joinings.some((j) => !j)) problems.add("join-target");
  joinings.forEach((j, at) => {
    if (joined.some((other, i) => i !== at && (j?.exclusive ?? []).some((k) => holds(context, other, k)))) problems.add("join-exclusive");
  });
  return [...problems];
}

/**
 * Validates profile records against the identity release of their rules version, which also holds the
 * roster entries they name. A record's own unit bounds what else it may name: its models must belong to
 * that unit and its wargear must be carried or offered there, or included by a bundle that is, while
 * attachment targets may be any unit.
 */
export function validateProfiles(identityValue: unknown, records: CatalogueRecord[]): ProfilesValidation {
  const identityResult = validateRelease(identityValue);
  if (!identityResult.ok) return { ok: false, errors: identityResult.errors.map((e) => `identity ${e}`) };
  const identity: Release = identityResult.release;
  const entries = new Map(identity.entries.map((entry) => [key(entry.kind, entry.id), entry]));
  const errors: string[] = [];
  const byKey = new Map<string, Profile>();

  for (const record of records) {
    const at = key(record.kind, record.id);
    if (record.rulesVersion.edition !== identity.rulesVersion.edition || record.rulesVersion.update !== identity.rulesVersion.update) {
      errors.push(`${at} belongs to a different rules version`);
      continue;
    }
    const check = checkData.get(record.kind as ProfileKind);
    if (!check) {
      errors.push(`${at} is not a profile kind`);
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
    byKey.set(at, { id: record.id, name: entry.name, data: record.data as any });
  }

  const refsOf = (entry: Entry | undefined, kind: string) => entry?.references?.filter((r) => r.kind === kind).map((r) => r.id) ?? [];
  const unitWargear = new Map<string, Set<string>>();
  for (const entry of identity.entries) {
    if (entry.retired || (entry.kind !== "model" && entry.kind !== "roster-option" && entry.kind !== "unit")) continue;
    for (const unit of entry.kind === "unit" ? [entry.id] : refsOf(entry, "unit")) {
      const carried = unitWargear.get(unit) ?? unitWargear.set(unit, new Set()).get(unit)!;
      for (const id of refsOf(entry, "wargear")) carried.add(id);
    }
  }
  // A Set visits members added while iterating it, so this adds what carried bundles include at any depth, each once.
  for (const carried of unitWargear.values()) for (const id of carried) for (const included of refsOf(entries.get(key("wargear", id)), "wargear")) carried.add(included);

  const unitModels = new Map<string, string[]>();
  for (const entry of identity.entries) {
    if (entry.kind !== "model" || entry.retired) continue;
    for (const unit of refsOf(entry, "unit")) unitModels.set(unit, [...(unitModels.get(unit) ?? []), entry.id]);
  }

  for (const [at, profile] of byKey) {
    const kind = at.slice(0, at.indexOf(":")) as ProfileKind;
    const entry = entries.get(at)!;
    const data = profile.data as any;
    for (const ref of namedRefs(kind, data)) {
      const target = entries.get(key(ref.kind, ref.id));
      if (!target || target.retired) errors.push(`${at} names ${key(ref.kind, ref.id)}, which is not current in the identity release`);
      else if (!entry.references?.some((r) => r.kind === ref.kind && r.id === ref.id)) errors.push(`${at} names ${key(ref.kind, ref.id)} but its identity entry does not reference it`);
      if (ref.kind === "wargear" && !unitWargear.get(data.unit)?.has(ref.id)) errors.push(`${at} names wargear:${ref.id}, which unit:${data.unit} neither carries nor offers`);
    }
    const gapped = new Set((profile.data.gaps ?? []).map((gap) => gap.field));
    for (const field of gapped) {
      if (field === "unit" || field === "gaps" || !Object.hasOwn(schema.$defs[kind].properties, field)) {
        errors.push(`${at} has a gap for unknown field ${field}`);
      } else if (kind !== "attachment" && data[field] !== undefined) {
        errors.push(`${at} states ${field} and also a gap for it`);
      }
    }
    for (const field of REQUIRED[kind]) {
      if (data[field] === undefined && !gapped.has(field)) errors.push(`${at} has no ${field} and no gap for it`);
    }
    for (const model of [...(data.models ?? []), ...((data as TransportProfileData).capacity?.whenEquipped ?? []).flatMap(({ model }) => model ?? [])]) {
      if (!refsOf(entries.get(key("model", model)), "unit").includes(data.unit)) errors.push(`${at} names model:${model}, which belongs to another unit`);
    }
    if (kind === "unit-profile") errors.push(...baseSizeErrors(at, data as UnitProfileData, unitModels.get(data.unit) ?? []));
    if (kind === "transport-profile") {
      const gear = (data as TransportProfileData).capacity?.whenEquipped?.map(({ wargear, model }) => wargear ?? `model:${model}`) ?? [];
      if (new Set(gear).size !== gear.length) errors.push(`${at} has multiple capacities for the same wargear or model`);
    }
    const targets = [...(data.leads ?? []), ...(data.supports ?? []), ...((data as AttachmentData).conditional ?? []).flatMap((c) => c.units ?? [])];
    const led = new Set([...(data.leads ?? []), ...((data as AttachmentData).conditional ?? []).filter((c) => c.role === "leads").flatMap((c) => c.units ?? [])]);
    for (const { units } of (data as AttachmentData).withAnotherLeader ?? []) for (const unit of units) if (!led.has(unit)) errors.push(`${at} leads unit:${unit} beside another leader but does not lead it`);
    for (const target of [...targets, ...(data.withAnotherLeader ?? []).flatMap((b: BesideLeader) => [...b.units, ...(b.besideUnits ?? [])]), ...(data.joins ?? []).flatMap((j: Joining) => j.units ?? [])]) if (target === data.unit) errors.push(`${at} attaches unit:${target} to itself`);
    for (const { units } of (data as AttachmentData).insteadOf ?? []) if (units.includes(data.unit)) errors.push(`${at} stands in for unit:${data.unit}, itself`);
    for (const [index, { when }] of ((data as AttachmentData).conditional ?? []).entries()) {
      if (when?.detachment !== undefined && when.detachment === when.withoutDetachment) errors.push(`${at} conditional ${index} needs and excludes detachment:${when.detachment}`);
      if (when?.withUnit !== undefined && when.withUnit === when.withoutUnit) errors.push(`${at} conditional ${index} needs and excludes unit:${when.withUnit}`);
    }
    const saves = [(data as UnitProfileData).invulnerableSave ?? []].flat();
    for (const against of ["ranged", "melee"]) {
      if (saves.length > 1 && saves.filter((s) => s.against === against).length > 1) errors.push(`${at} has more than one invulnerable save against ${against} attacks`);
    }
    for (const { summary } of saves) {
      if (summary === undefined) continue;
      const parsed = parseSummary(summary);
      if (!parsed.ok) errors.push(`${at} invulnerable save summary ${parsed.error}`);
      else if (summaryLinks(parsed.blocks).length > 0) errors.push(`${at} invulnerable save summary has a link`);
    }
  }

  const byKind = Map.groupBy([...byKey].sort(([a], [b]) => (a < b ? -1 : 1)), ([at]) => at.slice(0, at.indexOf(":")) as ProfileKind);
  const all = <K extends ProfileKind>(kind: K) => (byKind.get(kind) ?? []).map(([, p]) => p as Profile<K>);
  const byUnit = new Map(KINDS.map((kind) => [kind, Map.groupBy(all(kind), (p) => p.data.unit)]));

  for (const [unit, profiles] of byUnit.get("unit-profile")!) {
    const unscoped = profiles.filter((p) => !(p.data as UnitProfileData).models && !p.data.gaps?.some((g) => g.field === "models"));
    if (profiles.length > 1 && unscoped.length > 0) errors.push(`unit:${unit} has ${profiles.length} unit profiles, so each needs models or a gap for them`);
    const models = profiles.flatMap((p) => (p.data as UnitProfileData).models ?? []);
    for (const model of new Set(models)) if (models.indexOf(model) !== models.lastIndexOf(model)) errors.push(`unit:${unit} gives model:${model} more than one profile`);
  }
  for (const kind of ["attachment", "transport-profile"] as const) {
    for (const [unit, records] of byUnit.get(kind)!) {
      if (records.length > 1) errors.push(`unit:${unit} has more than one ${kind} record`);
    }
  }

  const links = all("attachment").flatMap(({ data }) => (["leads", "supports"] as const).flatMap((role) => (data[role] ?? []).map((target) => ({ at: `${role}:${target}`, unit: data.unit }))));
  const attached = Map.groupBy(links, (link) => link.at);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    profiles: {
      get: <K extends ProfileKind>(kind: K, id: string) => byKey.get(key(kind, id)) as Profile<K> | undefined,
      all,
      of: <K extends ProfileKind>(kind: K, unit: string) => (byUnit.get(kind)!.get(unit)?.slice() ?? []) as Profile<K>[],
      attachedBy: (unit, role) => (attached.get(`${role}:${unit}`) ?? []).map((link) => link.unit).toSorted(),
    },
  };
}

/**
 * A base size by model names each model the profile describes (its `models`, else every model of its unit) exactly
 * once, and no other; a base by wargear names each item once.
 */
function baseSizeErrors(at: string, data: UnitProfileData, unitModels: string[]): string[] {
  const size = data.baseSize;
  if (!size || typeof size !== "object") return [];
  const errors: string[] = [];
  const wargearOnce = (equipped: EquippedBase) => {
    const items = typeof equipped === "object" && "withWargear" in equipped ? equipped.withWargear.flatMap((entry) => entry.wargear) : [];
    for (const id of new Set(items)) if (items.indexOf(id) !== items.lastIndexOf(id)) errors.push(`${at} gives wargear:${id} more than one base size`);
  };
  if (!("byModel" in size)) {
    wargearOnce(size);
    return errors;
  }
  const scope = data.models ?? unitModels;
  const named = size.byModel.flatMap((entry) => entry.models);
  for (const id of new Set(named)) {
    if (named.indexOf(id) !== named.lastIndexOf(id)) errors.push(`${at} gives model:${id} more than one base size`);
    if (!scope.includes(id)) errors.push(`${at} gives a base size to model:${id}, which the profile does not describe`);
  }
  for (const id of scope) if (!named.includes(id)) errors.push(`${at} gives no base size to model:${id}`);
  for (const entry of size.byModel) wargearOnce(entry.size);
  return errors;
}
