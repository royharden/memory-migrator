"""Generates the wholly synthetic evaluation fixtures (dev + held-out, conversation-disjoint).

Labels describe what a careful human reviewer would extract from each user message,
written WITHOUT regard to what the rules can match (do not lower gold labels to fit the
rules). Caveat: the same agent wrote the rules and these labels, so they are not
independent; a later independent audit of >=20% of labels is still required.

Run: python -I gen_eval.py <out_dir>   (writes dev.json, heldout.json, manifest.json)
"""
import hashlib
import json
import sys

T0 = 1675209600  # 2023-02-01


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Conv:
    def __init__(self, cid, title, time=T0, dated=True):
        self.cid, self.title, self.time, self.dated = cid, title, time, dated
        self.nodes, self.prev, self.n = {}, None, 0
        self.labels, self.cases = [], []

    def msg(self, role, text, t=None, hidden=False, off_branch=False):
        self.n += 1
        nid = f"n{self.n}"
        when = t if t is not None else ((self.time + self.n * 60) if self.dated else None)
        m = {"id": f"m{self.n}", "author": {"role": role}, "create_time": when, "content": {"content_type": "text", "parts": [text]}}
        if hidden:
            m["metadata"] = {"is_visually_hidden_from_conversation": True}
        parent = self.prev
        self.nodes[nid] = {"id": nid, "parent": parent, "children": [], "message": m}
        if parent:
            self.nodes[parent]["children"].append(nid)
        if not off_branch:
            self.prev = nid
        return f"m{self.n}"

    def label(self, mid, quote, slot, value, polarity="assert", supported=True, sensitivity=()):
        lid = f"{self.cid}-L{len(self.labels) + 1}"
        self.labels.append({"id": lid, "conversationId": self.cid, "messageId": mid, "quote": quote, "slot": slot, "value": value,
                            "polarity": polarity, "supported": supported, "sensitivity": sorted(sensitivity)})
        return lid

    def case(self, mid, categories):
        self.cases.append({"conversationId": self.cid, "messageId": mid, "categories": sorted(categories)})

    def export(self):
        c = {"id": self.cid, "title": self.title, "mapping": self.nodes, "current_node": self.prev}
        if self.dated:
            c["create_time"] = self.time
        return c


def dataset(name, convs, groups, eligibility):
    labels = [l for c in convs for l in c.labels]
    for l in labels:  # every quote must be an exact substring of its (canonical) message
        conv = next(c for c in convs if c.cid == l["conversationId"])
        node = next(n for n in conv.nodes.values() if n["message"]["id"] == l["messageId"])
        text = node["message"]["content"]["parts"][0].replace("\r\n", "\n").replace("\r", "\n")
        assert l["quote"] in text, (l["id"], l["quote"], text)
    return {"id": f"synthetic-eval-{name}-v1", "split": name,
            "notes": "Wholly synthetic. Not real people. Not LoCoMo or any third-party dataset.",
            "export": [c.export() for c in convs], "labels": labels, "groups": groups,
            "sensitivityCases": [s for c in convs for s in c.cases], "eligibility": eligibility}


def E(text, eligible):
    return {"text": text, "eligible": eligible}


# ----------------------------- dev split ---------------------------------
d1 = Conv("dev-1", "Intro")
m = d1.msg("user", "Hi there! My name is Priya Raman and I live in Leeds.")
d1.label(m, "My name is Priya Raman", "identity.name", "Priya Raman")
d1.label(m, "I live in Leeds", "location.home", "Leeds")
m = d1.msg("user", "I work as a nurse at St Mary's Hospital.")
d1.label(m, "I work as a nurse", "work.role", "nurse")
d1.label(m, "I work as a nurse at St Mary's Hospital", "work.employer", "St Mary's Hospital")
m = d1.msg("user", "I love climbing. I'm allergic to penicillin.")
d1.label(m, "I love climbing", "preference.likes", "climbing")
d1.label(m, "I'm allergic to penicillin", "health.note", "allergic to penicillin", sensitivity=["health"])
d1.msg("user", "If I lived in Paris I'd learn French.")
d1.msg("assistant", "You work as a doctor, right?")
m = d1.msg("user", "my salary is £41,000")
d1.label(m, "my salary is £41,000", "financial.note", "£41,000", sensitivity=["finance"])

