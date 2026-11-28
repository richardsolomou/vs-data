import { resolve, type Ref } from "../catalogue-identity/identity.ts";
import { lookupPoints, type Miss } from "../points/lookup.ts";
import type { PointsSnapshot } from "../points/snapshot.ts";
import { modelBounds, requirements, type Definition, type DefinitionKind, type Definitions, type Per, type UnitData, type When } from "./definitions.ts";

/** A saved list in catalogue IDs: model counts by model ID, wargear counts by option ID, the warlord's model ID, and the allegiance taken. */
export type RosterUnit = {
  unit: string;
  models?: Record<string, number>;
  options?: Record<string, Record<string, number>>;
  enhancement?: string;
  warlord?: string;
  allegiance?: string;
};
/** A roster names one to three detachments, as `detachment`, `detachments`, or both, which it holds together. */
export type Roster = { faction: string; detachment?: string; detachments?: string[]; battleSize?: string; units: RosterUnit[] };
export type CheckOptions = { points?: PointsSnapshot };

export type ProblemCode =
  | "not-current"
  | "missing-definition"
  | "detachment-faction"
  | "unit-faction"
  | "unit-model"
  | "model-count"
  | "model-group-count"
  | "unit-size"
  | "unit-composition"
  | "unit-option"
  | "option-choice"
  | "option-count"
  | "option-quantity"
  | "option-uniform"
  | "option-cap"
  | "option-unavailable"
  | "option-group-count"
  | "enhancement-detachment"
  | "enhancement-keywords"
  | "enhancement-repeated"
  | "enhancement-exclusive"
  | "roster-limit"
  | "unit-limit"
  | "warlord-repeated"
  | "warlord-ineligible"
  | "warlord-required"
  | "enhancement-limit"
  | "unit-excluded"
  | "detachment-excluded"
  | "ally-detachment"
  | "ally-points"
  | "ally-limit"
  | "ally-enhancement"
  | "detachment-group"
  | "roster-points"
  | "detachment-points"
  | "detachment-count"
  | "detachment-repeated"
  | "allegiance-missing"
  | "allegiance-choice"
  | "allegiance-requires"
  | "allegiance-limit";
/** `unit` is the position in the roster, absent for the roster as a whole. */
export type Problem = { code: ProblemCode; unit?: number; message: string };

/** The roster's detachments: its `detachment` with its `detachments`, keeping any `detachments` repeats for the checker. */
export function rosterDetachments(roster: Roster): string[] {
  const listed = roster.detachments ?? [];
  return roster.detachment === undefined || listed.includes(roster.detachment) ? listed : [roster.detachment, ...listed];
}

/** Every catalogue reference a roster holds, for `checkUpgrade` before reading it under another release. */
export function rosterRefs(roster: Roster): Ref[] {
  return [
    { kind: "faction", id: roster.faction },
    ...rosterDetachments(roster).map((id) => ({ kind: "detachment", id })),
    ...(roster.battleSize ? [{ kind: "battle-size", id: roster.battleSize }] : []),
    ...roster.units.flatMap((u) => [
      { kind: "unit", id: u.unit },
      ...Object.keys(u.models ?? {}).map((id) => ({ kind: "model", id })),
      ...Object.entries(u.options ?? {}).flatMap(([id, counts]) => [{ kind: "roster-option", id }, ...Object.keys(counts).map((w) => ({ kind: "wargear", id: w }))]),
      ...(u.enhancement ? [{ kind: "enhancement", id: u.enhancement }] : []),
      ...(u.warlord ? [{ kind: "model", id: u.warlord }] : []),
      ...(u.allegiance ? [{ kind: "allegiance", id: u.allegiance }] : []),
    ]),
  ];
}

/** How many times a bound scaled by `per` applies in a unit of `total` models, `carriers` of which can take the option. */
const blocks = (per: Per | undefined, total: number, carriers: number) =>
  carriers === 0 ? 0 : per === "carrier" ? carriers : per ? Math.floor(total / per.models) : 1;

/** How many wargear selections an option takes in a unit of `total` models, `carriers` of which can take it. */
export function optionBounds(option: Definition<"roster-option">, total: number, carriers: number): { min: number; max: number } {
  const { choose, per, bySize } = option.data;
  const sized = bySize?.find(({ size }) => size === total);
  if (sized && carriers > 0) return { min: sized.min, max: sized.max };
  const n = blocks(per, total, carriers);
  return { min: choose.min * n, max: choose.max * n };
}

