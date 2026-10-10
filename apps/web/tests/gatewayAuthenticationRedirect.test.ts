import assert from 'node:assert/strict'
import test from 'node:test'
import { gatewayAuthenticationRedirect } from '../src/utils/gatewayWorkspacePath'

test('only an explicit local managed login expiry redirects to gateway authentication', () => {
 assert.equal(gatewayAuthenticationRedirect(new Response(null,{status:401,headers:{'X-WorkStep-Gateway-Login':'/gateway/login'}})),'/gateway/login')
 assert.equal(gatewayAuthenticationRedirect(new Response(null,{status:401})),null)
 assert.equal(gatewayAuthenticationRedirect(new Response(null,{status:403,headers:{'X-WorkStep-Gateway-Login':'/gateway/login'}})),null)
 assert.equal(gatewayAuthenticationRedirect(new Response(null,{status:401,headers:{'X-WorkStep-Gateway-Login':'https://evil.test'}})),null)
})
