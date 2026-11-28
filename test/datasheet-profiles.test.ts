import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkUpgrade, historyErrors, type Release } from "../src/catalogue-identity/identity.ts";
import { buildCatalogueRelease, type CatalogueRecord, type Manifest } from "../src/catalogue-releases/catalogue.ts";
import { attachedUnitProblems, canAttach, mustAttach, validateProfiles, type AttachedUnit, type AttachmentData, type ConditionalAttachment } from "../src/datasheet-profiles/profiles.ts";

const fixtures = new URL("../fixtures/", import.meta.url);
const json = (path: string): any => JSON.parse(readFileSync(new URL(path, fixtures), "utf8"));
const records = (dir: string) => readdirSync(new URL(dir, fixtures)).map((f) => json(`${dir}${f}`) as CatalogueRecord);
const identity = (version: string): Release => {
  const rosters = json(`roster-definitions/${version}/identity.json`);
  return { ...rosters, entries: [...rosters.entries, ...json(`datasheet-profiles/${version}/identity.json`).entries] };
};
const profileRecords = (version: string) => records(`datasheet-profiles/${version}/records/profiles/`);
const UNIT = "synthetic.ember-host";
const WARDENS = `${UNIT}.flame-wardens`;

function errors(change: (identity: Release, records: CatalogueRecord[]) => void) {
  const id = identity("1.1");
  const recs = profileRecords("1.1");
  change(id, recs);
  const result = validateProfiles(id, recs);
  return result.ok ? [] : result.errors;
}
const record = (recs: CatalogueRecord[], kind: string, id: string): any => recs.find((r) => r.kind === kind && r.id === id)!;
const entry = (id: Release, kind: string, entryId: string) => id.entries.find((e) => e.kind === kind && e.id === entryId)!;

function profiles(version: string) {
  const result = validateProfiles(identity(version), profileRecords(version));
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.profiles;
}

test("both rules versions validate", () => {
  assert.deepEqual([profiles("1.0").all("weapon-profile").length, profiles("1.1").all("weapon-profile").length], [2, 6]);
});

test("profile IDs form a valid identity history beside the roster IDs", () => {
  assert.deepEqual(historyErrors([identity("1.0"), identity("1.1")]), []);
});

test("a saved weapon profile that split into firing modes resolves to its replacements", () => {
  const [finding] = checkUpgrade(identity("1.1"), [{ kind: "weapon-profile", id: `${WARDENS}.cinder-cannon` }]);
  assert.deepEqual(finding.resolution.status === "retired" && finding.resolution.replacedBy.map((e) => e.id), [`${WARDENS}.cinder-cannon-focused`, `${WARDENS}.cinder-cannon-dispersed`]);
});

test("profiles build as a category that depends on rosters and reports the retired profile", () => {
  const build = (version: string, release: string, previous?: Parameters<typeof buildCatalogueRelease>[1]["previous"]) => {
    const dir = mkdtempSync(join(tmpdir(), "profiles-"));
    cpSync(fileURLToPath(new URL(`roster-definitions/${version}/records`, fixtures)), join(dir, "records"), { recursive: true });
    cpSync(fileURLToPath(new URL(`datasheet-profiles/${version}/records`, fixtures)), join(dir, "records"), { recursive: true });
    writeFileSync(join(dir, "identity.json"), JSON.stringify(identity(version)));
    const categories = json(`roster-definitions/${version}/categories.json`);
    categories.categories.push({ name: "profiles", status: "included", kinds: ["unit-profile", "weapon-profile", "attachment"], sources: [{ title: "Synthetic datasheet profiles", page: "1" }] });
    writeFileSync(join(dir, "categories.json"), JSON.stringify(categories));
    const result = buildCatalogueRelease(dir, { release, commit: "0".repeat(40), previous });
    assert.ok(result.ok, JSON.stringify(result));
    return result.files;
  };
  const files = build("1.1", "0.2.0", build("1.0", "0.1.0"));
  assert.ok(files.has("schema/datasheet-profiles/profiles.v1.schema.json"));
  const category = (JSON.parse(files.get("manifest.json")!.toString()) as Manifest).categories.find((c) => c.name === "profiles")!;
  assert.deepEqual([category.status, category.dependsOn, category.changes.retired.map((r) => r.id)], ["complete", ["rosters"], [`${WARDENS}.cinder-cannon`]]);
});

test("a unit's profiles are listed by kind and model", () => {
  const models = profiles("1.1").of("unit-profile", WARDENS).map((p) => p.data.models);
  assert.deepEqual(models, [[`${WARDENS}.warden`], [`${WARDENS}.leader`]]);
});

test("a bodyguard lists every unit that may lead it", () => {
  assert.deepEqual(profiles("1.1").attachedBy(WARDENS, "leads"), [`${UNIT}.pyre-lord`, `${UNIT}.the-kindler`]);
});

