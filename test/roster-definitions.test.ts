import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkUpgrade, historyErrors, type Release } from "../src/catalogue-identity/identity.ts";
import { buildCatalogueRelease, type CatalogueRecord, type Manifest } from "../src/catalogue-releases/catalogue.ts";
import { validateDefinitions, type Definitions } from "../src/roster-definitions/definitions.ts";
import { checkRoster, importUnit, pointsGaps, rosterRefs, unitKeywords, type Roster } from "../src/roster-definitions/roster.ts";
import type { PointsSnapshot } from "../src/points/snapshot.ts";
import { validateSnapshot } from "../src/points/validate.ts";

const fixtures = new URL("../fixtures/roster-definitions/", import.meta.url);
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, fixtures), "utf8"));
const input = (version: string) => ({
  identity: json(`${version}/identity.json`) as Release,
  records: readdirSync(new URL(`${version}/records/rosters/`, fixtures)).map((f) => json(`${version}/records/rosters/${f}`) as CatalogueRecord),
});

function definitions(version: string): Definitions {
  const { identity, records } = input(version);
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
}

const v10 = definitions("1.0");
const v11 = definitions("1.1");
const v12 = definitions("1.2");
const legal10 = json("rosters/legal-1.0.json") as Roster;
const legal11 = json("rosters/legal-1.1.json") as Roster;
const legal12 = json("rosters/legal-1.2.json") as Roster;
const WARDENS = "synthetic.ember-host.flame-wardens";
const WARDEN = `${WARDENS}.warden`;
const DRONES = "synthetic.ember-host.ash-drones";
const LORD = "synthetic.ember-host.pyre-lord";
const codes = (definitions: Definitions, roster: Roster) => checkRoster(definitions, roster).map((p) => `${p.unit ?? "-"} ${p.code}`);
const edited = (change: (roster: Roster) => void) => {
  const roster = structuredClone(legal11);
  change(roster);
  return roster;
};

test("all three rules versions form a valid identity history", () => {
  assert.deepEqual(historyErrors([v10.identity, v11.identity, v12.identity]), []);
});

test("unit options stay in ID order when input records arrive in reverse order", () => {
  const { identity, records } = input("1.1");
  const result = validateDefinitions(identity, records.toReversed());
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const ids = result.definitions.optionsOf(WARDENS).map(({ id }) => id);
  assert.deepEqual(ids, ["cannon", "carbines", "leader-weapon", "projector"].map((option) => `${WARDENS}.${option}`));
});

test("all three rules versions build complete catalogue releases", () => {
  const dir = (version: string) => fileURLToPath(new URL(version, fixtures));
  const first = buildCatalogueRelease(dir("1.0"), { release: "0.1.0", commit: "0".repeat(40) });
  assert.ok(first.ok, JSON.stringify(first));
  const second = buildCatalogueRelease(dir("1.1"), { release: "0.2.0", commit: "0".repeat(40), previous: first.files });
  assert.ok(second.ok, JSON.stringify(second));
  const third = buildCatalogueRelease(dir("1.2"), { release: "0.3.0", commit: "0".repeat(40), previous: second.files });
  assert.ok(third.ok, JSON.stringify(third));
  const manifest = JSON.parse(third.files.get("manifest.json")!.toString()) as Manifest;
  assert.deepEqual(manifest.categories.map((c) => [c.name, c.status]), [["rosters", "complete"]]);
});

const invalid: Record<string, [(records: CatalogueRecord[], identity: Release) => void, string]> = {
  "an unknown data field": [(r) => Object.assign(find(r, "unit", WARDENS).data, { points: 90 }), `unit:${WARDENS} data must NOT have additional properties`],
  "a size its models cannot reach": [(r) => ((find(r, "unit", WARDENS).data as any).sizes = [5, 12]), `unit:${WARDENS} size 12 is outside its models' 5-10`],
  "a join its identity entry omits": [
    (_, identity) => (identity.entries.find((e) => e.id === WARDEN)!.references = [{ kind: "unit", id: WARDENS }]),
    `model:${WARDEN} names wargear:synthetic.ember-rifle but its identity entry does not reference it`,
  ],
  "a record for a retired entry": [
    (r) => r.push({ ...find(r, "roster-option", `${WARDENS}.cannon`), id: `${WARDENS}.heavy-weapon` }),
    `roster-option:${WARDENS}.heavy-weapon is retired in the identity release`,
  ],
  "a record for another rules version": [
    (r) => (find(r, "unit", WARDENS).rulesVersion = v10.identity.rulesVersion),
    `unit:${WARDENS} belongs to a different rules version`,
  ],
  "a cap on wargear its option does not offer": [
    (r) => ((find(r, "roster-option", `${DRONES}.payload`).data as any).caps[1].choices = ["synthetic.ember-rifle"]),
    `roster-option:${DRONES}.payload caps wargear:synthetic.ember-rifle, which it does not offer`,
  ],
  "a requirement on another unit's option": [
    (r) => ((find(r, "roster-option", `${LORD}.ward`).data as any).requires = { option: `${WARDENS}.leader-weapon`, choices: ["synthetic.twin-ash-blades"] }),
    `roster-option:${LORD}.ward requires roster-option:${WARDENS}.leader-weapon, which belongs to another unit`,
  ],
  "two limits for one battle size": [
    (r) => (find(r, "unit", WARDENS).data as any).limits.push({ battleSize: "synthetic.incursion", perRoster: 2 }),
    `unit:${WARDENS} limits battle-size:synthetic.incursion more than once`,
  ],
  "an option group with another unit's option": [
    (r, identity) => {
      (find(r, "unit", WARDENS).data as any).optionGroups[0].options[1] = { option: `${LORD}.staff` };
      identity.entries.find((e) => e.id === WARDENS)!.references!.push({ kind: "roster-option", id: `${LORD}.staff` });
    },
    `unit:${WARDENS} optionGroups/0 names roster-option:${LORD}.staff, which belongs to another unit`,
  ],
  "an option group with wargear its option does not offer": [
    (r, identity) => {
      (find(r, "unit", WARDENS).data as any).optionGroups[0].options[0].choices = ["synthetic.scorch-projector"];
      identity.entries.find((e) => e.id === WARDENS)!.references!.push({ kind: "wargear", id: "synthetic.scorch-projector" });
    },
    `unit:${WARDENS} optionGroups/0 names wargear:synthetic.scorch-projector, which roster-option:${WARDENS}.cannon does not offer`,
  ],
  "an option group naming one option twice": [
    (r) => ((find(r, "unit", WARDENS).data as any).optionGroups[0].options[1] = { option: `${WARDENS}.cannon` }),
    `unit:${WARDENS} optionGroups/0 names roster-option:${WARDENS}.cannon more than once`,
  ],
  "a bundle that includes itself through another bundle": [
    (r, identity) => {
      (find(r, "wargear", "synthetic.ember-maul").data as any).includes = ["synthetic.maul-and-shield", "synthetic.ward-shield"];
      identity.entries.find((e) => e.id === "synthetic.ember-maul")!.references = [{ kind: "wargear", id: "synthetic.maul-and-shield" }, { kind: "wargear", id: "synthetic.ward-shield" }];
    },
    "wargear:synthetic.maul-and-shield includes itself",
  ],
  "replacing wargear the carrier lacks": [
    (r) => ((find(r, "roster-option", `${WARDENS}.leader-weapon`).data as any).replaces = ["synthetic.ember-rifle"]),
    `roster-option:${WARDENS}.leader-weapon replaces wargear:synthetic.ember-rifle, which its carriers do not carry`,
  ],
};

function find(records: CatalogueRecord[], kind: string, id: string): CatalogueRecord {
  return records.find((r) => r.kind === kind && r.id === id)!;
}

for (const [name, [change, error]] of Object.entries(invalid)) {
  test(`definitions with ${name} fail with: ${error}`, () => {
    const { identity, records } = input("1.1");
    change(records, identity);
    const result = validateDefinitions(identity, records);
    assert.ok(!result.ok && result.errors.includes(error), JSON.stringify(result));
  });
}

test("a unit may be marked as a Crucible datasheet", () => {
  const { identity, records } = input("1.2");
  (find(records, "unit", WARDENS).data as any).crucible = true;
  const result = validateDefinitions(identity, records);
  assert.deepEqual(result.ok ? [] : result.errors, []);
});

/** Errors of the 1.2 definitions with the flame wardens' core abilities set to `abilities`, the identity referencing `models`. */
const coreAbilityErrors = (abilities: object[], models: string[] = []) => {
  const { identity, records } = input("1.2");
  (find(records, "unit", WARDENS).data as any).coreAbilities = abilities;
  identity.entries.find((e: { kind: string; id: string }) => e.kind === "unit" && e.id === WARDENS)!.references!.push(...models.map((id) => ({ kind: "model", id })));
  const result = validateDefinitions(identity, records);
  return result.ok ? [] : result.errors;
};

test("a unit lists its core abilities with their values, one for only some of its models", () => {
  const found = coreAbilityErrors([{ ability: "deep-strike" }, { ability: "feel-no-pain", threshold: 5 }, { ability: "scouts", inches: 6 }, { ability: "deadly-demise", mortalWounds: "D3", models: [WARDEN] }, { ability: "lone-operative" }], [WARDEN]);
  assert.deepEqual(found, []);
});

test("a unit may list no core abilities", () => {
  assert.deepEqual(coreAbilityErrors([]), []);
});

for (const [ability, field] of [["feel-no-pain", "threshold"], ["scouts", "inches"], ["deadly-demise", "mortalWounds"], ["damaged", "wounds"]]) {
  test(`${ability} states its ${field}`, () => {
    assert.ok(coreAbilityErrors([{ ability }]).includes(`unit:${WARDENS} data/coreAbilities/0 must have required property '${field}'`));
  });
}

test("a core ability that takes no value states none", () => {
  assert.ok(coreAbilityErrors([{ ability: "stealth", inches: 6 }]).includes(`unit:${WARDENS} data/coreAbilities/0 must NOT have additional properties`));
});

