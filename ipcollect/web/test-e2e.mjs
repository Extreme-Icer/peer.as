import puppeteer from 'puppeteer-core'

const URL = process.env.URL || 'http://127.0.0.1:8812/'
const CHROME = '/usr/bin/google-chrome-stable'
const errors = [], warns = []

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 900 })
  page.on('console', m => { const tx = m.text(); if (m.type() === 'error') errors.push('CONSOLE: ' + tx); else if (m.type() === 'warning') warns.push(tx) })
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))
  page.on('requestfailed', r => { const u = r.url(); if (!u.includes('favicon')) errors.push('REQFAIL: ' + u + ' :: ' + (r.failure()?.errorText || '')) })

  console.log('→ navigate', URL)
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 })

  // 应用就绪: prompt 出现(meta+duckdb 初始化完成 + runSearch 跑过)
  await page.waitForSelector('.prompt, table tbody tr', { timeout: 60000 })
  console.log('✓ app booted (meta + DuckDB-WASM ready)')

  // 字段顺序(两行布局): [0]=IP [1]=origin [2]=country [3]=city [4]=path
  const inputs = await page.$$('.field input')
  console.log('  filter fields:', inputs.length)
  const F = { ip: inputs[0], origin: inputs[1], cc: inputs[2], city: inputs[3], path: inputs[4] }

  // 国家查询: 输入 CN -> 该国 geo 查询渲染
  await F.cc.click(); await F.cc.type('CN')
  await page.waitForSelector('table tbody tr.prow', { timeout: 40000 })
  const rows = await page.$$eval('table tbody tr.prow', els => els.length)
  const firstPfx = await page.$eval('tr.prow td.pfx', el => el.textContent.trim())
  console.log(`✓ country query CN -> ${rows} rows; first prefix: ${firstPfx}`)
  const status = await page.$eval('.statusline', el => el.textContent.trim())
  console.log(`  status: "${status}"`)
  if (!status.includes('中国大陆')) errors.push('CN override not in status: ' + status)

  // 点首行 -> insight 抽屉(路由图 + 路径表)
  await (await page.$('tr.prow')).click()
  await page.waitForSelector('.detail .dbody h2', { timeout: 30000 })
  const insH2 = await page.$eval('.detail .dbody h2', el => el.textContent.trim())
  const hasGraph = await page.$('.detail svg.pathsvg') ? 'yes' : 'no'
  const pathRows = await page.$$eval('.detail table.paths tbody tr', els => els.length)
  console.log(`✓ insight drawer: "${insH2}"; route-graph svg: ${hasGraph}; path rows: ${pathRows}`)

  // 全表 origin AS 搜索: 清国家 + origin -> pathsearch
  await page.$eval('.detail .close', el => el.click()).catch(() => {})
  await F.cc.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })) })  // 可靠清空
  await F.origin.click(); await F.origin.type('4538'); await page.keyboard.press('Enter')
  await page.waitForFunction(() => {
    const s = document.querySelector('.statusline')?.textContent || ''
    return document.querySelectorAll('table tbody tr.prow').length > 0 && (s.includes('全表') || s.includes('global'))
  }, { timeout: 40000 })
  const grows = await page.$$eval('table tbody tr.prow', els => els.length)
  const loc0 = await page.$eval('table tbody tr.prow td.loc', el => el.textContent.trim())
  console.log(`✓ global origin AS4538 -> ${grows} rows; first loc: "${loc0}"`)
  if (!loc0.includes('中国大陆')) errors.push('CN override not applied (loc=' + loc0 + ')')

  // i18n: 切到 EN, 校验文案变化
  const before = await page.$eval('.side .sec h3', el => el.textContent.trim())
  await page.$$eval('.foot button', els => els[0].click())  // lang toggle
  await new Promise(r => setTimeout(r, 200))
  const after = await page.$eval('.side .sec h3', el => el.textContent.trim())
  console.log(`✓ i18n toggle: "${before}" -> "${after}" ${before !== after ? '(changed)' : '(NO CHANGE!)'}`)
  if (before === after) errors.push('i18n toggle did not change UI text')

  // 截图
  await page.$$eval('.foot button', els => els[0].click())  // 切回中文
  await new Promise(r => setTimeout(r, 150))
  await page.screenshot({ path: 'e2e-shot.png', fullPage: false })
  console.log('✓ screenshot -> e2e-shot.png')

  console.log('\n=== console errors / failed requests:', errors.length, '===')
  errors.slice(0, 20).forEach(e => console.log('  ✗', e))
  process.exitCode = (rows > 0 && pathRows > 0 && errors.length === 0) ? 0 : 1
} catch (e) {
  console.log('TEST ERROR:', e.message)
  errors.forEach(x => console.log('  ✗', x))
  process.exitCode = 2
} finally {
  await browser.close()
}