test("a profile cannot name a model of another unit", () => {
  const found = errors((id, recs) => {
    const other = `${UNIT}.pyre-lord.lord`;
    record(recs, "unit-profile", `${WARDENS}.warden`).data.models = [other];
    entry(id, "unit-profile", `${WARDENS}.warden`).references!.push({ kind: "model", id: other });
  });
  assert.deepEqual(found, [`unit-profile:${WARDENS}.warden names model:${UNIT}.pyre-lord.lord, which belongs to another unit`]);
});

test("a weapon profile cannot name wargear its unit neither carries nor offers", () => {
  const found = errors((id, recs) => {
    record(recs, "weapon-profile", `${WARDENS}.ember-rifle`).data.wargear = "synthetic.ember-staff";
    entry(id, "weapon-profile", `${WARDENS}.ember-rifle`).references!.push({ kind: "wargear", id: "synthetic.ember-staff" });
  });
  assert.deepEqual(found, [`weapon-profile:${WARDENS}.ember-rifle names wargear:synthetic.ember-staff, which unit:${WARDENS} neither carries nor offers`]);
});

const LORD_STAFF = `${UNIT}.pyre-lord.ember-staff`;
const nameWargear = (id: Release, recs: CatalogueRecord[], profile: string, wargear: string) => {
  record(recs, "weapon-profile", profile).data.wargear = wargear;
  entry(id, "weapon-profile", profile).references!.push({ kind: "wargear", id: wargear });
};

test("a weapon profile may name wargear included by a bundle its unit offers", () => {
  assert.deepEqual(errors((id, recs) => nameWargear(id, recs, LORD_STAFF, "synthetic.ember-maul")), []);
});

test("a weapon profile may name wargear its unit carries itself rather than any model", () => {
  const found = errors((id, recs) => {
    nameWargear(id, recs, `${WARDENS}.ember-rifle`, "synthetic.ember-staff");
    entry(id, "unit", WARDENS).references!.push({ kind: "wargear", id: "synthetic.ember-staff" });
  });
  assert.deepEqual(found, []);
});

test("a weapon profile cannot name wargear only another unit's bundle includes", () => {
  const found = errors((id, recs) => nameWargear(id, recs, `${WARDENS}.ember-rifle`, "synthetic.ward-shield"));
  assert.deepEqual(found, [`weapon-profile:${WARDENS}.ember-rifle names wargear:synthetic.ward-shield, which unit:${WARDENS} neither carries nor offers`]);
});

test("bundles that include each other still bound a weapon profile's wargear", () => {
  const found = errors((id, recs) => {
    entry(id, "wargear", "synthetic.ember-maul").references = [{ kind: "wargear", id: "synthetic.maul-and-shield" }];
    nameWargear(id, recs, LORD_STAFF, "synthetic.ember-maul");
  });
  assert.deepEqual(found, []);
});

const transportLoad = { limit: 4, count: "models", selectors: ["Scouts", "Guard Infantry"] };

function transport(id: Release, records: CatalogueRecord[], capacity: object) {
  const unit = WARDENS;
  id.entries.push({ kind: "transport-profile", id: unit, name: "Transport", references: [{ kind: "unit", id: unit }] });
  records.push({
    formatVersion: 1, kind: "transport-profile", id: unit, rulesVersion: id.rulesVersion,
    source: { title: "Synthetic datasheet", page: "1" }, data: { unit, capacity },
  });
}

test("transport capacity distinguishes extra pools from alternative loads", () => {
  const capacity = {
    loads: [[transportLoad, { limit: 1, count: "models", selectors: ["Hero"] }], [{ limit: 1, count: "units", selectors: ["Monsters"], maxWounds: 3 }]],
    excluded: [{ selectors: ["Flying"], except: ["Friendly Scout"] }],
    space: [{ selectors: ["Heavy"], size: 2 }],
  };
  const id = identity("1.1");
  const recs = profileRecords("1.1");
  transport(id, recs, capacity);
  const result = validateProfiles(id, recs);
  if (!result.ok) assert.fail(result.errors.join("\n"));
  assert.deepEqual(result.profiles.of("transport-profile", WARDENS)[0]?.data.capacity, capacity);
});

test("conditional capacity can only name gear the transport carries or offers", () => {
  const found = errors((id, recs) => {
    const wargear = "synthetic.ember-staff";
    transport(id, recs, { loads: [[transportLoad]], whenEquipped: [{ wargear, pool: transportLoad }] });
    entry(id, "transport-profile", WARDENS).references!.push({ kind: "wargear", id: wargear });
  });
  assert.deepEqual(found, [`transport-profile:${WARDENS} names wargear:synthetic.ember-staff, which unit:${WARDENS} neither carries nor offers`]);
});

test("a capacity may depend on a model of the transport's own unit", () => {
  const found = errors((id, recs) => {
    const model = `${WARDENS}.leader`;
    transport(id, recs, { loads: [[transportLoad]], whenEquipped: [{ model, pool: { ...transportLoad, limit: 8 } }] });
    entry(id, "transport-profile", WARDENS).references!.push({ kind: "model", id: model });
  });
  assert.deepEqual(found, []);
});