test("a core ability is one the format names", () => {
  assert.ok(coreAbilityErrors([{ ability: "firing-deck" }]).includes(`unit:${WARDENS} data/coreAbilities/0/ability must be equal to one of the allowed values`));
});

test("a Feel No Pain roll is at most 6+", () => {
  assert.ok(coreAbilityErrors([{ ability: "feel-no-pain", threshold: 7 }]).includes(`unit:${WARDENS} data/coreAbilities/0/threshold must be <= 6`));
});

test("no model has one core ability twice", () => {
  assert.deepEqual(coreAbilityErrors([{ ability: "deadly-demise", mortalWounds: 1 }, { ability: "deadly-demise", mortalWounds: "D3", models: [WARDEN] }], [WARDEN]), [`unit:${WARDENS} gives model:${WARDEN} core ability deadly-demise more than once`]);
});

test("a core ability's models are references of its unit's identity entry", () => {
  assert.deepEqual(coreAbilityErrors([{ ability: "stealth", models: [WARDEN] }]), [`unit:${WARDENS} names model:${WARDEN} but its identity entry does not reference it`]);
});

test("a core ability names models of its own unit", () => {
  assert.deepEqual(coreAbilityErrors([{ ability: "stealth", models: [`${DRONES}.drone`] }], [`${DRONES}.drone`]), [`unit:${WARDENS} coreAbilities/0 names model:${DRONES}.drone, which belongs to another unit`]);
});

// Kindled Vow listing one Stratagem, whose rule summary entry the identity holds unless `listed` is false.
const listingCards = (referenced: boolean, listed = true) => {
  const { identity, records } = input("1.2");
  const stratagem = "synthetic.kindled-vow.flare-up";
  if (listed) identity.entries.push({ kind: "ability", id: stratagem, name: "Flare Up" });
  if (referenced) identity.entries.find((e) => e.id === "synthetic.kindled-vow")!.references!.push({ kind: "ability", id: stratagem });
  Object.assign(find(records, "detachment", "synthetic.kindled-vow").data, { stratagems: [stratagem], enhancements: [], enhancementsUnlisted: ["Smouldering Crown"] });
  return validateDefinitions(identity, records);
};

test("a detachment lists the rule summaries of its cards", () => {
  const result = listingCards(true);
  assert.ok(result.ok, JSON.stringify(result));
});

test("a detachment's card must be referenced by its identity entry", () => {
  const result = listingCards(false);
  assert.ok(!result.ok && result.errors.includes("detachment:synthetic.kindled-vow names ability:synthetic.kindled-vow.flare-up but its identity entry does not reference it"), JSON.stringify(result));
});

test("a detachment's card must be a current entry", () => {
  const result = listingCards(false, false);
  assert.ok(!result.ok && result.errors.includes("detachment:synthetic.kindled-vow names ability:synthetic.kindled-vow.flare-up, which is not a current entry"), JSON.stringify(result));
});

test("a legal roster has no problems", () => {
  assert.deepEqual(codes(v11, legal11), []);
});

test("an identity without a unit definition does not let a roster pass", () => {
  const { identity, records } = input("1.1");
  const result = validateDefinitions(identity, records.filter((r) => r.kind === "faction" || r.kind === "detachment"));
  assert.ok(result.ok);
  assert.deepEqual(codes(result.definitions, { ...legal11, units: [legal11.units[0]!] }), ["0 missing-definition"]);
});

const SIGIL = "synthetic.kindled-vow.ash-sigil";
const MANTLE = "synthetic.kindled-vow.cinder-mantle";
const BRAND = "synthetic.kindled-vow.brand-of-ash";
const illegal: Record<string, [(roster: Roster) => void, string[]]> = {
  "a unit outside its sizes": [(r) => (r.units[0]!.models = { [WARDEN]: 6 }), ["0 unit-size"]],
  "a model above its maximum": [(r) => (r.units[4]!.models = { "synthetic.ember-host.ash-drones.drone": 4 }), ["4 model-count", "4 unit-size"]],
  "more selections than every five models allow": [(r) => (r.units[1]!.options = { [`${WARDENS}.cannon`]: { "synthetic.cinder-cannon": 2 } }), ["1 option-count"]],
  "more selections than carriers": [(r) => (r.units[1]!.options = { [`${WARDENS}.carbines`]: { "synthetic.ember-carbine": 5 } }), ["1 option-count"]],
  "a negative choice count": [
    (r) => (r.units[1]!.options = { [`${WARDENS}.cannon`]: { "synthetic.cinder-cannon": 1, "synthetic.ember-rifle": -1 } }),
    ["1 option-quantity"],
  ],
  "more selections across options than their group allows": [
    (r) => (r.units[0]!.options![`${WARDENS}.cannon`] = { "synthetic.cinder-cannon": 2 }),
    ["0 option-group-count"],
  ],
  "more of one choice than its carriers may take": [(r) => (r.units[4]!.options = { [`${DRONES}.payload`]: { "synthetic.ash-carbine": 3 } }), ["4 option-cap"]],
  "more of one choice than the unit may take": [(r) => (r.units[4]!.options = { [`${DRONES}.payload`]: { "synthetic.ember-carbine": 2 } }), ["4 option-cap"]],
  "an option its required choice has not opened": [(r) => (r.units[2]!.options![`${LORD}.ward`] = { "synthetic.ward-shield": 1 }), ["2 option-unavailable"]],
  "an option its required choice opens": [
    (r) => (r.units[2]!.options = { [`${LORD}.staff`]: { "synthetic.twin-ash-blades": 1 }, [`${LORD}.ward`]: { "synthetic.ward-shield": 1 } }),
    [],
  ],
  "a uniform option taken by only some carriers": [(r) => (r.units[1]!.options = { [`${WARDENS}.carbines`]: { "synthetic.ember-carbine": 2 } }), ["1 option-uniform"]],
  "a uniform option split between choices": [(r) => (r.units[1]!.options = { [`${WARDENS}.carbines`]: { "synthetic.ember-carbine": 2, "synthetic.ash-carbine": 2 } }), ["1 option-uniform"]],
  "wargear its option does not offer": [(r) => (r.units[2]!.options = { "synthetic.ember-host.pyre-lord.staff": { "synthetic.ember-maul": 1 } }), ["2 option-choice"]],
  "an option from another unit": [(r) => (r.units[3]!.options = { "synthetic.ember-host.pyre-lord.staff": { "synthetic.maul-and-shield": 1 } }), ["3 unit-option"]],
  "an enhancement that allows Epic Heroes": [(r) => (r.units[3]!.enhancement = MANTLE), []],
  "an enhancement that excludes Epic Heroes": [(r) => ((r.units[3]!.enhancement = SIGIL), delete r.units[2]!.enhancement), ["3 enhancement-keywords"]],
  "an enhancement on a unit without its keywords": [(r) => (r.units[4]!.enhancement = MANTLE), ["4 enhancement-keywords"]],
  "an enhancement on a unit barred from enhancements": [(r) => r.units.push({ unit: "synthetic.ember-host.ember-colossus", enhancement: MANTLE }), ["5 enhancement-keywords"]],
  "an enhancement taken twice": [(r) => r.units.push({ unit: "synthetic.ember-host.pyre-lord", enhancement: SIGIL }), ["5 enhancement-repeated"]],
  "an upgrade taken three times": [(r) => ((r.units[0]!.enhancement = BRAND), (r.units[1]!.enhancement = BRAND), (r.units[3]!.enhancement = BRAND)), []],
  "an upgrade taken four times": [
    (r) => ((r.units[0]!.enhancement = BRAND), (r.units[1]!.enhancement = BRAND), (r.units[3]!.enhancement = BRAND), r.units.push({ unit: WARDENS, enhancement: BRAND })),
    ["5 enhancement-repeated"],
  ],
  "more copies than its battle size allows": [(r) => (r.battleSize = "synthetic.incursion"), ["1 roster-limit"]],
  "a battle size without its own limit for the unit": [(r) => (r.battleSize = "synthetic.strike-force"), []],
  "a battle size the release does not define": [(r) => (r.battleSize = "synthetic.onslaught"), ["- not-current"]],
  "a second copy of a unit limited to one": [(r) => r.units.push({ unit: "synthetic.ember-host.the-kindler" }), ["5 roster-limit"]],
  "an ID the release retired": [(r) => (r.units[0]!.options = { [`${WARDENS}.heavy-weapon`]: { "synthetic.cinder-cannon": 1 } }), ["0 not-current"]],
};

