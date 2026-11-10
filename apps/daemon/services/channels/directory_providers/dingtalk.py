from . import ChannelDirectoryProvider


class DingTalkDirectory(ChannelDirectoryProvider):
    async def fetch_snapshot(self):
        async with self.client() as client:
            auth = await self.request(client, 'POST', 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
                json={'appKey':self.bot['app_id'], 'appSecret':self.bot['secret']})
            params = {'access_token':auth['accessToken']}
            queue, visited, people = [('1', '根部门')], set(), {}
            while queue:
                id, name = queue.pop(0)
                if id in visited:
                    continue
                visited.add(id)
                if len(visited) > 10000:
                    raise ValueError('Too many departments')
                children = await self.request(client, 'POST', 'https://oapi.dingtalk.com/topapi/v2/department/listsub',
                    params=params, json={'dept_id':int(id)})
                queue.extend((str(row['dept_id']), row['name']) for row in children['result'])
                cursor, seen = 0, {'0'}
                while True:
                    page = (await self.request(client, 'POST', 'https://oapi.dingtalk.com/topapi/v2/user/list',
                        params=params, json={'dept_id':int(id), 'cursor':cursor, 'size':100}))['result']
                    for row in page['list']:
                        self.add(people, row['userid'], row.get('name'), [name])
                    cursor = self.next_page(page, seen, 'next_cursor')
                    if cursor is None:
                        break
            return list(people.values())