d2 = Conv("dev-2", "Moving", time=T0 + 20 * 86400)
m = d2.msg("user", "I live in Bristol.")
l_bristol = d2.label(m, "I live in Bristol", "location.home", "Bristol")
m = d2.msg("user", "I moved to Cardiff last spring.", t=T0 + 240 * 86400)
l_cardiff = d2.label(m, "I moved to Cardiff", "location.home", "Cardiff")
m = d2.msg("user", "I don't like coffee.")
d2.label(m, "I don't like coffee", "preference.dislikes", "coffee")
d2.msg("user", "Do I like tea?")
m = d2.msg("user", "I have two cats.")
d2.label(m, "I have two cats", "other.pets", "two cats", supported=False)

d3 = Conv("dev-3", "Work change", time=T0 + 40 * 86400)
m = d3.msg("user", "I work at Acme Corp.")
l_acme = d3.label(m, "I work at Acme Corp", "work.employer", "Acme Corp")
m = d3.msg("user", "I no longer work at Acme Corp. I work at Globex now.")
l_acme_deny = d3.label(m, "I no longer work at Acme Corp", "work.employer", "Acme Corp", polarity="deny")
l_globex = d3.label(m, "I work at Globex", "work.employer", "Globex")
d3.msg("user", "My friend says I live in Rome.")
d3.msg("user", "Please forget that I like jazz.")
m = d3.msg("user", "\U0001F600 I enjoy board games.")
d3.label(m, "I enjoy board games", "preference.likes", "board games")
m = d3.msg("user", "I live in Kraków.")
d3.label(m, "I live in Kraków", "location.home", "Kraków")

d4 = Conv("dev-4", "Correction", time=T0 + 60 * 86400)
m = d4.msg("user", "My name is Jon. Actually, my name is John, not Jon.")
l_jon = d4.label(m, "My name is Jon", "identity.name", "Jon")
l_john = d4.label(m, "my name is John, not Jon", "identity.name", "John")
l_notjon = d4.label(m, "my name is John, not Jon", "identity.name", "Jon", polarity="deny")
m = d4.msg("user", "I live in São Paulo.")
d4.label(m, "I live in São Paulo", "location.home", "São Paulo")
m = d4.msg("user", "I go to church every Sunday.")
d4.label(m, "I go to church every Sunday", "other.religion", "goes to church", supported=False, sensitivity=["belief"])
d4.case(m, ["belief"])
d4.msg("tool", "I live in Toolville")

d5 = Conv("dev-5", "Back and forth", dated=False)
m = d5.msg("user", "I live in Austin.\r\nI live in Dallas.")
l_austin = d5.label(m, "I live in Austin", "location.home", "Austin")
l_dallas = d5.label(m, "I live in Dallas", "location.home", "Dallas")
m = d5.msg("user", "I live in Austin.")
d5.label(m, "I live in Austin", "location.home", "Austin")
d5.msg("user", "```\nmy name is Bob\n```")
d5.msg("user", "I'm in Chicago this week.")
m = d5.msg("user", "My daughter is 9 years old.")
d5.case(m, ["minors"])

dev_groups = [
    {"id": "dev-G1", "slot": "location.home", "members": [l_bristol, l_cardiff]},
    {"id": "dev-G2", "slot": "work.employer", "members": [l_acme, l_acme_deny, l_globex]},
    {"id": "dev-G3", "slot": "identity.name", "members": [l_jon, l_john, l_notjon]},
    {"id": "dev-G4", "slot": "location.home", "members": [l_austin, l_dallas]},
]
dev_elig = [
    E("I live in Glasgow.", True), E("I work as a chef.", True), E("If I worked as a chef I'd be tired.", False),
    E("Does she live in Glasgow?", False), E("I like rye bread.", True), E("He said I like rye bread.", False),
    E("I'm in Rome for the weekend.", False), E("I speak three languages.", True), E("Pretend I live on Mars.", False),
    E("My name is Lina.", True),
]

