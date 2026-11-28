# Roster definitions

Roster definitions say how a list is built: which models a unit fields, what wargear it may take, which enhancements a detachment offers and to whom, and how many copies of a unit a roster may hold. A unit also carries datasheet facts no list check reads: its Legends and Crucible marks and its core abilities. They are the `data` of the roster category's records in a [catalogue release](catalogue-releases.md), one record per [identity](catalogue-identity.md) entry. The contract is [src/roster-definitions/definitions.v2.schema.json](../src/roster-definitions/definitions.v2.schema.json) plus the rules below, and `src/roster-definitions/` is a reference implementation of both.

Points are not definitions. Prices stay in [points snapshots](points.md), which join to definitions by the same catalogue IDs.

## Format versions

Every record's `data` carries `"formatVersion": 2`. Records without it are format version 1, described by [definitions.v1.schema.json](../src/roster-definitions/definitions.v1.schema.json), and all the records of one rules version use one version. Version 1 names wargear as lists, so it cannot say that a model carries two of an item or that an option replaces both. Version 2 counts them, and adds conditions, shared roster limits, compositions, substitutes and scaled option groups. `validateDefinitions` reads a version 1 list as a count of one of each item, which is what it meant, a version 1 `upgrade` as one three units may take, which version 2 states as `perRoster`, and a version 1 enhancement's `keywords` as its `eligibility`, so the checker, importer and points joins below treat both versions alike.

## Records

