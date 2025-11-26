﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import http from 'http'
import pkg from 'whatsapp-web.js'
import { buildResponder, humanize } from './src/responder.js'

const { Client, LocalAuth, MessageMedia } = pkg
const responder = buildResponder()

const ACC_PATHS = ['./netflix account.txt','./secure_data/accounts.txt','./accounts.txt']
const USED_PATH = './secure_data/used_accounts.json'
const lastPlanByChat = new Map()
const lastPlanTypeByChat = new Map()
const lastAssignedByChat = new Map()
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '60189611743@c.us')
const ADMIN_CHAT_IDS = ((process.env.ADMIN_CHAT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || null

function ensureDirOf(file){
  const dir = path.dirname(path.resolve(file))
  if(!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function sanitizeName(s){
  return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'unknown'
}

function parseAccounts(text){
  const lines = text.split(/\r?\n/)
  const accs = []
  let current = null
  for(const raw of lines){
    const line = raw.trim()
    const m = line.match(/([\w.+-]+@[\w.-]+)\s*:\s*(.+)/)
    if(m){
      if(current) accs.push(current)
      current = { email: m[1].trim(), password: m[2].trim(), plan: null }
      continue
    }
    if(current && /^plan\s*:/i.test(line)){
      const val = line.split(':')[1]?.toLowerCase() || ''
      let plan = null
      if(val.includes('premium')) plan = 'premium'
      else if(val.includes('standard') && val.includes('ads')) plan = 'ads'
      else if(val.includes('standard')) plan = 'standard'
      current.plan = plan
    }
  }
  if(current) accs.push(current)
  return accs
}

function extractPlanMonths(s){
  const m = (s||'').toLowerCase().match(/(\d{1,2})\s*(bulan|month|mth|mo)/)
  if(m) return parseInt(m[1],10)
  return null
}

function extractPlanType(s){
  const t = (s||'').toLowerCase()
  if(t.includes('premium')) return 'premium'
  if(t.includes('standard') && t.includes('ads')) return 'ads'
  if(t.includes('standard')) return 'standard'
  return null
}
function extractAmountRM(s){
  const t = String(s||'').toLowerCase()
  let m = t.match(/rm\s*([0-9]+(?:\.[0-9]+)?)/)
  if(!m) m = t.match(/([0-9]+(?:\.[0-9]+)?)\s*rm/)
  if(!m) m = t.match(/\b([0-9]{1,3})(?:\.[0-9]{1,2})?\b/)
  if(!m) return null
  return Math.round(parseFloat(m[1]))
}
function inferPlanByAmount(amount){
  const a = Number(amount||0)
  if(!a) return null
  const tbl = { premium: { 1:14, 3:30 }, standard: { 1:9, 3:25, 6:48, 12:90, 24:121 } }
  for(const [plan, monthsMap] of Object.entries(tbl)){
    for(const [mStr, price] of Object.entries(monthsMap)){
      const m = Number(mStr)
      if(price === a) return { planType: plan, months: m }
    }
  }
  return null
}

function loadAccounts(){
  for(const p of ACC_PATHS){
    if(fs.existsSync(p)){
      const txt = fs.readFileSync(p,'utf8')
      return parseAccounts(txt)
    }
  }
  return []
}

function loadUsed(){
  try{ return JSON.parse(fs.readFileSync(USED_PATH,'utf8')) }catch{ return { used: [], payments: [] } }
}

function saveUsed(data){
  ensureDirOf(USED_PATH)
  fs.writeFileSync(USED_PATH, JSON.stringify(data))
}

function nextAvailable(desiredPlan){
  const accs = loadAccounts()
  const used = loadUsed()
  const set = new Set(used.used)
  for(const a of accs){
    if(set.has(a.email)) continue
    if(desiredPlan && a.plan && a.plan !== desiredPlan) continue
    return a
  }
  return null
}

function markUsed(email, buyer, planType){
  const used = loadUsed()
  used.used = used.used || []
  used.used.push(email)
  used.last = { email, buyer, planType: planType || null, at: new Date().toISOString() }
  used.assignments = used.assignments || []
  used.assignments.push({ buyer, email, planType: planType || null, at: new Date().toISOString() })
  saveUsed(used)
}

function recordPayment(buyerName, planMonths, receiptFile, planType, buyerId, buyerPhone){
  const used = loadUsed()
  used.payments = used.payments || []
  used.payments.push({ buyerName, buyerId: buyerId || null, buyerPhone: buyerPhone || null, planMonths, planType: planType || null, receiptFile, at: new Date().toISOString(), verified: false })
  saveUsed(used)
}

function hasAnyPayment(chatId){
  try{
    const d = loadUsed()
    const pays = Array.isArray(d.payments)?d.payments:[]
    const phone = extractPhone(chatId)
    for(let i=pays.length-1;i>=0;i--){
      const p = pays[i]
      const byChat = !!p.buyerId && p.buyerId === chatId
      const byPhone = !!phone && !!p.buyerPhone && String(p.buyerPhone).replace(/[^0-9]/g,'') === phone
      if(byChat || byPhone) return true
    }
  }catch{}
  return false
}

function hasVerifiedPayment(chatId){
  try{
    const d = loadUsed()
    const pays = Array.isArray(d.payments)?d.payments:[]
    const phone = extractPhone(chatId)
    for(let i=pays.length-1;i>=0;i--){
      const p = pays[i]
      const byChat = !!p.buyerId && p.buyerId === chatId
      const byPhone = !!phone && !!p.buyerPhone && String(p.buyerPhone).replace(/[^0-9]/g,'') === phone
      if((byChat || byPhone) && p.verified===true) return true
    }
  }catch{}
  return false
}

function queuePendingApproval(chatId, buyerName, phone, receiptFile, planType, planMonths){
  const used = loadUsed()
  used.pending = Array.isArray(used.pending)?used.pending:[]
  const item = { chatId, buyerName: buyerName||null, phone: phone||null, receiptFile: receiptFile||null, planType: planType||null, planMonths: planMonths||null, at: new Date().toISOString() }
  used.pending.push(item)
  used.last = used.last || {}
  used.last.pending = item
  used.last.buyerPhone = String(phone||'').replace(/[^0-9]/g,'') || null
  saveUsed(used)
  return item
}

function setPaymentVerifiedByPhone(phone, ok){
  try{
    const d = loadUsed()
    const pays = Array.isArray(d.payments)?d.payments:[]
    const pnum = String(phone||'').replace(/[^0-9]/g,'')
    let changed = false
    for(let i=pays.length-1;i>=0;i--){
      const p = pays[i]
      const ph = String(p.buyerPhone||'').replace(/[^0-9]/g,'')
      if(ph === pnum){ p.verified = !!ok; changed = true; break }
    }
    d.pending = Array.isArray(d.pending)?d.pending:[]
    d.pending = d.pending.filter(x=>String(x.phone||'').replace(/[^0-9]/g,'') !== pnum)
    saveUsed(d)
    return changed
  }catch{ return false }
}

async function allocateForPhone(phone){
  const chatId = getChatIdByPhone(phone||'')
  if(!chatId) return false
  let desiredPlan = null
  const latest = getLatestPaymentForPhone(phone||'')
  if(latest && latest.planType) desiredPlan = latest.planType
  if(!desiredPlan) desiredPlan = lastPlanTypeByChat.get(chatId) || null
  const acc = nextAvailable(desiredPlan)
  if(!acc) return false
  const used = loadUsed()
  used.last = used.last || {}
  used.last.buyerPhone = String(phone||'').replace(/[^0-9]/g,'') || null
  saveUsed(used)
  markUsed(acc.email, chatId, acc.plan || null)
  lastAssignedByChat.set(chatId, acc)
  const text = `Akaun anda:\nEmail: ${acc.email}\nPassword: ${acc.password}\nPlan: ${acc.plan || 'tidak pasti'}\nSila login pada Netflix. Jika ada isu, beritahu kami. Jangan risau, jika akaun tidak valid atau ada masalah, kami akan ganti segera.`
  try{ await client.sendMessage(chatId, text) }catch{}
  return true
}
function getLatestPaymentForPhone(phone){
  try{
    const d = loadUsed()
    const pays = Array.isArray(d.payments)?d.payments:[]
    const pnum = String(phone||'').replace(/[^0-9]/g,'')
    for(let i=pays.length-1;i>=0;i--){ const p=pays[i]; const ph=String(p.buyerPhone||'').replace(/[^0-9]/g,''); if(ph===pnum) return p }
  }catch{}
  return null
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
})

client.on('qr', async (qr) => {
  qrcode.generate(qr, { small: true })
  try { await QRCode.toFile('./qr.png', qr, { width: 128 }); console.log('QR kecil disimpan: qr.png (128px)') } catch (e) { console.error('Gagal simpan QR PNG:', e) }
})

client.on('ready', () => { console.log('Bot siap. Menunggu mesej…') })
client.on('auth_failure', (msg) => { console.error('Auth gagal:', msg) })
client.on('disconnected', (reason) => { console.warn('Terputus:', reason) })

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return
    const chat = await msg.getChat()
    let name = 'Kawan'
    try {
      name = msg._data?.notifyName || msg._data?.pushname || (chat.isGroup ? msg._data?.sender?.pushname : chat.name) || chat?.name || 'Kawan'
    } catch { name = 'Kawan' }

    const planMonthsNow = extractPlanMonths(msg.body || '')
    if (planMonthsNow) lastPlanByChat.set(msg.from, planMonthsNow)
    const planTypeNow = extractPlanType(msg.body || '')
    if (planTypeNow) lastPlanTypeByChat.set(msg.from, planTypeNow)

  if(!chat.isGroup){
      upsertContact(msg.from, name)
      try{
        const u = loadUsed()
        const ph = extractPhone(msg.from)
        const contact = (Array.isArray(u.contacts)?u.contacts:[]).find(c=>c.chatId===msg.from || (ph && c.phone===ph))
        if(contact && contact.alias){ name = contact.alias }
      }catch{}
    }

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia()
        const mime = String(media.mimetype||'')
        const typ = String(msg.type||'').toLowerCase()
        const cap = String(msg._data?.caption || msg.body || '')
        const capTxt = cap.toLowerCase()
        const mentionsPay = /(resit|receipt|bukti|bayar|pembayaran|payment|transfer|bank|tng|touch|duitnow)/.test(capTxt)
        const isSticker = (typ==='sticker') || (/^image\/webp$/i.test(mime) && !mentionsPay)
        const isImageReceipt = (typ==='image') && /(image\/jpeg|image\/jpg|image\/png|image\/webp)/i.test(mime)
        const isDocReceipt = (typ==='document') && /(application\/pdf|image\/jpeg|image\/jpg|image\/png)/i.test(mime)
        if ((isImageReceipt || isDocReceipt) && mentionsPay) {
          const ext = mime.includes('pdf') ? 'pdf' : (mime.includes('jpeg')||mime.includes('jpg')) ? 'jpg' : mime.includes('png') ? 'png' : 'bin'
          const ts = new Date().toISOString().replace(/[:.]/g,'-')
          const receiptsDir = path.resolve('./receipts')
          if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true })
          let planMonths = planMonthsNow || lastPlanByChat.get(msg.from) || null
          let planType = planTypeNow || lastPlanTypeByChat.get(msg.from) || null
          const llm = ext!=='pdf' ? await analyzeReceiptLLM(media.data, mime, cap) : null
          const amtText = extractAmountRM(cap)
          const amt = llm?.amountRM || amtText || null
          const inf = amt ? inferPlanByAmount(amt) : null
          const priceMatched = !!inf
          if(priceMatched){ if(!planMonths) planMonths = inf.months; if(!planType) planType = inf.planType }
          const suffix = planMonths ? `${planMonths}month` : 'unknown'
          const filename = `receipt_${ts}_${sanitizeName(name)}_${suffix}.${ext}`
          const filePath = path.join(receiptsDir, filename)
          fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'))
          planType = planType || (planTypeNow || lastPlanTypeByChat.get(msg.from) || null)
          const phone = extractPhone(msg.from)
          recordPayment(name, planMonths || null, filename, planType || null, msg.from, phone || null)
          queuePendingApproval(msg.from, name, phone || null, filename, planType || null, planMonths || null)
          const reply = `Bukti pembayaran diterima (disimpan: ${filename}). Mohon tunggu 5 min untuk semakan admin.`
          await chat.sendMessage(reply)
          const adminId = ADMIN_CHAT_ID
          if (adminId) {
            const note = `APPROVAL PERLU\nPelanggan: ${name} (${msg.from})\nPhone: ${phone||''}\nPelan: ${(planType||'')||'-'} ${planMonths||''}m\nJumlah: ${amt?('RM'+amt):'-'} (${priceMatched?'PADAN':'TIDAK PADAN'})\nResit: ${filename}\nBalas: maya approve yes | maya approve no`
            try { await client.sendMessage(adminId, note) } catch (e) { }
            setTimeout(async()=>{ try{ await client.sendMessage(adminId, `Reminder approval: ${phone||''} | ${name}`) }catch{} }, 5*60*1000)
          }
          return
        } else if (isSticker) {
          const emos = ['🙂','😉','👌','👍','🙏','🔥','🎉','💯']
          const em = emos[Math.floor(Math.random()*emos.length)]
          await chat.sendMessage(em)
          return
        } else if (typ==='image' || typ==='document') {
          await chat.sendMessage(humanize('Imej diterima. Jika ini resit pembayaran, nyatakan "resit" pada kapsyen atau hantar screenshot resit yang jelas.'))
          return
        }
      } catch (e) {
        console.error('Gagal terima/simpan media:', e)
      }
    }

    const earlyTxt = (msg.body||'').toLowerCase()
    if(/^\s*maya\b/.test(earlyTxt)){
      if(earlyTxt.includes('admin') && (earlyTxt.includes('saya') || earlyTxt.includes('set') || earlyTxt.includes('tambah'))){
        addAdmin(msg.from)
        await chat.sendMessage(humanize('Nombor ini ditetapkan sebagai admin.'))
        return
      }
      if(earlyTxt.includes('nama') || earlyTxt.includes('name')){
        const tail = earlyTxt.replace(/^\s*maya[\s,:-]*/,'')
        const m = tail.match(/nama\s*(aku|saya)?\s*([=:,-])?\s*(.+)/i)
        const alias = (m && m[3] ? m[3].trim() : tail.replace(/^(nama|name)\s*/i,'').trim()) || null
        if(alias){ setAlias(msg.from, alias) }
        const text = alias ? `Nama panggilan disimpan: ${alias}` : 'Nyatakan nama panggilan selepas kata kunci nama.'
        await chat.sendMessage(humanize(text))
        return
      }
    }

    const result = await responder(msg.body || '', name)
    const { reply, delayMs, mediaPath, allocate, reportIssue, notifyAdmin, notifyCategory } = result

    await chat.sendStateTyping()
    await new Promise((r) => setTimeout(r, delayMs))
    await chat.clearState()

    const isAdmin = (id)=>{
      const norm = (v)=>String(v||'').replace(/[^0-9]/g,'')
      const d = norm(id)
      if(!d) return false
      if(d === norm(ADMIN_CHAT_ID)) return true
      if(ADMIN_CHAT_IDS.length && ADMIN_CHAT_IDS.some(x=>norm(x)===d)) return true
      try{
        const u = loadUsed()
        const admins = Array.isArray(u.admins)?u.admins:[]
        if(admins.some(x=>norm(x)===d)) return true
      }catch{}
      return false
    }
    const bodyTxt = (msg.body||'').toLowerCase()
    if(notifyAdmin){
      const note = `PERMINTAAN ADMIN\nPelanggan: ${name} (${msg.from})\nKategori: ${notifyCategory||'-'}\nMesej: ${msg.body||''}`
      const targets = [ADMIN_CHAT_ID].concat(Array.isArray(ADMIN_CHAT_IDS)?ADMIN_CHAT_IDS:[]).filter(Boolean)
      for(const t of targets){
        try{ await client.sendMessage(t, note) }catch{}
      }
    }
    if(isAdmin(msg.from) && /^\s*maya\b/.test(bodyTxt)){
      const tail = bodyTxt.replace(/^\s*maya[\s,:-]*/,'')
      const s = computeStats()
      const d = loadUsed()
      const issues = (Array.isArray(d.issues)?d.issues:[]).slice(-5).reverse()
      const reps = (Array.isArray(d.replacements)?d.replacements:[]).slice(-5).reverse()
      const pays = (Array.isArray(d.payments)?d.payments:[]).slice(-5).reverse()
      let text = ''
      if(tail.includes('admin') && (tail.includes('saya') || tail.includes('set') || tail.includes('tambah'))){
        addAdmin(msg.from)
        text = 'Nombor ini ditetapkan sebagai admin.'
      } else if(tail.includes('nama') || tail.includes('name')){
        const m = tail.match(/nama\s*(aku|saya)?\s*([=:,-])?\s*(.+)/i)
        const alias = (m && m[3] ? m[3].trim() : tail.replace(/^(nama|name)\s*/i,'').trim()) || null
        if(alias){ setAlias(msg.from, alias) }
        text = alias ? `Nama panggilan disimpan: ${alias}` : 'Nyatakan nama panggilan selepas kata kunci nama.'
      } else if(!tail || tail.includes('status') || tail.includes('help')){
        const dash = DASHBOARD_TOKEN ? `http://localhost:3000/dashboard?token=${DASHBOARD_TOKEN}` : 'http://localhost:3000/dashboard'
        text = `Baik, ini status terkini:\n• Customers: ${s.customers}\n• Contacts: ${s.contacts}\n• Purchases: ${s.purchases}\n• Income RM (Total/Bulan): ${s.incomeRM}/${s.incomeMonthRM}\n• Issues/Replacements: ${s.issues}/${s.replacements}\n• Stock Total/Used/Available: ${s.stockTotal}/${s.stockUsed}/${s.stockAvailable}\n• By Plan (available): Premium ${s.planAvailable.premium||0}, Standard ${s.planAvailable.standard||0}, Ads ${s.planAvailable.ads||0}\n• Expiring ≤7d / Expired: ${s.expiringSoon} / ${s.expired}\nDashboard: ${dash}`
      } else if(tail.includes('isu') || tail.includes('issue') || tail.includes('rosak') || tail.includes('broken')){
        const lines = issues.map(i=>`${i.at||''} | ${i.name||''} | ${i.account?.email||''} | ${(i.message||'').slice(0,60)}`)
        text = `Berikut isu terkini (${issues.length}):\n${lines.join('\n') || 'Tiada rekod'}`
      } else if(tail.includes('ganti') || tail.includes('replace') || tail.includes('replacement')){
        const lines = reps.map(r=>`${r.at||''} | ${r.oldEmail||''} -> ${r.newEmail||''} | ${r.planType||''}`)
        text = `Senarai penggantian terkini (${reps.length}):\n${lines.join('\n') || 'Tiada rekod'}`
      } else if(tail.includes('resit') || tail.includes('receipt')){
        const lines = pays.map(p=>`${p.at||''} | ${p.buyerName||''} | ${p.planType||''} ${p.planMonths||''}m | ${p.receiptFile||''}`)
        text = `Resit pembayaran terkini (${pays.length}):\n${lines.join('\n') || 'Tiada rekod'}`
      } else if(tail.includes('pending')){
        const pend = (Array.isArray(d.pending)?d.pending:[]).slice(-8).reverse()
        const lines = pend.map(p=>`${p.at||''} | ${p.buyerName||''} | ${p.phone||''} | ${p.planType||''} ${p.planMonths||''}m | ${p.receiptFile||''}`)
        text = `Menunggu kelulusan (${pend.length}):\n${lines.join('\n') || 'Tiada pending'}`
      } else if(tail.includes('approve')){
        const yes = /(yes|ya|setuju|betul)/.test(tail)
        const no = /(no|tidak|x|reject|tolak)/.test(tail)
        const m = tail.match(/(\+?\d[\d\s-]{6,})/)
        const phone = m ? m[1].replace(/[^0-9]/g,'') : (loadUsed().last?.buyerPhone||'')
        let ok = false
        if(phone){ ok = setPaymentVerifiedByPhone(phone, yes && !no) }
        if(yes && ok){
          const did = await allocateForPhone(phone)
          text = did ? 'Pembayaran disahkan dan login telah dihantar.' : 'Pembayaran disahkan. Stok sesuai belum tersedia.'
        }else if(no && ok){
          text = 'Pembayaran ditolak.'
        }else{
          text = 'Gagal proses approve. Nyatakan nombor atau pastikan resit wujud.'
        }
      } else if(tail.includes('stok') || tail.includes('stock')){
        text = `Ringkasan stok:\n• Total: ${s.stockTotal}\n• Used: ${s.stockUsed}\n• Available: ${s.stockAvailable}\n• Premium: ${s.planAvailable.premium||0}\n• Standard: ${s.planAvailable.standard||0}\n• Ads: ${s.planAvailable.ads||0}`
      } else if(tail.includes('expire') || tail.includes('tamat')){
        text = `Akan tamat dalam 7 hari: ${s.expiringSoon}\nSudah tamat: ${s.expired}`
      } else {
        text = 'Arahan maya: status | isu | ganti | resit | approve | stok | tamat | admin saya'
      }
      await chat.sendMessage(humanize(text))
      return
    }
    const adminCmd = isAdmin(msg.from) ? (
      (bodyTxt.includes('check status') || bodyTxt.includes('status')) ? 'status' :
      bodyTxt.includes('stats') ? 'stats' :
      bodyTxt.includes('income') ? 'income' :
      bodyTxt.includes('stock') ? 'stock' :
      bodyTxt.includes('expiring') ? 'expiring' : null
    ) : null
    if(adminCmd){
      const s = computeStats()
      let text
      if(adminCmd==='status'){
        const dash = DASHBOARD_TOKEN ? `http://localhost:3000/dashboard?token=${DASHBOARD_TOKEN}` : 'http://localhost:3000/dashboard'
        text = `Status Sistem\nCustomers: ${s.customers}\nContacts: ${s.contacts}\nPurchases: ${s.purchases}\nIncome RM (Total/Bulan): ${s.incomeRM}/${s.incomeMonthRM}\nIssues/Replacements: ${s.issues}/${s.replacements}\nStock Total/Used/Available: ${s.stockTotal}/${s.stockUsed}/${s.stockAvailable}\nBy Plan (avail): Premium ${s.planAvailable.premium||0}, Standard ${s.planAvailable.standard||0}, Ads ${s.planAvailable.ads||0}\nExpiring ≤7d / Expired: ${s.expiringSoon} / ${s.expired}\nDashboard: ${dash}`
      } else if(adminCmd==='stats') text = `Stats\nCustomers: ${s.customers}\nPurchases: ${s.purchases}\nIssues: ${s.issues}\nReplacements: ${s.replacements}\nIncome RM: ${s.incomeRM}`
      else if(adminCmd==='income') text = `Income RM: ${s.incomeRM}`
      else if(adminCmd==='stock') text = `Stock\nTotal: ${s.stockTotal}\nAvailable: ${s.stockAvailable}\nPremium: ${s.planAvailable.premium||0}\nStandard: ${s.planAvailable.standard||0}\nAds: ${s.planAvailable.ads||0}`
      else text = `Expiring ≤7d: ${s.expiringSoon}\nExpired: ${s.expired}`
      await chat.sendMessage(humanize(text))
      return
    }
    if (allocate) {
      if (chat.isGroup) {
        await chat.sendMessage('Aktivasi akaun hanya boleh melalui chat individu.')
        return
      }
      if(!hasVerifiedPayment(msg.from)){
        await chat.sendMessage('Aktivasi memerlukan resit pembayaran yang disahkan. Sila hantar resit dan admin akan sahkan.')
        return
      }
      const desiredPlan = lastPlanTypeByChat.get(msg.from) || null
      if(!desiredPlan){
        await chat.sendMessage('Nyatakan pelan: Premium atau Standard.')
        return
      }
      const acc = nextAvailable(desiredPlan)
      if (!acc) {
        await chat.sendMessage('Stok akaun sesuai sedang penuh. Sila tunggu seketika atau hubungi sokongan.')
        return
      }
      const phone = extractPhone(msg.from)
      const used = loadUsed()
      used.last = used.last || {}
      used.last.buyerPhone = phone || null
      saveUsed(used)
      markUsed(acc.email, msg.from, acc.plan || null)
      lastAssignedByChat.set(msg.from, acc)
      const text = `Akaun anda:\nEmail: ${acc.email}\nPassword: ${acc.password}\nPlan: ${acc.plan || 'tidak pasti'}\nSila login pada Netflix. Jika ada isu, beritahu kami. Jangan risau, jika akaun tidak valid atau ada masalah, kami akan ganti segera.`
      await chat.sendMessage(text)
      return
    }

    if (reportIssue) {
      const used = loadUsed()
      used.issues = used.issues || []
      let assigned = null
      if (used.assignments && Array.isArray(used.assignments)) {
        for (let i = used.assignments.length - 1; i >= 0; i--) {
          const a = used.assignments[i]
          if (a.buyer === msg.from) { assigned = a; break }
        }
      }
      if (!assigned && lastAssignedByChat.has(msg.from)) {
        const a = lastAssignedByChat.get(msg.from)
        assigned = { buyer: msg.from, email: a.email, planType: a.plan || null }
      }
      const phone = extractPhone(msg.from)
      used.issues.push({ buyer: msg.from, buyerPhone: phone || null, name, message: msg.body || '', account: assigned || null, at: new Date().toISOString() })
      saveUsed(used)
      const adminId = ADMIN_CHAT_ID
      if (adminId) {
        const accText = assigned ? `Email: ${assigned.email} | Plan: ${assigned.planType || 'unknown'}` : 'Tiada rekod akaun ditetapkan'
        const note = `NOTIFIKASI ISU AKAUN\nPelanggan: ${name} (${msg.from})\n${accText}\nMesej: ${msg.body || ''}`
        try { await client.sendMessage(adminId, note) } catch (e) { }
      }
      await chat.sendMessage(reply)
      const desiredPlan = assigned?.planType || lastPlanTypeByChat.get(msg.from) || null
      const replacement = nextAvailable(desiredPlan)
      if (!replacement) {
        await chat.sendMessage('Stok penggantian sesuai sedang penuh. Kami akan hubungi sebaik stok tersedia.')
        return
      }
      markUsed(replacement.email, msg.from, replacement.plan || null)
      lastAssignedByChat.set(msg.from, replacement)
      used.replacements = used.replacements || []
      const phone2 = extractPhone(msg.from)
      used.replacements.push({ buyer: msg.from, buyerPhone: phone2 || null, oldEmail: assigned?.email || null, newEmail: replacement.email, planType: replacement.plan || null, message: msg.body || '', at: new Date().toISOString() })
      saveUsed(used)
      const replMsg = `Penggantian akaun diproses. Akaun baru:\nEmail: ${replacement.email}\nPassword: ${replacement.password}\nPlan: ${replacement.plan || 'tidak pasti'}\nJika ada isu, beritahu kami.`
      await chat.sendMessage(replMsg)
      if (adminId) {
        const note2 = `PENGGANTIAN AKAUN\nPelanggan: ${name} (${msg.from})\nDaripada: ${assigned?.email || '-'}\nKepada: ${replacement.email} (${replacement.plan || 'unknown'})`
        try { await client.sendMessage(adminId, note2) } catch (e) { }
      }
      return
    }

    if (mediaPath) {
      try {
        const media = MessageMedia.fromFilePath(mediaPath)
        await chat.sendMessage(media, { caption: reply })
      } catch (e) {
        console.error('Gagal hantar imej pembayaran:', e)
        await chat.sendMessage(reply)
      }
    } else {
      await chat.sendMessage(reply)
    }
  } catch (err) {
    console.error('Ralat ketika membalas mesej:', err)
  }
})

