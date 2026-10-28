"""Static fixture integrity only: never imports/runs the parser or extractor."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def sha(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
assert manifest["activeHeldoutFile"] == "heldout-v2.json"
assert manifest["files"]["heldout.json"]["status"] == "contaminated-v1-regression-only"
ids, texts = {}, {}
for filename, meta in manifest["files"].items():
    dataset = json.loads((HERE / filename).read_text(encoding="utf-8"))
    assert sha(dataset) == meta["labelSha256"], filename
    assert len(dataset["labels"]) == meta["labels"]
    assert len(dataset["export"]) == meta["conversations"]
    assert len(dataset["eligibility"]) == meta["eligibilitySentences"]
    messages = {(conv["id"], node["message"]["id"]): node["message"]["content"]["parts"][0]
                for conv in dataset["export"] for node in conv["mapping"].values()}
    label_ids = {label["id"] for label in dataset["labels"]}
    assert len(label_ids) == len(dataset["labels"])
    for label in dataset["labels"]:
        assert label["quote"] in messages[(label["conversationId"], label["messageId"])].replace("\r\n", "\n").replace("\r", "\n"), label["id"]
    for group in dataset["groups"]:
        assert set(group["members"]) <= label_ids
    ids[filename] = {conv["id"] for conv in dataset["export"]}
    texts[filename] = set(messages.values()) | {row["text"] for row in dataset["eligibility"]}
fresh = manifest["files"]["heldout-v2.json"]
for prior in ("dev.json", "heldout.json"):
    assert not ids[prior] & ids["heldout-v2.json"]
    assert not texts[prior] & texts["heldout-v2.json"]
assert fresh["eligibilitySentences"] >= 40
assert fresh["labels"] + manifest["files"]["dev.json"]["labels"] >= 40
sources = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in fresh["coreSources"]}
assert sources == fresh["coreSources"], "core bytes changed since freeze"
assert sha(sources) == fresh["coreSourceSha256"]
# what_bug_this_catches: rerunning an old/new generator must not replace a frozen edition.
before = {p.name: p.read_bytes() for p in HERE.glob("*.json")}
for script, args in (("gen_eval.py", [str(HERE)]), ("gen_heldout_v2.py", [])):
    result = subprocess.run([sys.executable, "-I", str(HERE / script), *args], capture_output=True)
    assert result.returncode != 0 and b"Refusing" in result.stderr, script
assert before == {p.name: p.read_bytes() for p in HERE.glob("*.json")}
print("PASS: hashes, exact quotes, references, split disjointness, sizes, unchanged core and overwrite guards. No extractor executed.")
