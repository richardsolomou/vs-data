import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Release } from "../src/catalogue-identity/identity.ts";
import { buildCatalogueRelease, type CatalogueRecord, type Manifest } from "../src/catalogue-releases/catalogue.ts";
import type { ReleaseFiles } from "../src/releases/release.ts";
import { parseSummary, plain, stratagemSummary, validateSummaries } from "../src/rule-summaries/summaries.ts";
import { commonmark } from "./commonmark.ts";

const fixtures = fileURLToPath(new URL("../fixtures/rule-summaries/", import.meta.url));
const json = (path: string): any => JSON.parse(readFileSync(join(fixtures, path), "utf8"));
const identity = (): Release => json("identity.json");
const records = (): CatalogueRecord[] => readdirSync(join(fixtures, "records")).flatMap((c) => readdirSync(join(fixtures, "records", c)).map((f) => json(`records/${c}/${f}`)));
const OATH = { kind: "ability", id: "synthetic.ember-host.smouldering-oath" };
const VOLLEY = "synthetic.ember-host.kindled-vow.ember-volley";
const ERRATA = "synthetic-codex.errata.smouldering-oath";

function errors(change: (identity: Release, records: CatalogueRecord[]) => void) {
  const [id, recs] = [identity(), records()];
  change(id, recs);
  const result = validateSummaries(id, recs);
  return result.ok ? [] : result.errors;
}
const data = (recs: CatalogueRecord[], kind: string, id: string): any => recs.find((r) => r.kind === kind && r.id === id)!.data;

function build(change: (dir: string) => void = () => {}, release = "0.1.0", previous?: ReleaseFiles): ReleaseFiles {
  const dir = mkdtempSync(join(tmpdir(), "rule-summaries-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(fixtures, dir, { recursive: true });
  change(dir);
  const result = buildCatalogueRelease(dir, { release, commit: "0".repeat(40), previous });
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.files;
}
const category = (files: ReleaseFiles, name: string) => (JSON.parse(files.get("manifest.json")!) as Manifest).categories.find((c) => c.name === name)!;

test("the synthetic summaries validate and list the FAQ that amends a rule", () => {
  const result = validateSummaries(identity(), records());
  if (!result.ok) assert.fail(result.errors.join("\n"));
  assert.deepEqual(result.summaries.amendedBy(OATH).map((faq) => faq.id), [ERRATA]);
});

test("a mission card with no text of its own validates as complete without a summary", () => {
  const card = (recs: CatalogueRecord[]) => data(recs, "mission-card", "synthetic-pack.hold-the-pyre");
  const none = { text: "none", reason: "The card prints no rules text beyond its awards and actions." };
  assert.deepEqual(errors((_, recs) => { const d = card(recs); delete d.summary; Object.assign(d, none); }), []);
});

test("a mission card cannot carry both a summary and the no-text marker", () => {
  assert.ok(errors((_, recs) => Object.assign(data(recs, "mission-card", "synthetic-pack.hold-the-pyre"), { text: "none", reason: "None." })).length > 0);
});

test("rules reference and mission rules build as categories, with undrafted entries unresolved", () => {
  const files = build();
  assert.ok(files.has("schema/rule-summaries/summaries.v2.schema.json"));
  const rules = category(files, "rules-reference");
  const missions = category(files, "mission-rules");
  assert.deepEqual(
    [rules.status, rules.unresolved, missions.status, missions.dependsOn],
    ["partial", [{ kind: "ability", id: "synthetic.ember-host.kindled-vow.cinder-ward" }], "complete", ["rules-reference"]],
  );
});

test("a retired FAQ reports the publications that superseded it", () => {
  const sources = [{ title: "Synthetic Faction Pack: Version 1.2", page: "5" }];
  const files = build(
    (dir) => {
      const path = join(dir, "identity.json");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.revision = 2;
      value.entries.find((e: { id: string }) => e.id === ERRATA).retired = { replacedBy: [], sources };
      writeFileSync(path, JSON.stringify(value));
      rmSync(join(dir, `records/rules-reference/faq.${ERRATA}.json`));
    },
    "0.2.0",
    build(),
  );
  assert.deepEqual(category(files, "rules-reference").changes.retired, [{ kind: "faq", id: ERRATA, replacedBy: [], sources }]);
});

test("a catalogue record's attribution must be complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "rule-summaries-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(fixtures, dir, { recursive: true });
  const path = join(dir, `records/rules-reference/ability.${OATH.id}.json`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  delete value.attribution.licence;
  writeFileSync(path, JSON.stringify(value));
  const result = buildCatalogueRelease(dir, { release: "0.1.0", commit: "0".repeat(40) });
  assert.deepEqual(result.ok ? [] : result.errors, [`records/rules-reference/ability.${OATH.id}.json: /attribution must have required property 'licence'`]);
});

test("a provisional summary has no citations", () => {
  assert.deepEqual(
    errors((_, recs) => Object.assign(data(recs, "ability", OATH.id), { provisional: true, citations: [] })),
    [],
  );
});

test("a provisional summary cannot cite a source it was not checked against", () => {
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).provisional = true)).includes(`ability:${OATH.id} data/citations must NOT have more than 0 items`));
});

