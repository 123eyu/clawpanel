import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const readmes = [
  'README.md',
  'README.en.md',
  'README.zh-TW.md',
  'README.ja.md',
  'README.ko.md',
  'README.vi.md',
  'README.es.md',
  'README.pt.md',
  'README.ru.md',
  'README.fr.md',
  'README.de.md',
]

test('晴辰云免费测试与词元 API 赞助入口使用独立 Provider', () => {
  const presets = read('src/lib/model-presets.js')
  const models = read('src/pages/models.js')
  const assistant = read('src/pages/assistant.js')

  assert.match(presets, /providerKey:\s*'qtcool'/)
  assert.match(presets, /providerKey:\s*'ciyapi'/)
  assert.match(presets, /label:\s*'晴辰云'/)
  assert.match(presets, /badge:\s*'免费测试'/)
  assert.match(presets, /badge:\s*'赞助'/)
  assert.match(models, /prefix:\s*'qtcool'/)
  assert.match(models, /prefix:\s*'ciyapi'/)
  assert.match(models, /models\.providers\[provider\.providerKey\]/)
  assert.match(assistant, /qtcool:\s*\{[\s\S]*provider:\s*QTCOOL/)
  assert.match(assistant, /ciyapi:\s*\{[\s\S]*provider:\s*CIYAPI/)
  assert.match(assistant, /config\.models\.providers\[providerKey\]/)
  assert.match(assistant, /\.\.\.existingProvider/)
  assert.match(assistant, /const providerKey = definition\.provider\.providerKey/)
})

test('全部 README 已移除旧第三方推广并改为官网介绍', () => {
  for (const file of readmes) {
    const content = read(file)
    assert.doesNotMatch(content, /gpt\.qt\.cool|ciyapi\.79tian\.com|词元 API|詞元 API|晴辰云|晴辰雲|CiyAPI|QingChen Cloud/i)
    assert.match(content, /https:\/\/claw\.qt\.cool/)
    assert.match(content, /官网账号|官網帳號|Website account|Website-Konto|Cuenta web|Compte du site|公式サイトアカウント|공식 웹사이트|Conta do site|Аккаунт сайта|Tài khoản website/i)
  }
})

test('运行时与知识库同时说明两类服务的不同定位', () => {
  for (const file of ['src/lib/model-presets.js', 'src/lib/openclaw-kb.js']) {
    const content = read(file)
    assert.match(content, /gpt\.qt\.cool/)
    assert.match(content, /ciyapi\.79tian\.com/)
  }
  for (const file of ['src/pages/models.js', 'src/pages/assistant.js']) {
    const content = read(file)
    assert.match(content, /\bQTCOOL\b/)
    assert.match(content, /\bCIYAPI\b/)
  }
})

test('晴辰云快捷入口不内置、自动读取或静默复用旧密钥', () => {
  const presets = read('src/lib/model-presets.js')
  const models = read('src/pages/models.js')
  const assistant = read('src/pages/assistant.js')
  const modelsLocale = read('src/locales/modules/models.js')
  const assistantLocale = read('src/locales/modules/assistant.js')

  assert.doesNotMatch(presets, /readOpenclawConfig/)
  assert.match(presets, /if \(!key\) return provider\.models/)
  assert.doesNotMatch(models, /bannerKey\s*\|\|\s*existingProvider\?\.apiKey/)
  assert.match(models, /if \(!bannerKey\)/)
  assert.match(assistant, /qtcool:\s*\{[\s\S]*?allowConfigImport:\s*false/)
  assert.doesNotMatch(assistant, /quickDrafts\[providerKey\]\.key\s*=\s*configured\.apiKey/)
  assert.doesNotMatch(assistant, /assistant\.qtcoolSyncFrom/)
  assert.match(assistant, /syncFromButton\.style\.display\s*=\s*definition\.allowConfigImport/)
  assert.match(modelsLocale, /不内置晴辰云密钥/)
  assert.match(assistantLocale, /不内置或自动读取晴辰云密钥/)
  assert.doesNotMatch(assistantLocale, /qtcoolSyncFrom/)

  for (const lang of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'vi', 'es', 'pt', 'ru', 'fr', 'de']) {
    const locale = JSON.parse(read(`src/locales/${lang}.json`))
    assert.equal('qtcoolSyncFrom' in locale.assistant, false)
  }
})

test('文案区分免费测试与赞助福利', () => {
  const modelsLocale = read('src/locales/modules/models.js')
  const assistantLocale = read('src/locales/modules/assistant.js')

  for (const content of [modelsLocale, assistantLocale]) {
    assert.match(content, /免费测试/)
    assert.match(content, /晴辰云/)
    assert.match(content, /赞助/)
    assert.match(content, /¥1/)
    assert.match(content, /\$1/)
  }
})
