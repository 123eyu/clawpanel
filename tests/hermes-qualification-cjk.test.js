// 字体视觉红灯先于实现；本文件只跑隔离契约/发布路径，不执行apt或本机GUI。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runner=path.join(root,'scripts/hermes-qualification-browser.py'),python=process.platform==='win32'?'python':'python3'
function py(body){const code=`import importlib.util,json,copy,tempfile,pathlib\nspec=importlib.util.spec_from_file_location('cjk',${JSON.stringify(runner)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndef reject(fn):\n try: fn()\n except (AssertionError,ValueError,KeyError): return\n raise AssertionError('negative accepted')\n`+body;const r=spawnSync(python,['-B','-X','utf8','-c',code],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,(r.stdout+r.stderr).slice(-4500));return r.stdout}
test('fontconfig cmap必须逐码点覆盖真实中文；加载成功/LastResort/零glyph不能补绿',()=>{py(String.raw`
assert hasattr(m,'parse_fc_charset') and hasattr(m,'assert_cjk_coverage')
assert m.parse_fc_charset('20-7e 4e00-9fff')==[(32,126),(19968,40959)]
for bad in ['', 'xyz','9-1','110000','4e00 4d00','1-2-3']:reject(lambda:m.parse_fc_charset(bad))
face={'file':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','index':2,'family':'Noto Sans CJK SC','postscriptName':'NotoSansCJKsc-Regular','sha256':'a'*64,'charset':'20-7e 4e00-9fff'}
fonts=[{'familyName':'Noto Sans CJK SC','postScriptName':'NotoSansCJKsc-Regular','glyphCount':8,'isCustomFont':False}]
r=m.assert_cjk_coverage('浏览器完整回复模型',fonts,[face]);assert r['missingCodepoints']==[] and len(r['codepoints'])>0
m.assert_cjk_coverage('中文',[{**fonts[0],'glyphCount':2.0}],[face])
for bad in [[],[{**fonts[0],'glyphCount':0}],[{**fonts[0],'glyphCount':'8'}],[{**fonts[0],'glyphCount':True}],[{**fonts[0],'glyphCount':float('inf')}],[{**fonts[0],'glyphCount':2.5}],[{**fonts[0],'isCustomFont':True}],[{**fonts[0],'postScriptName':'LastResort'}]]:reject(lambda:m.assert_cjk_coverage('中文',bad,[face]))
reject(lambda:m.assert_cjk_coverage('中文',fonts,[{**face,'charset':'20-7e'}]));reject(lambda:m.assert_cjk_coverage('ASCII only',fonts,[face]))
print(json.dumps({'cmapContract':True,'nativeOrLiveUI':False}))
`)})
test('真实节点字体证据不造DOM，缺CDP/错字形/截图缺失仍红',()=>{py(String.raw`
assert hasattr(m,'capture_cjk_sample') and hasattr(m,'validate_cjk_report')
class Session:
 def send(self,name,args=None):
  if name=='DOM.getDocument':return {'root':{'nodeId':1}}
  if name=='DOM.querySelector':return {'nodeId':2}
  if name=='CSS.getPlatformFontsForNode':return {'fonts':[{'familyName':'Noto Sans CJK SC','postScriptName':'NotoSansCJKsc-Regular','glyphCount':2,'isCustomFont':False}]}
  return {}
 def detach(self):pass
class Context:
 def new_cdp_session(self,page):return Session()
class Locator:
 def evaluate(self,script):return {'text':'中文','selector':'html > body > p','visible':True,'fontFamily':'sans-serif'}
class Page:
 context=Context()
face={'file':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','index':2,'family':'Noto Sans CJK SC','postscriptName':'NotoSansCJKsc-Regular','sha256':'a'*64,'charset':'4e00-9fff'}
with tempfile.TemporaryDirectory() as d:
 png=pathlib.Path(d,'reply.png');png.write_bytes(bytes.fromhex('89504e470d0a1a0a')+b'isolated-not-a-real-screenshot')
 r=m.capture_cjk_sample(Page(),Locator(),'中文','reply',png,[face]);assert r['missingCodepoints']==[] and r['screenshotSha256']
 reject(lambda:m.capture_cjk_sample(Page(),Locator(),'其他','reply',png,[face]))
 reject(lambda:m.capture_cjk_sample(Page(),Locator(),'中文','reply',pathlib.Path(d,'absent.png'),[face]))
 proof={'required':True,'environment':{'beforeSha256':'b'*64,'afterSha256':'c'*64,'faces':[face]},'samples':[r,{**r,'label':'restarted','screenshot':'restarted.png'}]};m.validate_cjk_report(proof)
 for change in [lambda x:x['samples'].pop(),lambda x:x['samples'][0].update(missingCodepoints=['4e2d']),lambda x:x['samples'][0].update(platformFonts=[]),lambda x:x['samples'][0].update(screenshotSha256=''),lambda x:x['environment'].update(afterSha256='')]:
  bad=copy.deepcopy(proof);change(bad);reject(lambda:m.validate_cjk_report(bad))
print(json.dumps({'fixtureCDP':True,'realBrowser':False}))
`)})
test('workflow仅host签名apt/字体记录，原Chromium/90min/210/42/8及fresh目录保持',()=>{
 const source=fs.readFileSync(path.join(root,'.github/workflows/hermes-qualification.yml'),'utf8'),linux=source.split('  linux-long-ui:')[1];assert.ok(linux)
 for(const text of ['fonts-noto-cjk','fontconfig','AllowUnauthenticated=false','AllowInsecureRepositories=false','fontconfig-before.json','fontconfig-after.json','--font-environment','playwright==1.58.0','timeout-minutes: 90','--hold 210'])assert.ok(linux.includes(text),text)
 assert.ok(linux.indexOf('test ! -e "$EVIDENCE"')<linux.indexOf('fontconfig-before.json'));assert.ok(!/mkdir[^\n]*browser-round/.test(linux))
 const s=fs.readFileSync(runner,'utf8');assert.ok(s.includes('CSS.getPlatformFontsForNode'));assert.ok(s.includes('capture_cjk_sample(page,'));assert.ok(!/document\.fonts\.check|add_style_tag|set_content\(/.test(s));assert.ok(s.includes('210 <= a.hold <= 3600'))
})
test('字体metadata经现有publishEvidence脱敏；字体本体排除且不预建UI fresh根',async()=>{
 const {publishEvidence}=await import('../scripts/test-hermes-windows-qualification.mjs');const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'cjk-publish-'))),source=path.join(dir,'evidence'),output=path.join(dir,'public');fs.mkdirSync(source)
 try{fs.writeFileSync(path.join(source,'fontconfig-before.json'),JSON.stringify({apiKey:'CJK-PUBLISH-SECRET-123',fonts:[]}));fs.writeFileSync(path.join(source,'fontconfig-after.json'),JSON.stringify({fontSHA256:'a'.repeat(64),version:'fixture'}));fs.writeFileSync(path.join(source,'font.ttc'),'fixture font must not upload');assert.equal(fs.existsSync(path.join(source,'browser-round1')),false)
 await publishEvidence({roots:{evidence:source},output});assert.ok(fs.existsSync(path.join(output,'evidence/fontconfig-after.json')));assert.equal(fs.existsSync(path.join(output,'evidence/font.ttc')),false);assert.ok(!fs.readFileSync(path.join(output,'evidence/fontconfig-before.json'),'utf8').includes('CJK-PUBLISH-SECRET-123'));assert.equal(fs.existsSync(path.join(source,'browser-round1')),false)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('字体环境before/after是独立证据，after缺包/失败query/伪cmap均失败',()=>{py(String.raw`
assert hasattr(m,'font_environment') and hasattr(m,'read_font_environment')
m.sys.platform='linux'
def command(args):
 if args[0]=='dpkg-query' and '-W' in args:return {'args':args,'exitCode':0,'stdout':'fontconfig\t2.15.0\nfonts-noto-cjk\t1:20230817\n'}
 if args[0]=='dpkg-query':return {'args':args,'exitCode':0,'stdout':'/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc\n'}
 if args[0]=='fc-query':return {'args':args,'exitCode':0,'stdout':'2\tNoto Sans CJK SC\tNotoSansCJKsc-Regular\t20-7e 4e00-9fff\n'}
 return {'args':args,'exitCode':0,'stdout':'fixture-only'}
m.font_command=command;m.fingerprint_font_file=lambda p:{'file':str(p),'sha256':'a'*64,'bytes':16}
before=m.font_environment('before');after=m.font_environment('after');assert after['faces'] and before['phase']=='before' and after['phase']=='after'
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);(root/'fontconfig-before.json').write_text(json.dumps(before));(root/'fontconfig-after.json').write_text(json.dumps(after));proof=m.read_font_environment(root);assert proof['beforeSha256'] and proof['afterSha256'];assert not (root/'browser-round1').exists()
 (root/'fontconfig-after.json').write_text(json.dumps({**after,'faces':[]}));reject(lambda:m.read_font_environment(root))
m.font_command=lambda args:{'args':args,'exitCode':1,'stdout':''};reject(lambda:m.font_environment('after'));assert m.font_environment('before')['faces']==[]
print(json.dumps({'fontconfigCalls':'fixtures only','apt':False,'GUI':False}))
`)})
