import assert from 'node:assert/strict'
import {test} from 'node:test'
import {departmentRoots,departmentScope,policySubjects,userDepartmentScope,summarizeSelection} from '../src/OrganizationSyncSelection'
const departments=[{external_id:'1',display_name:'公司'}, {external_id:'2',display_name:'研发',parent_external_id:'1'}, {external_id:'3',display_name:'新增子部门',parent_external_id:'2'}, {external_id:'4',display_name:'销售',parent_external_id:'1'}]
const users=['2','3','4'].map(id=>({subject:id,display_name:id,department_ids:[id],changed:true,skipped:false,excluded:false,kind:'new',after:{name:id,active:true,departments:[id]}}))
test('maintenance ranges distinguish whole company, department descendants and named identities',()=>{
 assert.deepEqual(departmentRoots(departments,['2','3']),['2'])
 assert.deepEqual(departmentScope(departments,['2']),['2','3'])
 assert.deepEqual(policySubjects({mode:'all',department_ids:[],subjects:[],excluded_subjects:[]},users,departments),['2','3','4'])
 assert.deepEqual(policySubjects({mode:'departments',department_ids:['2'],subjects:[],excluded_subjects:[]},users,departments),['2','3'])
 assert.deepEqual(policySubjects({mode:'users',department_ids:[],subjects:['2'],excluded_subjects:[]},users,departments),['2'])
 assert.deepEqual(userDepartmentScope(departments,users,['3']),['3','2','1'])
 const summary=summarizeSelection(users,[{external_id:'3',name:'新增子部门',kind:'new',changed:true},{external_id:'4',name:'销售',kind:'new',changed:true}],['3'],['1','2','3'])
 assert.equal(summary.people_added,1)
 assert.equal(summary.departments_added,1)
 assert.equal(summary.people,1)
})