for (const [name, [change, expected]] of Object.entries(illegal)) {
  test(`a roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(v11, edited(change)), expected);
  });
}

test("a roster saved under the earlier rules version stays legal there", () => {
  assert.deepEqual(codes(v10, legal10), []);
});

test("upgrading that roster lists the aliased wargear and the split option", () => {
  const findings = checkUpgrade(v11.identity, rosterRefs(legal10)).map((f) => `${f.ref.id} ${f.resolution.status}`);
  assert.deepEqual(findings, [`${WARDENS}.heavy-weapon retired`, "synthetic.paired-ash-blades aliased"]);
});

test("an import reads a printed unit into catalogue IDs", () => {
  const read = importUnit(v11, "synthetic.ember-host", { name: "flame warden squad", models: 10, wargear: { "Cinder Cannon": 1, "Ember Pistol": 1 } });
  assert.deepEqual(read, { ok: true, unit: { unit: WARDENS, models: { [`${WARDENS}.leader`]: 1, [WARDEN]: 9 }, options: { [`${WARDENS}.cannon`]: { "synthetic.cinder-cannon": 1 } } } });
});

test("a size-specific option bound can close a choice even with eligible carriers", () => {
  const { identity, records } = input("1.1");
  Object.assign(find(records, "roster-option", `${WARDENS}.cannon`).data, { bySize: [{ size: 5, min: 0, max: 0 }] });
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  const roster = edited((r) => {
    r.units[1]!.options = { [`${WARDENS}.cannon`]: { "synthetic.cinder-cannon": 1 } };
  });
  assert.deepEqual(codes(validated.definitions, roster), ["1 option-count"]);
});

test("a cap uses the absolute maximum for its unit size", () => {
  const { identity, records } = input("1.1");
  const payload = find(records, "roster-option", `${DRONES}.payload`);
  Object.assign(payload.data, { caps: [{ choices: ["synthetic.ash-carbine"], max: 1, per: "carrier", bySize: [{ size: 2, max: 1 }] }] });
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(codes(validated.definitions, legal11), ["4 option-cap"]);
});

test("an option group counts only the choices it names", () => {
  const { identity, records } = input("1.1");
  (find(records, "unit", WARDENS).data as any).optionGroups = [{ options: [{ option: `${WARDENS}.leader-weapon`, choices: ["synthetic.twin-ash-blades"] }, { option: `${WARDENS}.cannon` }], max: 1 }];
  identity.entries.find((e) => e.id === WARDENS)!.references!.push({ kind: "roster-option", id: `${WARDENS}.leader-weapon` }, { kind: "wargear", id: "synthetic.twin-ash-blades" });
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  const withMaul = edited((r) => (r.units[0]!.options![`${WARDENS}.leader-weapon`] = { "synthetic.ember-maul": 1 }));
  assert.deepEqual([codes(validated.definitions, legal11), codes(validated.definitions, withMaul)], [["0 option-group-count"], []]);
});

test("a saved model mix is checked against its total size", () => {
  const { identity, records } = input("1.1");
  const leader = `${WARDENS}.leader`;
  Object.assign(find(records, "model", leader).data, { max: 2, bySize: [{ size: 10, min: 2, max: 2 }] });
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(codes(validated.definitions, legal11), ["0 model-count"]);
});

test("a shared model bound counts regular and alternate loadouts together", () => {
  const { identity, records } = input("1.1");
  const alternate = `${WARDENS}.alternate-warden`;
  const leader = `${WARDENS}.leader`;
  const original = find(records, "model", WARDEN);
  const originalEntry = identity.entries.find(({ id }) => id === WARDEN)!;
  identity.entries.push({ ...originalEntry, id: alternate, name: "Alternate Warden" });
  records.push({ ...original, id: alternate, data: { ...original.data, min: 0 } });
  Object.assign(find(records, "model", WARDEN).data, { min: 0 });
  Object.assign(find(records, "model", leader).data, { max: 2 });
  Object.assign(find(records, "unit", WARDENS).data, {
    modelGroups: [{ models: [WARDEN, alternate], min: 4, max: 4, bySize: [{ size: 10, min: 9, max: 9 }] }],
  });
  const unitEntry = identity.entries.find(({ id }) => id === WARDENS)!;
  unitEntry.references!.push({ kind: "model", id: WARDEN }, { kind: "model", id: alternate });
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const mixed = { ...legal11, units: [{ unit: WARDENS, models: { [WARDEN]: 7, [alternate]: 2, [leader]: 1 } }] };
  assert.deepEqual(codes(result.definitions, mixed), []);
  mixed.units[0]!.models[leader] = 2;
  mixed.units[0]!.models[alternate] = 1;
  assert.deepEqual(codes(result.definitions, mixed), ["0 model-group-count"]);
});

test("a shared model bound cannot include models from two units", () => {
  const { identity, records } = input("1.1");
  const foreign = `${LORD}.lord`;
  Object.assign(find(records, "unit", WARDENS).data, { modelGroups: [{ models: [WARDEN, foreign], min: 3, max: 9 }] });
  identity.entries.find(({ id }) => id === WARDENS)!.references!.push({ kind: "model", id: WARDEN }, { kind: "model", id: foreign });
  assert.deepEqual(validateDefinitions(identity, records), {
    ok: false, errors: [`unit:${WARDENS} modelGroups/0 names model:${foreign}, which belongs to another unit`],
  });
});

test("model bounds for a selected size can make an import unambiguous", () => {
  const { identity, records } = input("1.1");
  const leader = `${WARDENS}.leader`;
  Object.assign(find(records, "model", leader).data, { max: 2, bySize: [{ size: 10, min: 2, max: 2 }] });
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(importUnit(validated.definitions, "synthetic.ember-host", { name: "Flame Warden Squad", models: 10 }), {
    ok: true, unit: { unit: WARDENS, models: { [leader]: 2, [WARDEN]: 8 } },
  });
});

test("a bound cannot name an unlisted unit size", () => {
  const { identity, records } = input("1.1");
  const id = `${WARDENS}.cannon`;
  Object.assign(find(records, "roster-option", id).data, { bySize: [{ size: 6, min: 0, max: 1 }] });
  assert.deepEqual(validateDefinitions(identity, records), { ok: false, errors: [`roster-option:${id} bySize names unlisted size 6`] });
});

test("an import does not match a unit's name from an earlier rules version", () => {
  assert.deepEqual(importUnit(v11, "synthetic.ember-host", { name: "Flame Wardens", models: 5 }), { ok: false, misses: [{ code: "unknown-unit", name: "Flame Wardens" }] });
});

test("an import cannot discard a mismatched count for a unit with fixed models", () => {
  assert.deepEqual(importUnit(v11, "synthetic.ember-host", { name: "Pyre Lord", models: 2 }), {
    ok: false,
    misses: [{ code: "model-count-mismatch", name: "Pyre Lord" }],
  });
});

test("an import preserves a printed mix of named models", () => {
  const { identity, records } = input("1.1");
  const leader = `${WARDENS}.leader`;
  Object.assign(find(records, "model", leader).data, { max: 2 });
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  const printed = { name: "Flame Warden Squad", models: 10, modelCounts: { "Warden Leader": 2, warden: 8 } };
  assert.deepEqual(importUnit(result.definitions, "synthetic.ember-host", printed), {
    ok: true, unit: { unit: WARDENS, models: { [leader]: 2, [WARDEN]: 8 } },
  });
});

test("an import reports an unknown printed model", () => {
  const printed = { name: "Flame Warden Squad", models: 5, modelCounts: { "Sentry": 1, "Warden": 4 } };
  assert.deepEqual(importUnit(v11, "synthetic.ember-host", printed), {
    ok: false, misses: [{ code: "unknown-model", name: "Sentry" }],
  });
});

test("an import rejects a printed mix that disagrees with the unit total", () => {
  const printed = { name: "Flame Warden Squad", models: 5, modelCounts: { "Warden Leader": 1, "Warden": 5 } };
  assert.deepEqual(importUnit(v11, "synthetic.ember-host", printed), {
    ok: false, misses: [{ code: "model-count-mismatch", name: "Flame Warden Squad" }],
  });
});

test("an import reports wargear two options offer instead of choosing one", () => {
  const { identity, records } = input("1.1");
  (find(records, "roster-option", `${WARDENS}.projector`).data as any).choices.push("synthetic.cinder-cannon");
  identity.entries.find((e) => e.id === `${WARDENS}.projector`)!.references!.push({ kind: "wargear", id: "synthetic.cinder-cannon" });
  const result = validateDefinitions(identity, records);
  assert.ok(result.ok);
  assert.deepEqual(importUnit(result.definitions, "synthetic.ember-host", { name: "Flame Warden Squad", models: 5, wargear: { "cinder cannon": 1 } }), {
    ok: false,
    misses: [{ code: "ambiguous-wargear", name: "cinder cannon" }],
  });
});

test("points joins report every unpriced size, enhancement, and undefined priced unit", () => {
  const snapshot = validateSnapshot(json("points-1.1.json"));
  assert.ok(snapshot.ok);
  assert.deepEqual(pointsGaps(v11, (snapshot as { snapshot: PointsSnapshot }).snapshot), [
    { ref: { kind: "unit", id: "synthetic.ember-host.ash-drones" }, models: 3, reason: "no-size" },
    { ref: { kind: "enhancement", id: MANTLE }, reason: "unknown-enhancement" },
    { ref: { kind: "unit", id: "synthetic.ember-host.ash-wyrm" }, reason: "no-definition" },
  ]);
});

// Format version 2: counted wargear, conditions, shared and per-size bounds, substitutes, compositions.
const COLOSSUS = "synthetic.ember-host.ember-colossus";
const PACK = "synthetic.ember-host.cinder-pack";
const ASH_PACT = "synthetic.ash-pact";
const BANNER = "synthetic.kindled-vow.vanguard-banner";
const LORD_MODEL = `${LORD}.lord`;
const edited12 = (change: (roster: Roster) => void) => {
  const roster = structuredClone(legal12);
  change(roster);
  return roster;
};
test("an option with several requirements opens only once every one of them holds", () => {
  const { identity, records } = input("1.2");
  (find(records, "roster-option", `${WARDENS}.leader-weapon`).data as any).requires = [
    { option: `${WARDENS}.cannon`, choices: ["synthetic.cinder-cannon"] },
    { option: `${WARDENS}.projector`, choices: ["synthetic.scorch-projector"] },
  ];
  identity.entries.find((e) => e.id === `${WARDENS}.leader-weapon`)!.references!.push(
    ...[`${WARDENS}.cannon`, `${WARDENS}.projector`].map((id) => ({ kind: "roster-option" as const, id })),
    ...["synthetic.cinder-cannon", "synthetic.scorch-projector"].map((id) => ({ kind: "wargear" as const, id })),
  );
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  const withoutProjector = edited12((r) => delete r.units[0]!.options![`${WARDENS}.projector`]);
  assert.deepEqual([codes(validated.definitions, legal12), codes(validated.definitions, withoutProjector)], [[], ["0 option-unavailable"]]);
});

test("an option group with a minimum refuses a unit that takes fewer of its selections", () => {
  const { identity, records } = input("1.2");
  Object.assign((find(records, "unit", WARDENS).data as any).optionGroups[0], { min: 1 });
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(codes(validated.definitions, legal12), ["1 option-group-count"]);
});

const ashPact = (units: Roster["units"]): Roster => ({ faction: "synthetic.ember-host", detachment: ASH_PACT, battleSize: "synthetic.incursion", units });

test("version 1 wargear lists read as counts of one", () => {
  assert.deepEqual(v11.get("model", `${WARDENS}.leader`)!.data.wargear, { "synthetic.ember-pistol": 1, "synthetic.ash-blade": 1 });
});

test("a version 2 model carries a count of each wargear", () => {
  assert.deepEqual(v12.get("model", `${COLOSSUS}.colossus`)!.data.wargear, { "synthetic.cinder-cannon": 2 });
});

test("definitions mixing format versions fail", () => {
  const { identity, records } = input("1.2");
  find(records, "wargear", "synthetic.ash-blade").data = {};
  assert.deepEqual(validateDefinitions(identity, records), { ok: false, errors: ["records mix roster definition format versions 1 and 2"] });
});

const invalid12: Record<string, [(records: CatalogueRecord[], identity: Release) => void, string]> = {
  "a replacement of more than a carrier carries": [
    (r) => ((find(r, "roster-option", `${COLOSSUS}.cannons`).data as any).replaces["synthetic.cinder-cannon"] = 3),
    `roster-option:${COLOSSUS}.cannons replaces 3 of wargear:synthetic.cinder-cannon, but its carriers carry 2`,
  ],
  "a bundle of a single item": [
    (r) => ((find(r, "wargear", "synthetic.twin-scorch-projectors").data as any).includes["synthetic.scorch-projector"] = 1),
    "wargear:synthetic.twin-scorch-projectors includes fewer than two items",
  ],
  "substitutes on an option that is not uniform": [
    (r) => delete (find(r, "roster-option", `${WARDENS}.carbines`).data as any).uniform,
    `roster-option:${WARDENS}.carbines has substitutes but is not uniform`,
  ],
  "a limit after a row that always applies": [
    (r) => (find(r, "unit", DRONES).data as any).limits.reverse(),
    `unit:${DRONES} limits battle-size:synthetic.incursion after a row that always applies`,
  ],
  "an option group scaled per carrier without a carrier": [
    (r) => ((find(r, "unit", WARDENS).data as any).optionGroups[0].per = "carrier"),
    `unit:${WARDENS} optionGroups/0 names a carrier exactly when it scales per carrier`,
  ],
  "a size no composition reaches": [
    (r) => {
      const compositions = (find(r, "unit", PACK).data as any).compositions;
      compositions.splice(1, 2, compositions[0]);
    },
    `unit:${PACK} size 6 fits none of its compositions`,
  ],
  "a model repeating its unit's keyword": [
    (r) => Object.assign(find(r, "model", "synthetic.ember-host.flame-wardens.leader").data, { keywords: ["Infantry"] }),
    "model:synthetic.ember-host.flame-wardens.leader repeats its unit's keyword Infantry",
  ],
  "an empty list of faction keywords": [
    (r) => Object.assign(find(r, "unit", WARDENS).data, { factionKeywords: [] }),
    `unit:${WARDENS} data/factionKeywords must NOT have fewer than 1 items`,
  ],
  "a detachment keeping no keyword's units to its enhancements": [
    (r) => Object.assign(find(r, "detachment", ASH_PACT).data, { exclusiveEnhancements: { keywords: [] } }),
    `detachment:${ASH_PACT} data/exclusiveEnhancements/keywords must NOT have fewer than 1 items`,
  ],
  "a faction keyword the unit does not have": [
    (r) => Object.assign(find(r, "unit", WARDENS).data, { factionKeywords: ["Ash Host"] }),
    `unit:${WARDENS} faction keyword Ash Host is not one of its keywords`,
  ],
  "a faction excluding its own detachment": [
    (r) => Object.assign(find(r, "faction", "synthetic.ember-host").data, { excludedDetachments: ["synthetic.kindled-vow"] }),
    "faction:synthetic.ember-host excludes detachment:synthetic.kindled-vow, which is not its parent's",
  ],
  "a faction without detachments whose parent has some": [
    (r) => Object.assign(find(r, "faction", "synthetic.ember-host").data, { withoutDetachments: { warlords: ["synthetic.ember-host.pyre-lord.lord"] } }),
    "faction:synthetic.ember-host takes no detachments but it or its parent has some",
  ],
};

for (const [name, [change, error]] of Object.entries(invalid12)) {
  test(`version 2 definitions with ${name} fail with: ${error}`, () => {
    const { identity, records } = input("1.2");
    change(records, identity);
    const result = validateDefinitions(identity, records);
    assert.ok(!result.ok && result.errors.includes(error), JSON.stringify(result));
  });
}

test("a legal version 2 roster has no problems", () => {
  assert.deepEqual(codes(v12, legal12), []);
});

const illegal12: Record<string, [Roster, string[]]> = {
  "a counted replacement taken twice": [edited12((r) => (r.units[5]!.options![`${COLOSSUS}.cannons`]!["synthetic.twin-scorch-projectors"] = 2)), ["5 option-count"]],
  "two heavy weapons in five models": [edited12((r) => (r.units[1]!.options![`${WARDENS}.cannon`] = { "synthetic.cinder-cannon": 1 }, r.units[1]!.options![`${WARDENS}.projector`] = { "synthetic.scorch-projector": 1 })), ["1 option-group-count"]],
  "a uniform choice short of the models without a substitute": [edited12((r) => (r.units[1]!.options![`${WARDENS}.carbines`] = { "synthetic.ember-carbine": 2, "synthetic.cinder-lance": 1 })), ["1 option-uniform"]],
  "a substitute without the uniform choice": [edited12((r) => (r.units[1]!.options![`${WARDENS}.carbines`] = { "synthetic.cinder-lance": 1 })), []],
  "a model mix no composition offers": [edited12((r) => (r.units[6]!.models = { [`${PACK}.hunter`]: 4, [`${PACK}.hound`]: 2 })), ["6 unit-composition"]],
  "a unit no roster may hold": [edited12((r) => r.units.push({ unit: "synthetic.ember-host.ember-herald" })), ["7 roster-limit"]],
  "more units with a faction's limited keywords than it allows": [edited12((r) => r.units.push({ unit: LORD })), ["7 unit-limit"]],
  "an enhancement a warlord's condition has not opened": [edited12((r) => (r.units[0]!.enhancement = BANNER)), ["0 enhancement-keywords"]],
  "an enhancement a warlord's condition opens": [edited12((r) => ((r.units[0]!.enhancement = BANNER), (r.units[2]!.warlord = LORD_MODEL))), []],
  "a warlord model from another unit": [edited12((r) => (r.units[0]!.warlord = LORD_MODEL)), ["0 unit-model"]],
  "two warlords": [edited12((r) => ((r.units[2]!.warlord = LORD_MODEL), (r.units[3]!.warlord = "synthetic.ember-host.the-kindler.kindler"))), ["2 warlord-repeated", "3 warlord-repeated"]],
  "two copies limited to one outside the detachment that raises it": [{ ...ashPact([{ unit: DRONES }, { unit: DRONES }]), detachment: "synthetic.kindled-vow" }, ["1 roster-limit"]],
  "two copies in the detachment that raises their limit": [ashPact([{ unit: DRONES }, { unit: DRONES }]), []],
  "fewer units with a detachment's required keywords than it needs": [ashPact([{ unit: LORD }]), ["- unit-limit"]],
  "more units than a detachment's own bound allows": [ashPact([{ unit: DRONES }, { unit: LORD }, { unit: "synthetic.ember-host.the-kindler" }]), ["2 unit-limit"]],
};

for (const [name, [roster, expected]] of Object.entries(illegal12)) {
  test(`a version 2 roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(v12, roster), expected);
  });
}

