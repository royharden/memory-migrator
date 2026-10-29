"""Freeze the owner-authorized v3 revision, preserving v2 byte-for-byte.

No extractor is imported or executed. Source projection v1 mirrors the documented
parser projection; independent Node checks verify it against the actual parser.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(value):
    return hashlib.sha256(canon(value).encode("utf-8")).hexdigest()


def text_sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_text(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def source_digest(conv):
    nodes = []
    for node_id, node in sorted(conv["mapping"].items()):
        message = node["message"]
        nodes.append({"id": node_id, "parent": node["parent"], "message": {
            "id": message["id"], "role": message["author"]["role"],
            "hidden": message.get("metadata", {}).get("is_visually_hidden_from_conversation", False),
            "contentType": message["content"]["content_type"],
            "text": canonical_text("\n".join(message["content"]["parts"])),
            "time": message["create_time"],
        }})
    return sha({"v": 1, "conversationId": conv["id"], "currentNode": conv["current_node"], "nodes": nodes})


def build():
    # Pin current core before revising labels; rules/parser stay unchanged.
    sources = {p.relative_to(ROOT).as_posix(): text_sha(p.read_text(encoding="utf-8"))
               for p in sorted((ROOT / "supabase/functions/_shared/mm").glob("*.ts"))}
    old_path = HERE / "heldout-v2.json"
    old_bytes = old_path.read_bytes()
    data = json.loads(old_bytes)
    data["id"] = "synthetic-eval-heldout-v3"
    data["notes"] = "Wholly synthetic v3 revision of audited v2; not an unseen benchmark. Rules unchanged; no extractor run or tuning. Prior editions retained."
    data["provenance"] = {
        "rulesAtFreeze": "rules/2", "parserAtFreeze": "chatgpt-json/1",
        "labelReview": "V3 addresses independent v2 audit findings; a separate independent v3 audit is required. No extraction quality claim.",
    }
    # An astral character before a quote exercises code-point rather than UTF-16 offsets.
    data["export"][0]["mapping"]["node-1"]["message"]["content"]["parts"][0] = "🧭 " + data["export"][0]["mapping"]["node-1"]["message"]["content"]["parts"][0]
    family = {
        "id": "fresh-v3-family-label-29", "conversationId": "fresh-v2-4", "messageId": "message-5",
        "quote": "My son is eleven years old", "slot": "other.family", "value": "son aged eleven",
        "polarity": "assert", "supported": False, "sensitivity": ["minors"],
    }
    data["labels"].append(family)
    conv = data["export"][5]
    previous = conv["current_node"]
    conv["mapping"][previous]["children"].append("node-7")
    conv["mapping"]["node-7"] = {
        "id": "node-7", "parent": previous, "children": [],
        "message": {"id": "message-7", "author": {"role": "user"},
                    "create_time": 1735689600 + 6 * 86400 + 7 * 60,
                    "content": {"content_type": "text", "parts": ["I am married to Morgan Vale."]}},
    }
    conv["current_node"] = "node-7"
    data["labels"].append({
        "id": "fresh-v3-relationship-label-30", "conversationId": conv["id"], "messageId": "message-7",
        "quote": "I am married to Morgan Vale", "slot": "other.relationship", "value": "married to Morgan Vale",
        "polarity": "assert", "supported": False, "sensitivity": ["intimate"],
    })
    data["sensitivityCases"].append({"conversationId": conv["id"], "messageId": "message-7", "categories": ["intimate"]})
    reasons = [
        "Residence changed from Wellington to Dunedin; the explicit relocation suggests changed circumstances, subject to user confirmation.",
        "Lantern Books is asserted then denied and Copper Finch asserted; retain the employment history/retraction relationship for review.",
        "The same speed-chess preference is asserted and then denied; this is a preference retraction requiring review.",
        "Two incompatible roles have unknown source times; keep the group unresolved rather than assuming chronology.",
        "Two incompatible home locations have unknown source times; keep the group unresolved rather than assuming chronology.",
    ]
    for group, reason in zip(data["groups"], reasons):
        group["reason"] = reason
    conversations = {c["id"]: c for c in data["export"]}
    for label in data["labels"]:
        conv = conversations[label["conversationId"]]
        message = next(n["message"] for n in conv["mapping"].values() if n["message"]["id"] == label["messageId"])
        text = canonical_text("\n".join(message["content"]["parts"]))
        assert text.count(label["quote"]) == 1, label["id"]
        start = text.index(label["quote"])
        when = message["create_time"]
        label["source"] = {
            "sourceDigest": source_digest(conv), "conversationId": conv["id"], "messageId": message["id"],
            "role": message["author"]["role"], "textSha256": text_sha(text),
            "start": start, "end": start + len(label["quote"]), "quote": label["quote"],
            "quoteSha256": text_sha(label["quote"]), "parserVersion": "chatgpt-json/1",
            "sourceTime": datetime.fromtimestamp(when, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if when is not None else None,
        }
        label["assertion"] = label["quote"]
        label["eligible"] = True
        label["durable"] = True
        membership = [g for g in data["groups"] if label["id"] in g["members"]]
        label["groupIds"] = [g["id"] for g in membership]
        label["groupRationale"] = " ".join(g["reason"] for g in membership) if membership else "No competing or retracted assertion for this labelled fact within this conversation; no conflict group expected."
    assert old_path.read_bytes() == old_bytes
    return data, sources, text_sha(old_bytes.decode("utf-8"))


if __name__ == "__main__":
    target = HERE / "heldout-v3.json"
    if target.exists():
        raise SystemExit("Refusing to overwrite frozen v3. Create a new edition.")
    data, sources, old_hash = build()
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    manifest["fixtureVersion"] = 3
    manifest["activeHeldoutFile"] = target.name
    previous = manifest["files"]["heldout-v2.json"]
    previous["status"] = "retained-v2-independent-audit-return"
    previous["labelAudit"] = {"status": "return", "reviewer": "0094_Codex_GPT-61-Terra_Sub_BinSorter", "fraction": 1.0}
    manifest["files"][target.name] = {
        "labelSha256": sha(data), "conversations": len(data["export"]), "labels": len(data["labels"]),
        "supportedLabels": sum(label["supported"] for label in data["labels"]),
        "eligibilitySentences": len(data["eligibility"]), "status": "frozen-v3-independent-audit-pending",
        "frozen": "2026-10-28", "rulesAtFreeze": "rules/2", "parserAtFreeze": "chatgpt-json/1",
        "coreSourceHashEncoding": "UTF-8 text normalized to LF", "coreSourceSha256": sha(sources), "coreSources": sources,
        "derivedFrom": {"file": "heldout-v2.json", "rawSha256": old_hash, "labelSha256": previous["labelSha256"]},
        "labelAudit": {"status": "pending", "minimumFraction": 0.2},
    }
    target.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    (HERE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Frozen v3: {len(data['labels'])} labels, {len(data['sensitivityCases'])} sensitivity cases, SHA-256 {sha(data)}. No extractor run.")
