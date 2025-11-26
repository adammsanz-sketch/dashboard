const KB = {
  products: [
    { plan: 'Standard', months: 1, priceRM: 9 },
    { plan: 'Premium', months: 1, priceRM: 14 },
    { plan: 'Standard', months: 3, priceRM: 25 },
    { plan: 'Premium', months: 3, priceRM: 30 },
    { plan: 'Standard', months: 6, priceRM: 48 },
    { plan: 'Standard', months: 12, priceRM: 90 },
    { plan: 'Standard', months: 24, priceRM: 121 }
  ],
  features: [
    'Dolby Atmos',
    'Full HD 1080p / UltraHD 4K',
    'Fully Warranty',
    'Trusted Seller',
    '24/7 Remote Support'
  ],
  payment: {
    method: 'Touch n Go eWallet (Scan QR)',
    accountName: 'MOHD ZULFADLI BIN ZULKEPLI',
    steps: [
      'Scan QR dengan aplikasi bank/eWallet (Malaysia National QR)',
      'Masukkan jumlah ikut pelan yang dipilih',
      'Hantar bukti pembayaran dan email untuk aktifkan akaun',
      'Aktif segera selepas sahkan pembayaran'
    ],
    mediaPath: './payment_tng.png'
  }
}

const greetings = ['hi','hai','hello','helo','hey','assalamualaikum','salam']
const thanks = ['terima kasih','tq','thank you','thanks','makasih']
const affirm = ['ya','ok','okay','baik','boleh','setuju']
const deny = ['tak','tidak','no','x','taknak','belum']
const random = (arr) => arr[Math.floor(Math.random()*arr.length)]
const enders = ['🙂','😉','👌','👍','🙏']
const EMOJI_RE = /[\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

export const humanize = (text) => {
  const softeners = ['baik','okey','ya','sekejap ya','tunggu sekejap','noted']
  const addPhrase = Math.random() < 0.4 ? ` ${random(softeners)}` : ''
  const addEmoji = Math.random() < 0.2 ? ` ${random(enders)}` : ''
  return `${text}${addPhrase}${addEmoji}`
}

const calcDelay = (incoming, replyLen=0) => {
  const base = 700, perChar = 42, max = 4500
  const len = Math.min((incoming?.length || 0) + replyLen, 300)
  return Math.min(base + len*perChar, max)
}

const normalize = (s) => (s||'').toLowerCase().replace(/[^a-zA-Z0-9\s]/g,'').trim()

const SYSTEM_PROMPT = `
Anda ialah chatbot WhatsApp untuk jual akaun streaming.
Gaya: ringkas, mesra, profesional, Bahasa Melayu.
Tugas:
- Fahami pertanyaan pelanggan dan cadang pelan sesuai.
- Nyatakan harga tepat ikut katalog.
- Tekankan ciri: ${KB.features.join(', ')}.
- Beri arahan pembayaran yang jelas: ${KB.payment.method}.
- Jika maklumat tiada dalam konteks, tanya soalan ringkas untuk jelas.
- Elakkan mesej terlalu panjang; beri langkah seterusnya (cara bayar, bukti, tempoh aktif).
`

function formatCatalog(filterPremium) {
  const rows = KB.products
    .filter(p => filterPremium === undefined ? true : (filterPremium ? p.plan.toLowerCase()==='premium' : p.plan.toLowerCase()!=='premium'))
    .map(p => `${p.months} bulan ${p.plan} — RM${p.priceRM}`)
  return rows.join('\n')
}

function keywordPricing(txt){
  return /(harga|price|rate|kos|berapa|rm|ringgit|bulan|bulanan|premium|standard|ads|plan|pelan|pakej|package|paket|langgan|subscribe|sub|beli|order|purchase|deal|offer|promosi|promo|tawaran)/.test(txt)
}

function keywordPayment(txt){
  return /(bayar|payment|scan|qr|tng|touch|ewallet)/.test(txt)
}

function keywordProof(txt){
  return /(bukti|resit|receipt|proof|bayaran|transfer|bank in|screenshot)/.test(txt)
}

function keywordAllocate(txt){
  return /(aktif|aktifkan|activate|claim|redeem|tetapkan|assign)/.test(txt)
}

function keywordLoginHelp(txt){
  return /(login|log in|signin|sign in|masuk|cara login|cara log|macam mana nak login|how to login)/.test(txt)
}

function keywordHelpGeneral(txt){
  return /(tak faham|x faham|tidak faham|keliru|confuse)/.test(txt)
}

function keywordAdminEscalate(txt){
  return /(warranty|waranti|jaminan|refund|pulangan|approve|sahkan|manual|bank in|transfer bank|tolong admin|hubungi admin|soalan admin|tanya admin)/.test(txt)
}

function keywordIssue(txt){
  return /(rosak|broken|tak boleh|tidak boleh|cannot|invalid|salah|blocked|ban|error|gagal|fail login|tak masuk|tidak berfungsi)/.test(txt)
}

function keywordQuestion(txt){
  return /(\?|apa|macam mana|bagaimana|kenapa|bila|mana)/.test(txt)
}

function buildContext(){
  const json = JSON.stringify(KB)
  return `KATALOG_JSON=${json}`
}

async function callLLM(prompt, user){
  const key = process.env.OPENROUTER_API_KEY
  if(!key) throw new Error('OPENROUTER_API_KEY not set')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{
      'Authorization':`Bearer ${key}`,
      'Content-Type':'application/json',
      'HTTP-Referer':'http://localhost/',
      'X-Title':'WhatsApp Bot'
    },
    body: JSON.stringify({
      model:'openai/gpt-4o',
      messages:[
        { role:'system', content:SYSTEM_PROMPT },
        { role:'system', content:buildContext() },
        { role:'user', content:`Nama: ${user}\nMesej: ${prompt}` }
      ],
      temperature:0.7,
      max_tokens:160
    })
  })
  const data = await res.json()
  const reply = data?.choices?.[0]?.message?.content?.trim()
  if(!reply) throw new Error('Empty LLM reply')
  return reply
}