# ----------------------------- held-out split -----------------------------
h1 = Conv("ho-1", "Introductions", time=T0 + 100 * 86400)
m = h1.msg("user", "My name is Mei Chen. I live in Vancouver and I work as an architect at Northwind Studio.")
h1.label(m, "My name is Mei Chen", "identity.name", "Mei Chen")
h1.label(m, "I live in Vancouver", "location.home", "Vancouver")
h1.label(m, "I work as an architect", "work.role", "architect")
h1.label(m, "I work as an architect at Northwind Studio", "work.employer", "Northwind Studio")
m = h1.msg("user", "I really like hiking and I hate olives.")
h1.label(m, "I really like hiking", "preference.likes", "hiking")
h1.label(m, "I hate olives", "preference.dislikes", "olives")
m = h1.msg("user", "I'm allergic to shellfish. I also love sushi.")
h1.label(m, "I'm allergic to shellfish", "health.note", "allergic to shellfish", sensitivity=["health"])
h1.label(m, "I also love sushi", "preference.likes", "sushi")

h2 = Conv("ho-2", "Relocation", time=T0 + 120 * 86400)
m = h2.msg("user", "I live in Lyon.")
l_lyon = h2.label(m, "I live in Lyon", "location.home", "Lyon")
m = h2.msg("user", "I've just moved to Grenoble.", t=T0 + 300 * 86400)
l_gren = h2.label(m, "I've just moved to Grenoble", "location.home", "Grenoble")
m = h2.msg("user", "I earn $85,000 a year.")
h2.label(m, "I earn $85,000 a year", "financial.note", "$85,000 a year", sensitivity=["finance"])
h2.msg("user", "Imagine I worked at NASA.")

h3 = Conv("ho-3", "Music and home", time=T0 + 140 * 86400)
m = h3.msg("user", "I like jazz.")
l_jazz = h3.label(m, "I like jazz", "preference.likes", "jazz")
m = h3.msg("user", "I no longer like jazz.")
l_nojazz = h3.label(m, "I no longer like jazz", "preference.likes", "jazz", polarity="deny")
h3.msg("user", "Is my name Ana?")
m = h3.msg("user", "My partner and I live in Boston.")
h3.label(m, "My partner and I live in Boston", "location.home", "Boston", sensitivity=["intimate"])
h3.case(m, ["intimate"])
m = h3.msg("user", "I live at 42 Elm Street.")
h3.label(m, "I live at 42 Elm Street", "location.home", "42 Elm Street", sensitivity=["precise_location"])
h3.case(m, ["precise_location"])

h4 = Conv("ho-4", "Career", time=T0 + 160 * 86400)
m = h4.msg("user", "I work as a teacher.")
l_teach = h4.label(m, "I work as a teacher", "work.role", "teacher")
m = h4.msg("user", "I don't work as a teacher anymore.")
l_noteach = h4.label(m, "I don't work as a teacher anymore", "work.role", "teacher", polarity="deny")
m = h4.msg("user", "I enjoy Zürich in winter.")
h4.label(m, "I enjoy Zürich in winter", "preference.likes", "Zürich in winter")
h4.msg("user", "She told me I live in Denver.")

h5 = Conv("ho-5", "Jobs, undated", dated=False)
m = h5.msg("user", "I work at Initech.")
l_ini = h5.label(m, "I work at Initech", "work.employer", "Initech")
m = h5.msg("user", "I work at Hooli.")
l_hoo = h5.label(m, "I work at Hooli", "work.employer", "Hooli")
m = h5.msg("user", "I'm an atheist.")
h5.label(m, "I'm an atheist", "other.belief", "atheist", supported=False, sensitivity=["belief"])
h5.case(m, ["belief"])
m = h5.msg("user", "I was diagnosed with ADHD.")
h5.label(m, "I was diagnosed with ADHD", "health.note", "diagnosed with ADHD", sensitivity=["health"])
h5.case(m, ["health"])
m = h5.msg("user", "My girlfriend lives in Oslo.")
h5.case(m, ["intimate"])
h5.msg("user", "I live in Hiddenville.", hidden=True)
h5.msg("user", "I live in Branchville.", off_branch=True)