test("a version 2 import keeps counted default wargear off the roster", () => {
  assert.deepEqual(importUnit(v12, "synthetic.ember-host", { name: "Ember Colossus", models: 1, wargear: { "Cinder Cannon": 2 } }), {
    ok: true, unit: { unit: COLOSSUS, models: { [`${COLOSSUS}.colossus`]: 1 } },
  });
});

test("points joins skip a unit no roster may hold", () => {
  const snapshot = validateSnapshot(json("points-1.2.json"));
  assert.ok(snapshot.ok);
  assert.deepEqual(pointsGaps(v12, (snapshot as { snapshot: PointsSnapshot }).snapshot), [
    { ref: { kind: "enhancement", id: MANTLE }, reason: "unknown-enhancement" },
    { ref: { kind: "unit", id: "synthetic.ember-host.ash-wyrm" }, reason: "no-definition" },
  ]);
});

test("an option without a carrier may replace wargear the unit itself carries", () => {
  const { identity, records } = input("1.2");
  Object.assign(find(records, "unit", PACK).data, { wargear: { "synthetic.ember-staff": 1 } });
  identity.entries.find((e) => e.id === PACK)!.references!.push({ kind: "wargear", id: "synthetic.ember-staff" });
  records.push({ ...find(records, "roster-option", `${COLOSSUS}.cannons`), id: `${PACK}.staff`, data: { formatVersion: 2, unit: PACK, choose: { min: 0, max: 1 }, replaces: { "synthetic.ember-staff": 1 }, choices: ["synthetic.ember-maul"] } as any });
  identity.entries.push({ kind: "roster-option", id: `${PACK}.staff`, name: "Staff", references: [{ kind: "unit", id: PACK }, { kind: "wargear", id: "synthetic.ember-staff" }, { kind: "wargear", id: "synthetic.ember-maul" }] });
  assert.deepEqual(validateDefinitions(identity, records).ok, true);
});

test("a weighted option group member counts each selection that many times", () => {
  const { identity, records } = input("1.2");
  (find(records, "unit", WARDENS).data as any).optionGroups = [{ options: [{ option: `${WARDENS}.cannon`, weight: 2 }, { option: `${WARDENS}.projector` }], max: 2 }];
  const validated = validateDefinitions(identity, records);
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(codes(validated.definitions, legal12), ["0 option-group-count"]);
});

// Flame Wardens first fielded as ten, one Warden carrying a cinder cannon.
const withDefaults = (cannons: number, wardens = 9, referenced = true) => {
  const { identity, records } = input("1.2");
  Object.assign(find(records, "unit", WARDENS).data, { defaults: { [`${WARDENS}.cannon`]: { "synthetic.cinder-cannon": cannons } }, defaultModels: { [WARDEN]: wardens } });
  if (referenced) {
    identity.entries.find((e) => e.id === WARDENS)!.references!.push({ kind: "wargear", id: "synthetic.cinder-cannon" }, { kind: "model", id: WARDEN });
  }
  return validateDefinitions(identity, records);
};