test("a summary that is not provisional cites an official source", () => {
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).citations = [])).includes(`ability:${OATH.id} data/citations must NOT have fewer than 1 items`));
});

const CLARIFICATION = "synthetic.shooting-phase.selecting-targets";

test("a clarification's parent is another core rule", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "core-rule", CLARIFICATION).parent = { kind: "core-rule", id: CLARIFICATION })),
    [`core-rule:${CLARIFICATION} parent must be another core-rule`],
  );
});

test("a clarification's parent is a reference of its identity entry", () => {
  assert.deepEqual(
    errors((id) => (id.entries.find((e) => e.id === CLARIFICATION)!.references = [])),
    [`core-rule:${CLARIFICATION} parent core-rule:synthetic.shooting-phase is not a reference of its identity entry`],
  );
});

test("a clarification's parent has no parent of its own", () => {
  assert.deepEqual(
    errors((id, recs) => {
      data(recs, "core-rule", "synthetic.shooting-phase").parent = { kind: "core-rule", id: CLARIFICATION };
      id.entries.find((e) => e.id === "synthetic.shooting-phase")!.references = [{ kind: "core-rule", id: CLARIFICATION }];
    }),
    [`core-rule:synthetic.shooting-phase parent core-rule:${CLARIFICATION} has a parent of its own`, `core-rule:${CLARIFICATION} parent core-rule:synthetic.shooting-phase has a parent of its own`],
  );
});

test("a core rule's order is unique in its document", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "core-rule", CLARIFICATION).order = 1)),
    [`core-rule:${CLARIFICATION} order 1 is core-rule:synthetic.shooting-phase's in Synthetic Core Rules`],
  );
});

test("a core rule's anchor is unique in its document", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "core-rule", CLARIFICATION).anchor = "3.01")),
    [`core-rule:${CLARIFICATION} anchor 3.01 is core-rule:synthetic.shooting-phase's in Synthetic Core Rules`],
  );
});

test("rules of different documents may share an order and an anchor", () => {
  assert.deepEqual(
    errors((_, recs) => Object.assign(data(recs, "core-rule", CLARIFICATION), { document: "Synthetic Event Guide", order: 1, anchor: "3.01" })),
    [],
  );
});

const FLARE_UP = "synthetic.flare-up";

test("a core rule's printed Stratagem is a reference of its identity entry", () => {
  assert.deepEqual(
    errors((id) => delete id.entries.find((e) => e.id === FLARE_UP)!.references),
    [`core-rule:${FLARE_UP} prints ability:synthetic.core.flare-up but its identity entry does not reference it`],
  );
});

test("a core rule's printed Stratagem is a core Stratagem", () => {
  assert.deepEqual(
    errors((id, recs) => {
      data(recs, "core-rule", FLARE_UP).stratagem = { kind: "ability", id: VOLLEY };
      id.entries.find((e) => e.id === FLARE_UP)!.references!.push({ kind: "ability", id: VOLLEY });
    }),
    [`core-rule:${FLARE_UP} prints ability:${VOLLEY}, which is not a core Stratagem`],
  );
});

test("a core rule's printed Stratagem is current", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "core-rule", FLARE_UP).stratagem = { kind: "ability", id: "synthetic.core.missing" })),
    [`core-rule:${FLARE_UP} prints ability:synthetic.core.missing, which is not current in the identity release`],
  );
});

test("a Stratagem needs its CP cost", () => {
  assert.deepEqual(
    errors((_, recs) => delete data(recs, "ability", VOLLEY).cp),
    [`ability:${VOLLEY} is a Stratagem with no CP cost`],
  );
});

test("only a Stratagem has a CP cost", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", OATH.id).cp = 1)),
    [`ability:${OATH.id} is not a Stratagem but has a CP cost, Stratagem timing or Stratagem parts`],
  );
});