test("a capacity cannot depend on another unit's model", () => {
  const found = errors((id, recs) => {
    const model = `${UNIT}.pyre-lord.lord`;
    transport(id, recs, { loads: [[transportLoad]], whenEquipped: [{ model, pool: transportLoad }] });
    entry(id, "transport-profile", WARDENS).references!.push({ kind: "model", id: model });
  });
  assert.deepEqual(found, [`transport-profile:${WARDENS} names model:${UNIT}.pyre-lord.lord, which belongs to another unit`]);
});

test("an attachment cannot name a unit its identity entry does not reference", () => {
  const found = errors((_, recs) => record(recs, "attachment", `${UNIT}.pyre-lord`).data.leads.push(`${UNIT}.ash-drones`));
  assert.deepEqual(found, [`attachment:${UNIT}.pyre-lord names unit:${UNIT}.ash-drones but its identity entry does not reference it`]);
});

test("a missing characteristic needs a gap", () => {
  const found = errors((_, recs) => delete record(recs, "weapon-profile", `${WARDENS}.ember-rifle`).data.strength);
  assert.deepEqual(found, [`weapon-profile:${WARDENS}.ember-rifle has no strength and no gap for it`]);
});

test("a stated characteristic cannot also be a gap", () => {
  const found = errors((_, recs) => record(recs, "unit-profile", `${UNIT}.ash-drones.ash-drone`).data.leadership = 7);
  assert.deepEqual(found, [`unit-profile:${UNIT}.ash-drones.ash-drone states leadership and also a gap for it`]);
});

test("an unknown gap field cannot stand in for a profile field", () => {
  const found = errors((_, recs) => (record(recs, "unit-profile", `${WARDENS}.warden`).data.gaps = [{ field: "move", reason: "unrepresentable" }]));
  assert.deepEqual(found, [`unit-profile:${WARDENS}.warden has a gap for unknown field move`]);
});

test("several unit profiles each need models or a gap for them", () => {
  const found = errors((id, recs) => {
    delete record(recs, "unit-profile", `${WARDENS}.warden`).data.models;
    const warden = entry(id, "unit-profile", `${WARDENS}.warden`);
    warden.references = warden.references!.filter((r) => r.kind !== "model");
  });
  assert.deepEqual(found, [`unit:${WARDENS} has 2 unit profiles, so each needs models or a gap for them`]);
});

test("dice amounts must name a die", () => {
  const found = errors((_, recs) => (record(recs, "weapon-profile", `${UNIT}.pyre-lord.ember-staff`).data.damage = "D+3"));
  assert.ok(found.some((e) => e.startsWith(`weapon-profile:${UNIT}.pyre-lord.ember-staff data/damage`)), found.join("\n"));
});

test("a transport's Firing Deck is a positive number of models", () => {
  const id = identity("1.1");
  const recs = profileRecords("1.1");
  transport(id, recs, { loads: [[transportLoad]] });
  (recs.at(-1)!.data as { firingDeck?: number }).firingDeck = 0;
  const result = validateProfiles(id, recs);
  assert.deepEqual(result.ok ? [] : result.errors, [`transport-profile:${WARDENS} data/firingDeck must be >= 1`]);
});

const PYRE_LORD = `${UNIT}.pyre-lord.pyre-lord`;
const invulnerableSummary = (save: object) => errors((_, recs) => (record(recs, "unit-profile", PYRE_LORD).data.invulnerableSave = { roll: 4, ...save }));

test("an invulnerable save may apply only to melee attacks", () => {
  assert.deepEqual(invulnerableSummary({ against: "melee" }), []);
});

test("a conditional invulnerable save may summarise when it applies", () => {
  assert.deepEqual(invulnerableSummary({ conditional: true, summary: "Only while this model is within 6\" of an **objective marker**." }), []);
});

test("an invulnerable save summary cannot link to a record", () => {
  const found = invulnerableSummary({ conditional: true, summary: `Only while [Ember Ward](vsdata:ability/${UNIT}.ember-ward) is active.` });
  assert.deepEqual(found, [`unit-profile:${PYRE_LORD} invulnerable save summary has a link`]);
});

test("only a conditional invulnerable save has a summary", () => {
  const found = invulnerableSummary({ summary: "Only against ranged attacks." });
  assert.ok(found.includes(`unit-profile:${PYRE_LORD} data/invulnerableSave must have property conditional when property summary is present`), found.join("\n"));
});

const invulnerableSaves = (saves: object[]) => errors((_, recs) => (record(recs, "unit-profile", PYRE_LORD).data.invulnerableSave = saves));

test("a unit may have one invulnerable save against ranged attacks and another against melee", () => {
  assert.deepEqual(invulnerableSaves([{ roll: 6, against: "ranged" }, { roll: 4, against: "melee" }]), []);
});

