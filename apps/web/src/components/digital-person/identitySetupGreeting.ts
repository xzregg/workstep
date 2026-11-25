import type {DigitalPersonProfile} from '../../api/digitalPerson'

export function identitySetupGreetingKey(profile:DigitalPersonProfile){
 const state=profile.identity_setup
 if(state?.status!=='pending'||state.paused)return null
 const step=(['name','role','personality','duties'] as const).find(key=>!(key in state.answers))??'confirm'
 return `digitalPerson.identitySetup_${step}` as const
}