test("only a Stratagem has parts", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", OATH.id).parts = data(recs, "ability", VOLLEY).parts)),
    [`ability:${OATH.id} is not a Stratagem but has a CP cost, Stratagem timing or Stratagem parts`],
  );
});

test("a Stratagem's summary is its parts joined", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", VOLLEY).parts.target = "An **INFANTRY** or **CHARACTER** unit of yours.")),
    [`ability:${VOLLEY} summary is not its Stratagem parts joined`],
  );
});

test("a Stratagem's parts are joined in order, each after its bold label", () => {
  assert.equal(
    stratagemSummary({ when: "W.", target: "T.", effect: "E.", restrictions: "R." }),
    "**When:** W.\n\n**Target:** T.\n\n**Effect:** E.\n\n**Restrictions:** R.",
  );
});

test("a Stratagem part follows the summary grammar", () => {
  assert.ok(errors((_, recs) => (data(recs, "ability", VOLLEY).parts.effect = "The unit gets _hot_.")).includes(`ability:${VOLLEY} parts/effect block 1 uses markup outside the summary grammar (_)`));
});

test("a Stratagem part opens with a paragraph", () => {
  assert.ok(errors((_, recs) => (data(recs, "ability", VOLLEY).parts.effect = "- one\n- two")).includes(`ability:${VOLLEY} parts/effect does not open with a paragraph`));
});

test("a Stratagem's Detachment is a reference of its identity entry", () => {
  assert.deepEqual(
    errors((id) => id.entries.find((e) => e.id === VOLLEY)!.references!.pop()),
    [`ability:${VOLLEY} names detachment:synthetic.ember-host.kindled-vow but its identity entry does not reference it`],
  );
});

test("a detachment rule names its Detachment as a Stratagem does", () => {
  const detachment = { kind: "detachment", id: "synthetic.ember-host.kindled-vow" };
  assert.deepEqual(
    errors((id, recs) => {
      Object.assign(data(recs, "ability", OATH.id), { ruleType: "detachment-rule", detachment });
      id.entries.find((e) => e.id === OATH.id)!.references!.push(detachment);
    }),
    [],
  );
});

test("an army rule names no Detachment", () => {
  const detachment = { kind: "detachment", id: "synthetic.ember-host.kindled-vow" };
  assert.deepEqual(
    errors((id, recs) => {
      data(recs, "ability", OATH.id).detachment = detachment;
      id.entries.find((e) => e.id === OATH.id)!.references!.push(detachment);
    }),
    [`ability:${OATH.id} names a Detachment but is not a Stratagem, Enhancement or detachment rule`],
  );
});

test("a Stratagem's windows give each of its phases a turn, and differ", () => {
  const timing = (recs: CatalogueRecord[], windows: object[]) => Object.assign(data(recs, "ability", VOLLEY).stratagem, { phases: ["shooting", "fight"], turn: "any", windows });
  assert.deepEqual(errors((_, recs) => timing(recs, [{ phase: "shooting", turn: "opponent" }, { phase: "fight", turn: "any" }])), []);
  assert.deepEqual(
    errors((_, recs) => timing(recs, [{ phase: "fight", turn: "any" }, { phase: "shooting", turn: "opponent" }])),
    [`ability:${VOLLEY} Stratagem windows must give each of its phases, in order, turns that differ, with turn any`],
  );
});

test("a summary must follow the summary grammar", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "weapon-ability", "synthetic.searing").summary = "Searing is _hot_.")),
    ["weapon-ability:synthetic.searing summary block 1 uses markup outside the summary grammar (_)"],
  );
});

test("a summary link must point to a catalogue entry", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "weapon-ability", "synthetic.searing").summary = "See [the codex](https://example.com).")),
    ["weapon-ability:synthetic.searing summary block 1 uses markup outside the summary grammar (https://)"],
  );
});

test("the summary grammar rejects what CommonMark would read as other markup or merge", () => {
  const rejected = ["# Heading", "> Quote", "Two\n\n\nblank lines", "- a\n\n- b", "Lead\n- item", "2. starts at two", "- - nested", "a *b*", "a ***b***", "**open", "[x](vsdata:Bad/id)", "![x](vsdata:a/b)", "`code`", "<b>x</b>", "x &amp; y", "trailing \nspace"];
  assert.deepEqual(rejected.filter((summary) => parseSummary(summary).ok), []);
});