test("a list of invulnerable saves names each kind of attack once", () => {
  const found = invulnerableSaves([{ roll: 6, against: "melee" }, { roll: 4, against: "melee" }]);
  assert.deepEqual(found, [`unit-profile:${PYRE_LORD} has more than one invulnerable save against melee attacks`]);
});

test("each save in a list of invulnerable saves names the attacks it applies to", () => {
  const found = invulnerableSaves([{ roll: 6, against: "ranged" }, { roll: 4 }]);
  assert.ok(found.includes(`unit-profile:${PYRE_LORD} data/invulnerableSave/1 must have required property 'against'`), found.join("\n"));
});

const KINDLER = `${UNIT}.the-kindler`;
const DRONES = `${UNIT}.ash-drones`;
const VOW = "synthetic.kindled-vow";
const conditionalAttachment = (entry: Omit<ConditionalAttachment, "role">): AttachmentData => ({ unit: KINDLER, conditional: [{ role: "leads", ...entry }] });
const leadsWardens = (entry: Omit<ConditionalAttachment, "role">, ...contexts: Parameters<typeof canAttach>[3][]) =>
  contexts.map((context) => canAttach(conditionalAttachment(entry), "leads", WARDENS, context));

test("an unconditional attachment holds in any roster", () => {
  assert.equal(canAttach(profiles("1.1").of("attachment", KINDLER)[0]!.data, "leads", WARDENS), true);
});

test("a conditional entry applies only to its own role", () => {
  assert.equal(canAttach(conditionalAttachment({ units: [WARDENS] }), "supports", WARDENS), false);
});

test("a conditional entry may name its targets by keyword", () => {
  const found = leadsWardens({ keywords: ["INFANTRY", "BATTLELINE"] }, { keywords: { [WARDENS]: ["Infantry", "Battleline"] } }, { keywords: { [WARDENS]: ["INFANTRY"] } });
  assert.deepEqual(found, [true, false]);
});

test("a conditional entry may hold only for one faction", () => {
  const found = leadsWardens({ units: [WARDENS], when: { faction: "synthetic.ember-host" } }, { faction: "synthetic.ember-host" }, { faction: "synthetic.ash-court" });
  assert.deepEqual(found, [true, false]);
});

test("a conditional entry may need any of a roster's detachments", () => {
  const found = leadsWardens({ units: [WARDENS], when: { detachment: VOW } }, { detachments: ["synthetic.ash-pact", VOW] }, { detachments: ["synthetic.ash-pact"] });
  assert.deepEqual(found, [true, false]);
});

test("a conditional entry may bar a detachment", () => {
  const found = leadsWardens({ units: [WARDENS], when: { withoutDetachment: VOW } }, {}, { detachments: [VOW] });
  assert.deepEqual(found, [true, false]);
});

test("a conditional entry may need another unit in the roster", () => {
  const found = leadsWardens({ units: [WARDENS], when: { withUnit: `${UNIT}.pyre-lord` } }, { units: [`${UNIT}.pyre-lord`] }, {});
  assert.deepEqual(found, [true, false]);
});

test("a conditional entry may bar another unit from the roster", () => {
  const found = leadsWardens({ units: [WARDENS], when: { withoutUnit: `${UNIT}.pyre-lord` } }, {}, { units: [`${UNIT}.pyre-lord`] });
  assert.deepEqual(found, [true, false]);
});

test("a conditional entry may need a keyword both units hold", () => {
  const found = leadsWardens(
    { units: [WARDENS], shared: "MARK OF ASH" },
    { keywords: { [KINDLER]: ["MARK OF ASH"], [WARDENS]: ["MARK OF ASH"] } },
    { keywords: { [KINDLER]: ["MARK OF ASH"], [WARDENS]: ["MARK OF CINDER"] } },
    { keywords: { [KINDLER]: ["MARK OF CINDER"], [WARDENS]: ["MARK OF ASH"] } },
  );
  assert.deepEqual(found, [true, false, false]);
});

const conditionalErrors = (conditional: object, ...references: { kind: string; id: string }[]) =>
  errors((id, recs) => {
    record(recs, "attachment", KINDLER).data.conditional = [{ role: "leads", ...conditional }];
    entry(id, "attachment", KINDLER).references!.push(...references);
  });

test("a unit named by keyword never joins itself", () => {
  const attachment = conditionalAttachment({ keywords: ["INFANTRY"] });
  assert.equal(canAttach(attachment, "leads", KINDLER, { keywords: { [KINDLER]: ["INFANTRY"] } }), false);
});

test("a conditional entry cannot need and exclude the same detachment", () => {
  const found = conditionalErrors({ units: [WARDENS], when: { detachment: VOW, withoutDetachment: VOW } }, { kind: "detachment", id: VOW });
  assert.ok(found.some((e) => e.includes(`needs and excludes detachment:${VOW}`)), found.join("\n"));
});