/**
 * Whether a condition holds for the roster: its faction, one of its detachments, a unit naming that warlord model, and,
 * for one unit's condition, the `allegiance` that unit took and the wargear it carries, by count.
 */
export function holds(when: When | undefined, roster: Roster, allegiance?: string, carried?: ReadonlyMap<string, number>): boolean {
  if (!when) return true;
  return (
    (when.allegiance === undefined || when.allegiance === allegiance) &&
    (when.wargear === undefined || (carried?.get(when.wargear) ?? 0) > 0) &&
    (when.faction === undefined || when.faction === roster.faction) &&
    (when.detachment === undefined || rosterDetachments(roster).includes(when.detachment)) &&
    (when.warlord === undefined || roster.units.some((u) => u.warlord === when.warlord))
  );
}

/**
 * A unit's keywords in this roster: its own, less those a conditional keyword whose condition holds replaces, and every
 * such conditional keyword, given the allegiance it took and the wargear it carries.
 */
export function unitKeywords(unit: UnitData, roster: Roster, allegiance?: string, carried?: ReadonlyMap<string, number>): string[] {
  const held = (unit.conditionalKeywords ?? []).filter((c) => holds(c.when, roster, allegiance, carried));
  const replaced = new Set(held.flatMap((c) => c.replaces ?? []));
  return [...new Set([...unit.keywords.filter((k) => !replaced.has(k)), ...held.flatMap((c) => c.keywords)])];
}

const holdsAll = (keywords: string[], wanted: string[]) => wanted.every((k) => keywords.includes(k));

/**
 * Every reason the roster is not legal under these definitions, in roster order. With a points snapshot, it also
 * checks the roster's points and detachment points against its battle size. A unit costs its size, its enhancement and
 * each priced item it carries (its models' and its own wargear and a taken bundle's contents, less what its selections
 * replace, never below zero); a bundle costs only its contents, and an item the snapshot does not price costs nothing.
 */