test("plain text keeps the summary's blocks and drops its markup", () => {
  assert.equal(
    plain(data(records(), "core-rule", "synthetic.shooting-phase").summary),
    "In your Shooting phase, each of your units that is eligible to shoot shoots in turn.\n\nFor each unit:\n\n1. Select targets for its ranged weapons.\n2. Resolve those attacks.\n3. Select the next unit.\n\nA unit that has no eligible target cannot be selected.",
  );
});

test("CommonMark reads every fixture summary as the strict parser does", () => {
  for (const record of records()) {
    const parsed = parseSummary((record.data as { summary: string }).summary);
    assert.deepEqual(parsed.ok && parsed.blocks, commonmark((record.data as { summary: string }).summary), record.id);
  }
});

test("a linked rule must be a reference of the record's identity entry", () => {
  assert.deepEqual(
    errors((id) => delete id.entries.find((e) => e.id === OATH.id)!.references),
    [`ability:${OATH.id} names core-ability:synthetic.ashwalk but its identity entry does not reference it`],
  );
});

test("an FAQ must amend at least one catalogued rule", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "faq", ERRATA).amends = [])),
    [`faq:${ERRATA} data/amends must NOT have fewer than 1 items`],
  );
});

test("mechanic facts are checked as mechanic fields", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", VOLLEY).facts.fields.effect.by = 0)),
    [`ability:${VOLLEY} facts/effect/by must NOT be valid`],
  );
});

const AWARD = "synthetic-pack.hold-the-pyre.each-objective";
const ENHANCEMENT = {
  format: "vs-data-facts",
  version: "1",
  fields: { enhancement: { type: "model", points: 15, eligibility: { anyOf: [{ keywords: ["INFANTRY"], factionKeywords: ["SYNTHETIC"] }], excludedKeywords: ["EPIC HERO"] } } },
};

test("typed facts are checked against the shape for the record's kind", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "mission-award", AWARD).facts.fields = { detail: { window: "turn-end" } })),
    [`mission-award:${AWARD} facts must have required property 'award'`],
  );
});

test("an Enhancement's eligibility is typed facts of an Enhancement only", () => {
  const asEnhancement = (recs: CatalogueRecord[], facts: object) => Object.assign(data(recs, "ability", OATH.id), { ruleType: "enhancement", facts });
  assert.deepEqual(errors((_, recs) => asEnhancement(recs, ENHANCEMENT)), []);
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", VOLLEY).facts = ENHANCEMENT)),
    [`ability:${VOLLEY} facts must NOT have additional properties`],
  );
});

test("typed keywords are upper case", () => {
  const lower = structuredClone(ENHANCEMENT);
  lower.fields.enhancement.eligibility.anyOf[0].keywords = ["Infantry"];
  assert.deepEqual(
    errors((_, recs) => Object.assign(data(recs, "ability", OATH.id), { ruleType: "enhancement", facts: lower })),
    [`ability:${OATH.id} facts/enhancement/eligibility/anyOf/0/keywords/0 must match pattern "^[^a-z]*[A-Z0-9][^a-z]*$"`],
  );
});

test("award rounds are ascending", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "mission-award", AWARD).facts.fields.award.rounds = [3, 2])),
    [`mission-award:${AWARD} facts/award/rounds are not in ascending order`],
  );
});

test("typed facts name their format version", () => {
  assert.deepEqual(
    errors((_, recs) => (data(recs, "mission-award", AWARD).facts.version = "2")),
    [`mission-award:${AWARD} facts use vs-data-facts version 2, not 1`],
  );
});

const STRATAGEM = {
  format: "vs-data-facts",
  version: "1",
  fields: {
    stratagem: {
      limit: "battle",
      when: { at: "phase", after: "enemy-selected-targets" },
      target: { count: 1, side: "friendly", entity: "unit", keywords: ["INFANTRY"], conditions: ["targeted-by-the-attacking-unit"] },
    },
  },
};

test("a Stratagem's typed facts give its limit, moment and target, or say what is unresolved", () => {
  const unresolved = structuredClone(STRATAGEM);
  (unresolved.fields.stratagem as { when: object }).when = { unresolved: "event not typed" };
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", VOLLEY).facts = STRATAGEM)), []);
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", VOLLEY).facts = unresolved)), []);
});

test("a Stratagem's moment names a typed event", () => {
  const unknown = structuredClone(STRATAGEM);
  unknown.fields.stratagem.when.after = "enemy-sneezed";
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", VOLLEY).facts = unknown)),
    [
      `ability:${VOLLEY} facts/stratagem/when/after must be equal to one of the allowed values`,
      `ability:${VOLLEY} facts/stratagem/when/after must match "else" schema`,
      `ability:${VOLLEY} facts/stratagem/when must match "else" schema`,
    ],
  );
});