test("a conditional entry names its targets", () => {
  const found = conditionalErrors({ when: { detachment: VOW } });
  assert.ok(found.includes(`attachment:${KINDLER} data/conditional/0 must have required property 'units'`), found.join("\n"));
});

test("a conditional entry's keywords are printed in capitals", () => {
  const found = conditionalErrors({ keywords: ["Infantry"] });
  assert.ok(found.some((e) => e.startsWith(`attachment:${KINDLER} data/conditional/0/keywords/0 must match pattern`)), found.join("\n"));
});

test("a conditional entry's condition names an ID its identity entry references", () => {
  const found = conditionalErrors({ units: [DRONES], when: { withoutUnit: `${UNIT}.pyre-lord` } });
  assert.deepEqual(found, [`attachment:${KINDLER} names unit:${UNIT}.pyre-lord but its identity entry does not reference it`]);
});

test("a conditional entry's detachment must be a detachment", () => {
  const found = conditionalErrors({ units: [DRONES], when: { detachment: "synthetic.ember-host" } }, { kind: "faction", id: "synthetic.ember-host" });
  assert.deepEqual(found, [`attachment:${KINDLER} names detachment:synthetic.ember-host, which is not current in the identity release`]);
});

test("a conditional entry cannot attach a unit to itself", () => {
  const found = conditionalErrors({ units: [KINDLER] });
  assert.deepEqual(found, [`attachment:${KINDLER} attaches unit:${KINDLER} to itself`]);
});

const WARDEN = `${WARDENS}.warden`;
const LEADER = `${WARDENS}.leader`;
const baseSize = (size: unknown, refs: { kind: string; id: string }[] = []) =>
  errors((id, recs) => {
    record(recs, "unit-profile", WARDEN).data.baseSize = size;
    entry(id, "unit-profile", WARDEN).references!.push(...refs);
  });
/** The wardens' two models under one profile, sized by model. */
const byModel = (entries: object[]) =>
  errors((id, recs) => {
    recs.splice(recs.indexOf(record(recs, "unit-profile", `${WARDENS}.warden-leader`)), 1);
    id.entries.splice(id.entries.indexOf(entry(id, "unit-profile", `${WARDENS}.warden-leader`)), 1);
    Object.assign(record(recs, "unit-profile", WARDEN).data, { models: [WARDEN, LEADER], baseSize: { byModel: entries } });
    entry(id, "unit-profile", WARDEN).references!.push({ kind: "model", id: LEADER });
  });

test("a base size may differ by model", () => {
  assert.deepEqual(byModel([{ models: [LEADER], size: { diameter: 40 } }, { models: [WARDEN], size: { diameter: 32 } }]), []);
});

test("a base size by model gives every model of the profile a size", () => {
  assert.deepEqual(byModel([{ models: [LEADER], size: { diameter: 40 } }, { models: [LEADER], size: { diameter: 32 } }]), [
    `unit-profile:${WARDEN} gives model:${LEADER} more than one base size`,
    `unit-profile:${WARDEN} gives no base size to model:${WARDEN}`,
  ]);
});

test("a base size by model sizes only the profile's models", () => {
  const found = errors((id, recs) => {
    record(recs, "unit-profile", WARDEN).data.baseSize = { byModel: [{ models: [WARDEN], size: { diameter: 32 } }, { models: [LEADER], size: { diameter: 40 } }] };
    entry(id, "unit-profile", WARDEN).references!.push({ kind: "model", id: LEADER });
  });
  assert.deepEqual(found, [`unit-profile:${WARDEN} gives a base size to model:${LEADER}, which the profile does not describe`]);
});

test("a base size by wargear names wargear its unit carries or offers", () => {
  const found = baseSize({ size: { diameter: 32 }, withWargear: [{ wargear: ["synthetic.ember-staff"], size: { diameter: 40 } }] }, [{ kind: "wargear", id: "synthetic.ember-staff" }]);
  assert.deepEqual(found, [`unit-profile:${WARDEN} names wargear:synthetic.ember-staff, which unit:${WARDENS} neither carries nor offers`]);
});

test("a base size names its wargear in the identity entry's references", () => {
  const found = errors((id, recs) => {
    const warden = entry(id, "unit-profile", WARDEN);
    warden.references = warden.references!.filter((r) => r.kind !== "wargear");
  });
  assert.deepEqual(found, [`unit-profile:${WARDEN} names wargear:synthetic.cinder-cannon but its identity entry does not reference it`]);
});

test("unattributed alternatives list distinct bases", () => {
  assert.deepEqual(baseSize({ alternatives: [{ diameter: 32 }, { flyingBase: "small" }] }), []);
  assert.ok(baseSize({ alternatives: [{ diameter: 32 }, { diameter: 32 }] }).some((e) => e.startsWith(`unit-profile:${WARDEN} data/baseSize`)));
});

test("a base size's source needs a base size", () => {
  const found = errors((_, recs) => {
    const data = record(recs, "unit-profile", WARDEN).data;
    delete data.baseSize;
    data.gaps = [{ field: "baseSize", reason: "no-source" }];
  });
  assert.ok(found.includes(`unit-profile:${WARDEN} data must have property baseSize when property baseSizeSource is present`), found.join("\n"));
});

