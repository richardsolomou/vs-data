# Datasheet profiles

Datasheet profiles record what a unit's datasheet prints in its stat lines and which units it may join. They are the `data` of a profiles category in a [catalogue release](catalogue-releases.md), one record per [identity](catalogue-identity.md) entry, beside the [roster definitions](roster-definitions.md) whose units, models and wargear they name. The contract is [src/datasheet-profiles/profiles.v1.schema.json](../src/datasheet-profiles/profiles.v1.schema.json) plus the rules below, and `src/datasheet-profiles/` is a reference implementation of both.

The [example profiles](../fixtures/datasheet-profiles/README.md) show how these records join to roster definitions.

## Records

| Kind | `data` | Meaning |
| --- | --- | --- |
| `unit-profile` | `unit`, optional `models`, the unit characteristics, optional `gaps` | One stat line. With neither `models` nor a model gap, it describes every model of the unit. |
| `weapon-profile` | `unit`, `wargear`, the weapon characteristics, optional `keywords` and `gaps` | One stat line of a weapon as this unit's datasheet prints it. A weapon with several modes has one profile per mode, all naming the same `wargear`. |
| `attachment` | `unit`, optional `leads`, `supports`, `conditional`, `withAnotherLeader`, `joins`, `insteadOf`, `capacity` and `gaps` | The units this unit may join as a Leader (`leads`) or as a support attachment (`supports`) in any roster, those it may join only in some rosters (`conditional`), and the rules described under [attachment rules](#attachment-rules). |
| `transport-profile` | `unit`, `capacity` or a capacity gap, optional `firingDeck` | The transport's alternative loads, passenger allowances, exceptions and equipment-dependent capacities, and its Firing Deck. |

A stat line's ID is scoped by its unit, as in `<unit ID>.<profile>`, because two datasheets can print different stat lines for wargear with the same ID. An attachment or transport profile uses its unit's ID.

## Characteristics

| Field | Value |
| --- | --- |
| `movement` | Inches as an integer, `{ "atLeast": n }` for a move of at least `n` inches, or `null` when the datasheet prints none. |
| `toughness`, `wounds`, `strength` | A positive integer. |
| `save`, `leadership` | A roll: `3` means 3+. |
| `objectiveControl` | A non-negative integer, or `null` when the datasheet prints none. |
| `invulnerableSave` | `{ "roll": n }`, with `against: "ranged"` or `against: "melee"` when it applies only to ranged or only to melee attacks, and `conditional: true` when another rule of the datasheet says when it applies. A unit with one save against ranged and another against melee attacks has a list of two, each with its `against`. A conditional save may carry a `summary` of when it applies, such as `Only while this model is within 6″ of an objective marker.`, in the [summary grammar](rule-summaries.md#summary-text) without links. |
| `baseSize` | The base each model stands on, described [below](#base-sizes). |
| `range` | Inches as a positive integer, or `"melee"`. |
| `attacks`, `damage` | A positive integer, or dice written as `D6`, `2D3` or `D6+1`. |
| `skill` | The ballistic or weapon skill as a roll, or `null` when the weapon makes no hit roll. |
| `armourPenetration` | Zero or a negative integer. |
| `keywords` | Weapon keywords in capitals, one per item, including any parameter such as `RAPID FIRE 1`. A printed lower-case qualifier stays lower case (`ANTI-non-MONSTER/VEHICLE 2+`). A keyword is a name, never rules text. |

Unit profiles must state `movement`, `toughness`, `save`, `wounds`, `leadership` and `objectiveControl`, and weapon profiles `wargear`, `range`, `attacks`, `skill`, `strength`, `armourPenetration` and `damage`, unless a gap names the field.

## Conditional attachments

Each `conditional` entry gives a `role`, `leads` or `supports`, and names its targets: the units in `units` and any unit holding every keyword in `keywords` and none in its optional `excludedKeywords`, which needs `keywords`. `excludedKeywords` narrows an entry, so a reader must apply it rather than skip it. An entry has `units`, `keywords` or both. It applies where the roster meets its optional `when` and both units hold its optional `shared` keyword. A `when` holds for a roster of its `faction` that includes its `detachment` and its `withUnit`, and includes neither its `withoutDetachment` nor its `withoutUnit`. Each field it omits holds for any roster. Keywords are written in capitals, as printed.

`canAttach(attachment, role, target, context)` answers whether the attachment's unit may join `target` in `role`. The optional `context` gives the roster's `faction` ID, its `detachments` and `units` as lists of IDs, and `keywords`, each unit's keywords by unit ID (a unit holds every keyword its models hold), compared ignoring case. A field it omits is empty: a roster of no faction with no detachments, units or keywords.

## Attachment rules

By the core rules, a bodyguard unit takes one leader unit and one support unit, and each support unit in a roster must be attached to a bodyguard unit. A unit is a support unit in a roster where it has `supports` or a `supports` entry of `conditional` whose `when` holds there, whether or not a unit it supports is in the roster. A unit may be a leader unit for some bodyguards and a support unit for others. Leading is never compulsory.

`insteadOf` lists, on a bodyguard's record, the units it may be joined in place of, as a datasheet printing "if a unit can be attached to X, it can be attached to this unit instead". A unit that may join one of an entry's `units` in a role may join this unit in that role, where the entry's optional `role` is that role, the joining unit holds every keyword in its `keywords`, and none in its `excludedKeywords`. "With the Leader ability" is `role: "leads"`; a rule naming the joining units by keyword, such as "a CHARACTER unit" or "a CHAPLAIN model", gives that keyword; one naming two, such as "a CAPTAIN or CHAPTER MASTER unit", is an entry for each. A unit one stands in for may itself stand in for others.

`capacity`, on a bodyguard's record, raises the core limit: it takes up to `leads` leader units and `supports` support units, the omitted one staying at one. With `startingStrength`, the raise holds only while the unit's Starting Strength is at least that. `distinct` means no two of its attached units may be the same unit, and each of `limits` that at most `max` of them hold every keyword in its `keywords`.

`withAnotherLeader`, on a leader's record, lists bodyguard units it leads (`units`, each also in its `leads` or a `leads` entry of `conditional`) that it may lead even when one other leader unit already leads them, never beside a unit of its own: the bodyguard then takes the two. It holds too on a unit that stands in for one of them and admits the leader there. With `besideUnits` or `besideKeywords`, that other unit must be one of those units or hold one of those keywords. A bodyguard whose `capacity` already takes two leader units is not narrowed by it.

`joins` lists the units a unit may join to become part of them, outside the leader and support roles: a unit in an entry's `units` or holding every keyword in its `keywords` (any unit where it gives neither), led by a leader unit holding every keyword in its `ledBy`. With `required`, the unit must join one if it can; where none is in the roster it takes no part in the battle, which leaves the roster legal; no function checks it. With `exclusive`, the unit it joins may have no other joined unit holding one of those keywords. An entry gives `units`, `keywords` or `ledBy`.

`canAttach(attachment, role, target, context, attachmentOf)` follows `insteadOf` given `attachmentOf`, each unit's attachment record by unit ID; a stood-in unit's keywords come from `context.keywords` too, so give the keywords of every unit a stand-in names, not only the roster's. `mustAttach(attachment, context)` answers whether the unit is a support unit in the roster. `attachedUnitProblems(attached, context, attachmentOf)` checks one bodyguard with the units attached to or joined with it, as `{ bodyguard, startingStrength, leaders, supports, joined }`, and lists problem codes: `attachment-target`, `attachment-full`, `attachment-duplicate`, `attachment-limit`, `join-target` and `join-exclusive`.

## Base sizes

One base is `"hull"` for a model without a base, measured to its hull; `"unique"` for a model on no base of standard size, whose base players agree on; `{ "diameter": mm }` for a round base; `{ "length": mm, "width": mm }` for an oval; or `{ "flyingBase": "large" }` or `{ "flyingBase": "small" }` for a flying base the source names without a size. A round or oval base may be `approximate` or `flying`.

A profile's `baseSize` is one base, or one of these forms built from bases:

| Form | Meaning | Example |
| --- | --- | --- |
| `{ "alternatives": [base, ...] }` | The source lists these bases for the profile's models without saying which model takes which. | `{ "alternatives": [{ "diameter": 32 }, { "diameter": 40 }] }` |
| `{ "size": base, "withWargear": [{ "wargear": [ID, ...], "size": base }] }` | Models carrying any of an entry's wargear stand on its `size`; other models on the first `size`. Each base here may also be alternatives. | Rangers on 25mm, a Rangers model with an arquebus on a 60 × 35.5mm oval |
| `{ "byModel": [{ "models": [ID, ...], "size": ... }] }` | Each entry's models stand on its `size`, which may be any form above. The entries name every model the profile describes exactly once. | A leader on 32mm and the rest on 28.5mm |

`baseSizeSource` names where the base size is printed, in a record's `source` shape, when that is not the record's own `source`, as when a profile read from the app takes its base from a base size guide. Where no official source prints a datasheet's base size, its profiles carry VS Data's own where VS Data has one, with no `baseSizeSource`, and the input's README lists the datasheet.

## Transport capacity

Each `loads` entry is one way to load the transport. Each consists of one or more pools, and eligible passengers may occupy those pools at the same time. A pool gives its `limit`, whether it `count`s models or units, its `selectors` and an optional `maxWounds`. A selector is a keyword or a phrase formed by consecutive keywords. A passenger can match any selector in the list.

An `excluded` entry refuses a passenger matching its selectors unless an `except` selector also matches. `space` sets the number of places a matching model takes. Use the first matching entry and one place by default. The optional `moreWoundsThan` threshold is strict. A `whenEquipped` entry names a `wargear` item or a `model`. While the transport carries that item, or its unit includes that model, the entry's pool replaces the first pool of the first load. A model is named where the datasheet's equipment is a model of the unit, as the Tidewall Shieldline's Tidewall defence platform is. Multiple active replacements need a ruling before the capacity can be evaluated.

`firingDeck` gives the number of embarked models that can shoot from the transport, where its datasheet has Firing Deck.

Use a `capacity` gap when the complete transport capacity cannot be represented or an equipment condition cannot be joined. Deployment abilities such as splitting a unit before it embarks need separate mechanics records.

## Gaps

A gap is `{ "field", "reason" }`. `unrepresentable` means the source prints a value this format has no form for, such as an invulnerable save that differs by model, and the field is left out. `no-source` means no official source in reach prints the value and VS Data gives none of its own. `no-target` means the source names something no catalogue ID identifies: a weapon whose wargear the unit neither carries nor offers, a unit profile that matches none of the unit's models, or an attachment target with no unit. An attachment keeps the targets that resolve and adds one `no-target` gap for each that does not. A converter records a gap instead of choosing a nearby value or target.

## Local and qualified references

A profile's `unit` bounds what else it may name. Its `models` must belong to that unit, and any weapon profile or equipment condition must refer to wargear the unit carries or offers, or that a bundle it carries or offers includes at any depth. A transport's `whenEquipped` model must belong to its unit. Attachment targets are qualified: they may name any current unit in the release, including another faction's. Every reference resolves within the record's own rules version, so a release that holds only some factions cannot name a unit outside them.

## Validation

`validateProfiles(identity, records)` takes the identity release that holds both the profile entries and the roster entries they name. It checks each record's `data` against its kind and these rules, which the schema cannot express:

- Every record uses the identity release's rules version, its entry is current, and an entry has at most one record.
- Every ID a record names is current in the release and appears in its identity entry's `references`, so a release's `dependsOn` lists the roster category.
- The local references above hold, and no unit attaches to itself.
- A required characteristic is either stated or a gap, never both.
- A list of invulnerable saves names each kind of attack once, and each save's `summary` parses with the summary grammar and has no links.
- When a unit has several unit profiles, each names its models or has a `models` gap, and no model has two profiles.
- A base size by model gives each model the profile describes (its `models`, else every model of its unit) exactly one base size and names no other model. A model or wargear a base size names follows the local reference rules above, and no wargear item is named twice in one model's base size.
- A unit has at most one attachment and one transport record. A transport can state one replacement pool for each wargear ID.

`profiles.of(kind, unit)` lists a unit's records of one kind, and `profiles.attachedBy(unit, role)` lists the units whose `leads` or `supports` name it.

## Versioning

Profiles follow the [identity rules](catalogue-identity.md). A characteristic change keeps the profile's ID. A weapon that splits into modes retires its old profile with the new ones as `replacedBy`, so a saved reference to it resolves to them. A profile ID is never reused for a different stat line.

## MFM 1.6

The [MFM 1.6 input](../data/mfm-1-6/rule-summaries/README.md) holds a `profiles` category built from the official app's data build: a unit profile for each distinct stat line of every datasheet outside Combat Patrol, a weapon profile for each profile of every weapon a unit carries or may take, attachments, and a transport profile for each transport, with its capacity typed from the app's Transport rule and its Firing Deck. Warhammer Legends datasheets the app does not carry come from Games Workshop's Legends PDFs; a weapon profile names its wargear wherever the sheet's loadout is typed. Base sizes are the app's; where the app prints none it types, they come from the Base Size Guide in the Event Companion in force at the cutoff, cited in `baseSizeSource`. Legends PDFs print no base size, so a Legends datasheet takes the newest earlier guide that listed it while it was a matched-play unit. A datasheet no official source sizes, Legends or not, takes VS Data's own size where VS Data has one. The input's README gives the counts and every gap.

## Earlier rules versions

Each earlier 11th-edition input of a current release line (`data/<version>/rule-summaries/`; not the retired Custodes codex line) holds the same `profiles` category, built from the app build in force at that update's cutoff, with Legends profiles from the documents dated before it.

## Rehearsal

[Tracking issue](https://github.com/richardsolomou/vs-data/issues/39) · [Archived evidence](https://github.com/richardsolomou/vs-data/blob/80733c1fb93dd338b3078408c7f46c30c4ec422d/docs/datasheet-profiles.md#rehearsal)

## Weapon profile joins

[Tracking issue](https://github.com/richardsolomou/vs-data/issues/39) · [Archived evidence](https://github.com/richardsolomou/vs-data/blob/80733c1fb93dd338b3078408c7f46c30c4ec422d/docs/datasheet-profiles.md#weapon-profile-joins)