const EFFECTS = {
  format: "vs-data-facts",
  version: "1",
  fields: {
    grants: { abilities: [{ ability: "Feel No Pain 5+", to: "unit", whileAttached: true, against: ["mortal-wounds"] }] },
    weaponAbilities: [{ ability: "LETHAL HITS", attacks: ["melee"], to: "led-unit" }],
    reminder: { timings: [{ at: "phase-start", phase: "shooting", turn: "own" }] },
    combat: {
      applies: { target: { anyOf: [["INFANTRY"]] }, leading: true },
      readings: [
        { choices: [{ conditions: [{ kind: "leading" }], effects: [{ role: "attacker", attacks: ["melee"], rolls: { hitModifier: 1 } }] }], default: 1, roles: ["attacker"] },
        { roles: ["attacker"] },
      ],
      trees: [[{ ask: { unitHas: "INFANTRY" }, yes: 1, no: 2 }, { reading: 0 }, { reading: 1 }]],
      contexts: { "own.many.known": 0, "leading.many.known": 0 },
    },
  },
};

test("an ability's effect blocks give its grants, weapon abilities, reminders and combat readings", () => {
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = EFFECTS)), []);
});

test("a combat reading's trees and contexts point at entries that exist", () => {
  const broken = structuredClone(EFFECTS);
  broken.fields.combat.trees[0]![2] = { reading: 2 } as never;
  (broken.fields.combat.contexts as Record<string, number>)["army.one.known"] = 1;
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = broken)), [
    `ability:${OATH.id} facts/combat/trees/0/2 names a reading that does not exist`,
    `ability:${OATH.id} facts/combat/contexts/army.one.known names a tree that does not exist`,
  ]);
});

test("an effect names only the fields the format lists", () => {
  const unknown = structuredClone(EFFECTS);
  (unknown.fields.combat.readings[0]!.choices![0]!.effects[0] as Record<string, unknown>).reroll = "all";
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = unknown)).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0 must NOT have additional properties`));
});

test("rules the facts name are references of the record", () => {
  const named = { ...EFFECTS, fields: { ...EFFECTS.fields, references: [{ kind: "ability", id: VOLLEY }] } };
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = named)), [`ability:${OATH.id} facts name ability:${VOLLEY} but its identity entry does not reference it`]);
});

test("an effect block can be withheld as unresolved", () => {
  const withheld = { ...EFFECTS, fields: { ...EFFECTS.fields, combat: { unresolved: "the reading gives the effect to the wrong unit" } } };
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = withheld)), []);
});

test("an effect can be the bearer's alone, and a target only an Attached unit", () => {
  const scoped = structuredClone(EFFECTS);
  (scoped.fields.combat.readings[0]!.choices![0]!.effects[0] as Record<string, unknown>).bearerOnly = true;
  (scoped.fields.combat.applies.target as Record<string, unknown>).attached = true;
  scoped.fields.combat.readings[0]!.choices![0]!.conditions.push({ kind: "enemy-status", status: "BATTLE-SHOCKED" } as never);
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = scoped)), []);
});

test("a grant, an invulnerable save and an effect can be limited to some models or a stated condition", () => {
  const limited = structuredClone(EFFECTS);
  (limited.fields.grants.abilities[0] as Record<string, unknown>).conditional = true;
  (limited.fields as Record<string, unknown>).invulnerableSave = { roll: 4, keywords: ["CHARACTER"], conditional: true };
  (limited.fields.combat.readings[0]!.choices![0]!.effects[0] as Record<string, unknown>).modelKeywords = ["CHARACTER"];
  limited.fields.combat.readings[0]!.choices![0]!.conditions.push({ kind: "own-status", status: "EMPOWERED" } as never, { kind: "target-tougher" } as never);
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = limited)), []);
});

test("a grant can go to the units the player picks as the battle begins", () => {
  const picked = structuredClone(EFFECTS);
  Object.assign(picked.fields.grants.abilities[0] as Record<string, unknown>, { picked: { count: 2, withinInches: 6, limited: true }, conditional: true });
  (picked.fields.grants as Record<string, unknown>).keywords = [{ keyword: "MOBILE", to: "unit", picked: {}, conditional: true }];
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = picked)), []);
});

test("a picked grant names how many units, not none", () => {
  const picked = structuredClone(EFFECTS);
  (picked.fields.grants.abilities[0] as Record<string, unknown>).picked = { count: 0 };
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = picked)).includes(`ability:${OATH.id} facts/grants/abilities/0/picked/count must be >= 1`));
});

test("a rule can give keywords, to the unit or the bearer", () => {
  const given = structuredClone(EFFECTS);
  (given.fields.grants as Record<string, unknown>).keywords = [{ keyword: "MOBILE", to: "unit" }, { keyword: "DAEMON", to: "bearer", conditional: true }];
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)), []);
});

test("a keyword grant names a keyword in capitals", () => {
  const given = structuredClone(EFFECTS);
  (given.fields.grants as Record<string, unknown>).keywords = [{ keyword: "Mobile", to: "unit" }];
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts/grants/keywords/0/keyword must match pattern "^[^a-z]*[A-Z0-9][^a-z]*$"`));
});