test("a base size no official source prints is a no-source gap", () => {
  const found = errors((id, recs) => {
    const data = record(recs, "unit-profile", WARDEN).data;
    delete data.baseSize;
    delete data.baseSizeSource;
    data.gaps = [{ field: "baseSize", reason: "no-source" }];
    const warden = entry(id, "unit-profile", WARDEN);
    warden.references = warden.references!.filter((r) => r.kind !== "wargear");
  });
  assert.deepEqual(found, []);
});

test("a base size by wargear gives each item one size", () => {
  const cannon = "synthetic.cinder-cannon";
  const found = baseSize({ size: { diameter: 32 }, withWargear: [{ wargear: [cannon], size: { diameter: 40 } }, { wargear: [cannon], size: { diameter: 50 } }] });
  assert.deepEqual(found, [`unit-profile:${WARDEN} gives wargear:${cannon} more than one base size`]);
});

const PYRE_LORD_UNIT = `${UNIT}.pyre-lord`;
const COLOSSUS = `${UNIT}.ember-colossus`;
/** The Pyre Lord leads the wardens and the Kindler supports the drones, as in the fixture; `hosts` adds records by unit. */
const lookup = (hosts: Record<string, Omit<AttachmentData, "unit">> = {}) => {
  const records: Record<string, AttachmentData> = {
    [PYRE_LORD_UNIT]: { unit: PYRE_LORD_UNIT, leads: [WARDENS] },
    [KINDLER]: { unit: KINDLER, supports: [DRONES] },
  };
  for (const [unit, data] of Object.entries(hosts)) records[unit] = { ...records[unit], unit, ...data };
  return (unit: string) => records[unit];
};
const joinsInstead = (insteadOf: AttachmentData["insteadOf"], keywords: Record<string, string[]> = {}) =>
  canAttach(lookup()(PYRE_LORD_UNIT)!, "leads", COLOSSUS, { keywords }, lookup({ [COLOSSUS]: { insteadOf } }));

test("a unit may be joined instead of another by whatever may join that one", () => {
  assert.equal(joinsInstead([{ units: [WARDENS] }]), true);
});

test("a stand-in is joined only in the role the other unit is joined in", () => {
  const attachOf = lookup({ [COLOSSUS]: { insteadOf: [{ units: [WARDENS] }] } });
  assert.equal(canAttach(attachOf(PYRE_LORD_UNIT)!, "supports", COLOSSUS, {}, attachOf), false);
});

test("a stand-in may admit only one role", () => {
  const attachOf = lookup({ [COLOSSUS]: { insteadOf: [{ units: [DRONES], role: "leads" }] } });
  assert.equal(canAttach(attachOf(KINDLER)!, "supports", COLOSSUS, {}, attachOf), false);
});

test("a stand-in may admit only units holding its keywords", () => {
  assert.deepEqual([joinsInstead([{ units: [WARDENS], keywords: ["CHARACTER"] }], { [PYRE_LORD_UNIT]: ["CHARACTER"] }), joinsInstead([{ units: [WARDENS], keywords: ["CHARACTER"] }])], [true, false]);
});

test("a stand-in may refuse units holding a keyword", () => {
  assert.equal(joinsInstead([{ units: [WARDENS], excludedKeywords: ["EPIC HERO"] }], { [PYRE_LORD_UNIT]: ["EPIC HERO"] }), false);
});

test("a stand-in for a stand-in may be joined", () => {
  const attachOf = lookup({ [DRONES]: { insteadOf: [{ units: [WARDENS] }] }, [COLOSSUS]: { insteadOf: [{ units: [DRONES] }] } });
  assert.equal(canAttach(attachOf(PYRE_LORD_UNIT)!, "leads", COLOSSUS, {}, attachOf), true);
});

test("stand-ins naming each other join nothing new", () => {
  const attachOf = lookup({ [DRONES]: { insteadOf: [{ units: [COLOSSUS] }] }, [COLOSSUS]: { insteadOf: [{ units: [DRONES] }] } });
  assert.equal(canAttach(attachOf(PYRE_LORD_UNIT)!, "leads", COLOSSUS, {}, attachOf), false);
});

const problems = (attached: Omit<AttachedUnit, "bodyguard">, hosts: Record<string, Omit<AttachmentData, "unit">> = {}, keywords: Record<string, string[]> = {}) =>
  attachedUnitProblems({ bodyguard: WARDENS, ...attached }, { keywords }, lookup(hosts));

test("a bodyguard takes one leader unit by default", () => {
  assert.deepEqual(problems({ leaders: [PYRE_LORD_UNIT, KINDLER] }, { [KINDLER]: { leads: [WARDENS] } }), ["attachment-full"]);
});

test("an attached unit's members must be able to join its bodyguard", () => {
  assert.deepEqual(problems({ supports: [KINDLER] }), [`attachment-target`]);
});

