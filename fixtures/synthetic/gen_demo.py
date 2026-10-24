import json, sys
def msg(mid, role, text, t, hidden=False, ctype="text", extra=None):
    m = {"id": mid, "author": {"role": role}, "create_time": t, "content": {"content_type": ctype, "parts": [text]}}
    if hidden: m["metadata"] = {"is_visually_hidden_from_conversation": True}
    if extra: m.update(extra)
    return m
def convo(cid, title, t, chain, branches=(), current=True, no_time=False):
    mapping = {}
    prev = None
    for node_id, m in chain:
        mapping[node_id] = {"id": node_id, "parent": prev, "children": [], "message": m}
        if prev: mapping[prev]["children"].append(node_id)
        prev = node_id
    for node_id, parent, m in branches:
        mapping[node_id] = {"id": node_id, "parent": parent, "children": [], "message": m}
        mapping[parent]["children"].append(node_id)
    c = {"id": cid, "title": title, "mapping": mapping}
    if not no_time:
        c["create_time"] = t; c["update_time"] = t + 600
    if current: c["current_node"] = prev
    return c
D1, D2, D3 = 1704880800, 1717322400, 1719828000  # 2024-01-10, 2024-06-02, 2024-07-01
convs = [
  convo("demo-intro", "Getting started", D1, [
    ("sys", msg("sys", "system", "You are ChatGPT.", D1, hidden=True)),
    ("ctx", {"id": "ctx", "author": {"role": "user"}, "create_time": D1, "content": {"content_type": "user_editable_context", "user_profile": "SYNTHETIC CARRIER: about-me text (never imported)", "user_instructions": "SYNTHETIC CARRIER: custom instructions (never imported)"}}),
    ("u1", msg("u1", "user", "Hi! My name is Ada Quin. I live in Austin and I work as a librarian at the city library.", D1 + 60)),
    ("a1", msg("a1", "assistant", "Nice to meet you, Ada. You live in Paris, right?", D1 + 70)),
    ("u2", msg("u2", "user", "No. I like hiking. I have a peanut allergy.", D1 + 120)),
    ("a2", msg("a2", "assistant", "Noted.", D1 + 130)),
  ], branches=[("u2-old", "a1", msg("u2-old", "user", "I live in Atlantis.", D1 + 100))]),
  convo("demo-move", "Moving update", D2, [
    ("u1", msg("u1", "user", "Actually, my name is Ada Quinn, not Ada Quin.", D2 + 60)),
    ("a1", msg("a1", "assistant", "Thanks for the correction.", D2 + 70)),
    ("u2", msg("u2", "user", "I moved to Denver.\r\nMy salary is $64,000.", D2 + 120)),
    ("t1", msg("t1", "tool", "search results: I live in Secretville", D2 + 125)),
    ("a2", msg("a2", "assistant", "Congratulations on the move.", D2 + 130)),
  ]),
  convo("demo-work-a", "Work notes", 0, [
    ("u1", msg("u1", "user", "I work at Globex.", None)),
    ("a1", msg("a1", "assistant", "Got it.", None)),
  ], no_time=True),
  convo("demo-work-b", "More work notes", 0, [
    ("u1", msg("u1", "user", "I work at Initech.", None)),
  ], no_time=True),
  convo("demo-prefs", "Weekend plans", D3, [
    ("u1", msg("u1", "user", "I like jazz. I no longer like hiking.", D3 + 60)),
    ("u2", msg("u2", "user", "My friend says I live in Paris. If I live in Rome, I would be happy. Do I work at NASA?", D3 + 120)),
    ("u3", msg("u3", "user", "```\nI live in Tooltown\n```", D3 + 180)),
    ("u4", msg("u4", "user", "\U0001F389 I love dark chocolate.", D3 + 240)),
    ("u5", msg("u5", "user", "Please forget that I like jazz.", D3 + 300)),
  ]),
  convo("demo-branchless", "Missing current node", D3, [
    ("u1", msg("u1", "user", "I like tea.", D3 + 400)),
  ], current=False),
]
OUT = {"id": "synthetic-demo-v1", "notes": "Wholly synthetic ChatGPT-shaped export for the built-in local demo. Not a real person's data. Carrier text is marked SYNTHETIC CARRIER and must never appear in candidates or outputs.", "export": convs}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, ensure_ascii=False, indent=1)
