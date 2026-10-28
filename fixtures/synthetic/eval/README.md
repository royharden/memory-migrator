# Synthetic evaluation editions

The active replacement is heldout-v2.json, frozen on 2026-10-28 for rules/2 and
chatgpt-json/1. Its manifest pins every pure-core TypeScript source hash before
fixture authorship. The author did not run the extractor or adjust its rules.
Labels follow the natural-language contract even where a narrow rule may miss
them. It has 28 labels in six new conversations plus 40 eligibility sentences.

heldout.json is retained byte-for-byte as contaminated v1 regression material.
It must not support held-out quality claims. dev.json remains the original dev
fixture; its per-file freeze metadata still records rules/1.

Do not tune rules against v2 or overwrite a frozen edition. Rule changes require
a new independent split before new held-out claims. gen_eval.py refuses to replace
a v2 manifest; gen_heldout_v2.py refuses to overwrite its frozen output.

Independent review of at least 20% of labels remains pending. Static integrity
checks are not an extraction run. No measured accuracy or product acceptance is
claimed. The fixtures ship in the offline demo and are synthetic smoke checks,
not a private benchmark or real-user data.