test("a bodyguard's capacity may take more leader units", () => {
  assert.deepEqual(problems({ leaders: [PYRE_LORD_UNIT, KINDLER] }, { [WARDENS]: { capacity: { leads: 2 } }, [KINDLER]: { leads: [WARDENS] } }), []);
});

test("a capacity may hold only from a starting strength", () => {
  const hosts = { [WARDENS]: { capacity: { leads: 2, startingStrength: 20 } }, [KINDLER]: { leads: [WARDENS] } };
  assert.deepEqual([problems({ leaders: [PYRE_LORD_UNIT, KINDLER], startingStrength: 20 }, hosts), problems({ leaders: [PYRE_LORD_UNIT, KINDLER], startingStrength: 10 }, hosts)], [[], ["attachment-full"]]);
});

test("a capacity may refuse two of the same unit", () => {
  assert.deepEqual(problems({ leaders: [PYRE_LORD_UNIT, PYRE_LORD_UNIT] }, { [WARDENS]: { capacity: { leads: 2, distinct: true } } }), ["attachment-duplicate"]);
});

test("a capacity may limit the attached units holding a keyword", () => {
  const hosts = { [WARDENS]: { capacity: { leads: 2, limits: [{ keywords: ["COMMAND SQUAD"], max: 1 }] } } };
  assert.deepEqual(problems({ leaders: [PYRE_LORD_UNIT, PYRE_LORD_UNIT] }, hosts, { [PYRE_LORD_UNIT]: ["COMMAND SQUAD"] }), ["attachment-limit"]);
});

test("a leader may join beside one other leader unit where it says so", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS] }] } };
  assert.deepEqual(problems({ leaders: [PYRE_LORD_UNIT, KINDLER] }, hosts), []);
});

test("a leader joining beside another is never beside its own kind", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS] }] } };
  assert.deepEqual(problems({ leaders: [KINDLER, KINDLER] }, hosts), ["attachment-duplicate"]);
});

test("a leader may join beside only some other leader units", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS], besideUnits: [DRONES] }] }, [DRONES]: { leads: [WARDENS] } };
  assert.deepEqual([problems({ leaders: [DRONES, KINDLER] }, hosts), problems({ leaders: [PYRE_LORD_UNIT, KINDLER] }, hosts)], [[], ["attachment-full"]]);
});

test("a leader may join beside leader units holding a keyword", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS], besideKeywords: ["INQUISITOR"] }] } };
  assert.deepEqual([problems({ leaders: [PYRE_LORD_UNIT, KINDLER] }, hosts, { [PYRE_LORD_UNIT]: ["INQUISITOR"] }), problems({ leaders: [PYRE_LORD_UNIT, KINDLER] }, hosts)], [[], ["attachment-full"]]);
});

test("a leader joins beside only one other leader unit", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS] }] }, [DRONES]: { leads: [WARDENS] } };
  assert.deepEqual(problems({ leaders: [PYRE_LORD_UNIT, KINDLER, DRONES] }, hosts), ["attachment-full"]);
});

test("a joining unit joins a bodyguard holding its keywords", () => {
  const hosts = { [DRONES]: { joins: [{ keywords: ["COMMAND SQUAD"] }] } };
  assert.deepEqual([problems({ joined: [DRONES] }, hosts, { [WARDENS]: ["COMMAND SQUAD"] }), problems({ joined: [DRONES] }, hosts)], [[], ["join-target"]]);
});

test("a joining unit may need its bodyguard led by a unit holding a keyword", () => {
  const hosts = { [DRONES]: { joins: [{ ledBy: ["CRYPTEK"] }] } };
  assert.deepEqual([problems({ leaders: [PYRE_LORD_UNIT], joined: [DRONES] }, hosts, { [PYRE_LORD_UNIT]: ["CRYPTEK"] }), problems({ joined: [DRONES] }, hosts)], [[], ["join-target"]]);
});

test("a joining unit may refuse to share its bodyguard with units holding a keyword", () => {
  const hosts = { [DRONES]: { joins: [{ units: [WARDENS], exclusive: ["RETINUE"] }] }, [COLOSSUS]: { joins: [{ units: [WARDENS] }] } };
  assert.deepEqual(problems({ joined: [DRONES, COLOSSUS] }, hosts, { [COLOSSUS]: ["RETINUE"] }), ["join-exclusive"]);
});

test("a unit that may support a unit must be attached", () => {
  assert.equal(mustAttach(lookup()(KINDLER)!), true);
});

test("a unit that may only lead need not be attached", () => {
  assert.equal(mustAttach(lookup()(PYRE_LORD_UNIT)!), false);
});

test("a unit supporting only in some rosters must be attached only there", () => {
  const cato: AttachmentData = { unit: KINDLER, conditional: [{ role: "supports", units: [WARDENS], when: { withUnit: PYRE_LORD_UNIT } }] };
  assert.deepEqual([mustAttach(cato, { units: [PYRE_LORD_UNIT] }), mustAttach(cato, {})], [true, false]);
});