test("a keyword grant goes to the bearer, the leader or the unit, never to some models", () => {
  const given = structuredClone(EFFECTS);
  (given.fields.grants as Record<string, unknown>).keywords = [{ keyword: "MOBILE", to: "models" }];
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts/grants/keywords/0/to must be equal to one of the allowed values`));
});

test("a keyword grant names only the fields the format lists", () => {
  const given = structuredClone(EFFECTS);
  (given.fields.grants as Record<string, unknown>).keywords = [{ keyword: "MOBILE", to: "unit", named: true }];
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts/grants/keywords/0 must NOT have additional properties`));
});

test("an effect can change Wounds, regain wounds, cap mortal wounds and re-roll saves", () => {
  const more = structuredClone(EFFECTS);
  Object.assign(more.fields.combat.readings[0]!.choices![0]!.effects[0] as Record<string, unknown>, {
    wounds: 1,
    regainWounds: { dice: 1, sides: 3, bonus: 0 },
    rolls: { hitModifier: 1, saveReroll: "ones", singleRerolls: ["save"] },
    mortalWounds: { timing: "outside-attacks", rolls: 3, max: 3, outcomes: [{ min: 4, max: 6, damage: { dice: 0, sides: 6, bonus: 1 } }] },
  });
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = more)), []);
});

test("mortal wounds can roll one die per point of a model's Toughness", () => {
  const more = structuredClone(EFFECTS);
  Object.assign(more.fields.combat.readings[0]!.choices![0]!.effects[0] as Record<string, unknown>, {
    mortalWounds: { timing: "before", rolls: 1, perToughness: true, max: 6, outcomes: [{ min: 5, max: 6, damage: { dice: 0, sides: 6, bonus: 1 } }] },
  });
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = more)), []);
});

test("an allowance for a kind of option names exactly one way it widens it", () => {
  const options = (allowance: object) => ({ format: "vs-data-facts", version: "1", fields: { options: { offered: ["Orders"], allowances: [allowance] } } });
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = options({ options: "Orders", limit: 2, whileLeading: true }))), []);
  assert.deepEqual(
    errors((_, recs) => (data(recs, "ability", OATH.id).facts = options({ options: "Orders", limit: 2, extra: 1 }))),
    [`ability:${OATH.id} facts/options/allowances/0 must match exactly one schema in oneOf`, `ability:${OATH.id} facts/options must match "else" schema`],
  );
});

const effect = (fields: Record<string, unknown>) => {
  const changed = structuredClone(EFFECTS);
  Object.assign(changed.fields.combat.readings[0]!.choices![0]!.effects[0] as Record<string, unknown>, fields);
  return changed;
};
const withEffect = (fields: Record<string, unknown>) => errors((_, recs) => (data(recs, "ability", OATH.id).facts = effect(fields)));

test("an effect can change a weapon's Range", () => {
  assert.deepEqual(withEffect({ attacks: ["ranged"], characteristic: { name: "range", add: 6 } }), []);
});

test("an effect can set a weapon characteristic to dice", () => {
  assert.deepEqual(withEffect({ characteristic: { name: "damage", set: { dice: 1, sides: 3, bonus: 1 } } }), []);
});

test("an effect can multiply a weapon characteristic", () => {
  assert.deepEqual(withEffect({ characteristic: { name: "attacks", multiply: 2 } }), []);
});

