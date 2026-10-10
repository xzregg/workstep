import logging
from workstep_gateway_protocol.hooks import HookAccessLogFilter
from workstep_gateway_protocol.project_scope import project_http_route_allowed


def test_hook_log_filter_removes_all_query_values():
    record = logging.LogRecord('uvicorn.access', logging.INFO, '', 1, '%s - "%s %s HTTP/%s" %s',
                               ('peer', 'POST', '/api/hook/device/hook?token=secret&creator=private', '1.1', 201), None)
    HookAccessLogFilter().filter(record)
    assert 'secret' not in record.getMessage() and 'private' not in record.getMessage()
    assert '/api/hook/device/hook' in record.getMessage()


def test_project_hook_configuration_is_edit_only_and_project_bound():
    for method in ['GET', 'PUT']:
        path = '/api/workflow/flow/hooks'
        assert project_http_route_allowed(method, path, [('project_id', 'visible')], 'visible', access_level='edit')
        assert not project_http_route_allowed(method, path, [('project_id', 'visible')], 'visible', access_level='read')
        assert not project_http_route_allowed(method, path, [('project_id', 'private')], 'visible', access_level='edit')


def test_notification_configuration_history_and_actions_are_edit_only():
    root='/api/workflow/flow/notification-hooks'
    for method,path in [('GET',root),('PUT',root),('POST',root+'/preview'),('POST',root+'/hook/test'),('GET',root+'/hook/deliveries'),('POST',root+'/hook/deliveries/record/retry')]:
        assert project_http_route_allowed(method,path,[('project_id','p')],'p',access_level='edit')
        assert not project_http_route_allowed(method,path,[('project_id','p')],'p',access_level='read')
        assert not project_http_route_allowed(method,path,[('project_id','other')],'p',access_level='edit')
    assert not project_http_route_allowed('POST',root+'/arbitrary',[('project_id','p')],'p',access_level='edit')
