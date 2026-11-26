"""Admission rules shared by extraction, validation feedback and evaluation."""

NOTIFICATION_RULES = ("Write notification summaries (top-level and delegation actions) in the companion's configured identity, personality and tone, speaking directly to the user in first person. "
                      "Do not describe yourself or the user as a third party. Name the task title or concrete subject in every notification; do not rely on another notice or vague references such as 'two changes'. "
                      "Follow existing reply agreements, including length and format; avoid repetition and unnecessary detail. "
                      "Otherwise, in 1-2 short sentences, name the user's concrete request, its new status and any needed decision. "
                      "Keep paths, logs and rule citations internal unless essential. Distinguish reported progress from verified results; "
                      "do not claim personal execution of delegated work.")

COMPACT_RULES = '''Store durable knowledge, not an activity log. Ask what future question or decision each item will help answer; omit routine acknowledgements, repeated completion reports, test counts, build logs, temporary paths and intermediate UI edits unless essential to a reusable lesson or an explicit user request to remember them. Consolidate repeated discussion of the same change into one current, source-backed conclusion; do not merge independent facts, distinct dated events or preferences with progress. Write 1-2 short sentences per summary (aim for 120 Chinese characters or 60 words); preserve subject, important dates, conditions, limitations and reported-versus-verified status. Longer text is justified only by necessary evidence-backed details. Preserve complete facts rather than truncating to meet a length target. Sources retain the full detail. Keep experience situation/action/result brief and complementary rather than repeating the summary. Omit optional empty/default fields and entities/relations that add no retrieval value. Candidate count is a ceiling, not a target; zero is valid.'''

KIND_RULES = '''Classify the meaning and subject, not wording such as want, must, always or default. Separate personal information from decisions about a product.
- preference: capture the user's explicitly stated personal likes, dislikes, habits and reusable expectations for interaction or collaboration: response language/length, communication, notifications, personal work methods or tool choices. Preserve conditions and exceptions. Repeated behavior alone remains tentative rather than a confirmed preference. A one-off request is not a standing preference. Task instructions, feature requirements, technical schemes and product constraints belong to events when worth retaining, even if intended to last. Using preset tags for OmniVoice is a product decision; liking a warm, slower voice is a personal preference. Do not mix implementation reports into preferences or infer a personal trait from a project choice. Separate unrelated topics.
- fact: preserve who stated it, its subject and applicability, including time/version limits. Keep stable identity, possessions, environment and established background distinct from progress. Requests and implementation reports are not established properties: record them as events, preserving reported versus verified status. Store new progress as a separate event. A proposed configuration is not the user's actual setting; one incident does not prove a permanent system limitation. Assistant claims remain attributed reports.
- event: preserve significant occurrences, project decisions/requirements, commitments, progress or results with time, project and outcome. Similar incidents on different dates remain distinct events. Preserve planned/reported/verified/failed status. Do not retain every intermediate request or completion report; skip low-value UI edits, test counts and discussion already represented by an equivalent conclusion. An event must help future recall, not merely document that a conversation happened.
- experience: retain the evidenced situation, action and result, applicability, limitations and failed attempts. Plans and generic advice alone are not execution experience. A completion report alone is an event; retain experience only when its concrete method or failure can inform a future similar problem. A problem/change/tests-passed template alone is insufficient: identify an evidenced mechanism, reproducible diagnostic/corrective method, or bounded comparison/failed attempt. An unexplained browser timeout or failed delivery is an event, not a reusable lesson. Do not invent causes, remedies or successful results; retain the limits of simulated or small-sample evidence.'''