test("a weapon characteristic is multiplied by at least 2", () => {
  assert.ok(withEffect({ characteristic: { name: "attacks", multiply: 1 } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic/multiply must be >= 2`));
});

test("a weapon characteristic changes one way at a time", () => {
  assert.ok(withEffect({ characteristic: { name: "attacks", add: 1, multiply: 2 } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic must match exactly one schema in oneOf`));
});

test("an effect can remove a weapon ability", () => {
  assert.deepEqual(withEffect({ lostWeaponAbility: "HAZARDOUS" }), []);
});

test("an effect does not give and remove the same weapon ability", () => {
  assert.ok(withEffect({ weaponAbility: "HAZARDOUS", lostWeaponAbility: "HAZARDOUS" }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0 gives and removes HAZARDOUS`));
});

test("an effect does not apply to weapons both with and without one weapon ability", () => {
  assert.ok(withEffect({ weaponHas: "PSYCHIC", weaponLacks: "PSYCHIC" }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0 applies to weapons with and without PSYCHIC`));
});

test("only Attacks and Damage take dice", () => {
  assert.ok(withEffect({ attacks: ["ranged"], characteristic: { name: "range", set: { dice: 1, sides: 6, bonus: 0 } } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic/set must be integer`));
});

test("only Attacks and Damage are multiplied", () => {
  assert.ok(withEffect({ characteristic: { name: "armour-penetration", multiply: 2 } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic must NOT be valid`));
});

test("an effect can set a unit characteristic", () => {
  assert.deepEqual(withEffect({ unitStat: { kind: "toughness", set: 11 } }), []);
});

test("Toughness and Wounds are added to by their own effect fields, not unitStat", () => {
  assert.ok(withEffect({ unitStat: { kind: "wounds", add: 1 } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/unitStat must have required property 'set'`));
});

test("a set unit characteristic stays within what a profile prints", () => {
  assert.ok(withEffect({ unitStat: { kind: "toughness", set: 0 } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/unitStat/set must be >= 1`));
});

test("an invulnerable save can hold against ranged or melee attacks only", () => {
  const qualified = { ...EFFECTS, fields: { ...EFFECTS.fields, invulnerableSave: { roll: 5, against: "ranged" } } };
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = qualified)), []);
});

const GIVEN_WEAPON = {
  weapon: "Ember Brand",
  profiles: [{ range: "melee", attacks: 6, skill: 2, strength: 7, armourPenetration: -3, damage: "D3+1", keywords: ["Lethal Hits"] }],
};

test("an Enhancement can state the weapon it gives", () => {
  const given = { ...ENHANCEMENT, fields: { ...ENHANCEMENT.fields, upgradesWeapon: true, givenWeapon: GIVEN_WEAPON } };
  assert.deepEqual(errors((_, recs) => Object.assign(data(recs, "ability", OATH.id), { ruleType: "enhancement", facts: given })), []);
});

test("a rule that states the weapon it gives says it gives one", () => {
  const given = { ...EFFECTS, fields: { ...EFFECTS.fields, givenWeapon: GIVEN_WEAPON } };
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts must have property upgradesWeapon when property givenWeapon is present`));
});

test("a given weapon with several profiles names each one's mode", () => {
  const twice = { ...GIVEN_WEAPON, profiles: [GIVEN_WEAPON.profiles[0]!, GIVEN_WEAPON.profiles[0]!] };
  const given = { ...EFFECTS, fields: { ...EFFECTS.fields, upgradesWeapon: true, givenWeapon: twice } };
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts/givenWeapon/profiles/0 must have required property 'mode'`));
});