ho_groups = [
    {"id": "ho-G1", "slot": "location.home", "members": [l_lyon, l_gren]},
    {"id": "ho-G2", "slot": "preference.likes", "members": [l_jazz, l_nojazz]},
    {"id": "ho-G3", "slot": "work.role", "members": [l_teach, l_noteach]},
    {"id": "ho-G4", "slot": "work.employer", "members": [l_ini, l_hoo]},
]
ho_elig = [
    E("I live in Porto.", True), E("I live in Seoul now.", True), E("I moved to Nairobi.", True), E("My name is Tomas.", True),
    E("I work as a pharmacist.", True), E("I work at the public library.", True), E("I love sailing.", True), E("I hate mushrooms.", True),
    E("I'm allergic to latex.", True), E("My salary is $52,000.", True), E("I no longer live in Oslo.", True), E("I used to work at Initrode.", True),
    E("I don't like spicy food.", True), E("i work as a welder.", True), E("I enjoy long walks.", True), E("I have a sesame allergy.", True),
    E("I play the cello.", True), E("I have three brothers.", True), E("I'm vegetarian.", True), E("I'm a night owl.", True),
    E("If I lived in Tokyo I would learn Japanese.", False), E("Do I live in Porto?", False), E("What if I work at Google?", False),
    E("My brother lives in Lima.", False), E("She says I love sailing.", False), E("My boss thinks I work as a manager.", False),
    E('He wrote "I live in Paris" in his book.', False), E("I'm in Madrid for the summer.", False), E("I live in Berlin temporarily.", False),
    E("Pretend you are a pirate and I live in Tortuga.", False), E("For this chat, assume I work at NASA.", False), E("Please forget that I like jazz.", False),
    E("    I live in Codeville", False), E("Would I like opera?", False), E("Imagine I hate cheese.", False), E("Maybe I like opera.", False),
    E("They told me I work as a spy.", False), E("I might move to Lisbon someday.", False), E("Let's say my name is Zed.", False), E("Today is my birthday.", False),
]

if __name__ == "__main__":
    out = sys.argv[1]
    # V1 is historical regression material. Never overwrite the active V2 manifest.
    from pathlib import Path
    existing = Path(out) / "manifest.json"
    if existing.exists() and json.loads(existing.read_text(encoding="utf-8")).get("fixtureVersion", 1) >= 2:
        raise SystemExit("Refusing to replace a newer frozen edition with contaminated V1.")
    dev = dataset("dev", [d1, d2, d3, d4, d5], dev_groups, dev_elig)
    ho = dataset("heldout", [h1, h2, h3, h4, h5], ho_groups, ho_elig)
    assert not ({c["id"] for c in dev["export"]} & {c["id"] for c in ho["export"]}), "splits must be conversation-disjoint"
    manifest = {"fixtureVersion": 1, "frozen": "2026-10-23", "rulesAtFreeze": "rules/1", "parserAtFreeze": "chatgpt-json/1",
                "files": {}, "notes": "labelSha256 = SHA-256 of the canonical JSON (sorted keys, no whitespace, UTF-8) of each dataset object."}
    for name, ds in (("dev.json", dev), ("heldout.json", ho)):
        with open(f"{out}/{name}", "w", encoding="utf-8", newline="\n") as fh:
            json.dump(ds, fh, ensure_ascii=False, indent=1)
        manifest["files"][name] = {"labelSha256": hashlib.sha256(canon(ds).encode("utf-8")).hexdigest(),
                                   "conversations": len(ds["export"]), "labels": len(ds["labels"]),
                                   "supportedLabels": sum(1 for l in ds["labels"] if l["supported"]),
                                   "eligibilitySentences": len(ds["eligibility"])}
    with open(f"{out}/manifest.json", "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    print(json.dumps(manifest["files"]))