test("a unit states the selections and model counts it is first fielded with", () => {
  const result = withDefaults(1);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  assert.deepEqual(result.definitions.get("unit", WARDENS)!.data.defaults, { [`${WARDENS}.cannon`]: { "synthetic.cinder-cannon": 1 } });
});

test("default selections checkRoster refuses fail validation", () => {
  const result = withDefaults(3);
  assert.ok(!result.ok && result.errors.some((e) => e.startsWith(`unit:${WARDENS} defaults are not a legal fielding:`)), JSON.stringify(result));
});

test("default model counts outside the unit's sizes fail validation", () => {
  const result = withDefaults(1, 7);
  assert.ok(!result.ok && result.errors.some((e) => e.startsWith(`unit:${WARDENS} defaults are not a legal fielding:`)), JSON.stringify(result));
});

test("default selections must be referenced by the unit's identity entry", () => {
  const result = withDefaults(1, 9, false);
  assert.ok(!result.ok && result.errors.includes(`unit:${WARDENS} names model:${WARDEN} but its identity entry does not reference it`), JSON.stringify(result));
});

// Army construction: a parent faction, allies, detachment lists, and battle-size limits.
const EH = "synthetic.ember-host";
const KINDLED = "synthetic.kindled-vow";
const SWORN = "synthetic.sworn-vow";
const RITE = "synthetic.court-rite";
const KINDLER = `${EH}.the-kindler`;
const IMPS = `${EH}.ash-imps`;
const SEER = "synthetic.cinder-court.ash-seer";
const GUARD = "synthetic.cinder-court.court-guard";
const WRAITHS = "synthetic.smoke-kin.smoke-wraiths";
const BEAST = "synthetic.smoke-kin.smoke-beast";
const ORACLE = "synthetic.smoke-kin.smoke-oracle";
const points12 = (validateSnapshot(json("points-1.2.json")) as { snapshot: PointsSnapshot }).snapshot;
const incursion = (units: Roster["units"], detachments = [KINDLED]): Roster => ({ faction: EH, detachments, battleSize: "synthetic.incursion", units });
const priced = (roster: Roster) => checkRoster(v12, roster, { points: points12 }).map((p) => `${p.unit ?? "-"} ${p.code}`);
const BLAZE = `${EH}.blaze-oath`;
const SMOKE = `${EH}.smoke-oath`;
const RITE_ALLEGIANCE = `${EH}.ash-rite`;
const IMP = { unit: IMPS, allegiance: BLAZE };
const PACK_UNIT = { unit: PACK, models: { [`${PACK}.hunter`]: 3, [`${PACK}.hound`]: 3 } };

test("a roster may list its detachments", () => {
  assert.deepEqual(codes(v12, { ...legal12, detachment: undefined, detachments: [KINDLED] }), []);
});

test("a roster's references include every detachment it lists", () => {
  const refs = rosterRefs(incursion([], [ASH_PACT, KINDLED])).filter((r) => r.kind === "detachment").map((r) => r.id);
  assert.deepEqual(refs, [ASH_PACT, KINDLED]);
});

const construction: Record<string, [Roster, string[]]> = {
  "an enhancement from its second detachment": [incursion([{ unit: DRONES }, { unit: LORD, enhancement: SIGIL }], [ASH_PACT, KINDLED]), []],
  "more enhancements than its battle size allows": [incursion([{ unit: LORD, enhancement: SIGIL }, { unit: KINDLER, enhancement: MANTLE }]), ["1 enhancement-limit"]],
  "an upgrade beyond its battle size's enhancements": [incursion([{ unit: LORD, enhancement: SIGIL }, { unit: WARDENS, enhancement: BRAND }]), ["1 enhancement-limit"]],
  "an upgrade's later copies within its battle size's enhancements": [
    incursion([{ unit: WARDENS, enhancement: BRAND }, { unit: LORD, enhancement: BRAND }, { unit: SEER, enhancement: BRAND }]),
    [],
  ],
  "more copies than its battle size's duplicates": [incursion([{ unit: LORD }, { unit: LORD }, { unit: LORD }]), ["2 roster-limit"]],
  "a unit of the parent faction": [incursion([{ unit: SEER }]), []],
  "a unit the faction excludes": [incursion([{ unit: GUARD }]), ["0 unit-excluded"]],
  "a unit a detachment excludes": [incursion([{ unit: DRONES }, { unit: COLOSSUS }], [ASH_PACT]), ["1 unit-excluded"]],
  "a detachment of the parent faction": [incursion([{ unit: SEER, warlord: `${SEER}.seer` }], [KINDLED, RITE]), []],
  "two detachments sharing a group": [incursion([{ unit: LORD }], [KINDLED, SWORN]), ["- detachment-group"]],
  "a warlord without the Character keyword": [incursion([{ unit: WARDENS, warlord: WARDEN }]), ["0 warlord-ineligible"]],
  "an allied warlord": [incursion([{ unit: ORACLE, warlord: `${ORACLE}.oracle` }]), ["0 warlord-ineligible"]],
  "an allied warlord its detachment allows": [incursion([{ unit: ORACLE, warlord: `${ORACLE}.oracle` }], [SWORN]), []],
  "a warlord its detachment does not require": [incursion([{ unit: LORD, warlord: LORD_MODEL }], [KINDLED, RITE]), ["0 warlord-required"]],
  "no warlord where a detachment requires one": [incursion([{ unit: SEER }], [KINDLED, RITE]), ["- warlord-required"]],
  "an own unit outside the detachment its entry requires": [incursion([IMP]), ["0 ally-detachment"]],
  "an own unit in the detachment its entry requires": [incursion([{ unit: DRONES }, IMP], [ASH_PACT]), []],
  "more allied units with a keyword than their limit": [incursion([{ unit: WRAITHS }, { unit: ORACLE }]), ["- ally-limit"]],
  "an allied unit its limit frees": [incursion([{ unit: WARDENS }, { unit: WRAITHS }, { unit: ORACLE }]), []],
  "allied units under two limits of an entry with one": [incursion([{ unit: WRAITHS }, { unit: BEAST }]), ["- ally-limit"]],
  "no detachment": [incursion([{ unit: LORD }], []), ["- detachment-count"]],
  "four detachments": [{ ...incursion([{ unit: DRONES }, { unit: SEER, warlord: `${SEER}.seer` }], [ASH_PACT, RITE, SWORN]), detachment: KINDLED }, ["- detachment-count", "- detachment-group"]],
  "one detachment twice": [incursion([{ unit: LORD }], [KINDLED, KINDLED]), ["- detachment-repeated"]],
  "a detachment besides its listed ones": [{ ...incursion([{ unit: DRONES }, { unit: LORD, enhancement: SIGIL }], [ASH_PACT]), detachment: KINDLED }, []],
  "an enhancement on an allied unit": [incursion([{ unit: ORACLE, enhancement: SIGIL }]), ["0 ally-enhancement"]],
};

for (const [name, [roster, expected]] of Object.entries(construction)) {
  test(`a roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(v12, roster), expected);
  });
}

// The Ember Host excluding a detachment of its parent, and the Smoke Kin, who own none, taking no detachment.
const SMOKE_KIN = "synthetic.smoke-kin";
function factionVariant(id: string, data: object, references: { kind: "model" | "detachment"; id: string }[]): Definitions {
  const { identity, records } = input("1.2");
  Object.assign(find(records, "faction", id).data, data);
  const entry = identity.entries.find((e) => e.id === id)!;
  entry.references = [...(entry.references ?? []), ...references];
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
}
const BEAST_MODEL = `${BEAST}.beast`;
const excluding = () => factionVariant(EH, { excludedDetachments: [RITE] }, [{ kind: "detachment", id: RITE }]);
const withoutDetachment = () => factionVariant(SMOKE_KIN, { withoutDetachments: { warlords: [BEAST_MODEL] } }, [{ kind: "model", id: BEAST_MODEL }]);
const smokeKin = (units: Roster["units"], detachments: string[] = []): Roster => ({ faction: SMOKE_KIN, detachments, battleSize: "synthetic.incursion", units });

test("a roster with a parent's detachment its faction excludes reports detachment-excluded", () => {
  assert.deepEqual(codes(excluding(), incursion([{ unit: SEER, warlord: `${SEER}.seer` }], [KINDLED, RITE])), ["- detachment-excluded"]);
});

const withoutDetachments: Record<string, [Roster, string[]]> = {
  "no detachment and its named warlord": [smokeKin([{ unit: BEAST, warlord: BEAST_MODEL }]), []],
  "a detachment": [smokeKin([{ unit: BEAST, warlord: BEAST_MODEL }], [KINDLED]), ["- detachment-count", "- detachment-faction"]],
  "a warlord it does not name": [smokeKin([{ unit: BEAST }, { unit: ORACLE, warlord: `${ORACLE}.oracle` }]), ["1 warlord-required"]],
  "no warlord": [smokeKin([{ unit: BEAST }]), ["- warlord-required"]],
};

for (const [name, [roster, expected]] of Object.entries(withoutDetachments)) {
  test(`a roster of a faction without detachments with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(withoutDetachment(), roster), expected);
  });
}

// A Pyre Lord and a Smoke Oracle whose models a datasheet rule keeps from the warlord role.
function barredWarlords(): Definitions {
  const { identity, records } = input("1.2");
  for (const id of [LORD_MODEL, `${ORACLE}.oracle`]) Object.assign(find(records, "model", id).data, { warlord: false });
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
}

const barred: Record<string, [Roster, string[]]> = {
  "a warlord whose model cannot hold the role": [incursion([{ unit: LORD, warlord: LORD_MODEL }]), ["0 warlord-ineligible"]],
  "a detachment granting the role to a model that otherwise cannot hold it": [incursion([{ unit: ORACLE, warlord: `${ORACLE}.oracle` }], [SWORN]), []],
};

