import base64
import json
import httpx
import pytest

from cli import build_parser, dispatch
from services.tool_registry import WorkstepClient


@pytest.mark.parametrize('kind',['image','file'])
async def test_cli_uploads_local_attachment_then_sends_project_reference(tmp_path,kind):
    path=tmp_path/('photo.png' if kind=='image' else 'report.pdf')
    path.write_bytes(b'attachment')
    calls=[]
    def handler(request):
        calls.append(request.url.path)
        body=json.loads(request.content)
        if request.url.path=='/api/fs/upload/file':
            assert request.url.params['project_id']=='p'
            assert base64.b64decode(body['data_url'].split(',')[1])==b'attachment'
            assert body['filename']==path.name
            return httpx.Response(200,json={'url':'.workstep/uploads/'+path.name})
        assert body['attachments']==[{'kind':kind,'path':'.workstep/uploads/'+path.name}]
        assert body['session_id']=='s'
        assert body.get('text','')==''
        return httpx.Response(200,json={'ok':True,'sent':True})
    args=build_parser().parse_args(['channel','send','--project','p','--session','s','--'+kind,str(path)])
    result=await dispatch(args,WorkstepClient(transport=httpx.MockTransport(handler)))
    assert result['sent']
    assert calls==['/api/fs/upload/file','/api/channel-bots/send']


async def test_cli_attachment_upload_failure_never_sends(tmp_path):
    path=tmp_path/'report.pdf';path.write_bytes(b'pdf')
    calls=[]
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(403,json={'detail':'denied'})
    args=build_parser().parse_args(['channel','send','--project','p','--session','s','--file',str(path)])
    result=await dispatch(args,WorkstepClient(transport=httpx.MockTransport(handler)))
    assert result['ok'] is False
    assert calls==['/api/fs/upload/file']
