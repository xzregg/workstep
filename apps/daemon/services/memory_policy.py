"""Admission rules shared by extraction, validation feedback and evaluation."""

RULES = '''Memory admission and maintenance:
- preference: keep a specific reusable choice with its conditions and exceptions. A one-off request (such as skipping tests for this run) is not an unconditional preference. Separate unrelated topics.
- fact: preserve who stated it, its subject and applicability. Assistant claims remain attributed reports.
- event: preserve what happened and its time, project and outcome. Similar incidents on different dates remain distinct events.
- experience: retain the evidenced situation, action and result, limitations and failed attempts. Plans and generic advice alone are not execution experience.
- No useful durable information means no memory changes. Retain only useful changes, rather than one item per message or paraphrases that inflate counts.
- Canonical names and aliases need explicit evidence. Same surname or similar project names do not establish identity. Keep uncertain identities separate; preserve project, team, role and date distinctions. Relative dates refer to the source message time.
- Before replacing knowledge, search by the batch's specific entities/topic, then use memory read on the selected knowledge ID until fully read. Search summaries alone are insufficient. This lookup is for maintaining knowledge, not discovering old work or new notification reasons.
- Use supersedes only for fully read knowledge IDs about the same subject and applicability. Preserve relevant old conditions and supported information in the replacement. Keep unrelated facts and separate events distinct. An unresolved contradiction remains a conflict; recency alone is not proof.
- Return new source-backed statements when identity or replacement scope is uncertain. Keep only evidenced entities and statements. Related old knowledge is background, not new evidence for this batch's notifications or affinity.
'''


def validate_memories(decision, context, existing=()):
    from services.memory_knowledge import _validate
    memories=decision.get('memories',[])
    if not isinstance(memories,list) or len(memories)>24:
        raise ValueError('memories must be an array of at most 24 candidates')
    available={int(r['id']):r for r in context.get('reflection_batch',[]) if r.get('needs_knowledge',True)}
    for number,item in enumerate(memories,1):
        try:
            value=_validate(item,available)
            if not {f'knowledge:{k}' for k in value['supersedes']}.issubset(existing):
                raise ValueError('supersedes requires fully read knowledge IDs; never use source message IDs')
        except (ValueError,TypeError,KeyError) as exc:
            raise ValueError(f'memories[{number}]: {exc}') from None