for (const [name, [roster, expected]] of Object.entries(barred)) {
  test(`a roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(barredWarlords(), roster), expected);
  });
}

// The Ash Pact or the Kindled Vow keeping its Character units to its own enhancements.
function exclusive(detachment: string): Definitions {
  const { identity, records } = input("1.2");
  Object.assign(find(records, "detachment", detachment).data, { exclusiveEnhancements: { keywords: ["Character"] } });
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
}

const exclusiveEnhancements: Record<string, [string, Roster, string[]]> = {
  "another detachment's enhancement on a unit holding its keywords": [ASH_PACT, incursion([{ unit: DRONES }, { unit: LORD, enhancement: SIGIL }], [ASH_PACT, KINDLED]), ["1 enhancement-exclusive"]],
  "another detachment's enhancement on a unit without its keywords": [ASH_PACT, incursion([{ unit: DRONES }, { unit: WARDENS, enhancement: BRAND }], [ASH_PACT, KINDLED]), []],
  "its own enhancement on a unit holding its keywords": [KINDLED, incursion([{ unit: DRONES }, { unit: LORD, enhancement: SIGIL }], [ASH_PACT, KINDLED]), []],
  "another detachment's enhancement on a unit its allegiance gives its keywords": [
    ASH_PACT,
    incursion([{ unit: DRONES, allegiance: RITE_ALLEGIANCE, enhancement: SIGIL }], [ASH_PACT, KINDLED]),
    ["0 enhancement-exclusive"],
  ],
  "it outside the roster": [ASH_PACT, incursion([{ unit: LORD, enhancement: SIGIL }]), []],
};

for (const [name, [detachment, roster, expected]] of Object.entries(exclusiveEnhancements)) {
  test(`a detachment keeping units to its enhancements, with ${name}, reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(exclusive(detachment), roster), expected);
  });
}

// Enhancements whose rule facts limit their copies or leave them outside the battle size's enhancements.
function enhancementVariant(enhancement: string, data: object): Definitions {
  const { identity, records } = input("1.2");
  const record = find(records, "enhancement", enhancement).data as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
}

const enhancementLimits: Record<string, [string, object, Roster, string[]]> = {
  "an enhancement taken twice as its limit allows": [SIGIL, { perRoster: 2 }, incursion([{ unit: LORD, enhancement: SIGIL }, { unit: SEER, enhancement: SIGIL }]), []],
  "an enhancement taken more often than its limit allows": [SIGIL, { perRoster: 2 }, incursion([{ unit: LORD, enhancement: SIGIL }, { unit: SEER, enhancement: SIGIL }, { unit: LORD, enhancement: SIGIL }]), ["2 enhancement-repeated"]],
  "an upgrade without a limit taken twice": [BRAND, { perRoster: undefined }, incursion([{ unit: WARDENS, enhancement: BRAND }, { unit: LORD, enhancement: BRAND }]), ["1 enhancement-repeated"]],
  "more enhancements than its battle size allows, one of them outside the limit": [MANTLE, { outsideLimit: true }, incursion([{ unit: LORD, enhancement: SIGIL }, { unit: KINDLER, enhancement: MANTLE }]), []],
};

for (const [name, [enhancement, data, roster, expected]] of Object.entries(enhancementLimits)) {
  test(`a roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(enhancementVariant(enhancement, data), roster), expected);
  });
}

const STAFF = `${LORD}.staff`;
// Cinder Mantle with `eligibility` in place of its own, its identity entry referencing what that names.
function eligibilityVariant(eligibility: object, references: { kind: "unit" | "wargear"; id: string }[] = []): Definitions {
  const { identity, records } = input("1.2");
  (find(records, "enhancement", MANTLE).data as Record<string, unknown>).eligibility = eligibility;
  identity.entries.find((e) => e.kind === "enhancement" && e.id === MANTLE)!.references!.push(...references);
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
}

const characters = { anyOf: [{ keywords: ["Infantry"] }] };
const eligibility: Record<string, [object, Roster, string[], { kind: "unit" | "wargear"; id: string }[]?]> = {
  "a unit that is not a Character": [characters, incursion([{ unit: WARDENS, enhancement: MANTLE }]), ["0 enhancement-keywords"]],
  "a unit that is not a Character, which it allows": [{ ...characters, nonCharacters: true }, incursion([{ unit: WARDENS, enhancement: MANTLE }]), []],
  "an Epic Hero": [characters, incursion([{ unit: KINDLER, enhancement: MANTLE }]), ["0 enhancement-keywords"]],
  "an Epic Hero, which it allows": [{ ...characters, epicHeroes: true }, incursion([{ unit: KINDLER, enhancement: MANTLE }]), []],
  "a unit holding an excluded keyword": [{ ...characters, excludedKeywords: ["INFANTRY"] }, incursion([{ unit: LORD, enhancement: MANTLE }]), ["0 enhancement-keywords"]],
  "a unit matching its second group": [{ anyOf: [{ keywords: ["Fly"] }, { keywords: ["Infantry"] }] }, incursion([{ unit: LORD, enhancement: MANTLE }]), []],
  "a unit other than the one it names": [{ anyOf: [{ unit: KINDLER }] }, incursion([{ unit: LORD, enhancement: MANTLE }]), ["0 enhancement-keywords"], [{ kind: "unit", id: KINDLER }]],
  "the unit it names": [{ anyOf: [{ unit: LORD }] }, incursion([{ unit: LORD, enhancement: MANTLE }]), [], [{ kind: "unit", id: LORD }]],
  "a unit carrying none of its wargear": [{ ...characters, requiredWargear: ["synthetic.maul-and-shield"] }, incursion([{ unit: LORD, enhancement: MANTLE }]), ["0 enhancement-keywords"], [{ kind: "wargear", id: "synthetic.maul-and-shield" }]],
  "a unit carrying its wargear": [
    { ...characters, requiredWargear: ["synthetic.maul-and-shield"] },
    incursion([{ unit: LORD, options: { [STAFF]: { "synthetic.maul-and-shield": 1 } }, enhancement: MANTLE }]),
    [],
    [{ kind: "wargear", id: "synthetic.maul-and-shield" }],
  ],
  "the warlord's unit, which it bars": [{ ...characters, notWarlord: true }, incursion([{ unit: LORD, warlord: `${LORD}.lord`, enhancement: MANTLE }]), ["0 enhancement-keywords"]],
  "a unit other than the warlord's, which it bars": [{ ...characters, notWarlord: true }, incursion([{ unit: LORD, enhancement: MANTLE }, { unit: SEER, warlord: `${SEER}.seer` }]), []],
};

for (const [name, [data, roster, expected, references]] of Object.entries(eligibility)) {
  test(`an enhancement taken by ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(eligibilityVariant(data, references), roster), expected);
  });
}

test("an enhancement naming a unit its identity entry does not reference fails validation", () => {
  const { identity, records } = input("1.2");
  (find(records, "enhancement", MANTLE).data as Record<string, unknown>).eligibility = { anyOf: [{ unit: LORD }] };
  const result = validateDefinitions(identity, records);
  assert.deepEqual(result.ok ? [] : result.errors, [`enhancement:${MANTLE} names unit:${LORD} but its identity entry does not reference it`]);
});

// The Flame Wardens' leader is a Character, though the unit is not.
const LEADER = `${WARDENS}.leader`;
const characterLeader = (optional = false) => {
  const { identity, records } = input("1.2");
  Object.assign(find(records, "model", LEADER).data, { keywords: ["Character"] }, optional ? { min: 0 } : {});
  const result = validateDefinitions(identity, records);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.definitions;
};

const modelKeywords: Record<string, [Roster, string[]]> = {
  "its Character model as warlord": [incursion([{ unit: WARDENS, warlord: LEADER }]), []],
  "a model without the keyword as warlord": [incursion([{ unit: WARDENS, warlord: WARDEN }]), ["0 warlord-ineligible"]],
  "an enhancement its Character model can bear": [incursion([{ unit: WARDENS, enhancement: MANTLE }]), []],
};

