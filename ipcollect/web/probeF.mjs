import puppeteer from 'puppeteer-core'
const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome-stable',headless:'new',args:['--no-sandbox']})
const p=await b.newPage(); p.on('pageerror',e=>console.log('PAGEERR',e.message))
await p.goto('http://127.0.0.1:8799/',{waitUntil:'networkidle2',timeout:90000})
await p.waitForSelector('.prompt, table tbody tr',{timeout:60000})
// Feature 2: sidebar split counts
const stats=await p.$$eval('.stats div',ds=>ds.map(d=>d.querySelector('dt')?.textContent.trim()+'='+d.querySelector('dd')?.textContent.trim()))
console.log('SIDEBAR:', JSON.stringify(stats))
// Feature 1: family segmented control present
const fam=await p.$$eval('.famseg .famopt',es=>es.map(e=>e.textContent.trim()))
console.log('FAM control:', JSON.stringify(fam))
// click IPv6 segment, then search country CN -> expect only v6 rows
const opts=await p.$$('.famseg .famopt'); await opts[2].click(); await new Promise(r=>setTimeout(r,500))
const fields=await p.$$eval('.field input',e=>e.map(x=>x.placeholder)); const cci=fields.findIndex(s=>/国家|Country/.test(s))
const ins=await p.$$('.field input'); await ins[cci].click(); await ins[cci].type('CN')
await new Promise(r=>setTimeout(r,9000))
const rows=await p.$$eval('tr.prow td.pfx',e=>({n:e.length, v6:e.filter(x=>x.textContent.includes(':')).length, v4:e.filter(x=>!x.textContent.includes(':')).length})).catch(()=>({n:0}))
const st=await p.$eval('.statusline',e=>e.textContent.trim()).catch(()=>'')
console.log('CN + IPv6-only:', JSON.stringify(rows), '|', st)
await b.close(); console.log('DONE')
