import {request} from './transport'
export const FACE_MODEL_VERSION='human-3.3.6-faceres-1024-v1'
export interface FaceSettings {enabled:boolean;show_boxes?:boolean;show_names:boolean;include_people:boolean;include_relationship:boolean;preset:'balanced'|'light'|'clear';threshold:number}
export interface FacePerson {id:string;name:string;relationship:string;notes:string;enabled:boolean;sample_count:number;created_at:string;updated_at:string}
export interface FaceSample {id:string;model_version:string;created_at:string}
export interface FaceFramePerson {person_id:string;name:string;relationship?:string}
export interface FaceCatalog {revision:number;model_version:string;settings:FaceSettings;people:Array<Pick<FacePerson,'id'|'name'|'relationship'> & {embeddings:number[][]}>}
export type FaceEdit=Pick<FacePerson,'name'|'relationship'|'notes'|'enabled'>
const body=(value:unknown,method='POST')=>({method,body:JSON.stringify(value)})
const base='/digital-person/faces'
export const faceApi={
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