| Kind | `data` | Meaning |
| --- | --- | --- |
| `faction` | optional `unitLimits`, `parent`, `excludedUnits`, `excludedDetachments`, `withoutDetachments`, `allies` | The faction exists in this rules version. Each of `unitLimits` bounds how many units holding all its `keywords`, or matching one of its `anyOf` alternatives, a roster of the faction holds. A roster of the faction may also take the detachments and units of its `parent`, which has no parent of its own, but none of its `excludedUnits` or `excludedDetachments`. A faction with `withoutDetachments` takes no detachment at all, as when an army's own rules replace detachment selection: its roster's warlord must be one of `withoutDetachments.warlords`, which may hold the role though they otherwise could not, and `withoutDetachments.dispositions` are the [mission-pack](mission-packs.md) force dispositions its rosters have, where the faction names any. `allies` are described under [Allies](#allies). |
| `battle-size` | `points`, optional `detachmentPoints`, `enhancements`, `duplicates` | A battle size a roster can be built for, its points limit, the most detachment points its detachments cost together, the most enhancements it takes, counting only each enhancement's first copy and no `outsideLimit` enhancement, and how many copies of a unit it holds when the unit has no `perRoster` or limit for that battle size. |
| `detachment` | `faction`, optional `stratagems` and `enhancements`, with optional `stratagemsUnlisted` and `enhancementsUnlisted`, optional `dispositions`, `excludedUnits`, `warlords`, `requiredWarlords`, `group`, `exclusiveEnhancements`, `allegianceLimits` | The faction the detachment belongs to and, where listed, every Stratagem and Enhancement this rules version gives it: `stratagems` and `enhancements` name [rule summary](rule-summaries.md) records the release publishes (kind `ability`), and the `Unlisted` fields name, as printed, the cards the version has no record for. A record with the lists is complete for that version, so a consumer takes no card from another version. `dispositions` are the [mission-pack](mission-packs.md) force dispositions it has. A roster with the detachment holds none of its `excludedUnits`, may name a model in `warlords` as its warlord though it otherwise could not, and must name one of `requiredWarlords`. Two of a roster's detachments never share a `group`. While the roster holds the detachment, a unit holding every one of `exclusiveEnhancements.keywords` among its own and conditional keywords (not its models') takes only this detachment's enhancements, upgrades included. Each of `allegianceLimits` bounds, by `min` and `max`, how many of the roster's units take one of its `allegiances`. |
| `enhancement` | `detachment`, `eligibility`, optional `upgrade`, `perRoster`, `outsideLimit` | Offered by that detachment to the units `eligibility` admits, described under [Enhancement eligibility](#enhancement-eligibility). It may be taken once per roster, or by up to `perRoster` units; `upgrade` marks a unit upgrade, as the rule facts' `type` does, and changes nothing the checker reads. An `outsideLimit` enhancement does not count towards the battle size's `enhancements`. Both are the Enhancement's [rule facts](rule-facts.md) as they stand, so a missing `perRoster` means once, an upgrade's included. |
| `unit` | `faction`, `keywords`, `sizes`, optional `factionKeywords`, `allegiances`, `conditionalKeywords`, `compositions`, `modelGroups`, `optionGroups`, `uniformOptions`, `perRoster`, `limits`, `legends`, `crucible`, `coreAbilities`, `enhancements: false`, `wargear`, `defaults`, `defaultModels` | `sizes` lists every model count the unit may field. `keywords` are those all its models hold, in capitals and the app build's spelling where it has one; a keyword only some models hold is in those models' `keywords`, except in a datasheet copied from BSData, whose `keywords` are all BSData gives the unit. A datasheet the app build prints has its name among its `keywords` where no model holds it, as rules key on it, such as TECHMARINE and RHINO; a short form the name does not spell, such as LIEUTENANT for the Lieutenant in Phobos Armour, is there only where the build prints it. A datasheet from a Legends PDF the app build does not carry has the keywords that sheet prints. `factionKeywords` are those of its `keywords` the datasheet prints as faction keywords, such as ADEPTUS ASTARTES; they count wherever `keywords` do. `wargear` counts what the unit carries that none of its models does, such as a support turret, and options without a `carrier` may replace it. `modelGroups` bounds the sum of counts of its named model IDs, and `optionGroups` the selections several of its options take together. `uniformOptions` ties `uniform` options of different carriers together, below. `perRoster` caps its copies, and the first of `limits` for the roster's `battleSize` whose condition holds replaces it. A `perRoster` of 0 means no roster may hold the unit, as when it enters play only through another unit's rule. `legends: true` marks a Warhammer Legends datasheet, and `crucible: true` a datasheet printed in the Crucible of Champions book; `checkRoster` reads neither. `coreAbilities` are its datasheet's [core abilities](#core-abilities). `enhancements: false` bars a unit that the keyword rules would otherwise admit. |
| `model` | `unit`, `min`, `max`, `wargear`, optional `bySize`, `keywords` and `warlord: false` | A kind of model in the unit, how many of it the unit fields, and how many of each wargear ID each one carries by default, as `{ <wargear ID>: count }`. Its `keywords` are those it has beyond its unit's, as when a squad's leader is a Character: they count for that model holding the warlord role or bearing an enhancement, never for limits that count units. A `bySize` row gives its bounds at one total squad size. `warlord: false` keeps it from the warlord role, as when its datasheet says it cannot be the Warlord, unless a detachment's `warlords` or the faction's `withoutDetachments.warlords` lists it. |
| `roster-option` | `unit`, optional `carrier`, `choose`, optional `per`, `bySize`, `uniform`, `substitutes`, `replaces`, `caps`, `requires`, and `choices` | Wargear the unit may take. Each selection takes one of `choices`, which are wargear IDs, instead of the counts of wargear in `replaces`. |
| `wargear` | optional `includes` | A piece of wargear, or a bundle holding the counts of wargear in `includes`, at least two items in all. |
| `allegiance` | nothing besides `formatVersion` | A choice a unit takes in a roster, as described under [Allegiances](#allegiances), named by its identity entry. |

A model that carries two lascannons has `"wargear": { "<lascannon>": 2 }`. An option replacing both has `"replaces": { "<lascannon>": 2 }`, and a choice giving two heavy bolters for them is a bundle with `"includes": { "<heavy bolter>": 2 }`. An option replacing one lascannon at a time takes up to two selections per carrier instead.

An option without `replaces` adds its choice to the carrier's wargear. With a `choose.min` above zero it is a choice every carrier must make, as when a model carries no default weapon in one slot.

An option takes between `choose.min` and `choose.max` selections, scaled by `per`:

| `per` | Bounds |
| --- | --- |
| absent | Once for the unit, or not at all when the unit fields none of its `carrier`. |
| `"carrier"` | Once for each `carrier` model, as when every model may swap a weapon. |
| `{ "models": n }` | Once for every `n` models in the unit, as when one model in five may take a heavy weapon. |

A `uniform` option is all or nothing: the unit takes none of it, or takes its full scaled maximum of one choice, as when every model may swap the same weapon but the squad must match. Its `substitutes` are choices some models may take instead: the selections of its other choices are then either none or one choice taken by every carrier that takes no substitute, so the full scaled maximum counts the substitutes too. A cap usually limits the substitutes.

A unit's `uniformOptions` entries each list `uniform` options of different carriers that make the choice together, as when a sergeant and the squad must all carry the same weapon. The entry's options that can take a selection at the unit's size, and whose carriers did not all take a substitute, either all take none of their choices besides substitutes or all take the same one. Each option is still all or nothing by itself.

Each of an option's `caps` limits how many of its `choices` the option takes together, to `max` scaled by the cap's own `per`. A cap of 1 per carrier lets each model take any two of three wargear but never two of the same. A cap without `per` holds for the whole unit, as when only one model in a fixed squad may carry a particular weapon.

A model or option can specify `bySize: [{ size, min, max }]` for sizes with their own bounds. Use the total model count in the unit as `size`. A cap can specify `bySize: [{ size, max }]`. The listed values are absolute for that size. Other sizes use the regular bounds and scaling. An option with no carriers still takes zero selections.

A unit's `modelGroups` entries give `models`, `min`, `max` and optional `bySize`. The bound applies to the sum across its member IDs, for example when multiple equipment configurations fill the same kind of slot. Individual model bounds and the unit's total remain in force.

A unit's `optionGroups` entries give `options` and `max`, and optionally `min`, `per`, `carrier` and `bySize`. Each member names an `option` of the unit and, optionally, the `choices` of it that count and a `weight` each of their selections counts for, as when a choice of two shrine tokens uses up two of a limit on tokens. One option may be named by several members with different choices. The group holds at least `min` and at most `max` of those selections, both scaled by `per` like a cap, as when two options draw on one slot or offer the same weapon, or one model in three may take either of two weapons. A group scaled `"carrier"` names its `carrier` model, as when swaps on the same models exclude each other. A `bySize` row gives the group's absolute maximum at one size. A `min` makes the unit fill the group, as when a walker must carry at least two heavy weapons from several options. Only selections the roster lists count, so wargear a unit keeps by default never fills a group.

A unit's `compositions` are the ways it may field its models when model bounds alone would admit more, as when six models are either three and three or six and none. Each composition maps model IDs to `min` and `max`, and a model it omits fields none. The model counts must fit one composition as well as the models' own bounds and the unit's `sizes`.

An option with `requires` is closed until the unit takes one of `requires.choices` from the option `requires.option`, as when a character may take a relic only after swapping its default weapon. `requires` may instead list several such requirements, and the option opens only once every one holds, as when a weapon choice appears only after two earlier swaps.

A unit's `defaults` and `defaultModels` state how it is first fielded, where its models alone cannot. `defaults` are selections in a saved roster unit's `options` shape, `{ <option ID>: { <wargear ID>: count } }`, given where models of one kind start with different wargear, as when one model in four carries a venom bolt: each model's `wargear` is then what those models start from, and the selections make up the rest. `defaultModels` gives model counts by model ID where the first fielding differs from the models' `min`, as when those minimums sum to less than the smallest size; a model it omits fields its `min`. Neither changes what a saved roster means: a roster lists every selection it takes, the defaults among them.

## Core abilities

A unit's `coreAbilities` list the core abilities its datasheet gives it, as `{ "ability": id }` with the value the ability takes, if any, and `models` where the datasheet gives it only to those of the unit's models. `ability` is one of the fixed list below, each naming the `core-ability` entry with the same ID; it is not a reference, and Firing Deck is not among them.

| `ability` | Value |
| --- | --- |
| `feel-no-pain` | `threshold`, the roll from 2 to 6: `5` means Feel No Pain 5+. |
| `scouts` | `inches`. |
| `lone-operative` | `inches` where the datasheet prints a distance, as Lone Operative 15"; without it, the core rule's own distance. |
| `deadly-demise` | `mortalWounds`, a positive integer or dice, as `D3` or `2D6+6`. |
| `damaged` | `wounds`, the remaining wounds at or below which a model is damaged: `5` means Damaged 5. |
| `deep-strike`, `fights-first`, `hover`, `infiltrators`, `leader`, `stealth`, `super-heavy-walker`, `support` | None. |

An empty list means the datasheet gives the unit no core ability, and a unit without `coreAbilities` has none recorded. A Firing Deck is its [transport profile](datasheet-profiles.md#transport-capacity)'s `firingDeck`. A datasheet's own Damaged rule, such as "DAMAGED: 1-9 WOUNDS REMAINING", is its `unit-ability` [rule summary](rule-summaries.md), not `damaged`. `leader` and `support` record only that the datasheet prints the ability; its attachment profile decides which units it joins. A core ability another rule grants, such as a Detachment rule or an Enhancement, is in that rule's [rule facts](rule-facts.md). `checkRoster` does not read `coreAbilities`.

## Conditions

A `when` holds for a roster whose `faction` is the one it names, one of whose detachments is its `detachment`, and whose units name its `warlord` model as their warlord. Its `allegiance` and `wargear` hold only in a unit's `conditionalKeywords`, for a unit that took that allegiance or carries at least one of that wargear, counting its models' and its own wargear as the options it takes change them, and the contents of bundles, never in a condition on the roster such as a row of `limits`. Each field it omits holds for any roster. A unit's `conditionalKeywords` entries give `keywords` the unit holds where their `when` holds, as when a unit is BATTLELINE in one detachment or a character on a bike is MOUNTED, and a row of its `limits` with a `when` applies only where that holds. An entry's `replaces` are keywords of the unit's own `keywords` it no longer holds there, as when a jump pack makes a character JUMP PACK and FLY or Gravis armour makes it GRAVIS in place of TACTICUS; a keyword another such entry gives it still holds. Conditional keywords, and the keywords they replace, count for enhancements, a faction's `unitLimits`, an ally entry's `limits` and the warlord's CHARACTER keyword.

A faction's `unitLimits` entries give `keywords` and optional `min` and `max`: a roster of that faction holds between `min` and `max` units with all those keywords. An entry with `anyOf` names alternatives instead, each a list of keywords: it counts the units holding all the keywords of any one of them, as when a roster holds only one of a character's two datasheets, and with `exclusive: true` the units it counts must all fit one alternative, as when a rule bars one kind of unit from an army that includes another; a unit that fits several fits each of them. No alternative lies within another. Its `keywords` then list every keyword its alternatives name, so a reader that does not know `anyOf` counts only units holding all of them, which the entry counts too: it is never stricter than the entry, provided the entry and its `detachments` rows give no `min`, which they never do. A row of `detachments` names a `detachment` of the faction and its own optional `min` and `max`, which replace the entry's in a roster with that detachment, the first such row where it has several, so a row with neither lifts the limit there; on an entry with `anyOf`, a row never lifts `exclusive`.

A model loadout that a source writes as separate model entries, one per weapon, is one `model` with a `roster-option` per carrier whose choices are the loadouts as wargear.

## Allies

A faction's `allies` entries let its roster hold units beyond its own and its parent's. Each entry offers `units`, and may name:

| Field | Meaning |
| --- | --- |
| `detachments` | The roster holds the units only while one of its detachments is one of these. |
| `points` | `[{ battleSize, max }]`: the units together cost at most `max` points at that battle size, counting their wargear and enhancements. |
| `limits` | `[{ keywords, battleSize, max, free }]`: at most `max` of the units holding every keyword. Each optional `free` row `{ keywords, per }` stops a unit holding its `keywords` from counting, one for each unit in the roster holding every `per` keyword. |
| `oneLimit` | `true`: the roster takes units under one of the keyword sets of the entry's `limits` for its battle size only. A roster without a battle size has no such limits. |
| `enhancements` | `true`: the units may take the roster's enhancements. Otherwise they may not. |

A unit belongs to the first entry that offers it and whose `detachments`, if any, include one of the roster's. That entry's `points`, `limits` and `enhancements` then apply to it, and count only the units that belong to it. An entry may offer the faction's own or its parent's units, as when some of a faction's units are only allowed with one detachment and under a points cap; those units then follow the entry. A unit that no entry offers is legal when it belongs to the roster's faction or its parent and neither the faction nor one of the roster's detachments excludes it.

A roster's warlord is a fielded model holding the `CHARACTER` keyword, its own or its unit's, matched regardless of letter case, that belongs to the roster's faction or its parent and to no ally entry and has no `warlord: false`, or a model one of its detachments lists in `warlords` or, for a faction `withoutDetachments`, its `warlords` lists. Each detachment's `requiredWarlords` narrows that choice.

## Enhancement eligibility

An enhancement's `eligibility` admits a unit with a fielded model whose keywords, its unit's and its own, match it, in any letter case:

| Field | Meaning |
| --- | --- |
| `anyOf` | The model matches one entry: it holds every one of the entry's `keywords`, and its unit is the entry's `unit` where the entry names one. |
| `excludedKeywords` | The model holds none of these. |
| `nonCharacters` | `true`: the model need not hold CHARACTER. Otherwise it must. |
| `epicHeroes` | `true`: the model may hold EPIC HERO. Otherwise it may not. |
| `requiredWargear` | The unit carries at least one of these wargear IDs, counting its models' and its own wargear as the options it takes change them, and the contents of bundles. |
| `notWarlord` | `true`: the unit does not hold the warlord. |

A unit with `enhancements: false` is never admitted. These are the Enhancement's [rule facts](rule-facts.md) eligibility with catalogue IDs: an entry's `factionKeywords` are among its `keywords`, and `requiredWargear` lists every wargear ID of the one item the facts name. Version 1 states eligibility as `keywords.all`, every one of which the model holds, and `keywords.none`, none of which it holds, with no CHARACTER or EPIC HERO rule beside them; `validateDefinitions` reads them as that `eligibility`, so they too match in any letter case.

## Allegiances

A unit's `allegiances` entries offer it a choice of one of `choices`, which are `allegiance` IDs. An entry with a `detachment` applies only in a roster with that detachment, and a `required` one means the unit must take one of its choices. `requires` maps a choice to a wargear ID the unit must carry to take it, counting its models' and its own wargear as the options it takes change them, and the contents of bundles. A conditional keyword whose `when` names an allegiance gives the unit its keywords once it takes that allegiance.

## Validation

`validateDefinitions(identity, records)` checks the identity release, each record's `data` against its kind, and these rules, which the schema cannot express:

- Every record uses the identity release's rules version, its entry is current, and an entry has at most one record.
- Every ID a record's data names has a record of the right kind and appears in the identity entry's `references`, so a release's `dependsOn` and `unresolvedReferences` see every join. A detachment's `dispositions` and a faction's `withoutDetachments.dispositions` are mission-pack members, outside this check.
- Every ID in a detachment's `stratagems` and `enhancements` is a current `ability` entry that the detachment's identity entry references.
- Every unit has at least one model, and every size lies between its models' summed minimums and maximums at that size.
- Every shared model group includes at least two distinct models that belong to its unit.
- Every option group names only options of its own unit, with only choices those options offer, and no choice of an option twice. A group of format version 1 names at least two options.
- A model's `keywords` are none of its unit's own `keywords`.
- A unit's `factionKeywords` are all among its `keywords`.
- A unit's `coreAbilities` name only its own models, and give no model one core ability twice.
- A model's `min` is no more than its `max`, an option's `choose.min` no more than its `choose.max`, and an option group's `min` no more than its `max`.
- An option's carrier belongs to its unit. It replaces no more of an item than one of its carriers carries, or for an option without one, than a model or the unit itself carries, and does not offer what it replaces.
- An option caps only wargear it offers. Each of its requirements names another option of the same unit and choices that option offers, and an option with requirements has no minimum.
- An option with `substitutes` is `uniform`, offers them, and offers a choice besides them.
- Every option a unit's `uniformOptions` entry names belongs to that unit, is `uniform`, has a carrier no other option of the entry has, and offers the same choices besides its substitutes as the others. No option is in two entries.
- An option group scaled per carrier names a carrier of its unit, and only such a group names one.
- Every composition names only its unit's models, and every unit size fits at least one composition.
- A unit sets at most one limit per battle size and condition, and no limit after one without a condition for the same battle size, which would never apply. Each list of `bySize` bounds has at most one row per size and uses the unit's declared sizes.
- A faction's unit limits name only its own or its parent's detachments, each once, and no `min` above its `max`. Its ally entries' `detachments` are its own or its parent's.
- A detachment's allegiance limits have no `min` above their `max`.
- A faction's `parent` is another faction with no parent of its own. Its `excludedDetachments` are its parent's detachments, and a faction `withoutDetachments` has, like its parent, no detachments of its own.
- A unit's allegiance `requires` and the `wargear` its conditional keywords name only choices of its own entry and wargear the unit's models, the unit itself or its options carry, and no `when` in its `limits` names an allegiance or wargear. A conditional keyword `replaces` only keywords among the unit's own `keywords`.
- A wargear bundle includes at least two items and does not include itself, directly or through another bundle.
- A unit's `defaults` and `defaultModels`, taken as one roster unit, are a fielding `checkRoster` accepts, apart from limits on how many units a roster holds.

## MFM 1.6

The [MFM 1.6 input](../data/mfm-1-6/rule-summaries/README.md) includes the `rosters` category in format version 2, built from the official app's data build: factions, battle sizes, Detachments, and every datasheet outside Combat Patrol as one unit, modelled once rather than once per Space Marine chapter. Every wargear option the app allows is stated exactly. A unit's `aliases` are the BSData entry IDs of the datasheets it stands for (`bsdata.<entry ID with dots>`), so lists saved against BSData IDs resolve. Warhammer Legends datasheets the app does not carry are typed from Games Workshop's Legends PDFs where their text states the loadout exactly; the README lists the rest. Enhancement eligibility is in each Enhancement's [rule facts](rule-facts.md).

## Earlier rules versions

Each earlier 11th-edition input of a current release line (`data/<version>/rule-summaries/`; not the retired Custodes codex line) includes the same `rosters` category, built from the app build in force at that update's cutoff and the Legends documents dated before it. A unit keeps the ID it has in MFM 1.6, and lists the BSData entry IDs of the datasheets Praetorium compiled for that update among its aliases.

## Saved rosters

A saved roster names a `faction`, one to three detachments as `detachment`, `detachments`, or both, which it then holds together, an optional `battleSize`, and its `units`. Each unit gives its `unit` ID, its model counts by model ID, its taken wargear as `{ <option ID>: { <wargear ID>: count } }`, an optional `enhancement` and `allegiance`, and, for the warlord's unit, the warlord's model ID as `warlord`. A unit holds at most one enhancement, an upgrade included, so `enhancement` is a single ID. An omitted model count uses its base `min`. The checker then applies the bounds for the sum of those counts. Wargear a unit keeps by default is not listed.

`checkRoster(definitions, roster, { points })` checks the constraints this format supports. The optional [points snapshot](points.md) prices the roster for the points checks: a unit costs its size (the row its models' `mix` picks where rows of that size differ by the models they hold), its enhancement, and each priced item it carries, which counts its models' and its own wargear and the contents of a bundle it takes, less what its selections replace, never below zero per item. A bundle costs only its contents, never a row of its own. Wargear the snapshot does not price costs nothing; a unit size, detachment or enhancement it does not price also costs nothing, and `pointsGaps` below lists those. It reports problems in roster order, each with a `code`, the unit's position, and a message:

| Code | Problem |
| --- | --- |
| `not-current` | An ID that is aliased, retired or missing in this release. |
| `missing-definition` | A current ID with no definition in the supplied records. |
| `detachment-faction`, `unit-faction` | A detachment or unit from a faction other than the roster's or its parent, and not offered by an ally entry. |
| `detachment-count`, `detachment-repeated`, `detachment-excluded` | No detachment or more than three, or any at all for a faction `withoutDetachments`; one listed twice; or a parent's detachment the faction excludes. |
| `detachment-group` | Two detachments sharing a `group`. |
| `unit-excluded` | A unit the faction or one of the roster's detachments excludes. |
| `unit-model`, `model-count`, `unit-size` | A model, or a warlord, from another unit, a model count outside its bounds, or a total outside `sizes`. |
| `model-group-count`, `unit-composition` | The named models' combined count is outside their shared bounds, or the model counts fit none of the unit's compositions. |
| `unit-option`, `option-choice`, `option-count`, `option-uniform` | An option from another unit, wargear the option does not offer, a selection count outside its scaled bounds, a `uniform` option split between choices besides its substitutes or short of its maximum, or the options of a `uniformOptions` entry making different choices. |
| `option-cap`, `option-unavailable` | More of some choices than a cap allows, or an option taken before a choice it `requires`. |
| `option-group-count` | Fewer selections across an option group's members than its scaled `min`, or more than its `max`. |
| `option-quantity` | A wargear choice with a negative, fractional or invalid count. |
| `enhancement-detachment`, `enhancement-keywords`, `enhancement-repeated` | An enhancement from a detachment the roster does not have, on a unit its `eligibility` does not admit, or taken more often than its `perRoster`, or, without one, twice. |
| `enhancement-limit` | More enhancements than the battle size's `enhancements`, counting only each enhancement's first copy and no `outsideLimit` enhancement. |
| `enhancement-exclusive` | An enhancement of another detachment on a unit that one of the roster's detachments keeps to its own through `exclusiveEnhancements`. |
| `roster-limit` | More copies of a unit than its limit for the roster's battle size, or `perRoster` when the roster or unit names none, or the battle size's `duplicates` when the unit has neither. |
| `ally-detachment` | A unit only ally entries offer, none of them under one of the roster's detachments. |
| `ally-points`, `ally-limit` | An ally entry's units over its `points`, over one of its `limits`, or under more than one limit of a `oneLimit` entry. |
| `ally-enhancement` | An enhancement on a unit of an ally entry without `enhancements`. |
| `unit-limit` | More or fewer units with a faction's limited keywords than the roster's faction and detachment allow. |
| `warlord-repeated` | More than one unit names a warlord. |
| `allegiance-missing`, `allegiance-choice`, `allegiance-requires` | A unit without the allegiance a `required` entry that applies needs, with one no entry that applies offers, or without the wargear its allegiance requires. |
| `allegiance-limit` | Fewer or more units with a detachment's limited allegiances than its `allegianceLimits` allow. |
| `warlord-ineligible`, `warlord-required` | A warlord that may not hold the role, or, where a detachment has `requiredWarlords` or the faction `withoutDetachments`, a warlord outside them or none at all. |
| `roster-points`, `detachment-points` | With a points snapshot, units, wargear and enhancements over the battle size's `points`, or detachments over its `detachmentPoints`. |

Before reading a roster under another release, pass `rosterRefs(roster)` to [`checkUpgrade`](catalogue-identity.md#consumer-mappings-and-upgrades). A saved roster keeps its rules version so it can be checked against those definitions.

## Imports

`importUnit(definitions, faction, printed)` reads a list's unit name, model count, and additional wargear into catalogue IDs. Names match exactly, ignoring case and surrounding space. With the optional `modelCounts` breakdown by printed model name, each model must resolve within the unit and the counts must sum to the total. With only a total, fixed models keep their count and a single variable model takes the rest, using the bounds for that unit size. Multiple variable models without a breakdown are ambiguous. The importer reports unknown or ambiguous names and mismatched counts. The caller checks legality with `checkRoster`. [Localisation](localisation.md) handles translated and historical names.

## Points joins

`pointsGaps(definitions, snapshot)` joins definitions to a points snapshot that uses the same catalogue IDs. It reports every unit size, detachment, and enhancement without a price, with the [lookup](points.md#looking-up-a-cost) reason, and every priced unit with no definition. A size whose first-copy rows all give a `mix` has a price when each mix picks its row. A unit no roster may hold needs no price.

## History

The rules in [When an ID changes](catalogue-identity.md#when-an-id-changes) apply to every kind here. The fixtures exercise the cases a roster meets:

- A renamed unit keeps its ID, so an import must use the name in the list's own rules version.
- A duplicate wargear entry becomes an alias of the one kept.
- An option split in two is retired with `replacedBy` naming both successors.
- Battle sizes, caps, an option group, and a conditional option first appear in the second release, so the first release's roster has no battle size.
- The third release is written in format version 2 and adds counted wargear, conditions, shared roster limits, compositions, a substitute, a unit no roster may hold, a parent faction, two ally entries (one of them restricting the faction's own unit), excluded units, detachment groups and warlords, battle-size limits, and allegiances.

[fixtures/roster-definitions](../fixtures/roster-definitions) holds three catalogue release inputs for an invented faction (the third adds an invented parent and allied faction), points snapshots for the second and third, and a saved roster for each. [test/roster-definitions.test.ts](../test/roster-definitions.test.ts) builds the releases, checks the history, and covers validation, legality, imports, upgrades, and points joins.