test("a unit that must join one is not a support unit", () => {
  assert.equal(mustAttach({ unit: DRONES, joins: [{ keywords: ["COMMAND SQUAD"], required: true }] }), false);
});

test("a support unit does not lead a joining unit's bodyguard", () => {
  const hosts = { [DRONES]: { joins: [{ ledBy: ["CRYPTEK"] }] }, [KINDLER]: { supports: [WARDENS] } };
  assert.deepEqual(problems({ supports: [KINDLER], joined: [DRONES] }, hosts, { [KINDLER]: ["CRYPTEK"] }), ["join-target"]);
});

test("a joining unit joins a unit it names or one holding its keywords", () => {
  const hosts = { [DRONES]: { joins: [{ units: [COLOSSUS], keywords: ["INFANTRY"] }] } };
  assert.deepEqual(problems({ joined: [DRONES] }, hosts, { [WARDENS]: ["INFANTRY"] }), []);
});

test("a leader joins beside another on a unit standing in for its bodyguard", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS] }] }, [COLOSSUS]: { insteadOf: [{ units: [WARDENS] }] } };
  assert.deepEqual(attachedUnitProblems({ bodyguard: COLOSSUS, leaders: [PYRE_LORD_UNIT, KINDLER] }, {}, lookup(hosts)), []);
});

test("a capacity taking two of the same unit is not narrowed by a leader joining beside another", () => {
  const hosts = { [WARDENS]: { capacity: { leads: 2 } }, [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS] }] } };
  assert.deepEqual(problems({ leaders: [KINDLER, KINDLER] }, hosts), []);
});

test("a leader joins beside another only on units it leads", () => {
  const found = recordErrors({ withAnotherLeader: [{ units: [DRONES] }] }, { kind: "unit", id: DRONES });
  assert.deepEqual(found, [`attachment:${KINDLER} leads unit:${DRONES} beside another leader but does not lead it`]);
});

test("a leader never joins beside itself", () => {
  const found = recordErrors({ withAnotherLeader: [{ units: [WARDENS], besideUnits: [KINDLER] }] });
  assert.deepEqual(found, [`attachment:${KINDLER} attaches unit:${KINDLER} to itself`]);
});

test("a conditional entry excludes keywords only beside keywords it names", () => {
  const found = conditionalErrors({ units: [WARDENS], excludedKeywords: ["CHARACTER"] });
  assert.ok(found.some((e) => e.includes("data/conditional/0 must have property keywords when property excludedKeywords is present")), found.join("\n"));
});

const recordErrors = (data: object, ...references: { kind: string; id: string }[]) =>
  errors((id, recs) => {
    Object.assign(record(recs, "attachment", KINDLER).data, data);
    entry(id, "attachment", KINDLER).references!.push(...references);
  });

test("a stand-in names units its identity entry references", () => {
  const found = recordErrors({ insteadOf: [{ units: [PYRE_LORD_UNIT] }] });
  assert.deepEqual(found, [`attachment:${KINDLER} names unit:${PYRE_LORD_UNIT} but its identity entry does not reference it`]);
});

test("a unit is never a stand-in for itself", () => {
  const found = recordErrors({ insteadOf: [{ units: [KINDLER] }] });
  assert.deepEqual(found, [`attachment:${KINDLER} stands in for unit:${KINDLER}, itself`]);
});

test("a joining unit names what it joins", () => {
  const found = recordErrors({ joins: [{ required: true }] });
  assert.ok(found.some((e) => e.startsWith(`attachment:${KINDLER} data/joins/0 must`)), found.join("\n"));
});

test("a capacity raises a limit", () => {
  const found = recordErrors({ capacity: { distinct: true } });
  assert.ok(found.some((e) => e.startsWith(`attachment:${KINDLER} data/capacity must`)), found.join("\n"));
});

test("a conditional entry may refuse targets holding a keyword", () => {
  const found = leadsWardens({ keywords: ["INFANTRY"], excludedKeywords: ["CHARACTER"] }, { keywords: { [WARDENS]: ["INFANTRY"] } }, { keywords: { [WARDENS]: ["INFANTRY", "CHARACTER"] } });
  assert.deepEqual(found, [true, false]);
});

test("a leader joins beside another on a stand-in only where the stand-in admits it", () => {
  const hosts = { [KINDLER]: { leads: [WARDENS], withAnotherLeader: [{ units: [WARDENS] }] }, [COLOSSUS]: { insteadOf: [{ units: [WARDENS], keywords: ["CHAPLAIN"] }] }, [PYRE_LORD_UNIT]: { leads: [COLOSSUS] } };
  assert.deepEqual(attachedUnitProblems({ bodyguard: COLOSSUS, leaders: [PYRE_LORD_UNIT, KINDLER] }, {}, lookup(hosts)), ["attachment-target", "attachment-full"]);
});