RULES = COMPACT_RULES + '\n' + KIND_RULES + '\n' + '''Memory admission and maintenance:
- A request to remind the user or act at a particular time belongs in the schedule. The request and scheduling acknowledgment alone are not durable knowledge or a standing preference.
- Process each assigned conversation separately before combining related knowledge. Inventory its concrete events, dates, decisions, preferences and facts, then check that the candidates preserve those independently useful statements. Anchor yesterday/last weekday to that message timestamp. Keep different actions and organizations distinct even for the same person and topic.
- session_knowledge is a bounded directory of earlier knowledge linked to this batch's sessions. complete=false means omitted or older knowledge may exist; absence is not evidence of novelty. Use titles and summaries as maintenance clues, then CLI memory search by the specific subject/topic when needed. Read the full selected knowledge before supersedes. The directory does not count as a full read or new source evidence. Append distinct events; update only an explicitly corrected claim. Before final output, check each conversation again for omitted dated events and mismatched speakers.
- Write summaries, entity labels, relationship labels and experience fields in the dominant language of the supporting source messages, independent of the character, interface and reply language. For mixed-language batches, choose the source language for each memory separately. Preserve the original spelling of names, identifiers, error codes and quoted key terms. Identity aliases require source evidence; translated topic words are retrieval clues rather than proof of identity.
- Keep independently reusable facts in separate memories: preferences, possessions and stable identity remain distinct from project or personal progress. Store new progress as a separate event. An event cannot supersede a fact or preference. Reserve supersedes for an explicit correction of the same claim; after reading the old record, retain every still-supported independent detail and condition. If a replacement would omit a supported detail, keep the old record and add a separate memory.
- Resolve short answers from their explicit question and surrounding turns in the assigned conversation. Include the question's subject, time and purpose in the standalone summary, and cite both the question and answer when both supply meaning. Preserve different dates and different plans as separate events; the source timestamp anchors relative dates, while unknown dates remain unknown.
- Attribute a question to its explicit speaker and the answer or commitment to the answer's explicit speaker. Resolve I/you from those speakers in each turn; preserve speaker labels even when both messages share the same transport role.
- No useful durable information means no memory changes. Retain only useful changes, rather than one item per message or paraphrases that inflate counts.
- Canonical names and aliases need explicit evidence. Same surname or similar project names do not establish identity. Keep uncertain identities separate; preserve project, team, role and date distinctions. Relative dates refer to the source message time.
- source_ids contains only the current pending batch conversation.memory_ids supporting new statements. When supersedes names fully read old knowledge, its old source references are inherited automatically by the program; preserve old content through supersedes and cite current-batch sources for the update.
- Before replacing knowledge, search by the batch's specific entities/topic, then use memory read on the selected knowledge ID until fully read. Search summaries alone are insufficient. This lookup is for maintaining knowledge, not discovering old work or new notification reasons.
- Use supersedes only for fully read knowledge IDs about the same subject and applicability. Preserve relevant old conditions and supported information in the replacement. Keep unrelated facts and separate events distinct. An unresolved contradiction remains a conflict; recency alone is not proof.
- Return new source-backed statements when identity or replacement scope is uncertain. Keep only evidenced entities and statements. Related old knowledge is background, not new evidence for this batch's notifications or affinity.
'''


def validate_memories(decision, context, existing=()):
    from services.memory_knowledge import _validate
    memories=decision.get('memories',[])
    if not isinstance(memories,list):
        raise ValueError('memories must be an array')
    available={int(r['id']):r for r in context.get('reflection_batch',[]) if r.get('needs_knowledge',True)}
    for number,item in enumerate(memories,1):
        try:
            sources=item.get('source_ids',[]) if isinstance(item,dict) else []
            if isinstance(sources,list):
                allowed={f'memory:{mid}' for mid in available}
                unknown=[sid for sid in sources if isinstance(sid,str) and sid not in allowed]
                if unknown:
                    raise ValueError('Unknown evidence IDs: '+', '.join(unknown)+
                                     '. source_ids must cite this pending batch; older references are inherited through supersedes.')
            value=_validate(item,available)
            if not {f'knowledge:{k}' for k in value['supersedes']}.issubset(existing):
                raise ValueError('supersedes requires fully read knowledge IDs; never use source message IDs')
        except (ValueError,TypeError,KeyError) as exc:
            raise ValueError(f'memories[{number}]: {exc}') from None


def repair_instruction(error, context):
    """Precise, bounded feedback without source bodies or automatic evidence edits."""
    import json
    from services.memory_secrets import redact
    allowed=[f"memory:{int(row['id'])}" for row in context.get('reflection_batch',[]) if row.get('needs_knowledge',True)]
    return ('The assessment was not applied. Validation error: '+redact(str(error))[:1500]+
            '\nReturn a corrected complete assessment JSON for the same pending batch. '
            'Wrap the complete result in exactly one <json>...</json> pair. '
            'Finish the response with the literal closing tag </json> after the JSON object. '
            'Required top-level fields: decision (silent or notify), summary (string), source_ids (array of strings, [] is valid). '
            'Top-level summary must be empty when silent; use nonempty notification text when notify. '
            'Do not output notification_reason; delivery failures are recorded by the program. '
            + NOTIFICATION_RULES + ' '
            'These fields remain required for historical or memory-only batches; memories is an optional separate array. '
            'Allowed current-batch source_ids: '+json.dumps(allowed)+'. '
            'Earlier evidence is inherited automatically from fully read supersedes knowledge IDs. '
            'Preserve supported old information through that replacement; cite current-batch evidence for new changes. '
            'For missing relation endpoints, declare the evidenced entity or omit the unsupported relation. '
            'Preserve unaffected valid candidates and source IDs that actually support their statements. '+COMPACT_RULES+' '
            'Return valid JSON, escaping double quotes inside strings as \\" or using single quotes in prose. '
            'Do not send messages or repeat completed operations.')
