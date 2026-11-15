"""Small LLM-facing CLI views; the daemon/native-tool response stays unchanged."""
import json
import re


def _pick(value, fields):
    return {key:value[key] for key in fields if key in value}


def _summary(item):
    result = _pick(item, ('id','role','kind','outcome','state','event_time','created_at','needs_read','matched_entities','matched_relations'))
    original = str(item.get('summary') or item.get('content') or '')
    text = re.sub(r'\s+', ' ', original).strip()
    preview = text[:159] + '…' if len(text) > 160 else text
    title = str(item.get('title') or re.split(r'[。！？\n]', text)[0])[:40]
    result['title'] = title
    # Avoid repeating the title in both fields. These are deterministic excerpts,
    # not a new LLM-generated interpretation.
    summary = preview[len(title):].lstrip(' 。！？') if preview.startswith(title) else preview
    if summary:
        result['summary'] = summary
    if len(text) > 160 or 'content' in item:
        result['needs_read'] = True
    if item.get('sources'):
        result['source_ids'] = list(dict.fromkeys(s['id'] for s in item['sources'] if 'id' in s))
    return result


def compact(result, operation, *, events=False):
    if not isinstance(result, dict) or result.get('ok') is False or events or operation == 'pending':
        return result
    if operation == 'read':
        return _pick(result, ('id','content','role','created_at','source_kind','outcome',
                              'offset','next_offset','has_more','total_chars'))
    output = _pick(result, ('snapshot','has_more','next_cursor'))
    for field in ('items','knowledge'):
        if field in result:
            output[field] = [_summary(item) for item in result[field]]
    if 'coverage' in result:
        output['coverage'] = _pick(result['coverage'], ('basis','since','before','query','keyword_match','complete_filtered_history','complete_source_history',
            'unavailable_or_changed','unavailable_projects','snapshot_truncated'))
    if 'source_texts' in result:
        output['source_texts'] = [_pick(item, ('id','source_ids','project_id','session_id','source_message_id',
            'role','author_id','author_name','source_kind','outcome','created_at','content',
            'offset','next_offset','has_more','total_chars')) for item in result['source_texts']]
        output['source_coverage'] = result['source_coverage']
    return output


def render(result, operation):
    """Text rows plus a small machine-readable pagination/coverage footer."""
    if operation == 'pending':
        return json.dumps(result,ensure_ascii=False,separators=(',',':'))
    lines = []
    if operation == 'read':
        lines.append(str(result.get('id','')))
        lines.append(str(result.get('content','')))
        meta = {key:value for key,value in result.items() if key not in ('id','content')}
    else:
        for field in ('knowledge','items'):
            for item in result.get(field, []):
                lines.append(f"{item.get('id','')} | {item.get('title','')}")
                if item.get('summary'):
                    lines.append(item['summary'])
                details = {key:value for key,value in item.items() if key not in ('id','title','summary')}
                if details:
                    lines.append(json.dumps(details,ensure_ascii=False,separators=(',',':')))
        if not lines:
            lines.append('No results in this page.')
        for source in result.get('source_texts', []):
            lines.append(f"Source {source.get('id','')} | {source.get('role','')}")
            lines.append(source.get('content',''))
            lines.append(json.dumps({k:v for k,v in source.items() if k!='content'},ensure_ascii=False,separators=(',',':')))
        meta = {key:value for key,value in result.items() if key not in ('items','knowledge','source_texts')}
    if meta:
        lines.append(json.dumps(meta,ensure_ascii=False,separators=(',',':')))
    return '\n'.join(lines)
