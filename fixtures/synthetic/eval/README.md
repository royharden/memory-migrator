# Synthetic evaluation editions

The active edition is heldout-v3.json, frozen on 2026-10-28 for rules/2 and
chatgpt-json/1. It revises v2 after independent reviewer 0094 returned three
findings. It has 30 labels (25 supported, five unsupported) across six synthetic
conversations, five reasoned groups, eight sensitivity cases covering all six
categories, and 40 eligibility sentences. It is a revised synthetic smoke split,
not a fresh unseen benchmark.

The added unsupported family/minor assertion affects the whole-corpus denominator.
A separate unsupported married-partner assertion and sensitivity case cover intimate
relationships. Every label carries its exact assertion, eligible/durable flags,
conflict membership/rationale and source Evidence: canonical conversation digest,
conversation/message IDs, role, message/quote hashes, half-open code-point offsets,
parser version and source time. An emoji before a quote verifies offset units.

Conversation digests use the parser's documented projection v1. The Node regression
checks every label against the real parser and evidence validator without invoking
the extractor. The scorer consumes pinned spans and refuses invalid pins rather
than searching for another occurrence. Legacy labels lacking pins require unique
quotes; an ambiguous legacy quote is refused.

heldout-v2.json is retained byte-for-byte with its original canonical hash and
recorded independent RETURN. heldout.json is contaminated v1 regression material;
dev.json retains its original rules/1 freeze. The v3 manifest records the raw v2
hash, lineage and current pure-core hashes (UTF-8/LF). V3's source author used the
independent findings, not extractor predictions. No extraction run or rule tuning
occurred. A separate independent v3 review remains pending.

Do not overwrite frozen data. All three generators refuse to overwrite a newer
or existing frozen edition. Use a new version for future label changes.
Run static integrity with:
    python -I fixtures/synthetic/eval/verify_integrity.py
Run the isolated parser/evidence regressions with Node 24+:
    npm run test:fixture-v3
These checks are not extraction accuracy measurements, app validation or product
acceptance. No real-user data or third-party benchmark data is included.
