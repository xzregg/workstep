"""Friendly labels for legacy synthetic enterprise roots, without changing identities."""


def directory_name(name, parent_external_id, provider, tenant_id):
    if parent_external_id is None and name == tenant_id:
        return {'dingtalk': '钉钉组织', 'wecom': '企业微信组织'}.get(provider, '企业组织')
    return name
