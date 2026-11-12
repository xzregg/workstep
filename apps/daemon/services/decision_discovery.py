"""Search only the reviewed models executable by the local inference worker."""
from services.decision_catalog import compatible_models


def search_models(query):
    query = query.strip().casefold()
    results = []
    models = compatible_models()
    for model in models:
        repo = model.get('repo_id', 'convaiinnovations/' + model['id'])
        if query and query not in (' '.join((repo, model['name'], model['description']))).casefold():
            continue
        multilingual = model['id'] == 'laya-multilingual'
        results.append({'id': repo, 'url': 'https://huggingface.co/' + repo,
            'license': model.get('license', 'apache-2.0'), 'languages': ['多语言，含中文'] if multilingual or model['id'].startswith('d1-') else ['en'],
            'parameters': (322000000 if multilingual else 421000000) if model.get('backend') != 'gguf' else None,
            'size_bytes': sum(file[1] for file in model['files']),
            'library': 'llama.cpp' if model.get('backend') == 'gguf' else 'laya', 'gated': False, 'supported': True, 'managed_model': model['id']})
    return {'models': results, 'limit': len(models)}