for (const [name, [roster, expected]] of Object.entries(modelKeywords)) {
  test(`a unit with a Character model and ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(characterLeader(), roster), expected);
  });
}

const withoutLeader = { [LEADER]: 0, [WARDEN]: 5 };
const unfieldedLeader: Record<string, [Roster, string[]]> = {
  "an enhancement only that model could bear": [incursion([{ unit: WARDENS, models: withoutLeader, enhancement: MANTLE }]), ["0 enhancement-keywords"]],
  "that model as warlord": [incursion([{ unit: WARDENS, models: withoutLeader, warlord: LEADER }]), ["0 warlord-ineligible"]],
};

for (const [name, [roster, expected]] of Object.entries(unfieldedLeader)) {
  test(`a unit whose Character model is not fielded with ${name} reports ${expected.join(", ")}`, () => {
    assert.deepEqual(codes(characterLeader(true), roster), expected);
  });
}

// 1080 points against Incursion's 1000.
const overspent = incursion([
  { unit: COLOSSUS },
  { unit: COLOSSUS },
  PACK_UNIT,
  PACK_UNIT,
  { unit: LORD, enhancement: SIGIL },
  { unit: DRONES, models: { [`${DRONES}.drone`]: 3 } },
  { unit: WARDENS, models: { [WARDEN]: 9 } },
]);

// A Colossus carries two cinder cannons by default; its cannons option swaps them for a bundle of two scorch projectors.
const wargearPriced = (item: string, points: number): PointsSnapshot => {
  const snapshot = structuredClone(points12);
  const colossus = snapshot.factions.flatMap((f) => f.units).find((u) => u.id === COLOSSUS)!;
  colossus.wargear = [{ item, points }];
  return snapshot;
};

test("a roster pays for priced wargear its units carry by default", () => {
  const problems = checkRoster(v12, incursion([{ unit: COLOSSUS }]), { points: wargearPriced("synthetic.cinder-cannon", 400) });
  assert.deepEqual(problems.map((p) => p.message), ["a roster costs at most 1000 points, costs 1040"]);
});

test("a roster does not pay for priced wargear its selections replace", () => {
  const roster = incursion([{ unit: COLOSSUS, options: { [`${COLOSSUS}.cannons`]: { "synthetic.twin-scorch-projectors": 1 } } }]);
  assert.deepEqual(checkRoster(v12, roster, { points: wargearPriced("synthetic.cinder-cannon", 400) }), []);
});

test("a roster does not pay for a priced bundle beside its contents", () => {
  const roster = incursion([{ unit: COLOSSUS, options: { [`${COLOSSUS}.cannons`]: { "synthetic.twin-scorch-projectors": 1 } } }]);
  assert.deepEqual(checkRoster(v12, roster, { points: wargearPriced("synthetic.twin-scorch-projectors", 800) }), []);
});

test("a roster pays for priced wargear a chosen bundle holds", () => {
  const roster = incursion([{ unit: COLOSSUS, options: { [`${COLOSSUS}.cannons`]: { "synthetic.twin-scorch-projectors": 1 } } }]);
  const problems = checkRoster(v12, roster, { points: wargearPriced("synthetic.scorch-projector", 400) });
  assert.deepEqual(problems.map((p) => p.code), ["roster-points"]);
});

// The Cinder Pack priced at 6 models by its mix: 1100 as 3 hunters and 3 hounds, 120 as 6 hunters.
const mixedPack = (): PointsSnapshot => {
  const snapshot = structuredClone(points12);
  const pack = snapshot.factions.flatMap((f) => f.units).find((u) => u.id === PACK)!;
  pack.tiers = [
    {
      copies: { from: 1 },
      costs: [
        { models: 3, points: 60 },
        { models: 6, composition: "3 Hunters, 3 Hounds", mix: { [`${PACK}.hunter`]: 3, [`${PACK}.hound`]: 3 }, points: 1100 },
        { models: 6, composition: "6 Hunters", mix: { [`${PACK}.hunter`]: 6 }, points: 120 },
      ],
    },
  ];
  return snapshot;
};

test("a roster pays the row its unit's mix of models picks", () => {
  assert.deepEqual(checkRoster(v12, incursion([PACK_UNIT]), { points: mixedPack() }).map((p) => p.code), ["roster-points"]);
});

test("points joins report no gap for a size its rows' mixes each price", () => {
  assert.deepEqual(pointsGaps(v12, mixedPack()).filter((g) => g.ref.id === PACK), []);
});

test("a roster over its battle size's points reports roster-points", () => {
  assert.deepEqual(priced(overspent), ["- roster-points"]);
});

test("a roster's points are checked only against a points snapshot", () => {
  assert.deepEqual(codes(v12, overspent), []);
});

test("detachments over their battle size's detachment points report detachment-points", () => {
  assert.deepEqual(priced(incursion([{ unit: DRONES }, { unit: SEER, warlord: `${SEER}.seer` }], [KINDLED, ASH_PACT, RITE])), ["- detachment-points"]);
});

test("an allied unit's enhancement counts towards its entry's points", () => {
  assert.deepEqual(priced(incursion([{ unit: DRONES }, { ...IMP, enhancement: BRAND }], [ASH_PACT, KINDLED])), ["- ally-points"]);
});

test("a unit limit may name a detachment of the faction's parent", () => {
  const { identity, records } = input("1.2");
  (find(records, "faction", EH).data as any).unitLimits[0].detachments.push({ detachment: RITE, max: 2 });
  identity.entries.find((e) => e.id === EH)!.references!.push({ kind: "detachment", id: RITE });
  assert.ok(validateDefinitions(identity, records).ok);
});

test("allied units in a roster without a battle size fall under no limit", () => {
  assert.deepEqual(codes(v12, { faction: EH, detachment: KINDLED, units: [{ unit: WRAITHS }, { unit: BEAST }] }), []);
});

test("allied units over their entry's points report ally-points", () => {
  assert.deepEqual(priced(incursion([{ unit: DRONES }, IMP, IMP], [ASH_PACT])), ["- ally-points"]);
});

const ally = (records: CatalogueRecord[]) => (find(records, "faction", EH).data as any).allies[1];
const invalidConstruction: Record<string, [(records: CatalogueRecord[], identity: Release) => void, string]> = {
  "a parent that has a parent": [
    (r, identity) => {
      (find(r, "faction", "synthetic.cinder-court").data as any).parent = "synthetic.smoke-kin";
      identity.entries.find((e) => e.id === "synthetic.cinder-court")!.references = [{ kind: "faction", id: "synthetic.smoke-kin" }];
    },
    `faction:${EH} names faction:synthetic.cinder-court, which has a parent of its own`,
  ],
  "a faction its own parent": [(r) => ((find(r, "faction", EH).data as any).parent = EH), `faction:${EH} names itself as its parent`],
  "an allied unit its identity entry omits": [
    (_, identity) => {
      const entry = identity.entries.find((e) => e.id === EH)!;
      entry.references = entry.references!.filter((ref) => ref.id !== WRAITHS);
    },
    `faction:${EH} names unit:${WRAITHS} but its identity entry does not reference it`,
  ],
  "an ally limit for a battle size with no record": [(r) => (ally(r).limits[0].battleSize = "synthetic.onslaught"), `faction:${EH} names battle-size:synthetic.onslaught, which has no record`],
  "an ally points cap for a battle size with no record": [(r) => (ally(r).points[0].battleSize = "synthetic.onslaught"), `faction:${EH} names battle-size:synthetic.onslaught, which has no record`],
  "an ally entry requiring another faction's detachment": [
    (r, identity) => {
      (find(r, "detachment", SWORN).data as any).faction = "synthetic.smoke-kin";
      identity.entries.find((e) => e.id === SWORN)!.references!.push({ kind: "faction", id: "synthetic.smoke-kin" });
      (find(r, "faction", EH).data as any).allies[0].detachments = [SWORN];
      identity.entries.find((e) => e.id === EH)!.references!.push({ kind: "detachment", id: SWORN });
    },
    `faction:${EH} allies/0 names detachment:${SWORN}, which belongs to another faction`,
  ],
  "one limit without limits": [(r) => delete ally(r).limits, `faction:${EH} data/allies/1 must have property limits when property oneLimit is present`],
  "a granted warlord that is not a model": [
    (r) => ((find(r, "detachment", SWORN).data as any).warlords = [LORD]),
    `detachment:${SWORN} names model:${LORD}, which has no record`,
  ],
  "an excluded unit its identity entry omits": [
    (r) => (find(r, "detachment", ASH_PACT).data as any).excludedUnits.push(LORD),
    `detachment:${ASH_PACT} names unit:${LORD} but its identity entry does not reference it`,
  ],
};

for (const [name, [change, error]] of Object.entries(invalidConstruction)) {
  test(`definitions with ${name} fail with: ${error}`, () => {
    const { identity, records } = input("1.2");
    change(records, identity);
    const result = validateDefinitions(identity, records);
    assert.ok(!result.ok && result.errors.includes(error), JSON.stringify(result));
  });
}

const allegiances: Record<string, [Roster, string[]]> = {
  "a unit without the allegiance it must take": [incursion([{ unit: DRONES }, { unit: IMPS }], [ASH_PACT]), ["1 allegiance-missing"]],
  "an allegiance its unit does not offer": [incursion([{ unit: DRONES }, { unit: IMPS, allegiance: RITE_ALLEGIANCE }], [ASH_PACT]), ["1 allegiance-choice"]],
  "an allegiance offered only with another detachment": [incursion([{ unit: DRONES, allegiance: RITE_ALLEGIANCE }]), ["0 allegiance-choice"]],
  "an allegiance without the wargear it needs": [incursion([{ unit: DRONES }, { unit: IMPS, allegiance: SMOKE }], [ASH_PACT]), ["1 allegiance-requires"]],
  "an allegiance with the wargear it needs": [incursion([{ unit: DRONES }, { unit: IMPS, allegiance: SMOKE, options: { [`${IMPS}.maul`]: { "synthetic.ember-maul": 1 } } }], [ASH_PACT]), []],
  // Ash Rite makes each Drone a Character, so the second also passes Ash Pact's one Character.
  "more allegiances than a detachment allows": [
    incursion([{ unit: DRONES, allegiance: RITE_ALLEGIANCE }, { unit: DRONES, allegiance: RITE_ALLEGIANCE }], [ASH_PACT, KINDLED]),
    ["1 unit-limit", "- allegiance-limit"],
  ],
  "an enhancement an allegiance's keyword opens": [incursion([{ unit: DRONES, allegiance: RITE_ALLEGIANCE, enhancement: SIGIL }], [ASH_PACT, KINDLED]), []],
  "an enhancement without the allegiance that opens it": [incursion([{ unit: DRONES, enhancement: SIGIL }], [ASH_PACT, KINDLED]), ["0 enhancement-keywords"]],
};

for (const [name, [roster, expected]] of Object.entries(allegiances)) {
  test(`a roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(v12, roster), expected);
  });
}

test("a roster's references include each unit's allegiance", () => {
  assert.deepEqual(rosterRefs(incursion([IMP])).filter((r) => r.kind === "allegiance"), [{ kind: "allegiance", id: BLAZE }]);
});

const offer = (records: CatalogueRecord[]) => (find(records, "unit", IMPS).data as any).allegiances[0];
const invalidAllegiances: Record<string, [(records: CatalogueRecord[], identity: Release) => void, string]> = {
  "an allegiance requirement for a choice its offer lacks": [
    (r) => (offer(r).requires = { [RITE_ALLEGIANCE]: "synthetic.ember-maul" }),
    `unit:${IMPS} allegiances/0 requires allegiance:${RITE_ALLEGIANCE}, which it does not offer`,
  ],
  "an allegiance requirement for wargear the unit cannot carry": [
    (r, identity) => {
      offer(r).requires = { [SMOKE]: "synthetic.ward-shield" };
      identity.entries.find((e) => e.id === IMPS)!.references!.push({ kind: "wargear", id: "synthetic.ward-shield" });
    },
    `unit:${IMPS} allegiances/0 requires wargear:synthetic.ward-shield, which the unit cannot carry`,
  ],
  "an allegiance limit with its minimum above its maximum": [
    (r) => ((find(r, "detachment", ASH_PACT).data as any).allegianceLimits[0].min = 2),
    `detachment:${ASH_PACT} allegianceLimits/0 min is above max`,
  ],
  "an allegiance in a roster-wide condition": [
    (r) => ((find(r, "unit", DRONES).data as any).limits[0].when = { allegiance: RITE_ALLEGIANCE }),
    `unit:${DRONES} limits name an allegiance, which holds only in conditional keywords`,
  ],
};

