from . import ChannelDirectoryProvider
from services.channels.directory import DirectoryError


class WeComDirectory(ChannelDirectoryProvider):
    fields = ('directory_corp_id', 'directory_agent_id', 'directory_secret')

    async def fetch_snapshot(self):
        if not all(self.bot.get(key) for key in self.fields):
            raise DirectoryError('directory_credentials', '请填写企业 ID、通讯录应用 Agent ID 和 Secret')
        async with self.client() as client:
            root = 'https://qyapi.weixin.qq.com/cgi-bin/'
            token = (await self.request(client, 'GET', root+'gettoken', params={
                'corpid':self.bot['directory_corp_id'], 'corpsecret':self.bot['directory_secret']}))['access_token']
            params = {'access_token':token}
            await self.request(client, 'GET', root+'agent/get',
                params={**params, 'agentid':self.bot['directory_agent_id']})
            departments = (await self.request(client, 'GET', root+'department/list', params=params))['department']
            names = {str(row['id']):row['name'] for row in departments}
            people = {}
            for department in departments:
                data = await self.request(client, 'GET', root+'user/list',
                    params={**params, 'department_id':department['id'], 'fetch_child':0})
                for row in data['userlist']:
                    if row.get('status') in (2, 5):
                        continue
                    # Directory/application IDs cannot be assumed to be bot IDs.
                    self.add(people, row['userid'], row.get('name'),
                        [names[str(id)] for id in row.get('department', []) if str(id) in names], send=False)
            return list(people.values())
