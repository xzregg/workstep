import {request} from './transport'
export const FACE_MODEL_VERSION='human-3.3.6-faceres-1024-v1'
export interface FaceSettings {enabled:boolean;show_boxes?:boolean;show_names:boolean;show_relationship?:boolean;include_people:boolean;include_relationship:boolean;preset:'balanced'|'light'|'clear';threshold:number}
export const includesFaceContext=(settings:FaceSettings)=>settings.include_people&&settings.include_relationship
export interface FacePerson {id:string;name:string;relationship:string;notes:string;enabled:boolean;sample_count:number;created_at:string;updated_at:string}
export interface FaceSample {id:string;model_version:string;created_at:string}
export interface FaceFramePerson {person_id:string;name:string;relationship?:string}
export interface FaceWelcomeSettings {enabled:boolean;phrases:string[];output:'text'|'voice';away_minutes:number;person_cooldown_minutes:number;interval_minutes:number;hourly_limit:number;daily_limit:number}
export interface FaceWelcome {text:string;speak:boolean;personalized:boolean}
export interface FaceWelcomeCandidate {event_id:string;person_id:string;revision:number}
export interface FaceCatalog {welcome?: Pick<FaceWelcomeSettings,'enabled'|'away_minutes'>|null;revision:number;model_version:string;settings:FaceSettings;people:Array<Pick<FacePerson,'id'|'name'|'relationship'> & {embeddings:number[][]}>}
export type FaceEdit=Pick<FacePerson,'name'|'relationship'|'notes'|'enabled'>
const body=(value:unknown,method='POST')=>({method,body:JSON.stringify(value)})
const base='/digital-person/faces'
export const faceApi={
 welcomeSettings:()=>request<FaceWelcomeSettings>(base+'/welcome'),
 saveWelcome:(settings:FaceWelcomeSettings)=>request<FaceWelcomeSettings>(base+'/welcome',body(settings,'PUT')),
 offerWelcome:(value:FaceWelcomeCandidate,signal:AbortSignal)=>request<FaceWelcome|null>(base+'/welcome/offer',{...body(value),signal}),
 settings:()=>request<{settings:FaceSettings;revision:number}>(base+'/settings'),
 saveSettings:(settings:FaceSettings)=>request<{settings:FaceSettings;revision:number}>(base+'/settings',body(settings,'PUT')),
 people:()=>request<{items:FacePerson[]}>(base+'/people'),
 create:(value:FaceEdit & {consent:true;embeddings:number[][];model_version:string})=>request<FacePerson>(base+'/people',body(value)),
 update:(id:string,value:FaceEdit)=>request<FacePerson>(base+`/people/${encodeURIComponent(id)}`,body(value,'PUT')),
 delete:(id:string)=>request(base+`/people/${encodeURIComponent(id)}`,{method:'DELETE'}),
 samples:(id:string)=>request<{items:FaceSample[]}>(base+`/people/${encodeURIComponent(id)}/samples`),
 addSamples:(id:string,embeddings:number[][])=>request<FacePerson>(base+`/people/${encodeURIComponent(id)}/samples`,body({embeddings,model_version:FACE_MODEL_VERSION})),
 deleteSample:(id:string,sid:string)=>request(base+`/people/${encodeURIComponent(id)}/samples/${encodeURIComponent(sid)}`,{method:'DELETE'}),
 catalog:()=>request<FaceCatalog>(base+'/catalog'),
 revision:()=>request<{revision:number}>(base+'/revision'),
 context:(person_ids:string[],unknown_count:number)=>request<{people:FaceFramePerson[];text:string}>(base+'/context',body({person_ids,unknown_count})),
}