client.initialize()

function computeStats(){
  const d = loadUsed()
  const payments = Array.isArray(d.payments) ? d.payments : []
  const issues = Array.isArray(d.issues) ? d.issues : []
  const replacements = Array.isArray(d.replacements) ? d.replacements : []
  const assignments = Array.isArray(d.assignments) ? d.assignments : []
  const contacts = Array.isArray(d.contacts) ? d.contacts : []
  const accs = loadAccounts()
  const usedSet = new Set(Array.isArray(d.used)?d.used:[])
  const stockTotal = accs.length
  const stockUsed = usedSet.size
  const stockAvailable = Math.max(stockTotal - stockUsed, 0)
  const planAvailable = { premium:0, standard:0, ads:0, unknown:0 }
  for(const a of accs){ if(usedSet.has(a.email)) continue; const k=a.plan||'unknown'; if(!(k in planAvailable)) planAvailable[k]=0; planAvailable[k]++ }
  const buyers = new Set(payments.map(p => (p.buyerName||'').trim().toLowerCase()).filter(Boolean))
  const byPlan = { premium:0, standard:0, ads:0, unknown:0 }
  for(const a of assignments){ const k = a.planType || 'unknown'; if(!(k in byPlan)) byPlan[k] = 0; byPlan[k]++ }
  const now = new Date()
  const expiries = []
  for(const p of payments){
    if(!p.planMonths || !p.at) continue
    const start = new Date(p.at)
    const exp = new Date(start.getTime())
    exp.setMonth(exp.getMonth() + Number(p.planMonths))
    const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / (24*3600*1000))
    expiries.push({ name: p.buyerName||'', phone: p.buyerPhone||'', start: p.at, expiry: exp.toISOString(), daysLeft })
  }
  const expiredCount = expiries.filter(e => e.daysLeft < 0).length
  const soonCount = expiries.filter(e => e.daysLeft >= 0 && e.daysLeft <= 7).length
  const PRICES = { premium: { 1:14, 3:30 }, standard: { 1:9, 3:25, 6:48, 12:90, 24:121 }, ads: { 1:9 } }
  const phoneToChat = new Map(contacts.map(c => [c.phone, c.chatId]))
  let incomeRM = 0
  let incomeMonthRM = 0
  for(const p of payments){
    const m = Number(p.planMonths||0)
    let t = (p.planType||'').toLowerCase()
    if(!t && p.buyerId){
      for(let i=assignments.length-1;i>=0;i--){ const a=assignments[i]; if(a.buyer===p.buyerId){ t=(a.planType||'').toLowerCase(); break } }
    }
    if(!t && p.buyerPhone){
      const chatId = phoneToChat.get(p.buyerPhone)
      if(chatId){ for(let i=assignments.length-1;i>=0;i--){ const a=assignments[i]; if(a.buyer===chatId){ t=(a.planType||'').toLowerCase(); break } } }
    }
    const tbl = PRICES[t]||{}
    const val = tbl[m]||0
    incomeRM += val
    try{
      const dt = new Date(p.at)
      const now = new Date()
      if(dt.getFullYear()===now.getFullYear() && dt.getMonth()===now.getMonth()) incomeMonthRM += val
    }catch{}
  }
  return {
    customers: buyers.size,
    contacts: contacts.length,
    purchases: payments.length,
    issues: issues.length,
    replacements: replacements.length,
    usedAccounts: Array.isArray(d.used) ? d.used.length : 0,
    stockTotal,
    stockAvailable,
    stockUsed,
    planAvailable,
    byPlan,
    expired: expiredCount,
    expiringSoon: soonCount,
    incomeRM,
    incomeMonthRM,
    latestIssues: issues.slice(-10).reverse(),
    latestReplacements: replacements.slice(-10).reverse(),
    latestExpiries: expiries.sort((a,b)=>new Date(a.expiry)-new Date(b.expiry)).slice(0,10)
  }
}