export function checkRoster(definitions: Definitions, roster: Roster, options: CheckOptions = {}): Problem[] {
  const problems: Problem[] = [];
  const current = (kind: DefinitionKind, id: string, unit?: number) => {
    if (definitions.get(kind, id)) return true;
    const found = resolve(definitions.identity, { kind, id });
    if (found.status === "current") {
      problems.push({ code: "missing-definition", ...(unit === undefined ? {} : { unit }), message: `${kind}:${id} has no definition` });
    } else {
      problems.push({ code: "not-current", ...(unit === undefined ? {} : { unit }), message: `${kind}:${id} is ${found.status}` });
    }
    return false;
  };
  const rosterProblem = (code: ProblemCode, message: string) => problems.push({ code, message });
  const battleSize = roster.battleSize && current("battle-size", roster.battleSize) ? roster.battleSize : undefined;
  const size = battleSize ? definitions.get("battle-size", battleSize)!.data : undefined;
  const faction = current("faction", roster.faction) ? definitions.get("faction", roster.faction)!.data : undefined;
  const own = new Set([roster.faction, ...(faction?.parent ? [faction.parent] : [])]);
  const detachmentIds = rosterDetachments(roster);
  const without = faction?.withoutDetachments;
  if (without ? detachmentIds.length > 0 : detachmentIds.length === 0 || detachmentIds.length > 3) {
    rosterProblem("detachment-count", `a ${roster.faction} roster has ${without ? "no detachments" : "one to three detachments"}, has ${detachmentIds.length}`);
  }
  for (const [i, id] of detachmentIds.entries()) if (detachmentIds.indexOf(id) < i) rosterProblem("detachment-repeated", `detachment:${id} is listed more than once`);
  const detachments = [...new Set(detachmentIds)].filter((id) => current("detachment", id)).map((id) => definitions.get("detachment", id)!);
  const groups = new Map<string, string>();
  for (const detachment of detachments) {
    if (faction && !own.has(detachment.data.faction)) rosterProblem("detachment-faction", `detachment:${detachment.id} is not a ${roster.faction} detachment`);
    else if (faction?.excludedDetachments?.includes(detachment.id)) rosterProblem("detachment-excluded", `detachment:${detachment.id} is excluded from ${roster.faction} rosters`);
    const { group } = detachment.data;
    if (group === undefined) continue;
    if (groups.has(group)) rosterProblem("detachment-group", `${detachment.name} shares ${group} with detachment:${groups.get(group)}`);
    else groups.set(group, detachment.id);
  }
  const excluded = new Set([...(faction?.excludedUnits ?? []), ...detachments.flatMap((d) => d.data.excludedUnits ?? [])]);
  const granted = new Set([...detachments.flatMap((d) => d.data.warlords ?? []), ...(without?.warlords ?? [])]);
  // The warlord must be one of each list, from the roster's detachments and a faction without detachments.
  const requiredWarlords = [
    ...detachments.flatMap((d) => (d.data.requiredWarlords ? [{ name: d.name, models: d.data.requiredWarlords }] : [])),
    ...(without ? [{ name: roster.faction, models: without.warlords }] : []),
  ];
  const allies = faction?.allies ?? [];
  // A unit belongs to the first entry that offers it under one of the roster's detachments, and only that entry counts it.
  const entryOf = (unit: string) => allies.findIndex((a) => a.units.includes(unit) && (!a.detachments || a.detachments.some((d) => detachmentIds.includes(d))));
  const members = allies.map(() => [] as number[]);
  const keywordsAt: string[][] = [];
  const costs: number[] = [];
  const price = (ref: Parameters<typeof lookupPoints>[1]) => {
    const found = options.points && lookupPoints(options.points, ref);
    return found && found.ok ? found.points : 0;
  };

  const copies = new Map<string, number>();
  const enhancementCopies = new Map<string, number>();
  let enhancementCount = 0;
  const unitLimits = (faction?.unitLimits ?? []).map((limit) => {
    const row = limit.detachments?.find((d) => detachmentIds.includes(d.detachment)) ?? limit;
    const alternatives = limit.anyOf ?? [limit.keywords];
    const named = alternatives.map((alternative) => alternative.join(" ")).join(" or ");
    // With `exclusive`, the alternatives every unit counted so far fits; empty once two units fit none in common.
    return { alternatives, named, exclusive: limit.exclusive === true, min: row.min, max: row.max, count: 0, fits: null as number[] | null };
  });
  const warlords = roster.units.filter((u) => u.warlord !== undefined).length;
  roster.units.forEach((picked, i) => {
    const add = (code: ProblemCode, message: string) => problems.push({ code, unit: i, message });
    if (!current("unit", picked.unit, i)) return;
    const unit = definitions.get("unit", picked.unit)!;
    const entry = entryOf(unit.id);
    const offered = allies.filter((a) => a.units.includes(unit.id));
    if (entry >= 0) members[entry]!.push(i);
    else if (offered.length > 0) {
      add("ally-detachment", `${unit.name} needs one of ${offered.flatMap((a) => a.detachments ?? []).map((d) => `detachment:${d}`).join(", ")}`);
    } else if (!own.has(unit.data.faction)) add("unit-faction", `${unit.name} is not a ${roster.faction} unit`);
    if (excluded.has(unit.id)) add("unit-excluded", `${unit.name} is excluded from this roster`);
    copies.set(unit.id, (copies.get(unit.id) ?? 0) + 1);
    const limit = unit.data.limits?.find((l) => l.battleSize === battleSize && holds(l.when, roster))?.perRoster ?? unit.data.perRoster ?? size?.duplicates;
    if (copies.get(unit.id) === (limit ?? Infinity) + 1) add("roster-limit", `${unit.name} is limited to ${limit} per roster`);

    const models = definitions.modelsOf(unit.id);
    for (const id of Object.keys(picked.models ?? {})) {
      if (current("model", id, i) && !models.some((m) => m.id === id)) add("unit-model", `model:${id} is not part of ${unit.name}`);
    }
    const counts = new Map(models.map((m) => [m.id, picked.models && Object.hasOwn(picked.models, m.id) ? picked.models[m.id]! : m.data.min]));
    const held = carried(definitions, unit, counts, picked);
    const keywords = unitKeywords(unit.data, roster, picked.allegiance, held);
    keywordsAt[i] = keywords;
    for (const shared of unitLimits) {
      const matched = shared.alternatives.flatMap((alternative, at) => (alternative.every((k) => keywords.includes(k)) ? [at] : []));
      if (!matched.length) continue;
      shared.count++;
      if (shared.count === (shared.max ?? Infinity) + 1) add("unit-limit", `a roster holds at most ${shared.max} ${shared.named} units`);
      if (!shared.exclusive) continue;
      const fitted = shared.fits === null || shared.fits.length > 0;
      shared.fits = shared.fits === null ? matched : shared.fits.filter((at) => matched.includes(at));
      if (fitted && !shared.fits.length) add("unit-limit", shared.alternatives.length === 2 ? `a roster holds ${shared.named} units, not both` : `a roster holds units of only one of ${shared.named}`);
    }
    // A fielded model's keywords: its unit's and its own.
    const fielded = models.filter((m) => (counts.get(m.id) ?? 0) > 0).map((m) => ({ id: m.id, keywords: [...keywords, ...(m.data.keywords ?? [])] }));
    if (picked.warlord !== undefined) {
      const warlord = picked.warlord;
      const inUnit = models.some((m) => m.id === warlord);
      if (current("model", warlord, i) && !inUnit) add("unit-model", `model:${warlord} is not part of ${unit.name}`);
      if (warlords > 1) add("warlord-repeated", "a roster has one warlord");
      const held = fielded.find((m) => m.id === warlord);
      const character = held?.keywords.some((k) => k.toUpperCase() === "CHARACTER") ?? false;
      const barred = models.find((m) => m.id === warlord)?.data.warlord === false;
      if (inUnit && !held) add("warlord-ineligible", `model:${warlord} is not fielded in ${unit.name}`);
      else if (inUnit && !granted.has(warlord) && (barred || !character || offered.length > 0 || !own.has(unit.data.faction))) add("warlord-ineligible", `${unit.name} cannot hold the warlord`);
      for (const required of requiredWarlords) {
        if (inUnit && !required.models.includes(warlord)) add("warlord-required", `${required.name} needs one of ${required.models.map((m) => `model:${m}`).join(", ")} as warlord`);
      }
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    for (const model of models) {
      const count = counts.get(model.id)!;
      const { min, max } = modelBounds(model.data, total);
      if (!Number.isSafeInteger(count) || count < min || count > max) {
        add("model-count", `${model.name} needs ${min}-${max} models, has ${count}`);
      }
    }
    for (const group of unit.data.modelGroups ?? []) {
      const count = group.models.reduce((sum, id) => sum + counts.get(id)!, 0);
      const { min, max } = modelBounds(group, total);
      if (count < min || count > max) {
        const names = group.models.map((id) => definitions.get("model", id)!.name);
        add("model-group-count", `${names.join(", ")} together need ${min}-${max} models, have ${count}`);
      }
    }
    if (!unit.data.sizes.includes(total)) add("unit-size", `${unit.name} fields ${unit.data.sizes.join(" or ")} models, has ${total}`);
    const fits = (composition: Record<string, { min: number; max: number }>) =>
      models.every((m) => counts.get(m.id)! >= (composition[m.id]?.min ?? 0) && counts.get(m.id)! <= (composition[m.id]?.max ?? 0));
    if (unit.data.compositions && !unit.data.compositions.some(fits)) add("unit-composition", `${unit.name} fields its models in none of its compositions`);

    const options = definitions.optionsOf(unit.id);
    for (const [id, chosen] of Object.entries(picked.options ?? {})) {
      if (!current("roster-option", id, i)) continue;
      const option = options.find((o) => o.id === id);
      if (!option) {
        add("unit-option", `roster-option:${id} is not offered to ${unit.name}`);
        continue;
      }
      const selections = Object.entries(chosen);
      if (selections.some(([, n]) => !Number.isSafeInteger(n) || n < 0)) add("option-quantity", `${option.name} needs non-negative whole counts`);
      const taken = selections.filter(([, n]) => n > 0);
      for (const [wargear] of taken) {
        if (current("wargear", wargear, i) && !option.data.choices.includes(wargear)) add("option-choice", `${option.name} does not offer wargear:${wargear}`);
      }
    }
    const takenOf = (optionId: string, only?: string[]) =>
      Object.entries(picked.options?.[optionId] ?? {})
        .filter(([w, n]) => n > 0 && (!only || only.includes(w)))
        .reduce((sum, [, n]) => sum + n, 0);
    for (const option of options) {
      const carriers = option.data.carrier ? (counts.get(option.data.carrier) ?? 0) : total;
      const { min, max } = optionBounds(option, total, carriers);
      const taken = takenOf(option.id);
      const substitutes = option.data.substitutes ?? [];
      const substituted = takenOf(option.id, substitutes);
      const kinds = Object.entries(picked.options?.[option.id] ?? {}).filter(([w, n]) => n > 0 && !substitutes.includes(w)).length;
      if (taken < min || taken > max) add("option-count", `${option.name} takes ${min}-${max}, has ${taken}`);
      else if (option.data.uniform && (kinds > 1 || (taken > substituted && taken !== max))) {
        add("option-uniform", `${option.name} is taken ${max} times with one choice besides its substitutes, or not at all`);
      }
      for (const cap of option.data.caps ?? []) {
        const sized = cap.bySize?.find(({ size }) => size === total);
        const most = sized && carriers > 0 ? sized.max : cap.max * blocks(cap.per, total, carriers);
        const capped = takenOf(option.id, cap.choices);
        if (capped > most) add("option-cap", `${option.name} takes at most ${most} of ${cap.choices.map((w) => `wargear:${w}`).join(", ")}, has ${capped}`);
      }
      for (const requirement of requirements(option.data)) {
        if (taken > 0 && takenOf(requirement.option, requirement.choices) === 0) {
          add("option-unavailable", `${option.name} needs one of ${requirement.choices.map((w) => `wargear:${w}`).join(", ")} from roster-option:${requirement.option}`);
        }
      }
    }
    // Uniform options of several carriers take one choice together, leaving out one whose carriers are not fielded or
    // took nothing but substitutes, as many as it allows (none where its maximum is 0).
    for (const group of unit.data.uniformOptions ?? []) {
      const members = group.flatMap((id) => options.filter((o) => o.id === id));
      const chosen = members.flatMap((option) => {
        const carriers = option.data.carrier ? (counts.get(option.data.carrier) ?? 0) : total;
        const substitutes = option.data.substitutes ?? [];
        const { max } = optionBounds(option, total, carriers);
        if (!carriers || takenOf(option.id, substitutes) === max) return [];
        return [Object.entries(picked.options?.[option.id] ?? {}).filter(([w, n]) => n > 0 && !substitutes.includes(w)).map(([w]) => w)];
      });
      const choices = new Set(chosen.flat());
      if (choices.size > 1 || (choices.size === 1 && chosen.some((c) => !c.length))) {
        add("option-uniform", `${members.map((o) => o.name).join(", ")} take one choice together, or none of them takes one`);
      }
    }
    for (const group of unit.data.optionGroups ?? []) {
      const taken = group.options.reduce((sum, { option, choices, weight = 1 }) => sum + weight * takenOf(option, choices), 0);
      const carriers = group.carrier ? (counts.get(group.carrier) ?? 0) : total;
      const most = group.bySize?.find(({ size }) => size === total)?.max ?? group.max * blocks(group.per, total, carriers);
      const least = (group.min ?? 0) * blocks(group.per, total, carriers);
      const members = group.options.map(({ option }) => `roster-option:${option}`).join(", ");
      if (taken > most) add("option-group-count", `${members} together take at most ${most}, have ${taken}`);
      else if (taken < least) add("option-group-count", `${members} together take at least ${least}, have ${taken}`);
    }

    const offers = (unit.data.allegiances ?? []).filter((offer) => !offer.detachment || detachmentIds.includes(offer.detachment));
    if (picked.allegiance === undefined) {
      if (offers.some((offer) => offer.required)) add("allegiance-missing", `${unit.name} needs an allegiance`);
    } else if (current("allegiance", picked.allegiance, i)) {
      const allegiance = picked.allegiance;
      const offer = offers.find((o) => o.choices.includes(allegiance));
      const needed = offer?.requires?.[allegiance];
      if (!offer) add("allegiance-choice", `${unit.name} cannot take allegiance:${allegiance}`);
      else if (needed && !((held.get(needed) ?? 0) > 0)) add("allegiance-requires", `allegiance:${allegiance} needs ${unit.name} to carry wargear:${needed}`);
    }

    if (picked.enhancement && current("enhancement", picked.enhancement, i)) {
      const enhancement = definitions.get("enhancement", picked.enhancement)!;
      if (!detachmentIds.includes(enhancement.data.detachment)) add("enhancement-detachment", `${enhancement.name} belongs to another detachment`);
      for (const keeper of detachments) {
        const kept = keeper.data.exclusiveEnhancements?.keywords;
        if (kept && keeper.id !== enhancement.data.detachment && holdsAll(keywords, kept)) add("enhancement-exclusive", `${unit.name} takes only ${keeper.name} enhancements`);
      }
      if (entry >= 0 && !allies[entry]!.enhancements) add("ally-enhancement", `${unit.name} cannot take enhancements`);
      const { anyOf, excludedKeywords = [], requiredWargear, epicHeroes, nonCharacters, notWarlord } = enhancement.data.eligibility;
      // A model of the unit bears it: one fielded model whose keywords, the unit's and its own, it allows, in any letter case.
      const bears = (keywords: string[]) => {
        const has = (k: string) => keywords.some((own) => own.toUpperCase() === k.toUpperCase());
        if ((!nonCharacters && !has("CHARACTER")) || (!epicHeroes && has("EPIC HERO")) || excludedKeywords.some(has)) return false;
        return anyOf.some((entry) => (!entry.unit || entry.unit === unit.id) && (entry.keywords ?? []).every(has));
      };
      const carries = !requiredWargear || requiredWargear.some((w) => (held.get(w) ?? 0) > 0);
      if (unit.data.enhancements === false || !fielded.some((m) => bears(m.keywords)) || !carries) {
        add("enhancement-keywords", `${unit.name} cannot take ${enhancement.name}`);
      }
      if (notWarlord && picked.warlord !== undefined) add("enhancement-keywords", `${enhancement.name} cannot be taken by the warlord's unit`);
      const copy = (enhancementCopies.get(enhancement.id) ?? 0) + 1;
      enhancementCopies.set(enhancement.id, copy);
      const most = enhancement.data.perRoster ?? 1;
      if (copy > most) add("enhancement-repeated", `${enhancement.name} is taken at most ${most === 1 ? "once" : `${most} times`}`);
      // Only an enhancement's first copy counts towards the battle size's limit, and none of one outside it.
      if (copy === 1 && !enhancement.data.outsideLimit && ++enhancementCount === (size?.enhancements ?? Infinity) + 1) add("enhancement-limit", `a roster takes at most ${size!.enhancements} enhancements`);
    }

    const enhancement = picked.enhancement ? definitions.get("enhancement", picked.enhancement) : undefined;
    const enhancementFaction = enhancement ? (definitions.get("detachment", enhancement.data.detachment)?.data.faction ?? "") : "";
    costs[i] =
      (enhancement ? price({ kind: "enhancement", faction: enhancementFaction, detachment: enhancement.data.detachment, enhancement: enhancement.id }) : 0) +
      price({ kind: "unit", faction: unit.data.faction, unit: unit.id, models: total, copy: copies.get(unit.id)!, mix: Object.fromEntries(counts) }) +
      [...held]
        .filter(([item]) => !definitions.get("wargear", item)?.data.includes)
        .reduce((sum, [item, n]) => sum + Math.max(n, 0) * price({ kind: "wargear", faction: unit.data.faction, unit: unit.id, item }), 0);
  });
  for (const shared of unitLimits) {
    if (shared.count < (shared.min ?? 0)) rosterProblem("unit-limit", `a roster holds at least ${shared.min} ${shared.named} units, has ${shared.count}`);
  }
  allies.forEach((ally, a) => {
    const units = members[a]!;
    const allyPoints = units.reduce((sum, i) => sum + costs[i]!, 0);
    for (const row of ally.points ?? []) {
      if (options.points && row.battleSize === battleSize && allyPoints > row.max) rosterProblem("ally-points", `allied units cost at most ${row.max} points, cost ${allyPoints}`);
    }
    for (const limit of ally.limits ?? []) {
      if (limit.battleSize !== battleSize) continue;
      const under = units.filter((i) => holdsAll(keywordsAt[i]!, limit.keywords));
      const freed = new Set<number>();
      for (const free of limit.free ?? []) {
        const backing = keywordsAt.filter((k) => k && holdsAll(k, free.per)).length;
        for (const i of under.filter((i) => !freed.has(i) && holdsAll(keywordsAt[i]!, free.keywords)).slice(0, backing)) freed.add(i);
      }
      const counted = under.length - freed.size;
      if (counted > limit.max) rosterProblem("ally-limit", `a roster holds at most ${limit.max} allied ${limit.keywords.join(" ")} units, has ${counted}`);
    }
    if (ally.oneLimit) {
      const sets = (ally.limits ?? []).filter((l) => l.battleSize === battleSize).map((l) => l.keywords);
      const under = units.filter((i) => sets.some((set) => holdsAll(keywordsAt[i]!, set)));
      if (sets.length > 0 && !sets.some((set) => under.every((i) => holdsAll(keywordsAt[i]!, set)))) rosterProblem("ally-limit", "allied units fall under one of their limits only");
    }
  });
  for (const detachment of detachments) {
    for (const { allegiances, min, max } of detachment.data.allegianceLimits ?? []) {
      const count = roster.units.filter((u) => u.allegiance !== undefined && allegiances.includes(u.allegiance)).length;
      if (count < (min ?? 0) || count > (max ?? Infinity)) {
        rosterProblem("allegiance-limit", `${detachment.name} needs ${min ?? 0}-${max ?? "any"} units with ${allegiances.map((a) => `allegiance:${a}`).join(", ")}, has ${count}`);
      }
    }
  }
  if (warlords === 0) {
    for (const required of requiredWarlords) rosterProblem("warlord-required", `${required.name} needs one of ${required.models.map((m) => `model:${m}`).join(", ")} as warlord`);
  }
  if (options.points && size) {
    const total = costs.reduce((sum, n) => sum + n, 0);
    if (total > size.points) rosterProblem("roster-points", `a roster costs at most ${size.points} points, costs ${total}`);
    const dp = detachments.reduce((sum, d) => sum + price({ kind: "detachment", faction: d.data.faction, detachment: d.id }), 0);
    if (size.detachmentPoints !== undefined && dp > size.detachmentPoints) rosterProblem("detachment-points", `detachments cost at most ${size.detachmentPoints} detachment points, cost ${dp}`);
  }
  return problems;
}

/** How many of each wargear the unit carries: its models' and its own, changed by the options it takes, with bundles expanded. */
function carried(definitions: Definitions, unit: Definition<"unit">, counts: Map<string, number>, picked: RosterUnit): Map<string, number> {
  const held = new Map<string, number>();
  const carry = (id: string, n: number) => {
    held.set(id, (held.get(id) ?? 0) + n);
    for (const [inner, k] of Object.entries(definitions.get("wargear", id)?.data.includes ?? {})) carry(inner, n * k);
  };
  for (const model of definitions.modelsOf(unit.id)) for (const [id, n] of Object.entries(model.data.wargear)) carry(id, n * (counts.get(model.id) ?? 0));
  for (const [id, n] of Object.entries(unit.data.wargear ?? {})) carry(id, n);
  for (const option of definitions.optionsOf(unit.id)) {
    for (const [id, n] of Object.entries(picked.options?.[option.id] ?? {})) {
      if (!(n > 0)) continue;
      carry(id, n);
      for (const [replaced, k] of Object.entries(option.data.replaces ?? {})) carry(replaced, -n * k);
    }
  }
  return held;
}

/** A printed unit with its total model count and, when present, its complete breakdown by model name. */
export type PrintedUnit = { name: string; models: number; modelCounts?: Record<string, number>; wargear?: Record<string, number> };
export type ImportMiss = {
  code: "unknown-unit" | "ambiguous-unit" | "unknown-model" | "ambiguous-models" | "model-count-mismatch" | "unknown-wargear" | "ambiguous-wargear";
  name: string;
};
export type ImportResult = { ok: true; unit: RosterUnit } | { ok: false; misses: ImportMiss[] };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function importedModelCounts(models: Definition<"model">[], printed: PrintedUnit, misses: ImportMiss[]): Record<string, number> {
  if (printed.modelCounts) {
    const counts: Record<string, number> = Object.fromEntries(models.map(({ id }) => [id, 0]));
    for (const [name, quantity] of Object.entries(printed.modelCounts)) {
      const matches = models.filter((model) => same(model.name, name));
      if (matches.length !== 1) misses.push({ code: matches.length ? "ambiguous-models" : "unknown-model", name });
      else if (!Number.isSafeInteger(quantity) || quantity < 0) misses.push({ code: "model-count-mismatch", name });
      else counts[matches[0]!.id] += quantity;
    }
    if (!misses.length && (!Number.isSafeInteger(printed.models) || Object.values(counts).reduce((sum, n) => sum + n, 0) !== printed.models)) {
      misses.push({ code: "model-count-mismatch", name: printed.name });
    }
    return counts;
  }

  const bounds = models.map((m) => ({ id: m.id, ...modelBounds(m.data, printed.models) }));
  const variable = bounds.filter(({ min, max }) => min !== max);
  const fixed = bounds.filter(({ min, max }) => min === max).reduce((sum, { min }) => sum + min, 0);
  if (variable.length > 1) misses.push({ code: "ambiguous-models", name: printed.name });
  if (variable.length === 0 && printed.models !== fixed) misses.push({ code: "model-count-mismatch", name: printed.name });
  return Object.fromEntries(bounds.map((m) => [m.id, m === variable[0] ? printed.models - fixed : m.min]));
}

/**
 * Reads a printed unit into catalogue IDs by exact name, never by similarity. Legality is `checkRoster`'s job,
 * so a count that can be assigned to a variable model is checked there.
 */
export function importUnit(definitions: Definitions, faction: string, printed: PrintedUnit): ImportResult {
  const units = definitions.all("unit").filter((u) => u.data.faction === faction && same(u.name, printed.name));
  if (units.length !== 1) return { ok: false, misses: [{ code: units.length ? "ambiguous-unit" : "unknown-unit", name: printed.name }] };
  const unit = units[0]!;
  const misses: ImportMiss[] = [];

  const models = definitions.modelsOf(unit.id);
  const counts = importedModelCounts(models, printed, misses);

  const options = new Map<string, Record<string, number>>();
  const defaults = new Set([...models.flatMap((m) => Object.keys(m.data.wargear)), ...Object.keys(unit.data.wargear ?? {})]);
  for (const [name, count] of Object.entries(printed.wargear ?? {})) {
    const offers = definitions.optionsOf(unit.id).flatMap((o) => o.data.choices.filter((id) => same(definitions.get("wargear", id)?.name ?? "", name)).map((id) => ({ o, id })));
    if (offers.length === 1) {
      const [{ o, id }] = offers as [typeof offers[number]];
      options.set(o.id, { ...options.get(o.id), [id]: count });
    }
    else if (offers.length > 1) misses.push({ code: "ambiguous-wargear", name });
    else if (![...defaults].some((id) => same(definitions.get("wargear", id)?.name ?? "", name))) misses.push({ code: "unknown-wargear", name });
  }
  return misses.length > 0
    ? { ok: false, misses }
    : { ok: true, unit: { unit: unit.id, models: counts, ...(options.size ? { options: Object.fromEntries(options) } : {}) } };
}

export type PointsGap = { ref: Ref; models?: number; reason: Miss | "no-definition" };

// The mixes of a unit's first-copy rows at one size, where every such row gives one.
function mixesAt(snapshot: PointsSnapshot, ref: { faction: string; unit: string; models: number }) {
  const unit = snapshot.factions.find((f) => f.id === ref.faction)?.units.find((u) => u.id === ref.unit);
  const rows = unit?.tiers.find((t) => t.copies.from === 1)?.costs.filter((c) => c.models === ref.models) ?? [];
  return rows.length > 0 && rows.every((c) => c.mix) ? rows.map((c) => c.mix!) : undefined;
}

/**
 * Joins definitions to a points snapshot that uses the same catalogue IDs: every unit size and enhancement must
 * have a price, every detachment its detachment points, and every priced unit a definition. A unit no roster may
 * hold, with `perRoster` 0 and no limit above it, needs no price.
 */
export function pointsGaps(definitions: Definitions, snapshot: PointsSnapshot): PointsGap[] {
  const gaps: PointsGap[] = [];
  const miss = (ref: Ref, result: ReturnType<typeof lookupPoints>, models?: number) => {
    if (!result.ok) gaps.push({ ref, ...(models === undefined ? {} : { models }), reason: result.reason });
  };
  for (const unit of definitions.all("unit")) {
    if (unit.data.perRoster === 0 && !unit.data.limits?.some((l) => l.perRoster > 0)) continue;
    for (const models of unit.data.sizes) {
      const ref = { kind: "unit", faction: unit.data.faction, unit: unit.id, models } as const;
      const result = lookupPoints(snapshot, ref);
      // Rows of one size told apart by their mixes price it when each mix picks its row.
      const mixes = !result.ok && result.reason === "ambiguous-size" ? mixesAt(snapshot, ref) : undefined;
      if (mixes?.every((mix) => lookupPoints(snapshot, { ...ref, mix }).ok)) continue;
      miss({ kind: "unit", id: unit.id }, result, models);
    }
  }
  for (const detachment of definitions.all("detachment")) {
    miss({ kind: "detachment", id: detachment.id }, lookupPoints(snapshot, { kind: "detachment", faction: detachment.data.faction, detachment: detachment.id }));
  }
  for (const enhancement of definitions.all("enhancement")) {
    const faction = definitions.get("detachment", enhancement.data.detachment)!.data.faction;
    miss(
      { kind: "enhancement", id: enhancement.id },
      lookupPoints(snapshot, { kind: "enhancement", faction, detachment: enhancement.data.detachment, enhancement: enhancement.id }),
    );
  }
  for (const faction of snapshot.factions) {
    for (const unit of faction.units) if (!definitions.get("unit", unit.id)) gaps.push({ ref: { kind: "unit", id: unit.id }, reason: "no-definition" });
  }
  return gaps;
}
