import struct, json, sys, collections

COMPONENT_TYPE={5120:'BYTE',5121:'UBYTE',5122:'SHORT',5123:'USHORT',5125:'UINT',5126:'FLOAT'}
NUMCOMP={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
TYPESZ={5126:4,5125:4,5123:2,5121:1,5122:2,5120:1}

def load(path):
    data=open(path,'rb').read()
    off=12; jc=None; bc=None
    while off<len(data):
        clen,ctype=struct.unpack('<I4s',data[off:off+8])
        if ctype==b'JSON': jc=data[off+8:off+8+clen]
        elif ctype==b'BIN\x00': bc=data[off+8:off+8+clen]
        off+=8+clen
    return json.loads(jc), bc or b''

def acc(g,i):
    a=g['accessors'][i]
    bv=a.get('bufferView')
    d='inline' if bv is None else ('BIN' if g['bufferViews'][bv].get('byteOffset',0)>=0 else '?')
    return f"[{i}] {a['type']}/{COMPONENT_TYPE[a['componentType']]} n={a['count']} min={a.get('min')} max={a.get('max')} bv={d}"

def report(path):
    g,bc=load(path)
    print('='*72); print(path, 'binlen', len(bc))
    for k in ['scene','nodes','meshes','materials','skins','animations','textures','images','samplers','accessors','bufferViews','buffers']:
        v=g.get(k)
        print(f'  {k}:', len(v) if isinstance(v,list) else v)
    # node summary
    nodes=g.get('nodes',[])
    print('  nodes with mesh:',sum(1 for n in nodes if 'mesh' in n),'with skin:',sum(1 for n in nodes if 'skin' in n),'with cam:',sum(1 for n in nodes if 'camera' in n),'roots approx:', sum(1 for n in nodes if 'children' in n and len(n['children'])>3))
    names=[n.get('name') for n in nodes]
    print('  first 25 node names:', names[:25])
    # meshes primitives attributes
    attrcount=collections.Counter()
    priminfo=[]
    for mi,m in enumerate(g.get('meshes',[])):
        for p in m['primitives']:
            attrs=tuple(sorted(p['attributes'].keys()))
            attrcount[attrs]+=1
            priminfo.append((mi,m.get('name'),attrs,p.get('material'),p.get('mode'),list(p['indices'] if 'indices' in p else [])))
    print('  primitive attribute sets:')
    for k,v in attrcount.items(): print('   ',v,k)
    print('  sample prims (mesh,name,attrs,mat,mode,idxacc):', priminfo[:12])
    # materials
    mats=g.get('materials',[])
    used=set()
    for m in g.get('meshes',[]):
        for p in m['primitives']:
            if 'material' in p: used.add(p['material'])
    print('  materials used:',len(used),'of',len(mats))
    for i in sorted(used)[:14]:
        mt=mats[i]; pbr=mt.get('pbrMetallicRoughness',{})
        tex={}
        for key in ['baseColorTexture','metallicRoughnessTexture','normalTexture','emissiveTexture','occlusionTexture']:
            t=mt.get(key) or pbr.get(key)
            if t: tex[key]=t['index']
        print(f'   mat[{i}] {mt.get("name")} base={pbr.get("baseColorFactor")} mr={pbr.get("metallicFactor")},{pbr.get("roughnessFactor")} dbl={mt.get("doubleSided")} tex={tex}')
    # skins
    for si,s in enumerate(g.get('skins',[])[:6]):
        jn=s['joints']
        print(f'  skin[{si}] name={s.get("name")} joints={len(jn)} inverseMats={acc(g,s["inverseBindMatrices"]) if "inverseBindMatrices" in s else None} root={s.get("skeleton")}')
        print('    joint names:', [names[j] for j in jn[:20]])
    # animations
    for ai,a in enumerate(g.get('animations',[])[:5]):
        chans=a['channels']; kinds=collections.Counter(c['target']['path'] for c in chans)
        print(f'  anim[{ai}] name={a.get("name")} channels={len(chans)} {dict(kinds)} samplers={len(a["samplers"])}')
    # accessors referenced by meshes/skins
    refs=set()
    for m in g.get('meshes',[]):
        for p in m['primitives']:
            if 'indices' in p: refs.add(p['indices'])
            for v in p['attributes'].values(): refs.add(v)
    for s in g.get('skins',[]):
        if 'inverseBindMatrices' in s: refs.add(s['inverseBindMatrices'])
    print('  accessor index range used by geo/skins: max', max(refs) if refs else None, 'count', len(refs))
    # buffers/images
    for bi,b in enumerate(g.get('buffers',[])):
        print(f'  buffer[{bi}] uri={b.get("uri")} len={b["byteLength"]}')
    imgs=g.get('images',[])
    print('  images:', [(i.get('mimeType'), i.get('bufferView'), (i.get('uri') or '')[:40]) for i in imgs][:12])
    print('  textures sampler/usage:', [(t.get('sampler'), t.get('source')) for t in g.get('textures',[])][:12])
    # node transform stats
    tr=collections.Counter()
    for n in nodes:
        k=tuple(sorted(x for x in ['translation','rotation','scale','matrix'] if x in n))
        tr[k]+=1
    print('  node transform kinds:', dict(tr))
    print('  scenes:', g.get('scenes'), 'scene', g.get('scene'))
    exts = g.get('extensionsRequired'), g.get('extensionsUsed')
    print('  extensionsReq/Used:', exts)
    return g,bc

for p in sys.argv[1:]:
    report(p)