function startDashboardServer(){
  const port = process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT,10) : 3000
  const server = http.createServer((req,res)=>{
    try{
      const u = new URL(req.url, 'http://localhost')
      const allowOrigin = process.env.DASHBOARD_ORIGIN || '*'
      res.setHeader('Access-Control-Allow-Origin', allowOrigin)
      res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Token, X-Admin-Key')
      if(req.method === 'OPTIONS'){ res.writeHead(204); res.end(''); return }
      const allowed = ()=>{
        if(!DASHBOARD_TOKEN) return true
        const qtok = u.searchParams.get('token')
        const htok = (req.headers['x-token']||'').toString()
        return (qtok && qtok===DASHBOARD_TOKEN) || (htok && htok===DASHBOARD_TOKEN)
      }
      if(u.pathname.startsWith('/api/receipts')){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const dir = path.resolve('./receipts')
        if(!fs.existsSync(dir)){ res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify([])); return }
        const files = fs.readdirSync(dir).filter(f=>/\.(png|jpg|jpeg|webp)$/i.test(f))
        const withStat = files.map(f=>{ const fp=path.join(dir,f); const st=fs.statSync(fp); return { name:f, mtime: st.mtime.toISOString() } })
        withStat.sort((a,b)=>new Date(b.mtime)-new Date(a.mtime))
        res.writeHead(200, { 'Content-Type':'application/json' })
        res.end(JSON.stringify(withStat.slice(0,12)))
        return
      }
      if(u.pathname.startsWith('/receipts/')){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const name = decodeURIComponent(u.pathname.replace('/receipts/',''))
        const dir = path.resolve('./receipts')
        const fp = path.join(dir, name)
        if(!fs.existsSync(fp)){ res.writeHead(404); res.end('Not found'); return }
        const ext = (path.extname(fp)||'').toLowerCase()
        const ct = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream'
        const data = fs.readFileSync(fp)
        res.writeHead(200, { 'Content-Type': ct })
        res.end(data)
        return
      }
      if(u.pathname === '/api/stats'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const stats = computeStats()
        res.writeHead(200, { 'Content-Type':'application/json' })
        res.end(JSON.stringify(stats))
        return
      }
      if(u.pathname === '/api/contacts'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const d = loadUsed(); const arr = Array.isArray(d.contacts)?d.contacts:[]
        res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify(arr)); return
      }
      if(u.pathname === '/api/issues'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const d = loadUsed(); const arr = Array.isArray(d.issues)?d.issues:[]
        res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify(arr)); return
      }
      if(u.pathname === '/api/replacements'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const d = loadUsed(); const arr = Array.isArray(d.replacements)?d.replacements:[]
        res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify(arr)); return
      }
      if(u.pathname === '/api/purchases'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const d = loadUsed(); const arr = Array.isArray(d.payments)?d.payments:[]
        const PRICES = { premium: { 1:14, 3:30 }, standard: { 1:9, 3:25, 6:48, 12:90, 24:121 }, ads: { 1:9 } }
        const out = arr.map(p=>{ const t=(p.planType||'').toLowerCase(); const m=Number(p.planMonths||0); const price=((PRICES[t]||{})[m])||0; return { ...p, priceRM: price } })
        res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify(out)); return
      }
      if(u.pathname === '/api/export'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const type = u.searchParams.get('type') || ''
        const d = loadUsed()
        let rows = []
        if(type==='contacts'){ rows = (Array.isArray(d.contacts)?d.contacts:[]).map(c=>[c.chatId||'', c.name||'', c.phone||'', c.lastSeen||'']) }
        else if(type==='purchases'){ const PRICES = { premium: { 1:14, 3:30 }, standard: { 1:9, 3:25, 6:48, 12:90, 24:121 }, ads: { 1:9 } }; rows = (Array.isArray(d.payments)?d.payments:[]).map(p=>{ const t=(p.planType||'').toLowerCase(); const m=Number(p.planMonths||0); const price=((PRICES[t]||{})[m])||0; return [p.buyerName||'', p.buyerPhone||'', p.planType||'', p.planMonths||'', price, p.receiptFile||'', p.at||''] }) }
        else if(type==='issues'){ rows = (Array.isArray(d.issues)?d.issues:[]).map(i=>[i.name||'', i.buyerPhone||'', i.account?.email||'', i.message||'', i.at||'']) }
        else if(type==='replacements'){ rows = (Array.isArray(d.replacements)?d.replacements:[]).map(r=>[r.buyerPhone||'', r.oldEmail||'', r.newEmail||'', r.planType||'', r.at||'']) }
        const csv = [ 'sep=,', (type==='contacts'?'chatId,name,phone,lastSeen': type==='purchases'?'buyerName,buyerPhone,planType,planMonths,priceRM,receiptFile,at': type==='issues'?'name,buyerPhone,email,message,at':'buyerPhone,oldEmail,newEmail,planType,at'), ...rows.map(r=>r.map(x=>String(x).replace(/"/g,'""')).map(x=>`"${x}"`).join(',')) ].join('\n')
        res.writeHead(200, { 'Content-Type':'text/csv' }); res.end(csv); return
      }
      if(u.pathname === '/dashboard2' || u.pathname === '/dash'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const s = computeStats()
        const donutTotal = (s.byPlan.premium||0)+(s.byPlan.standard||0)+(s.byPlan.ads||0)+(s.byPlan.unknown||0) || 1
        const p1 = Math.round(((s.byPlan.premium||0)/donutTotal)*360)
        const p2 = Math.round(((s.byPlan.standard||0)/donutTotal)*360)
        const p3 = Math.round(((s.byPlan.ads||0)/donutTotal)*360)
        const g1 = p1
        const g2 = p1+p2
        const g3 = p1+p2+p3
        const receipts = (()=>{ try{ const r=JSON.parse(fs.readFileSync(path.resolve('./secure_data/used_accounts.json'),'utf8')); const arr = Array.isArray(r.payments)?r.payments:[]; return arr.slice(-8).reverse().map(x=>x.receiptFile).filter(Boolean);}catch{return []} })()
        const receiptsImgs = receipts.map(n=>`<div class="shot"><img src="/receipts/${encodeURIComponent(n)}" alt="${n}"/><div class="cap">${n}</div></div>`).join('')
        const html2 = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboard</title><style>:root{--bg:#0d0f14;--panel:#161a22;--text:#e8e8e8;--muted:#9aa5b1;--accent:#ffc107;--accent2:#18a0fb;--accent3:#26c6da;--danger:#ff5c77}*{box-sizing:border-box}html{scroll-behavior:smooth}body{font-family:Inter,system-ui,Arial;background:var(--bg);color:var(--text);margin:0;display:flex;min-height:100vh}aside{width:220px;background:#0b0d11;border-right:1px solid #1f2530;padding:18px;display:flex;flex-direction:column}aside .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:16px}aside nav a{display:block;padding:10px 12px;border-radius:8px;color:#cdd7e3;text-decoration:none;margin-bottom:6px;transition:all .2s ease}aside nav a.active{background:#141822;color:#fff;border:1px solid #222834}main{flex:1;padding:22px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;position:sticky;top:0;padding-bottom:8px;background:linear-gradient(to bottom,rgba(13,15,20,.95),rgba(13,15,20,.75));backdrop-filter:saturate(180%) blur(6px)}header .title{font-size:22px;font-weight:700}header .sub{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px}.card{background:var(--panel);padding:14px;border-radius:12px;border:1px solid #222834;box-shadow:0 8px 20px rgba(0,0,0,.25);transition:transform .18s ease, box-shadow .18s ease}.card:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.3)}.num{font-size:28px;font-weight:700}.muted{color:var(--muted)}.two{display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-top:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{border-bottom:1px solid #222834;padding:8px;text-align:left}.section{margin-top:12px}.donut{width:220px;height:220px;border-radius:50%;background:conic-gradient(var(--accent) 0deg ${g1}deg, var(--accent2) ${g1}deg ${g2}deg, var(--accent3) ${g2}deg ${g3}deg, #2b3240 ${g3}deg 360deg);position:relative;margin:auto}.donut::after{content:"";position:absolute;inset:24px;background:var(--panel);border-radius:50%}.legend{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px}.legend .item{display:flex;gap:8px;align-items:center}.dot{width:10px;height:10px;border-radius:50%}.shots{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px;margin-top:12px}.shot{background:#0b0d11;border:1px solid #222834;border-radius:10px;overflow:hidden}.shot img{width:100%;height:120px;object-fit:cover;display:block;transition:transform .2s ease}.shot img:hover{transform:scale(1.03)}.cap{font-size:12px;padding:6px;color:#cdd7e3;text-align:center}.kbd{background:#10131a;border:1px solid #222834;padding:2px 6px;border-radius:6px}.row{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:10px}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#0b0d11;border:1px solid #222834;color:#cdd7e3;font-size:12px}.danger{color:#fff;background:#ff4d6d;border-color:#ff4d6d}.footer{margin-top:18px;color:#74808f;font-size:12px;text-align:center}.btn{background:#0b0d11;color:#cdd7e3;border:1px solid #222834;padding:8px 12px;border-radius:8px;text-decoration:none;transition:all .2s ease}.btn:hover{background:#141822;color:#fff}.wrap{max-width:1200px;margin:0 auto} @media (max-width:1024px){.grid{grid-template-columns:repeat(2,minmax(180px,1fr))}.two{grid-template-columns:1fr}.row{grid-template-columns:repeat(2,minmax(160px,1fr))}.legend{grid-template-columns:repeat(2,1fr)}aside{position:fixed;left:0;top:0;bottom:0;transform:translateX(-100%);transition:transform .25s ease}aside.open{transform:translateX(0)}main{padding:16px}} @media (max-width:640px){.grid{grid-template-columns:1fr}.shots{grid-template-columns:repeat(2,minmax(120px,1fr))}header .title{font-size:18px}.num{font-size:24px}aside{width:180px}} .topbar{display:none}@media (max-width:1024px){.topbar{display:flex;align-items:center;gap:12px;background:#0b0d11;border-bottom:1px solid #1f2530;padding:10px 14px;position:sticky;top:0;z-index:10}} .fade{opacity:0;transform:translateY(6px);transition:opacity .25s ease, transform .25s ease}.fade.show{opacity:1;transform:none}</style></head><body><aside id="nav"><div class="brand"><span>📊</span><span>Dashboard</span></div><nav><a class="active" href="/dashboard2">Overview</a><a href="/crm2">CRM</a><a href="/api/stats">API</a></nav></aside><div class="wrap" style="flex:1;display:flex;flex-direction:column"><div class="topbar"><button id="menu" class="btn">Menu</button><div style="flex:1"></div><a class="btn" href="/crm2">CRM</a></div><main><header><div><div class="title">Overview</div><div class="sub">Ringkasan operasi</div></div><a class="btn" href="/crm2">Pergi ke CRM</a></header><section class="grid fade" id="cards"><div class="card"><div class="muted">Customers</div><div class="num">${s.customers}</div></div><div class="card"><div class="muted">Contacts</div><div class="num">${s.contacts}</div></div><div class="card"><div class="muted">Purchases</div><div class="num">${s.purchases}</div></div><div class="card"><div class="muted">Income RM</div><div class="num">${s.incomeRM}</div></div></section><section class="two fade" id="charts"><div class="card"><div class="muted">Stock</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px"><div class="pill">Total ${s.stockTotal}</div><div class="pill">Used ${s.stockUsed}</div><div class="pill">Avail ${s.stockAvailable}</div></div><table class="table" style="margin-top:8px"><tr><th>Premium</th><th>Standard</th><th>Ads</th></tr><tr><td>${s.planAvailable.premium||0}</td><td>${s.planAvailable.standard||0}</td><td>${s.planAvailable.ads||0}</td></tr></table><div class="section"><span class="pill ${s.expiringSoon>0?'danger':''}">Expiring ≤7d ${s.expiringSoon}</span> <span class="pill">Expired ${s.expired}</span></div></div><div class="card" style="text-align:center"><div class="muted">By Plan</div><div class="donut"></div><div class="legend"><div class="item"><span class="dot" style="background:var(--accent)"></span><span>Premium</span></div><div class="item"><span class="dot" style="background:var(--accent2)"></span><span>Standard</span></div><div class="item"><span class="dot" style="background:var(--accent3)"></span><span>Ads</span></div><div class="item"><span class="dot" style="background:#2b3240"></span><span>Unknown</span></div></div></div></section><section class="section fade" id="shotsWrap"><div class="muted">Resit Terkini</div><div class="shots">${receiptsImgs}</div></section><div class="footer">Dashboard</div></main></div><script>var a=document.getElementById('nav');var m=document.getElementById('menu');if(m){m.onclick=function(){a.classList.toggle('open')}};setTimeout(function(){document.getElementById('cards').classList.add('show');document.getElementById('charts').classList.add('show');document.getElementById('shotsWrap').classList.add('show')},120)</script></body></html>`
        res.writeHead(200, { 'Content-Type':'text/html' })
        const extra = `<script>
          (function(){
          var style=document.createElement('style');
          style.textContent='.overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;z-index:999}.overlay.show{display:flex}.overlay img{max-width:92vw;max-height:92vh;border-radius:12px}.light{--bg:#ffffff;--panel:#f7f7f9;--text:#111;--muted:#667085;--accent:#ffb300;--accent2:#0ea5e9;--accent3:#06b6d4;--danger:#ef4444}';
          document.head.appendChild(style);
          })();
          function renderCards(s){
            var el=document.getElementById('cards');
            if(!el) return;
            el.innerHTML = '<div class="card"><div class="muted">Customers</div><div class="num">'+s.customers+'</div></div>'+
              '<div class="card"><div class="muted">Contacts</div><div class="num">'+s.contacts+'</div></div>'+
              '<div class="card"><div class="muted">Purchases</div><div class="num">'+s.purchases+'</div></div>'+
              '<div class="card"><div class="muted">Income RM</div><div class="num">'+s.incomeRM+'</div></div>'
          }
          function renderCharts(s){
            var wrap=document.getElementById('charts');
            if(!wrap) return;
            var donutTotal=(s.byPlan.premium||0)+(s.byPlan.standard||0)+(s.byPlan.ads||0)+(s.byPlan.unknown||0)||1;
            var p1=Math.round(((s.byPlan.premium||0)/donutTotal)*360),p2=Math.round(((s.byPlan.standard||0)/donutTotal)*360),p3=Math.round(((s.byPlan.ads||0)/donutTotal)*360);
            var g1=p1,g2=p1+p2,g3=p1+p2+p3;
            wrap.innerHTML = '<div class="card"><div class="muted">Stock</div>'+
              '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px">'+
              '<div class="pill">Total '+s.stockTotal+'</div><div class="pill">Used '+s.stockUsed+'</div><div class="pill">Avail '+s.stockAvailable+'</div></div>'+
              '<table class="table" style="margin-top:8px"><tr><th>Premium</th><th>Standard</th><th>Ads</th></tr><tr><td>'+(s.planAvailable.premium||0)+'</td><td>'+(s.planAvailable.standard||0)+'</td><td>'+(s.planAvailable.ads||0)+'</td></tr></table>'+
              '<div class="section"><span class="pill '+(s.expiringSoon>0?'danger':'')+'">Expiring ≤7d '+s.expiringSoon+'</span> <span class="pill">Expired '+s.expired+'</span></div></div>'+
              '<div class="card" style="text-align:center"><div class="muted">By Plan</div><div class="donut" style="background:conic-gradient(var(--accent) 0deg '+g1+'deg, var(--accent2) '+g1+'deg '+g2+'deg, var(--accent3) '+g2+'deg '+g3+'deg, #2b3240 '+g3+'deg 360deg)"></div>'+
              '<div class="legend"><div class="item"><span class="dot" style="background:var(--accent)"></span><span>Premium</span></div><div class="item"><span class="dot" style="background:var(--accent2)"></span><span>Standard</span></div><div class="item"><span class="dot" style="background:var(--accent3)"></span><span>Ads</span></div><div class="item"><span class="dot" style="background:#2b3240"></span><span>Unknown</span></div></div></div>'
          }
          function ensureQuick(){
            var main=document.querySelector('main');
            if(!main) return; if(document.getElementById('quick')) return;
            var sec=document.createElement('section'); sec.className='section'; sec.id='quick';
            sec.innerHTML='<div class="grid" style="grid-template-columns:repeat(2,1fr);gap:12px">'+
              '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div class="muted">Expiring ≤7 days</div><a class="btn" href="/crm2?tab=contacts&q=expiring">Buka CRM</a></div><div id="expiringList" class="muted" style="margin-top:8px"></div></div>'+
              '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div class="muted">Issues</div><a class="btn" href="/crm2?tab=issues">Buka CRM</a></div><div id="issuesList" class="muted" style="margin-top:8px"></div></div>'+
            '</div>';
            main.appendChild(sec);
          }
          function renderQuick(stats, issues){
            ensureQuick();
            var e=document.getElementById('expiringList'); var i=document.getElementById('issuesList');
            var ex=Array.isArray(stats.latestExpiries)?stats.latestExpiries.slice(0,6):[];
            e.innerHTML=ex.map(function(x){ return '<div class="row"><span>'+ (x.name||'') +'</span><span class="pill">'+ (x.daysLeft!=null? (x.daysLeft+'d') : '') +'</span></div>'}).join('') || 'Tiada';
            var iss=Array.isArray(issues)?issues.slice(-6).reverse():[];
            i.innerHTML=iss.map(function(x){ return '<div>'+ (x.at||'') +' • '+ (x.name||'') +' • '+ ((x.account||{}).email||'') +'</div>'}).join('') || 'Tiada';
          }
          function setupLightbox(){
            var wrap=document.getElementById('shotsWrap'); if(!wrap) return; if(wrap._lb) return; wrap._lb=true;
            var ov=document.createElement('div'); ov.className='overlay'; ov.innerHTML='<img/>'; document.body.appendChild(ov);
            wrap.addEventListener('click', function(ev){ var img=ev.target.closest('img'); if(!img) return; ov.querySelector('img').src=img.src; ov.classList.add('show'); });
            ov.addEventListener('click', function(){ ov.classList.remove('show'); });
          }
          function ensureIncomeSection(){
            var main=document.querySelector('main'); if(!main) return; if(document.getElementById('incomeSec')) return;
            var sec=document.createElement('section'); sec.className='section'; sec.id='incomeSec';
            sec.innerHTML='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div class="muted">Income 6 bulan</div><button id="themeToggle" class="btn">Tema</button></div><svg id="incomeSvg" width="100%" height="140" preserveAspectRatio="none"></svg></div>';
            main.appendChild(sec);
          }
          function renderIncomeChart(purchases){
            ensureIncomeSection(); var svg=document.getElementById('incomeSvg'); if(!svg) return;
            var parseM=(s)=>{ var d=new Date(s); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0,7) };
            var map={}; (purchases||[]).forEach(function(p){ if(!p.at||p.priceRM==null) return; var k=parseM(p.at); map[k]=(map[k]||0)+Number(p.priceRM)||0 });
            var now=new Date(); var keys=[]; for(var i=5;i>=0;i--){ var d=new Date(now.getFullYear(), now.getMonth()-i, 1); var k=d.toISOString().slice(0,7); keys.push(k) }
            var series=keys.map(function(k){ return { k, v: map[k]||0 } });
            var maxV=series.reduce((m,x)=>x.v>m?x.v:m,0); var w=svg.clientWidth||600; var h=140; var pad=20; var step=(w-pad*2)/Math.max(series.length-1,1);
            var pts=series.map(function(x,idx){ var px=pad+idx*step; var py= h-pad - (maxV? (x.v/maxV)*(h-pad*2) : 0); return [px,py] });
            var dPath = pts.map((p,i)=> (i?'L':'M')+p[0]+','+p[1]).join(' ');
            svg.innerHTML='<polyline fill="none" stroke="var(--accent2)" stroke-width="2" points="'+pts.map(p=>p.join(',')).join(' ')+'" />'+
              '<path d="'+dPath+'" fill="none" stroke="var(--accent3)" stroke-width="2" />'+
              pts.map(function(p,idx){ return '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="3" fill="var(--accent)" />' }).join('')+
              keys.map(function(k,idx){ var x=pad+idx*step; return '<text x="'+x+'" y="'+(h-4)+'" fill="var(--muted)" font-size="10" text-anchor="middle">'+k+'</text>' }).join('')+
              '<text x="'+(w-4)+'" y="12" fill="var(--muted)" font-size="10" text-anchor="end">RM '+maxV+'</text>';
          }
          function ensureThemeToggle(){
            var btn=document.getElementById('themeToggle'); if(!btn) return;
            var apply=function(mode){ if(mode==='light'){ document.body.classList.add('light') } else { document.body.classList.remove('light') } localStorage.setItem('themeMode', mode) };
            var cur=localStorage.getItem('themeMode')||'dark'; apply(cur);
            btn.onclick=function(){ cur = (document.body.classList.contains('light')?'dark':'light'); apply(cur) };
          }
          var API=(localStorage.getItem('api')|| (location.origin.indexOf('sanztech.online')>-1?'https://bot.sanztech.online':''));
          var TOKEN=(localStorage.getItem('token')|| new URLSearchParams(location.search).get('token')||'');
          if(TOKEN) localStorage.setItem('token', TOKEN);
          function apiUrl(p){ var u=(API?API:'')+p; if(TOKEN){ u+= (u.indexOf('?')>-1?'&':'?')+'token='+TOKEN } return u }
          async function refresh(){
            try{ var rs=await fetch(apiUrl('/api/stats')); if(!rs.ok) return; var s=await rs.json(); renderCards(s); renderCharts(s); var ri=await fetch(apiUrl('/api/issues')); var arr= ri.ok? await ri.json() : []; renderQuick(s, arr); setupLightbox(); ensureIncomeSection(); var rp=await fetch(apiUrl('/api/purchases')); var ps= rp.ok? await rp.json() : []; renderIncomeChart(ps); ensureThemeToggle(); }catch(e){}
          }
          setInterval(refresh, 8000);
          window.addEventListener('load', function(){ setTimeout(refresh, 400); });
        </script>`;
        res.end(html2.replace('</body></html>', extra + '</body></html>'))
        return
      }
      if(u.pathname === '/dashboard' || u.pathname === '/'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const s = computeStats()
        const donutTotal = (s.byPlan.premium||0)+(s.byPlan.standard||0)+(s.byPlan.ads||0)+(s.byPlan.unknown||0) || 1
        const p1 = Math.round(((s.byPlan.premium||0)/donutTotal)*360)
        const p2 = Math.round(((s.byPlan.standard||0)/donutTotal)*360)
        const p3 = Math.round(((s.byPlan.ads||0)/donutTotal)*360)
        const g1 = p1
        const g2 = p1+p2
        const g3 = p1+p2+p3
        const receipts = (()=>{ try{ const r=JSON.parse(fs.readFileSync(path.resolve('./secure_data/used_accounts.json'),'utf8')); const arr = Array.isArray(r.payments)?r.payments:[]; return arr.slice(-8).reverse().map(x=>x.receiptFile).filter(Boolean);}catch{return []} })()
        const receiptsImgs = receipts.map(n=>`<div class="shot"><img src="/receipts/${encodeURIComponent(n)}" alt="${n}"/><div class="cap">${n}</div></div>`).join('')
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title><style>:root{--bg:#0d0f14;--panel:#161a22;--text:#e8e8e8;--muted:#9aa5b1;--accent:#ffc107;--accent2:#18a0fb;--accent3:#26c6da;--danger:#ff5c77}*{box-sizing:border-box}body{font-family:Inter,system-ui,Arial;background:var(--bg);color:var(--text);margin:0;display:flex;min-height:100vh}aside{width:220px;background:#0b0d11;border-right:1px solid #1f2530;padding:18px;display:flex;flex-direction:column}aside .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:16px}aside nav a{display:block;padding:10px 12px;border-radius:8px;color:#cdd7e3;text-decoration:none;margin-bottom:6px}aside nav a.active{background:#141822;color:#fff;border:1px solid #222834}main{flex:1;padding:22px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}header .title{font-size:22px;font-weight:700}header .sub{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px}.card{background:var(--panel);padding:14px;border-radius:12px;border:1px solid #222834}.num{font-size:28px;font-weight:700}.muted{color:var(--muted)}.two{display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-top:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{border-bottom:1px solid #222834;padding:8px;text-align:left}.section{margin-top:12px}.donut{width:220px;height:220px;border-radius:50%;background:conic-gradient(var(--accent) 0deg ${g1}deg, var(--accent2) ${g1}deg ${g2}deg, var(--accent3) ${g2}deg ${g3}deg, #2b3240 ${g3}deg 360deg);position:relative;margin:auto}.donut::after{content:"";position:absolute;inset:24px;background:var(--panel);border-radius:50%;}.legend{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px}.legend .item{display:flex;gap:8px;align-items:center}.dot{width:10px;height:10px;border-radius:50%}.shots{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}.shot{background:#0b0d11;border:1px solid #222834;border-radius:10px;overflow:hidden}.shot img{width:100%;height:110px;object-fit:cover;display:block}.cap{font-size:11px;color:#cdd7e3;padding:6px}</style></head><body><aside><div class="brand"><div style="width:10px;height:10px;background:var(--accent);border-radius:2px"></div><div>WhatsApp Bot</div></div><nav><a class="active" href="/dashboard">Dashboard</a><a href="/api/stats">API</a></nav></aside><main><header><div class="title">Dashboard</div><div class="sub">Live metrics</div></header><div class="grid"><div class="card"><div class="muted">Customers</div><div class="num">${s.customers}</div></div><div class="card"><div class="muted">Contacts</div><div class="num">${s.contacts}</div></div><div class="card"><div class="muted">Purchases</div><div class="num">${s.purchases}</div></div><div class="card"><div class="muted">Income RM</div><div class="num">${s.incomeRM}</div></div><div class="card"><div class="muted">Issues</div><div class="num" style="color:${s.issues>0?'var(--danger)':'var(--text)'}">${s.issues}</div></div><div class="card"><div class="muted">Replacements</div><div class="num">${s.replacements}</div></div><div class="card"><div class="muted">Stock Total</div><div class="num">${s.stockTotal}</div></div><div class="card"><div class="muted">Stock Available</div><div class="num">${s.stockAvailable}</div></div></div><div class="two"><div class="card"><div class="muted">Latest Issues</div><table class="table"><tr><th>At</th><th>Name</th><th>Phone</th><th>Email</th><th>Message</th></tr>${s.latestIssues.map(i=>`<tr><td>${i.at||''}</td><td>${i.name||''}</td><td>${i.buyerPhone||''}</td><td>${i.account?.email||''}</td><td>${(i.message||'').slice(0,120)}</td></tr>`).join('')}</table></div><div class="card"><div class="muted">By Plan</div><div class="donut"></div><div class="legend"><div class="item"><div class="dot" style="background:var(--accent)"></div><div>Premium ${s.byPlan.premium||0}</div></div><div class="item"><div class="dot" style="background:var(--accent2)"></div><div>Standard ${s.byPlan.standard||0}</div></div><div class="item"><div class="dot" style="background:var(--accent3)"></div><div>Ads ${s.byPlan.ads||0}</div></div><div class="item"><div class="dot" style="background:#2b3240"></div><div>Unknown ${s.byPlan.unknown||0}</div></div></div></div><div class="two"><div class="card"><div class="muted">Latest Replacements</div><table class="table"><tr><th>At</th><th>Phone</th><th>Old</th><th>New</th><th>Plan</th></tr>${s.latestReplacements.map(r=>`<tr><td>${r.at||''}</td><td>${r.buyerPhone||''}</td><td>${r.oldEmail||''}</td><td>${r.newEmail||''}</td><td>${r.planType||''}</td></tr>`).join('')}</table></div><div class="card"><div class="muted">Upcoming Expiries</div><table class="table"><tr><th>Expiry</th><th>Name</th><th>Phone</th><th>Days Left</th></tr>${s.latestExpiries.map(e=>`<tr><td>${e.expiry||''}</td><td>${e.name||''}</td><td>${e.phone||''}</td><td>${e.daysLeft||''}</td></tr>`).join('')}</table></div></div><div class="two"><div class="card"><div class="muted">Stock Available by Plan</div><table class="table"><tr><th>Plan</th><th>Available</th></tr><tr><td>Premium</td><td>${s.planAvailable.premium||0}</td></tr><tr><td>Standard</td><td>${s.planAvailable.standard||0}</td></tr><tr><td>Ads</td><td>${s.planAvailable.ads||0}</td></tr><tr><td>Unknown</td><td>${s.planAvailable.unknown||0}</td></tr></table></div><div class="card"><div class="muted">Receipts</div><div class="shots">${receiptsImgs}</div></div></div></main></body></html>`
        res.writeHead(200, { 'Content-Type':'text/html' })
        res.end(html)
        return
      }
      if(u.pathname === '/crm2'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const html2 = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CRM</title><style>:root{--bg:#0d0f14;--panel:#161a22;--text:#e8e8e8;--muted:#9aa5b1}*{box-sizing:border-box}body{font-family:Inter,system-ui,Arial;background:var(--bg);color:var(--text);margin:0;display:flex;min-height:100vh}aside{width:220px;background:#0b0d11;border-right:1px solid #1f2530;padding:18px}aside a{display:block;padding:10px 12px;border-radius:8px;color:#cdd7e3;text-decoration:none;margin-bottom:6px;transition:all .2s ease}aside a.active{background:#141822;color:#fff;border:1px solid #222834}main{flex:1;padding:22px}h1{margin:0 0 12px}nav.tabs{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}nav.tabs button{background:#0b0d11;color:#cdd7e3;border:1px solid #222834;padding:8px 12px;border-radius:8px;cursor:pointer;transition:all .2s ease}nav.tabs button.active{background:#141822;color:#fff}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #222834;padding:8px;text-align:left}input[type=text]{background:#0b0d11;color:#fff;border:1px solid #222834;border-radius:8px;padding:8px;width:100%}.row{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:12px}@media (max-width:640px){aside{position:fixed;left:0;top:0;bottom:0;transform:translateX(-100%);transition:transform .25s ease;width:180px}aside.open{transform:translateX(0)}main{padding:16px}}.btn{background:#0b0d11;color:#cdd7e3;border:1px solid #222834;padding:8px 12px;border-radius:8px;text-decoration:none;transition:all .2s ease}.btn:hover{background:#141822;color:#fff}.topbar{display:none}@media (max-width:640px){.topbar{display:flex;align-items:center;gap:12px;background:#0b0d11;border-bottom:1px solid #1f2530;padding:10px 14px;position:sticky;top:0;z-index:10}}</style></head><body><aside id="crmNav"><a href="/dashboard2">Dashboard</a><a class="active" href="/crm2">CRM</a><a href="/api/stats">API</a></aside><div style="flex:1;display:flex;flex-direction:column"><div class="topbar"><button id="menu2" class="btn">Menu</button><div style="flex:1"></div><a class="btn" href="/dashboard2">Dashboard</a></div><main><h1>CRM</h1><nav class="tabs"><button data-tab="contacts" class="active">Contacts</button><button data-tab="purchases">Purchases</button><button data-tab="issues">Issues</button><button data-tab="replacements">Replacements</button></nav><div class="row"><input id="search" type="text" placeholder="Search"/><a id="exportLink" href="#" class="btn">Export CSV</a></div><div id="tableWrap"></div><script>var params=new URLSearchParams(location.search);var current=params.get('tab')||'contacts';var initialQ=params.get('q')||'';document.getElementById("search").value=initialQ;var btns=Array.prototype.slice.call(document.querySelectorAll("nav.tabs button"));btns.forEach(function(b){b.onclick=function(){btns.forEach(function(x){x.classList.remove("active")});b.classList.add("active");current=b.dataset.tab;load()}});document.getElementById("search").oninput=function(){render()};function fmt(x){return x||""}function table(head,rows){var t='<table><thead><tr>'+head.map(function(h){return'<th>'+h+'</th>'}).join('')+'</tr></thead><tbody>'+rows.map(function(r){return'<tr>'+r.map(function(c){return'<td>'+fmt(c)+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table>';document.getElementById('tableWrap').innerHTML=t}var API=(localStorage.getItem('api')|| (location.origin.indexOf('sanztech.online')>-1?'https://bot.sanztech.online':''));var TOKEN=(localStorage.getItem('token')|| new URLSearchParams(location.search).get('token')||'');if(TOKEN) localStorage.setItem('token', TOKEN);function apiUrl(p){var u=(API?API:'')+p; if(TOKEN){ u+= (u.indexOf('?')>-1?'&':'?')+'token='+TOKEN } return u }function setExport(){var link=document.getElementById('exportLink');link.href=apiUrl('/api/export?type='+current)}function render(){setExport();var q=(document.getElementById('search').value||initialQ||'').toLowerCase();fetch(apiUrl('/api/'+current)).then(function(r){return r.json()}).then(function(arr){arr=arr.filter(function(x){return JSON.stringify(x).toLowerCase().includes(q)});if(current==='contacts') table(['chatId','name','phone','lastSeen'], arr.map(function(c){return[c.chatId,c.name,c.phone,c.lastSeen]}));else if(current==='purchases') table(['buyerName','buyerPhone','planType','planMonths','priceRM','receiptFile','at'], arr.map(function(p){return[p.buyerName,p.buyerPhone,p.planType,p.planMonths,p.priceRM,p.receiptFile,p.at]}));else if(current==='issues') table(['name','buyerPhone','email','message','at'], arr.map(function(i){return[i.name,i.buyerPhone,(i.account||{}).email||'',i.message,i.at]}));else table(['buyerPhone','oldEmail','newEmail','planType','at'], arr.map(function(r){return[r.buyerPhone,r.oldEmail,r.newEmail,r.planType,r.at]}))})}function load(){render()}load();var n=document.getElementById('crmNav');var m=document.getElementById('menu2');if(m){m.onclick=function(){n.classList.toggle('open')}};</script></main></div></body></html>`
        res.writeHead(200, { 'Content-Type':'text/html' })
        res.end(html2)
        return
      }
      if(u.pathname === '/crm'){
        if(!allowed()){ res.writeHead(401); res.end('Unauthorized'); return }
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>CRM</title><style>:root{--bg:#0d0f14;--panel:#161a22;--text:#e8e8e8;--muted:#9aa5b1}*{box-sizing:border-box}body{font-family:Inter,system-ui,Arial;background:var(--bg);color:var(--text);margin:0;display:flex;min-height:100vh}aside{width:220px;background:#0b0d11;border-right:1px solid #1f2530;padding:18px}aside a{display:block;padding:10px 12px;border-radius:8px;color:#cdd7e3;text-decoration:none;margin-bottom:6px}aside a.active{background:#141822;color:#fff;border:1px solid #222834}main{flex:1;padding:22px}h1{margin:0 0 12px}nav.tabs{display:flex;gap:10px;margin-bottom:12px}nav.tabs button{background:#0b0d11;color:#cdd7e3;border:1px solid #222834;padding:8px 12px;border-radius:8px;cursor:pointer}nav.tabs button.active{background:#141822;color:#fff}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #222834;padding:8px;text-align:left}input[type=text]{background:#0b0d11;color:#fff;border:1px solid #222834;border-radius:8px;padding:8px;width:100%}.row{display:flex;gap:10px;margin-bottom:12px}</style></head><body><aside><a href="/dashboard">Dashboard</a><a class="active" href="/crm">CRM</a><a href="/api/stats">API</a></aside><main><h1>CRM</h1><nav class="tabs"><button data-tab="contacts" class="active">Contacts</button><button data-tab="purchases">Purchases</button><button data-tab="issues">Issues</button><button data-tab="replacements">Replacements</button></nav><div class="row"><input id="search" type="text" placeholder="Search"/><a id="exportLink" href="#" style="color:#7cc4ff;text-decoration:none">Export CSV</a></div><div id="tableWrap"></div><script>var current="contacts";var btns=Array.prototype.slice.call(document.querySelectorAll("nav.tabs button"));btns.forEach(function(b){b.onclick=function(){btns.forEach(function(x){x.classList.remove("active")});b.classList.add("active");current=b.dataset.tab;load()}});document.getElementById("search").oninput=function(){render(window._rows||[])};var API=(localStorage.getItem('api')|| (location.origin.indexOf('sanztech.online')>-1?'https://bot.sanztech.online':''));var TOKEN=(localStorage.getItem('token')|| new URLSearchParams(location.search).get('token')||'');if(TOKEN) localStorage.setItem('token', TOKEN);function apiUrl(p){var u=(API?API:'')+p; if(TOKEN){ u+= (u.indexOf('?')>-1?'&':'?')+'token='+TOKEN } return u }document.getElementById("exportLink").onclick=function(e){e.preventDefault();location.href=apiUrl('/api/export?type='+current)};function esc(s){return String(s||"")}function rowContacts(r){return "<tr><td>"+esc(r.name)+"</td><td>"+esc(r.phone)+"</td><td>"+esc(r.lastSeen)+"</td></tr>"}function rowPurchases(r){return "<tr><td>"+esc(r.buyerName)+"</td><td>"+esc(r.buyerPhone)+"</td><td>"+esc(r.planType)+"</td><td>"+esc(r.planMonths)+"</td><td>"+esc(r.priceRM)+"</td><td>"+esc(r.at)+"</td></tr>"}function rowIssues(r){return "<tr><td>"+esc(r.name)+"</td><td>"+esc(r.buyerPhone)+"</td><td>"+esc((r.account||{}).email)+"</td><td>"+esc((r.message||"").slice(0,120))+"</td><td>"+esc(r.at)+"</td></tr>"}function rowRepl(r){return "<tr><td>"+esc(r.buyerPhone)+"</td><td>"+esc(r.oldEmail)+"</td><td>"+esc(r.newEmail)+"</td><td>"+esc(r.planType)+"</td><td>"+esc(r.at)+"</td></tr>"}async function load(){var res=await fetch(apiUrl('/api/'+current));var rows=await res.json();window._rows=rows;render(rows)}function render(rows){var q=(document.getElementById("search").value||"").toLowerCase();var list=rows.filter(function(r){return JSON.stringify(r).toLowerCase().indexOf(q)>-1});var html='';if(current==='contacts'){html='<table><tr><th>Name</th><th>Phone</th><th>Last Seen</th></tr>'+list.map(rowContacts).join('')+'</table>'}else if(current==='purchases'){html='<table><tr><th>Name</th><th>Phone</th><th>Plan</th><th>Months</th><th>Price RM</th><th>Date</th></tr>'+list.map(rowPurchases).join('')+'</table>'}else if(current==='issues'){html='<table><tr><th>Name</th><th>Phone</th><th>Email</th><th>Message</th><th>Date</th></tr>'+list.map(rowIssues).join('')+'</table>'}else{html='<table><tr><th>Phone</th><th>Old</th><th>New</th><th>Plan</th><th>Date</th></tr>'+list.map(rowRepl).join('')+'</table>'}document.getElementById("tableWrap").innerHTML=html}load()</script></main></body></html>`
        res.writeHead(200, { 'Content-Type':'text/html' })
        res.end(html)
        return
      }
      res.writeHead(404, { 'Content-Type':'text/plain' })
      res.end('Not found')
    }catch(e){
      res.writeHead(500, { 'Content-Type':'text/plain' })
      res.end('Error')
    }
  })
  server.listen(port, ()=>{})
  return server
}

startDashboardServer()
startReminderScheduler()
function extractPhone(chatId){
  const id = (chatId||'').split('@')[0]
  if(!id) return null
  const d = id.replace(/[^0-9]/g,'')
  if(!d) return null
  return d.startsWith('+' ) ? d : d
}

function upsertContact(chatId, name){
  const used = loadUsed()
  used.contacts = used.contacts || []
  const phone = extractPhone(chatId)
  let found = null
  for(let i=0;i<used.contacts.length;i++){
    const c = used.contacts[i]
    if(c.chatId === chatId || (phone && c.phone === phone)){ found = c; break }
  }
  const now = new Date().toISOString()
  if(found){
    found.name = name || found.name || null
    found.phone = phone || found.phone || null
    found.lastSeen = now
  }else{
    used.contacts.push({ chatId, name: name || null, alias: null, phone: phone || null, lastSeen: now })
  }
  saveUsed(used)
}

function setAlias(chatId, alias){
  const used = loadUsed()
  used.contacts = used.contacts || []
  const phone = extractPhone(chatId)
  let found = null
  for(let i=0;i<used.contacts.length;i++){
    const c = used.contacts[i]
    if(c.chatId === chatId || (phone && c.phone === phone)){ found = c; break }
  }
  const now = new Date().toISOString()
  if(found){
    found.alias = alias || found.alias || null
    found.lastSeen = now
  }else{
    used.contacts.push({ chatId, name: null, alias: alias || null, phone: phone || null, lastSeen: now })
  }
  saveUsed(used)
}

function addAdmin(chatId){
  const used = loadUsed()
  used.admins = Array.isArray(used.admins) ? used.admins : []
  const exists = used.admins.some(x=>x===chatId)
  if(!exists){ used.admins.push(chatId) }
  saveUsed(used)
}
function getChatIdByPhone(phone){
  try{
    const d = loadUsed()
    const contacts = Array.isArray(d.contacts)?d.contacts:[]
    const p = String(phone||'').replace(/[^0-9]/g,'')
    for(const c of contacts){ if((c.phone||'')===p) return c.chatId }
  }catch{}
  return null
}

async function runExpiryReminders(){
  try{
    const d = loadUsed()
    d.reminders = Array.isArray(d.reminders)?d.reminders:[]
    const payments = Array.isArray(d.payments)?d.payments:[]
    const now = Date.now()
    for(const p of payments){
      if(!p.planMonths || !p.at) continue
      const start = new Date(p.at)
      const exp = new Date(start.getTime()); exp.setMonth(exp.getMonth() + Number(p.planMonths))
      const daysLeft = Math.ceil((exp.getTime() - now) / (24*3600*1000))
      if(daysLeft < 0 || daysLeft > 7) continue
      const chatId = getChatIdByPhone(p.buyerPhone||'')
      if(!chatId) continue
      let last = null
      for(let i=d.reminders.length-1;i>=0;i--){ const r=d.reminders[i]; if(r.chatId===chatId && r.type==='expiry'){ last=r; break } }
      if(last){ const diff = now - new Date(last.at).getTime(); if(diff < 24*3600*1000) continue }
      const msg = `Hi ${p.buyerName||''}, langganan anda akan tamat dalam ${daysLeft} hari. Mahu renew?`
      try{ await client.sendMessage(chatId, msg) }catch{}
      d.reminders.push({ chatId, type: 'expiry', at: new Date().toISOString(), daysLeft })
    }
    saveUsed(d)
  }catch{}
}

function startReminderScheduler(){
  runExpiryReminders()
  setInterval(runExpiryReminders, 6*3600*1000)
}
async function analyzeReceiptLLM(base64, mime, caption){
  try{
    const key = process.env.OPENROUTER_API_KEY
    if(!key) return null
    const url = 'https://openrouter.ai/api/v1/chat/completions'
    const content = [
      { type:'text', text: 'Ekstrak amount (RM), merchant, status berjaya/gagal, kaedah bayar dan tarikh daripada imej resit. Balas JSON ringkas dengan kunci: amountRM, currency, success, merchant, method, time.' },
      { type:'input_image', image_url: { url: `data:${mime};base64,${base64}` } }
    ]
    const body = { model:'openai/gpt-4o', messages:[{ role:'user', content }], temperature:0.2, max_tokens:200 }
    const res = await fetch(url,{ method:'POST', headers:{ 'Authorization':`Bearer ${key}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    const txt = data?.choices?.[0]?.message?.content?.trim() || ''
    let obj = null
    try{ obj = JSON.parse(txt) }catch{}
    if(obj && typeof obj==='object') return obj
    const m = txt.match(/amount\s*[:=]\s*rm?\s*([0-9]+(?:\.[0-9]+)?)/i)
    const amt = m ? Math.round(parseFloat(m[1])) : null
    const succ = /berjaya|successful|success/i.test(txt)
    return { amountRM: amt, currency: 'RM', success: succ || null }
  }catch{ return null }
}
