export function normalizeReference(text, arabic = false) {
  let value=String(text).normalize('NFKC').toLowerCase();
  if(arabic) value=value.replace(/[\u064b-\u065f\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي');
  return value.replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
}
export function editDistance(a,b) { let row=Array.from({length:b.length+1},(_,i)=>i); for(let i=0;i<a.length;i++){const next=[i+1];for(let j=0;j<b.length;j++) next.push(Math.min(row[j+1]+1,next[j]+1,row[j]+(a[i]===b[j]?0:1)));row=next;}return row[b.length]; }
export function accuracy(reference,hypothesis,{arabic=false,normalize=true}={}) {
  const a=normalize?normalizeReference(reference,arabic):String(reference), b=normalize?normalizeReference(hypothesis,arabic):String(hypothesis);
  const words=a.match(/\S+/g)||[], candidate=b.match(/\S+/g)||[]; const chars=[...a], other=[...b];
  return {wordErrors:editDistance(words,candidate),referenceWords:words.length,wer:words.length?editDistance(words,candidate)/words.length:null,charErrors:editDistance(chars,other),referenceChars:chars.length,cer:chars.length?editDistance(chars,other)/chars.length:null};
}
