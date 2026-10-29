"""Author the replacement synthetic split without invoking the extractor.

Freeze the current core bytes first. Labels follow the natural-language contract,
not observed predictions. Never tune the frozen rules against this split. V1 is
retained as contaminated regression material. Independent label audit is pending.
Run once: python -I fixtures/synthetic/eval/gen_heldout_v2.py
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canon(value).encode("utf-8")).hexdigest()


def build():
    # Capture before constructing labels; do not import or execute any core module.
    sources = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
               for p in sorted((ROOT / "supabase/functions/_shared/mm").glob("*.ts"))}
    conversations, labels, groups, cases = [], [], [], []

    def conversation(number, rows, dated=True):
        cid = f"fresh-v2-{number}"
        mapping, previous = {}, None
        refs = []
        for i, (role, text, facts, categories) in enumerate(rows, 1):
            nid, mid = f"node-{i}", f"message-{i}"
            message = {"id": mid, "author": {"role": role},
                       "create_time": 1735689600 + number * 86400 + i * 60 if dated else None,
                       "content": {"content_type": "text", "parts": [text]}}
            mapping[nid] = {"id": nid, "parent": previous, "children": [], "message": message}
            if previous:
                mapping[previous]["children"].append(nid)
            previous = nid
            ids = []
            for quote, slot, value, polarity, supported, sensitivity in facts:
                assert quote in text
                lid = f"{cid}-label-{len(labels) + 1}"
                labels.append({"id": lid, "conversationId": cid, "messageId": mid,
                               "quote": quote, "slot": slot, "value": value, "polarity": polarity,
                               "supported": supported, "sensitivity": sorted(sensitivity)})
                ids.append(lid)
            refs.append(ids)
            if categories:
                cases.append({"conversationId": cid, "messageId": mid, "categories": sorted(categories)})
        conversations.append({"id": cid, "title": f"Synthetic replacement conversation {number}",
                              "mapping": mapping, "current_node": previous})
        return refs

    def f(quote, slot, value, polarity="assert", supported=True, sensitivity=()):
        return quote, slot, value, polarity, supported, sensitivity

    def u(text, *facts, categories=()):
        return "user", text, facts, categories

    def group(slot, *members):
        groups.append({"id": f"fresh-v2-group-{len(groups) + 1}", "slot": slot,
                       "members": list(members)})

    conversation(1, [
        u("For the introduction: my name is Imani Okafor.", f("my name is Imani Okafor", "identity.name", "Imani Okafor")),
        u("My home is in Bergen.", f("My home is in Bergen", "location.home", "Bergen")),
        u("I am a ceramic artist.", f("I am a ceramic artist", "work.role", "ceramic artist")),
        u("My employer is Fjord Workshop.", f("My employer is Fjord Workshop", "work.employer", "Fjord Workshop")),
        u("I enjoy restoring old radios.", f("I enjoy restoring old radios", "preference.likes", "restoring old radios")),
        u("I dislike licorice.", f("I dislike licorice", "preference.dislikes", "licorice")),
        ("assistant", "You live in Atlantis and work for Fiction Incorporated.", (), ()),
    ])
    refs = conversation(2, [
        u("I live in Wellington.", f("I live in Wellington", "location.home", "Wellington")),
        u("I relocated to Dunedin this winter.", f("I relocated to Dunedin", "location.home", "Dunedin")),
        u("I have a walnut allergy.", f("I have a walnut allergy", "health.note", "walnut allergy", sensitivity=["health"]), categories=["health"]),
        u("My salary is NZ$73,500.", f("My salary is NZ$73,500", "financial.note", "NZ$73,500", sensitivity=["finance"]), categories=["finance"]),
        u("If I moved to Reykjavik, I would need a warmer coat."),
    ])
    group("location.home", refs[0][0], refs[1][0])
    refs = conversation(3, [
        u("I work at Lantern Books.", f("I work at Lantern Books", "work.employer", "Lantern Books")),
        u("I no longer work at Lantern Books.", f("I no longer work at Lantern Books", "work.employer", "Lantern Books", "deny")),
        u("I work at Copper Finch now.", f("I work at Copper Finch", "work.employer", "Copper Finch")),
        u("I play the bassoon.", f("I play the bassoon", "other.hobby", "plays bassoon", supported=False)),
        u("My sibling says they live in Tallinn."),
    ])
    group("work.employer", refs[0][0], refs[1][0], refs[2][0])
    refs = conversation(4, [
        u("I like speed chess.", f("I like speed chess", "preference.likes", "speed chess")),
        u("I no longer like speed chess.", f("I no longer like speed chess", "preference.likes", "speed chess", "deny")),
        u("I have chronic migraines.", f("I have chronic migraines", "health.note", "chronic migraines", sensitivity=["health"]), categories=["health"]),
        u("I live at 87 Example Lane.", f("I live at 87 Example Lane", "location.home", "87 Example Lane", sensitivity=["precise_location"]), categories=["precise_location"]),
        u("My son is eleven years old.", categories=["minors"]),
        u("Could my name be Noel?"),
    ])
    group("preference.likes", refs[0][0], refs[1][0])
    refs = conversation(5, [
        u("I work as a meteorologist.", f("I work as a meteorologist", "work.role", "meteorologist")),
        u("I work as a cartographer.", f("I work as a cartographer", "work.role", "cartographer")),
        u("I live in Tartu.", f("I live in Tartu", "location.home", "Tartu")),
        u("I live in Turku.", f("I live in Turku", "location.home", "Turku")),
        u("I follow the Quaker faith.", f("I follow the Quaker faith", "other.belief", "Quaker", supported=False, sensitivity=["belief"]), categories=["belief"]),
        u("Please remove the claim that I like speed chess."),
    ], dated=False)
    group("work.role", refs[0][0], refs[1][0])
    group("location.home", refs[2][0], refs[3][0])
    conversation(6, [
        u("My name is Leila Haddad.", f("My name is Leila Haddad", "identity.name", "Leila Haddad")),
        u("I love cyanotype printing.", f("I love cyanotype printing", "preference.likes", "cyanotype printing")),
        u("I hate traffic noise.", f("I hate traffic noise", "preference.dislikes", "traffic noise")),
        u("I earn EUR 64,200 annually.", f("I earn EUR 64,200 annually", "financial.note", "EUR 64,200 annually", sensitivity=["finance"]), categories=["finance"]),
        u("I speak Welsh.", f("I speak Welsh", "other.language", "Welsh", supported=False)),
        u("In my short story, a character says: I live in Fairytale City."),
    ])
    positive = [
        "I live in Uppsala.", "My home is in Gdansk.", "I relocated to Hobart.", "My name is Soren.",
        "I am a locksmith.", "My employer is Paper Kite Labs.", "I enjoy astronomy.", "I dislike pickles.",
        "I have a nickel allergy.", "My income is CAD 48,000.", "I no longer live in Split.", "I used to work at Kite Works.",
        "I do not like drum solos.", "I work as a botanist.", "I love making kites.", "I have asthma.",
        "I play badminton.", "I speak Tagalog.", "I keep a tortoise.", "I am left handed.",
    ]
    negative = [
        "If I lived in Busan I would learn Korean.", "Do I live in Busan?", "What if I were a carpenter?",
        "My cousin lives in Quito.", "She thinks I enjoy astronomy.", "My colleague said I am a locksmith.",
        'The sample sentence is "I live in Siena".', "I am in Ljubljana for a conference.",
        "I live in Bruges just for this holiday.", "Pretend my name is Captain Comet.",
        "For this roleplay, I work at Cloud Castle.", "Please forget that I love making kites.",
        "    I live in Indented Code City", "Would I enjoy fencing?", "Imagine that I hate mustard.",
        "Maybe I will live in Riga.", "They claimed I work as a pilot.", "I might become a baker someday.",
        "Suppose my employer were Moon Station.", "The meeting starts at noon.",
    ]
    data = {"id": "synthetic-eval-heldout-v2", "split": "heldout",
            "notes": "Wholly synthetic replacement authored after core freeze, without running or tuning the extractor. Independent label audit pending. Not a quality benchmark.",
            "export": conversations, "labels": labels, "groups": groups, "sensitivityCases": cases,
            "eligibility": [{"text": text, "eligible": True} for text in positive]
                           + [{"text": text, "eligible": False} for text in negative]}
    return data, sources


if __name__ == "__main__":
    target = OUT / "heldout-v2.json"
    if target.exists():
        raise SystemExit("Refusing to overwrite a frozen split. Create a new edition instead.")
    data, sources = build()
    manifest = json.loads((OUT / "manifest.json").read_text(encoding="utf-8"))
    manifest["fixtureVersion"] = 2
    manifest["frozen"] = "2026-10-28"
    manifest["rulesAtFreeze"] = "rules/2"
    manifest["activeHeldoutFile"] = target.name
    manifest["files"]["heldout.json"]["status"] = "contaminated-v1-regression-only"
    manifest["files"]["heldout.json"]["rulesAtFreeze"] = "rules/1"
    manifest["files"]["dev.json"]["rulesAtFreeze"] = "rules/1"
    manifest["files"][target.name] = {
        "labelSha256": digest(data), "conversations": len(data["export"]), "labels": len(data["labels"]),
        "supportedLabels": sum(label["supported"] for label in data["labels"]),
        "eligibilitySentences": len(data["eligibility"]), "status": "frozen-unmeasured-audit-pending",
        "rulesAtFreeze": "rules/2", "coreSourceSha256": digest(sources), "coreSources": sources,
        "labelAudit": {"status": "pending", "minimumFraction": 0.2},
    }
    target.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Frozen replacement: {len(data['labels'])} labels, {len(data['export'])} conversations, 40 eligibility sentences; no extractor run.")
