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


def test_speech_output_project_sessions_cannot_manage_host_configuration():
    for method, path in [('GET', '/api/speech-output'), ('POST', '/api/speech-output/sessions'),
                         ('POST', '/api/speech-output/sessions/' + 'a' * 32 + '/next'),
                         ('DELETE', '/api/speech-output/sessions/' + 'a' * 32)]:
        assert allowed(method, path, [('project_id', 'p')], 'p', access_level='edit')
        assert not allowed(method, path, [('project_id', 'other')], 'p', access_level='edit')
        if method != 'GET':
            assert not allowed(method, path, [('project_id', 'p')], 'p', access_level='read')
    for method, path in [('PUT', '/api/speech-output/settings'), ('POST', '/api/speech-output/models/download'),
                         ('POST', '/api/speech-output/models/delete'), ('POST', '/api/speech-output/models/unload'),
                         ('POST', '/api/speech-output/voices')]:
        assert not allowed(method, path, [('project_id', 'p')], 'p', access_level='edit')


def test_call_voiceprint_flag_preserves_project_scope_and_host_boundary():
    query = [('project_id', 'p'), ('phone_call', 'true')]
    assert allowed('POST', '/api/speech/sessions', query, 'p', access_level='edit')
    assert not allowed('POST', '/api/speech/sessions', query, 'p', access_level='read')
    assert not allowed('POST', '/api/speech/sessions', query, 'other', access_level='edit')
    for method, suffix in [('PUT', '/settings'), ('POST', '/enroll'), ('POST', '/test'),
                           ('POST', '/download'), ('POST', '/cancel'), ('DELETE', '/download'), ('DELETE', '')]:
        assert not allowed(method, '/api/speech/voiceprint' + suffix, [('project_id', 'p')], 'p', access_level='edit')
