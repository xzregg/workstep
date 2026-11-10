from . import ChannelDirectoryProvider


class FeishuDirectory(ChannelDirectoryProvider):
    domain = 'https://open.feishu.cn'

    async def fetch_snapshot(self):
        async with self.client() as client:
            root = self.domain + '/open-apis/'
            token = (await self.request(client, 'POST', root+'auth/v3/tenant_access_token/internal',
                json={'app_id':self.bot['app_id'], 'app_secret':self.bot['secret']}))['tenant_access_token']
            headers = {'Authorization':'Bearer '+token}
            queue, visited, people = [('0', '根部门')], set(), {}
            while queue:
                id, name = queue.pop(0)
                if id in visited:
                    continue
                visited.add(id)
                if len(visited) > 10000:
                    raise ValueError('Too many departments')
                for kind in ('departments', 'users'):
                    path = f'contact/v3/departments/{id}/children' if kind == 'departments' else 'contact/v3/users/find_by_department'
                    params = {'department_id_type':'open_department_id', 'page_size':50}
                    if kind == 'departments':
                        params['fetch_child'] = 'false'
                    else:
                        params.update(department_id=id, user_id_type='open_id')
                    seen = set()
                    while True:
                        page = (await self.request(client, 'GET', root+path, headers=headers, params=params))['data']
                        for row in page.get('items', []):
                            if kind == 'departments':
                                queue.append((str(row['open_department_id']), row['name']))
                            elif not any(row.get('status', {}).get(key) for key in ('is_resigned','is_frozen','is_exited')):
                                self.add(people, row['open_id'], row.get('name'), [name])
                        token = self.next_page(page, seen)
                        if token is None:
                            break
                        params['page_token'] = token
            return list(people.values())