for (const [name, [change, error]] of Object.entries(invalidAllegiances)) {
  test(`definitions with ${name} fail with: ${error}`, () => {
    const { identity, records } = input("1.2");
    change(records, identity);
    const result = validateDefinitions(identity, records);
    assert.ok(!result.ok && result.errors.includes(error), JSON.stringify(result));
  });
}

// Ash Imps carrying an ember maul are Fly in place of Infantry, and Ash Pact needs a Fly unit.
const MAUL = { [`${IMPS}.maul`]: { "synthetic.ember-maul": 1 } };
const wargearKeywords: Record<string, [Roster, string[]]> = {
  "a unit without the wargear that gives a keyword a limit needs": [incursion([IMP], [ASH_PACT]), ["- unit-limit"]],
  "a unit with the wargear that gives a keyword a limit needs": [incursion([{ ...IMP, options: MAUL }], [ASH_PACT]), []],
};

for (const [name, [roster, expected]] of Object.entries(wargearKeywords)) {
  test(`a roster with ${name} reports ${expected.join(", ") || "nothing"}`, () => {
    assert.deepEqual(codes(v12, roster), expected);
  });
}

test("a unit carrying wargear loses the keywords its conditional keywords replace", () => {
  assert.deepEqual(unitKeywords(v12.get("unit", IMPS)!.data, incursion([]), undefined, new Map([["synthetic.ember-maul", 1]])), ["Fly"]);
});

const wargearCondition = (records: CatalogueRecord[]) => (find(records, "unit", IMPS).data as any).conditionalKeywords[0];
const invalidWargearKeywords: Record<string, [(records: CatalogueRecord[], identity: Release) => void, string]> = {
  "a conditional keyword on wargear the unit cannot carry": [
    (r, identity) => {
      wargearCondition(r).when = { wargear: "synthetic.ward-shield" };
      identity.entries.find((e) => e.id === IMPS)!.references!.push({ kind: "wargear", id: "synthetic.ward-shield" });
    },
    `unit:${IMPS} conditionalKeywords/0 names wargear:synthetic.ward-shield, which the unit cannot carry`,
  ],
  "a conditional keyword replacing one the unit lacks": [
    (r) => (wargearCondition(r).replaces = ["Monster"]),
    `unit:${IMPS} conditionalKeywords/0 replaces Monster, which is not one of its keywords`,
  ],
  "wargear in a roster-wide condition": [
    (r) => ((find(r, "unit", IMPS).data as any).limits = [{ battleSize: "synthetic.incursion", perRoster: 1, when: { wargear: "synthetic.ember-maul" } }]),
    `unit:${IMPS} limits name wargear, which holds only in conditional keywords`,
  ],
};

for (const [name, [change, error]] of Object.entries(invalidWargearKeywords)) {
  test(`definitions with ${name} fail with: ${error}`, () => {
    const { identity, records } = input("1.2");
    change(records, identity);
    const result = validateDefinitions(identity, records);
    assert.ok(!result.ok && result.errors.includes(error), JSON.stringify(result));
  });
}

// The Wardens' leader may take the carbines the Wardens take, and a unit-wide rule makes every model take the same one.
const uniformAcrossCarriers = (change?: (records: CatalogueRecord[], identity: Release) => void) => {
  const { identity, records } = input("1.2");
  Object.assign(find(records, "roster-option", `${WARDENS}.leader-weapon`).data, {
    uniform: true,
    replaces: { "synthetic.ember-pistol": 1 },
    choices: ["synthetic.ember-carbine", "synthetic.ash-carbine"],
  });
  (find(records, "unit", WARDENS).data as any).uniformOptions = [[`${WARDENS}.carbines`, `${WARDENS}.leader-weapon`]];
  for (const id of [WARDENS, `${WARDENS}.leader-weapon`]) {
    identity.entries.find((e) => e.id === id)!.references!.push(
      ...[`${WARDENS}.carbines`, `${WARDENS}.leader-weapon`].map((option) => ({ kind: "roster-option" as const, id: option })),
      ...["synthetic.ember-carbine", "synthetic.ash-carbine", "synthetic.ember-pistol"].map((wargear) => ({ kind: "wargear" as const, id: wargear })),
    );
  }
  change?.(records, identity);
  return validateDefinitions(identity, records);
};
const leaderTakes = (options: Record<string, number>) => edited12((r) => (r.units[1]!.options![`${WARDENS}.leader-weapon`] = options));
// The first unit of the roster takes its leader's weapon as the 1.2 fixture had it, so only the second is compared.
const secondUnit = (definitions: Definitions, roster: Roster) => codes(definitions, roster).filter((c) => c.startsWith("1 "));

test("uniform options of different carriers accept every model taking the same choice", () => {
  const validated = uniformAcrossCarriers();
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(secondUnit(validated.definitions, leaderTakes({ "synthetic.ember-carbine": 1 })), []);
});

test("uniform options of different carriers refuse a carrier taking another choice", () => {
  const validated = uniformAcrossCarriers();
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(secondUnit(validated.definitions, leaderTakes({ "synthetic.ash-carbine": 1 })), ["1 option-uniform"]);
});

test("uniform options of different carriers refuse a carrier keeping its default", () => {
  const validated = uniformAcrossCarriers();
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(secondUnit(validated.definitions, legal12), ["1 option-uniform"]);
});

test("uniform options of different carriers accept a unit taking none of them", () => {
  const validated = uniformAcrossCarriers();
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(secondUnit(validated.definitions, edited12((r) => (r.units[1]!.options = {}))), []);
});

test("uniform options must each be uniform", () => {
  const validated = uniformAcrossCarriers((records) => delete (find(records, "roster-option", `${WARDENS}.leader-weapon`).data as any).uniform);
  assert.deepEqual(validated.ok ? [] : validated.errors, [`unit:${WARDENS} uniformOptions/0 names roster-option:${WARDENS}.leader-weapon, which is not uniform`]);
});

test("a carrier taking a substitute leaves its uniform option out of the choice made together", () => {
  const validated = uniformAcrossCarriers((records, identity) => {
    Object.assign(find(records, "roster-option", `${WARDENS}.leader-weapon`).data, { choices: ["synthetic.ember-carbine", "synthetic.ash-carbine", "synthetic.cinder-lance"], substitutes: ["synthetic.cinder-lance"] });
    identity.entries.find((e) => e.id === `${WARDENS}.leader-weapon`)!.references!.push({ kind: "wargear", id: "synthetic.cinder-lance" });
  });
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(secondUnit(validated.definitions, leaderTakes({ "synthetic.cinder-lance": 1 })), []);
});

test("uniform options made together offer the same choices", () => {
  const validated = uniformAcrossCarriers((records) => ((find(records, "roster-option", `${WARDENS}.leader-weapon`).data as any).choices = ["synthetic.ash-carbine"]));
  assert.deepEqual(validated.ok ? [] : validated.errors, [`unit:${WARDENS} uniformOptions/0 names options offering different choices besides their substitutes`]);
});

test("uniform options made together have different carriers", () => {
  const validated = uniformAcrossCarriers((records) => ((find(records, "roster-option", `${WARDENS}.leader-weapon`).data as any).carrier = WARDEN));
  assert.ok(!validated.ok && validated.errors.includes(`unit:${WARDENS} uniformOptions/0 names roster-option:${WARDENS}.leader-weapon, whose carrier is not one only it names`));
});

test("a uniform option that can take nothing at the unit's size is left out of the choice made together", () => {
  const validated = uniformAcrossCarriers((records) => ((find(records, "roster-option", `${WARDENS}.leader-weapon`).data as any).bySize = [{ size: 5, min: 0, max: 0 }]));
  if (!validated.ok) assert.fail(validated.errors.join("\n"));
  assert.deepEqual(secondUnit(validated.definitions, legal12), []);
});

test("an option is made together with others in one entry only", () => {
  const validated = uniformAcrossCarriers((records) => {
    const unit = find(records, "unit", WARDENS).data as any;
    unit.uniformOptions.push([...unit.uniformOptions[0]].reverse());
  });
  assert.ok(!validated.ok && validated.errors.includes(`unit:${WARDENS} uniformOptions/1 names roster-option:${WARDENS}.leader-weapon, which another entry names`));
});

/** The 1.2 definitions with the ward shield naming a rule summary as its rule, listed and referenced as given. */
const wargearRules = (referenced: boolean, listed = true) => {
  const { identity, records } = input("1.2");
  const rule = "synthetic.ward-shield.warding";
  if (listed) identity.entries.push({ kind: "ability", id: rule, name: "Warding" });
  if (referenced) {
    const shield = identity.entries.find((e) => e.id === "synthetic.ward-shield")!;
    shield.references = [...(shield.references ?? []), { kind: "ability", id: rule }];
  }
  (find(records, "wargear", "synthetic.ward-shield").data as any).rules = [rule];
  const result = validateDefinitions(identity, records);
  return result.ok ? [] : result.errors;
};

test("a piece of wargear names the rule summaries of the rules it gives", () => {
  assert.deepEqual(wargearRules(true), []);
});

test("a piece of wargear's rule must be referenced by its identity entry", () => {
  assert.ok(wargearRules(false).includes("wargear:synthetic.ward-shield names ability:synthetic.ward-shield.warding but its identity entry does not reference it"));
});

test("a piece of wargear's rule must be a current entry", () => {
  assert.ok(wargearRules(false, false).includes("wargear:synthetic.ward-shield names ability:synthetic.ward-shield.warding, which is not a current entry"));
});