test("a given weapon's profile states every weapon characteristic", () => {
  const { damage: _, ...short } = GIVEN_WEAPON.profiles[0]!;
  const given = { ...EFFECTS, fields: { ...EFFECTS.fields, upgradesWeapon: true, givenWeapon: { ...GIVEN_WEAPON, profiles: [short] } } };
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts/givenWeapon/profiles/0 must have required property 'damage'`));
});

const WARGEAR = { kind: "wargear", id: "synthetic.ember-guard.ember-shield" };
const asWargearRule = (id: Release, recs: CatalogueRecord[], referenced = true) => {
  id.entries.push({ kind: "wargear", id: WARGEAR.id, name: "Ember Shield" } as never);
  const entry = id.entries.find((e) => e.id === OATH.id)!;
  if (referenced) entry.references = [...(entry.references ?? []), WARGEAR];
  Object.assign(data(recs, "ability", OATH.id), { ruleType: "unit-ability", wargear: [WARGEAR] });
};

test("a unit ability can name the wargear it is the rule of", () => {
  assert.deepEqual(errors((id, recs) => asWargearRule(id, recs)), []);
});

test("the wargear a rule names is a reference of its identity entry", () => {
  assert.deepEqual(errors((id, recs) => asWargearRule(id, recs, false)), [`ability:${OATH.id} names wargear:${WARGEAR.id} but its identity entry does not reference it`]);
});

test("only a unit ability names wargear", () => {
  assert.ok(
    errors((id, recs) => {
      asWargearRule(id, recs);
      data(recs, "ability", OATH.id).ruleType = "army-rule";
    }).includes(`ability:${OATH.id} names wargear but is not a unit ability`),
  );
});

test("an effect can apply only to weapons without a weapon ability", () => {
  assert.deepEqual(withEffect({ weaponLacks: "PSYCHIC" }), []);
});

test("a single given weapon profile has no mode", () => {
  const given = { ...EFFECTS, fields: { ...EFFECTS.fields, upgradesWeapon: true, givenWeapon: { ...GIVEN_WEAPON, profiles: [{ ...GIVEN_WEAPON.profiles[0]!, mode: "strike" }] } } };
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)).includes(`ability:${OATH.id} facts/givenWeapon/profiles/0 must NOT be valid`));
});

test("a given weapon's modes are distinct", () => {
  const twice = { ...GIVEN_WEAPON, profiles: [{ ...GIVEN_WEAPON.profiles[0]!, mode: "strike" }, { ...GIVEN_WEAPON.profiles[0]!, mode: "strike" }] };
  const given = { ...EFFECTS, fields: { ...EFFECTS.fields, upgradesWeapon: true, givenWeapon: twice } };
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = given)), [`ability:${OATH.id} facts/givenWeapon names the mode strike twice`]);
});

test("an effect on weapons without a weapon ability does not give or remove it", () => {
  assert.ok(withEffect({ weaponLacks: "HAZARDOUS", lostWeaponAbility: "HAZARDOUS" }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0 changes HAZARDOUS on weapons without it`));
});

test("a Range set is at least 1", () => {
  assert.ok(withEffect({ attacks: ["ranged"], characteristic: { name: "range", set: -6 } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic/set must be >= 1`));
});

test("an addition to a weapon characteristic can scale with the models counted", () => {
  assert.deepEqual(withEffect({ characteristic: { name: "strength", add: 1, per: { models: 5, in: ["unit", "embarked"] } } }), []);
});

test("an addition to a unit characteristic can scale with the models counted", () => {
  assert.deepEqual(withEffect({ unitStat: { kind: "objective-control", add: 1, per: { models: 3, in: ["embarked"] } } }), []);
});

test("only an addition scales with the models counted", () => {
  assert.ok(withEffect({ characteristic: { name: "attacks", set: 2, per: { models: 5, in: ["unit"] } } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic must have property add when property per is present`));
});

test("a scaling addition counts at least 2 models", () => {
  assert.ok(withEffect({ characteristic: { name: "strength", add: 1, per: { models: 1, in: ["unit"] } } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic/per/models must be >= 2`));
});

test("a scaling addition is a whole number, never dice", () => {
  assert.ok(withEffect({ characteristic: { name: "attacks", add: { dice: 1, sides: 3, bonus: 0 }, per: { models: 5, in: ["unit"] } } }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0/characteristic/add must be integer`));
});

test("a defender's effect can hold only against attacks by models of a keyword", () => {
  const defender = structuredClone(EFFECTS);
  defender.fields.combat.readings[0]!.choices![0]!.effects[0] = { role: "defender", attacks: ["ranged", "melee"], attackerKeywords: ["DAEMON"], invulnerable: 4 } as never;
  assert.deepEqual(errors((_, recs) => (data(recs, "ability", OATH.id).facts = defender)), []);
});

test("only a defender's effect names the attacking models' keywords", () => {
  assert.ok(withEffect({ attackerKeywords: ["DAEMON"] }).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0 must NOT be valid`));
});

test("a Feel No Pain against Psychic Attacks is stated as psychicFeelNoPain", () => {
  const defender = structuredClone(EFFECTS);
  defender.fields.combat.readings[0]!.choices![0]!.effects[0] = { role: "defender", attacks: ["ranged", "melee"], weaponHas: "PSYCHIC", feelNoPain: 5 } as never;
  assert.ok(errors((_, recs) => (data(recs, "ability", OATH.id).facts = defender)).includes(`ability:${OATH.id} facts/combat/readings/0/choices/0/effects/0 states a Feel No Pain against Psychic Attacks as feelNoPain`));
});
