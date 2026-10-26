"""Developer-only streaming fallback when the dataset rows service is unavailable.
Downloads public reference text and only the first N matching audio members, never
extracts tar paths. Python 3 stdlib and curl are required; no desktop dependency.
"""
import csv, hashlib, io, json, pathlib, subprocess, sys, tarfile
out = pathlib.Path(sys.argv[1] if len(sys.argv)>1 else '.local/fleurs')
count = int(sys.argv[2]) if len(sys.argv)>2 else 2
if not 1<=count<=100: raise ValueError('Use 1–100 fixtures per language')
out.mkdir(parents=True,exist_ok=True)
def fetch(url): return subprocess.check_output(['curl','-fsSL','--max-time','60',url])
revision=sys.argv[3] if len(sys.argv)>3 else json.loads(fetch('https://huggingface.co/api/datasets/google/fleurs'))['sha']
fixtures=[]
for config,language in [('en_us','en'),('ar_eg','ar')]:
    base=f'https://huggingface.co/datasets/google/fleurs/resolve/{revision}/data/{config}'
    rows=list(csv.reader(io.StringIO(fetch(base+'/test.tsv').decode()),delimiter='\t'))
    references={row[1]:row for row in rows}
    child=subprocess.Popen(['curl','-fsSL',base+'/audio/test.tar.gz'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    selected=0; sentences=set()
    try:
        with tarfile.open(fileobj=child.stdout,mode='r|gz') as archive:
            for member in archive:
                name=pathlib.PurePosixPath(member.name).name
                if not member.isfile() or member.size>20*1024**2 or name not in references: continue
                row=references[name]
                if row[3] in sentences: continue
                audio=archive.extractfile(member).read()
                target=f'{config}-{name}'; (out/target).write_bytes(audio)
                fixtures.append(dict(id=f'{config}-{row[0]}',audio=target,language=language,reference=row[2],referenceVerified=True,referenceOrigin='FLEURS public human transcription; no independent spot check',sha256=hashlib.sha256(audio).hexdigest(),source='google/fleurs',revision=revision,license='CC-BY-4.0',split='test',tuningAllowed=False))
                selected+=1;sentences.add(row[3])
                if selected>=count: break
    finally:
        child.stdout.close();child.terminate();child.wait()
    if selected<count: raise RuntimeError('Insufficient public fixtures')
manifest=dict(fixtures=fixtures,profiles=[dict(id='tiny-cli',options=dict(model='tiny',chunkSeconds=0,backend='cpu'))])
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2), encoding='utf-8')
print(json.dumps(dict(fixtures=len(fixtures),revision=revision,manifest=str(out/'manifest.json'))))
