from workstep_gateway_protocol import project_http_route_allowed as allowed


def test_speech_project_edit_access_cannot_manage_host_models():
    for method, path in [('GET', '/api/speech'), ('POST', '/api/speech/sessions'),
                         ('POST', '/api/speech/sessions/'+'a'*32+'/audio'),
                         ('DELETE', '/api/speech/sessions/'+'a'*32)]:
        assert allowed(method, path, [('project_id', 'p')], 'p', access_level='edit')
        if method != 'GET':
            assert not allowed(method, path, [('project_id', 'p')], 'p', access_level='read')
        assert not allowed(method, path, [('project_id', 'other')], 'p', access_level='edit')
        assert not allowed(method, path, [('project_id', 'p'), ('project_id', 'p')], 'p', access_level='edit')
    for method, path in [('POST', '/api/speech/models/download'), ('PUT', '/api/speech/settings'),
                         ('DELETE', '/api/speech/models/current')]:
        assert not allowed(method, path, [('project_id', 'p')], 'p', access_level='edit')
