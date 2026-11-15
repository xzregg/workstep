export const STOP_DIGITAL_SPEECH='workstep:digital-person-stop-speech'
export const DIGITAL_OUTPUT_FRAME='workstep:digital-person-output-frame'
export interface DigitalOutputFrame {projectId:string;sessionId:string|null;playing:boolean;level:number;busy?:boolean}
export function stopDigitalSpeech(projectId:string,sessionId:string|null){
 window.dispatchEvent(new window.CustomEvent(STOP_DIGITAL_SPEECH,{detail:{projectId,sessionId}}))
}