export function buildResponder(){
  return async function respond(body, name='Kawan'){
    const txt = normalize(body)
    const raw = body || ''

    if(EMOJI_RE.test(raw) && raw.replace(EMOJI_RE,'').trim().length===0){
      const e = raw.match(EMOJI_RE)?.[0] || random(enders)
      return { reply: e, delayMs: calcDelay(body, 2) }
    }

    if(keywordIssue(txt)){
      const reply = humanize(`Maaf atas kesulitan. Saya sudah rekod isu akaun anda dan akan semak segera. Boleh hantar screenshot ralat kalau ada? Jika akaun tidak valid atau bermasalah, kami akan ganti segera.`)
      return { reply, delayMs: calcDelay(body, reply.length), reportIssue: true }
    }

    if(keywordSubtitle(txt)){
      const reply = humanize(`Kebanyakan tajuk di Netflix ada pilihan subtitle dan audio (BM/EN) bergantung pada tajuk. Boleh tukar di ikon Audio/Subtitles pada pemain.`)
      return { reply, delayMs: calcDelay(body, reply.length) }
    }

    if(keywordHelp(txt)){
      const reply = humanize(`Jika ada yang tidak faham (cara login atau lain-lain), boleh WhatsApp admin: https://wa.me/qr/LYVUPSNLE4MXD1. Tunggu sekejap, kami akan bantu.`)
      return { reply, delayMs: calcDelay(body, reply.length) }
    }

    if(keywordCompare(txt)){
      const reply = humanize(`Perbezaan ringkas:\n• Premium: kualiti sehingga 4K, tanpa iklan.\n• Standard: Full HD 1080p, nilai terbaik.\n• Standard with ads: HD + ada iklan, paling jimat.\nJika mahu ikut bajet: Premium RM14, Standard RM9 (1 bulan).`)
      return { reply, delayMs: calcDelay(body, reply.length) }
    }

    if(keywordAdminEscalate(txt)){
      let cat = 'ADMIN'
      if(/warranty|waranti|jaminan/.test(txt)) cat = 'WARRANTY'
      else if(/refund|pulangan/.test(txt)) cat = 'REFUND'
      else if(/approve|sahkan/.test(txt)) cat = 'APPROVE'
      else if(/bank in|transfer bank/.test(txt)) cat = 'PAYMENT'
      const reply = humanize(`Baik, saya rujuk kepada admin untuk sahkan/perjelas. Jika perlu segera, WhatsApp admin: https://wa.me/qr/LYVUPSNLE4MXD1. Tunggu sekejap ya.`)
      return { reply, delayMs: calcDelay(body, reply.length), notifyAdmin: true, notifyCategory: cat }
    }

    if(keywordLoginHelp(txt) || keywordHelpGeneral(txt)){
      const reply = humanize(`Cara login ringkas:\n1) Buka aplikasi/website Netflix\n2) Tekan Sign In\n3) Masukkan email & password yang diberi\nJika masih keliru, boleh WhatsApp admin: https://wa.me/qr/LYVUPSNLE4MXD1.`)
      return { reply, delayMs: calcDelay(body, reply.length) }
    }

    if(keywordQuestion(txt)){
      const reply = humanize(`Baik, saya rujuk soalan ini kepada admin untuk jawapan tepat. Untuk bantuan segera, WhatsApp admin: https://wa.me/qr/LYVUPSNLE4MXD1.`)
      return { reply, delayMs: calcDelay(body, reply.length), notifyAdmin: true, notifyCategory: 'QUESTION' }
    }

    // Bukti perlu didahulukan daripada bayaran supaya "bukti pembayaran" tidak tersalah laluan
    if(keywordProof(txt)){
      const reply = humanize(`Boleh hantar bukti di sini. Sertakan: 1) Screenshot resit, 2) Pelan dipilih, 3) Email untuk login. Selepas sah, akaun diaktifkan segera.`)
      return { reply, delayMs: calcDelay(body, reply.length) }
    }

    if(keywordPayment(txt)){
      const steps = KB.payment.steps.map((s,i)=>`${i+1}. ${s}`).join('\n')
      const reply = humanize(`Cara bayar (${KB.payment.method}):\nNama akaun: ${KB.payment.accountName}\n${steps}`)
      return { reply, delayMs: calcDelay(body, reply.length), mediaPath: KB.payment.mediaPath }
    }


    if(keywordAllocate(txt)){
      const reply = humanize(`Baik, saya akan aktifkan akaun sekarang. Mohon beri email yang akan digunakan.`)
      return { reply, delayMs: calcDelay(body, reply.length), allocate: true }
    }

    if(keywordPricing(txt)){
      const q = parsePricingQuery(txt)
      if(q.plan || q.months){
        const pick = KB.products.find(p => (q.plan? p.plan.toLowerCase()===q.plan.toLowerCase(): true) && (q.months? p.months===q.months : true))
        if(pick){
          const line = `${pick.months} bulan ${pick.plan} — RM${pick.priceRM}`
          const reply = humanize(`Harga: ${line}. ${pricingFollowup()}`)
          return { reply, delayMs: calcDelay(body, reply.length) }
        }
      }
      const lines = formatCatalog(undefined)
      const reply = humanize(`Senarai harga:\n${lines}\n${pricingFollowup()}`)
      return { reply, delayMs: calcDelay(body, reply.length) }
    }

    try{
      const llmReply = await callLLM(body, name)
      return { reply: llmReply, delayMs: calcDelay(body, llmReply.length) }
    }catch{
      let reply
      if(greetings.some(g=>txt.startsWith(g))) reply = humanize(`Hi ${name}, apa khabar?`)
      else if(thanks.some(t=>txt.includes(t))) reply = humanize('Sama-sama! Ada apa lagi saya boleh bantu?')
      else if(affirm.some(a=>txt===a||txt.includes(a))) reply = humanize('Baik, saya teruskan ya.')
      else if(deny.some(d=>txt===d||txt.includes(d))) reply = humanize('Baik, kalau perlukan apa-apa beritahu saya ya.')
      else if(keywordQuestion(txt)) return { reply: humanize('Baik, saya rujuk soalan ini kepada admin. Tunggu sekejap ya.'), delayMs: calcDelay(body, 40), notifyAdmin: true, notifyCategory: 'QUESTION' }
      else if(txt.length<4) reply = humanize('Boleh jelaskan sikit lagi?')
      else reply = humanize('Baik, saya faham. Saya akan cuba bantu sebaik mungkin.')
      return { reply, delayMs: calcDelay(body, reply.length) }
    }
  }
}
function keywordCompare(txt){
  return /(beza|difference|compare|banding|vs)/.test(txt)
}
function keywordHelp(txt){
  return /(tak faham|tidak faham|xfaham|x faham|macam mana|cara login|nak login|nak log|bantu|help|support)/.test(txt)
}
function keywordSubtitle(txt){
  return /(subtitle|sarikata|caption|audio|bahasa melayu|bahasa malaysia|bm|malay)/.test(txt)
}
function parsePricingQuery(txt){
  let plan = null
  if(/premium/.test(txt)) plan = 'Premium'
  else if(/standard/.test(txt)) plan = 'Standard'
  else if(/ads/.test(txt)) plan = 'Ads'
  let months = null
  const m1 = txt.match(/(\d{1,2})\s*bulan/)
  if(m1) months = parseInt(m1[1],10)
  if(months==null){
    if(/sebulan|1 bulan/.test(txt)) months = 1
    else if(/3 bulan/.test(txt)) months = 3
    else if(/6 bulan/.test(txt)) months = 6
    else if(/12 bulan|setahun/.test(txt)) months = 12
    else if(/24 bulan|dua puluh empat/.test(txt)) months = 24
  }
  return { plan, months }
}

function pricingFollowup(){
  return 'Mahukan saya DM cara bayar?'
}
