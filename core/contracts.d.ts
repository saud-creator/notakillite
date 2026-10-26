/** UI/Core protocol v2. Native browser messaging retains its independent protocol v1. */
export type JobStatus = 'queued'|'running'|'paused'|'done'|'needs-review'|'cancelled'|'error'|'interrupted';
export type ResourcePolicy = 'auto'|'background'|'maximum';
export type Backend = 'auto'|'cpu'|'vulkan'|'cuda';
export interface ProcessingProfile { model:'tiny'|'base'|'turbo'|'large-v3'; language:'auto'|'en'|'ar'; resourcePolicy:ResourcePolicy; backend:Backend; threads:number; workers:number; chunkSeconds:0|30|60|120; ocr:boolean; }
export interface Finding { start:number; end:number; kind:string; detail?:string; }
export interface TranscriptSegment { id:string; start:number; end:number; rawText:string; text:string; marker?:boolean; manuallyEdited?:boolean; pdfReferences?:{file:string;page:number;score:number;verified:false}[]; }
export interface TranscriptDocument { schemaVersion:1; revision:number; reviewStatus:'unreviewed'|'edited'; segments:TranscriptSegment[]; quality:{status:'ok'|'repaired'|'needs-review';findings:Finding[]}; history:{revision:number;segmentId:string;before:string;after:string;at:string}[]; }
export interface EditRequest { id:string; revision:number; segmentId:string; text:string; }
export interface RetryPassageRequest { id:string; revision:number; segmentId:string; }
export interface CoreRequest { id:number; type:string; params:unknown; }
export type CoreResponse = {id:number;result:unknown}|{id:number;error:string;code:string};
