import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  downloadMediaMessage, normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const logger = pino({ level: 'silent' })
const DATA_DIR = process.env.DATA_DIR || './data'
fs.mkdirSync(DATA_DIR, { recursive: true })
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth')
const CHATS_FILE = path.join(DATA_DIR, 'chats.json')
const SUBS_FILE = path.join(DATA_DIR, 'subs.json')
const PROMPT = fs.readFileSync('./prompt.txt', 'utf8')

// ----- المفاتيح (كلها مجانية) -----
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim()
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim()
const TAVILY_KEY = (process.env.TAVILY_API_KEY || '').trim()

const GROQ_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b')
  .split(',').map(s => s.trim()).filter(Boolean)
const GROQ_VISION_MODEL = (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b').trim()
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim()
const STT_MODEL = (process.env.GROQ_STT_MODEL || 'whisper-large-v3').trim()
const REASONING = (process.env.REASONING_EFFORT || 'medium').trim() // low | medium | high
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4000)
const SEARCH_ON = (process.env.SEARCH || 'on').trim() !== 'off'

const HISTORY_LIMIT = 12
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 60)
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR || 8)
const DEFAULT_TOPICS = process.env.DIGEST_TOPICS || 'أخبار المغرب، أخبار العالم، الرياضة، التكنولوجيا'
// نمر مسموح لها فالخاص (أرقام فقط، مفرقة بفاصلة). فارغ = الكل.
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)

const FAIL = 'السيرفر مشغول دابا، عاود المحاولة من بعد شوية 🙏'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const userPart = j => j?.split('@')[0].split(':')[0]

const SUB_CMDS = ['/نشرة', '/نشره', '/newsletter', '/digest']
const UNSUB_CMDS = ['/ايقاف', '/إيقاف', '/stop']
const NEWS_CMDS = ['/اخبار', '/أخبار', '/news']

// الأسئلة اللي كتحتاج بحث فالأنترنت
const SEARCH_HINT = /ابحث|بحث|اليوم|دابا|الان|الآن|حاليا|حالياً|آخر|اخر|جديد|أخبار|اخبار|خبر|نتيجة|نتائج|سعر|أسعار|اسعار|ثمن|طقس|مباراة|ماتش|بورصة|رئيس|وزير|حكومة|2025|2026|today|latest|news|price|score|weather|current|recent|now/i
const NEWS_HINT = /أخبار|اخبار|خبر|اليوم|دابا|الان|الآن|آخر|اخر|news|today|latest|breaking/i

// ---------- حفظ الملفات ----------
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return {} }
}
let chats = loadJson(CHATS_FILE)
let subs = loadJson(SUBS_FILE)
let saveTimer
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CHATS_FILE, JSON.stringify(chats)) }
    catch (e) { console.log('save failed:', e.message) }
  }, 2000)
}
function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs)) }
  catch (e) { console.log('subs save failed:', e.message) }
}
function pushHistory(jid, role, content) {
  const arr = (chats[jid] ||= [])
  arr.push({ role, content: String(content).slice(0, 3000) })
  while (arr.length > HISTORY_LIMIT) arr.shift()
  save()
}

// ---------- الوقت فالمغرب ----------
function casa() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date())
  const g = t => p.find(x => x.type === t).value
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) }
}

// ---------- الحدود ----------
const hits = new Map()
function limited(id) {
  const now = Date.now()
  const arr = (hits.get(id) || []).filter(t => now - t < 10 * 60 * 1000)
  arr.push(now)
  hits.set(id, arr)
  return arr.length > 20
}
const daily = new Map()
function overDaily(id) {
  const k = `${id}|${casa().date}`
  const n = (daily.get(k) || 0) + 1
  daily.set(k, n)
  if (daily.size > 5000) daily.clear()
  return n > DAILY_LIMIT
}

// ---------- تقسيم الجواب الطويل ----------
function chunks(text, max = 3500) {
  const out = []
  let cur = ''
  for (const para of text.split('\n\n')) {
    if (cur && (cur + '\n\n' + para).length > max) { out.push(cur); cur = '' }
    if (para.length > max) {
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max))
    } else {
      cur = cur ? cur + '\n\n' + para : para
    }
  }
  if (cur) out.push(cur)
  return out
}

// ---------- البحث (Tavily) ----------
const searchCache = new Map() // key -> { t, results }
async function tavily(query, news = false, max = 5, days = 0) {
  if (!TAVILY_KEY) return []
  const key = `${query}|${news}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.results
  try {
    const body = {
      query: query.slice(0, 350), max_results: max,
      search_depth: 'basic', topic: news ? 'news' : 'general'
    }
    if (news && days) body.days = days
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (!res.ok) {
      console.log('TAVILY ERROR', res.status, JSON.stringify(data).slice(0, 200))
      return []
    }
    const results = (data.results || []).slice(0, max).map(r => ({
      title: r.title, url: r.url, content: (r.content || '').slice(0, 450)
    }))
    if (searchCache.size > 300) searchCache.clear()
    searchCache.set(key, { t: Date.now(), results })
    return results
  } catch (e) {
    console.log('TAVILY FETCH ERROR', e.message)
    return []
  }
}
function formatResults(results) {
  return results.map((r, i) => {
    let host = ''
    try { host = new URL(r.url).hostname } catch (e) { /* ignore */ }
    return `${i + 1}) ${r.title} — ${r.content} (${host})`
  }).join('\n')
}

// ---------- Groq ----------
const blocked = new Map() // model -> وقت الفك
async function callGroq(model, system, past, userContent) {
  if (!GROQ_KEY || (blocked.get(model) || 0) > Date.now()) return null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const body = {
        model, temperature: 0.6, max_completion_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: system }, ...past, { role: 'user', content: userContent }]
      }
      if (model.includes('gpt-oss')) body.reasoning_effort = REASONING
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
        body: JSON.stringify(body)
      })
      const raw = await res.text()
      let data = null
      try { data = JSON.parse(raw) } catch (e) { /* ماشي JSON */ }
      if (res.ok && data) {
        const out = data?.choices?.[0]?.message?.content?.trim()
        if (out) return out
      }
      console.log('GROQ ERROR', model, res.status, raw.slice(0, 250))
      if (res.status === 429) {
        if (/per day|TPD/i.test(raw)) {
          const mt = /try again in (?:(\d+)h)?(?:(\d+)m)?/i.exec(raw)
          const mins = mt ? Number(mt[1] || 0) * 60 + Number(mt[2] || 0) : 30
          blocked.set(model, Date.now() + Math.max(mins, 1) * 60 * 1000)
          console.log('DAILY LIMIT', model, 'skipping', Math.max(mins, 1), 'min')
          return null
        }
        await sleep(4000)
        continue
      }
      if (data && ![500, 502, 503].includes(res.status)) break
    } catch (e) {
      console.log('GROQ FETCH ERROR', model, e.message)
    }
    await sleep(2000 * attempt)
  }
  return null
}

// ---------- Gemini ----------
async function callGemini(system, past, text, images) {
  if (!GEMINI_KEY || (blocked.get('gemini') || 0) > Date.now()) return null
  const contents = [
    ...past.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    {
      role: 'user',
      parts: [
        ...images.slice(0, 4).map(b => ({
          inline_data: { mime_type: 'image/jpeg', data: b.toString('base64') }
        })),
        { text }
      ]
    }
  ]
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.6, maxOutputTokens: MAX_TOKENS }
        })
      })
      const raw = await res.text()
      let data = null
      try { data = JSON.parse(raw) } catch (e) { /* ماشي JSON */ }
      if (res.ok && data) {
        const out = (data?.candidates?.[0]?.content?.parts || [])
          .map(p => p.text || '').join('').trim()
        if (out) return out
      }
      console.log('GEMINI ERROR', GEMINI_MODEL, res.status, raw.slice(0, 250))
      if (res.status === 429) {
        blocked.set('gemini', Date.now() + 10 * 60 * 1000)
        return null
      }
      if (![500, 502, 503].includes(res.status)) break
    } catch (e) {
      console.log('GEMINI FETCH ERROR', e.message)
    }
    await sleep(2500 * attempt)
  }
  return null
}

// ---------- الجواب ----------
// rawQuery: نص السؤال الأصلي (إلا بغيتي بحث أوتوماتيك). null = بلا بحث
async function askAI(jid, userText, images = [], rawQuery = null, histText = null) {
  if (!GROQ_KEY && !GEMINI_KEY) {
    console.log('ERROR: no GROQ_API_KEY or GEMINI_API_KEY')
    return null
  }
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Casablanca' })
  const system = `${PROMPT}\n\nالتاريخ والوقت الحالي (المغرب): ${now}`

  const past = [...(chats[jid] || [])]
  while (past.length && past[0].role !== 'user') past.shift()

  // بحث فالأنترنت (مقتطفات قصيرة)
  let text = userText
  if (SEARCH_ON && TAVILY_KEY && rawQuery && !images.length && SEARCH_HINT.test(rawQuery)) {
    const results = await tavily(rawQuery, NEWS_HINT.test(rawQuery))
    if (results.length) {
      text =
        `${userText}\n\n[نتائج بحث من الأنترنت بتاريخ ${now}]\n${formatResults(results)}\n` +
        `[نهاية النتائج. جاوب بالاعتماد عليها، وذكر المصدر باختصار. إلا ما كافياش، قول هادشي.]`
    }
  }

  let out = null
  if (images.length) {
    out = await callGemini(system, past, text || 'شنو كاين فهاد الصورة؟ حللها بالتفصيل.', images)
    if (!out) {
      const content = [
        { type: 'text', text: text || 'شنو كاين فهاد الصورة؟ حللها بالتفصيل.' },
        ...images.slice(0, 3).map(b => ({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` }
        }))
      ]
      out = await callGroq(GROQ_VISION_MODEL, system, past, content)
    }
  } else {
    for (const model of GROQ_MODELS) {
      out = await callGroq(model, system, past, text)
      if (out) break
    }
    if (!out) out = await callGemini(system, past, text, [])
  }

  if (out) {
    const h = histText || userText
    pushHistory(jid, 'user', images.length ? `${h} [صورة]` : h)
    pushHistory(jid, 'assistant', out)
  }
  return out
}

// ---------- النشرة ----------
async function buildDigest(jid, topics) {
  if (!TAVILY_KEY) return null
  const list = topics.split(/[،,\n]| و /).map(s => s.trim()).filter(Boolean).slice(0, 5)
  const blocks = []
  for (const t of list) {
    const r = await tavily(`${t} آخر الأخبار`, true, 4, 2)
    if (r.length) blocks.push(`### ${t}\n${formatResults(r)}`)
  }
  if (!blocks.length) return null
  const prompt =
    `اعمل ليا نشرة أخبار اليوم، بالاعتماد على النتائج لتحت فقط.\n` +
    `القواعد: من 6 لـ 8 نقط مرتبة بالأهمية. كل نقطة: عنوان بالخط الغليظ، وسطرين بالكثير، ومن بعد اسم المصدر. ` +
    `ما تخترعش شي حاجة. إلا ما كاينش جديد فموضوع، قولها. بالدارجة المغربية. ` +
    `فالآخر جملة وحدة: شنو أهم حاجة اليوم.\n\n${blocks.join('\n\n')}`
  return askAI(jid, prompt, [], null, '[نشرة الأخبار اليومية]')
}

// ---------- فهم الرسائل الصوتية (Groq Whisper) ----------
async function transcribe(buf) {
  if (!GROQ_KEY) return null
  try {
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg')
    form.append('model', STT_MODEL)
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form
    })
    const data = await res.json()
    if (!res.ok) {
      console.log('STT ERROR', res.status, JSON.stringify(data).slice(0, 300))
      return null
    }
    return data?.text?.trim() || null
  } catch (e) {
    console.log('STT FETCH ERROR', e.message)
    return null
  }
}

// ---------- البوت ----------
let currentSock = null
let connected = false

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })
  currentSock = sock
  let asked = false

  const myIds = () => [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !asked && !sock.authState.creds.registered && process.env.PHONE) {
      asked = true
      try {
        const code = await sock.requestPairingCode(process.env.PHONE)
        console.log('PAIRING CODE:', code)
      } catch (e) {
        console.log('pairing error:', e.message)
        asked = false
      }
    }
    if (connection === 'open') {
      connected = true
      console.log('Bot connected')
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('connection closed, code:', code)
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000)
      else console.log('logged out, change AUTH_DIR and relink')
    }
  })

  const getMedia = (msgObj, key) =>
    downloadMediaMessage(
      { key, message: msgObj }, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )

  async function sendLong(jid, m, text) {
    const parts = chunks(text)
    for (const [i, part] of parts.entries()) {
      await sock.sendMessage(jid, { text: part }, i === 0 && m ? { quoted: m } : {})
      if (i < parts.length - 1) await sleep(700)
    }
  }

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue
        const jid = m.key.remoteJid
        if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue
        const isGroup = jid.endsWith('@g.us')

        const msg = normalizeMessageContent(m.message)
        if (!msg) continue
        const ext = msg.extendedTextMessage
        const img = msg.imageMessage
        const aud = msg.audioMessage
        const text = msg.conversation || ext?.text || img?.caption || ''
        const ctx = ext?.contextInfo || img?.contextInfo || aud?.contextInfo
        const name = m.pushName || 'مستخدم'
        const senderId = isGroup ? m.key.participant : jid

        // فالخاص: لائحة مسموحين (اختياري)
        if (!isGroup && ALLOWED_USERS.length) {
          const ids = [jid, m.key.remoteJidAlt].filter(Boolean)
            .map(x => userPart(x).replace(/\D/g, ''))
          if (!ids.some(i => ALLOWED_USERS.includes(i))) {
            console.log('BLOCKED private chat:', ids.join(','))
            continue
          }
        }

        // فالجروب: غير فاش يتاغ البوت ولا يتجاوب على رسالة ديالو
        const me = myIds()
        if (isGroup) {
          const mentioned = (ctx?.mentionedJid || []).some(j => me.includes(userPart(j)))
          const repliedToBot = ctx?.participant && me.includes(userPart(ctx.participant))
          if (!mentioned && !repliedToBot) continue
        }

        const clean = text.replace(/@\d+/g, '').trim()
        const [cmd, ...rest] = clean.split(/\s+/)
        const arg = rest.join(' ').trim()

        if (clean === '/reset') {
          delete chats[jid]
          save()
          await sock.sendMessage(jid, { text: '🧹 تمسح السجل. نبداو من الأول.' }, { quoted: m })
          continue
        }

        // أوامر النشرة
        if (SUB_CMDS.includes(cmd)) {
          if (!TAVILY_KEY) {
            await sock.sendMessage(jid, { text: 'النشرة ما مفعلاش بعد (خاص مفتاح البحث).' }, { quoted: m })
            continue
          }
          const topics = arg || DEFAULT_TOPICS
          subs[jid] = { topics, last: casa().date }
          saveSubs()
          await sock.sendMessage(jid, {
            text:
              `✅ تسجلتي فالنشرة اليومية.\n` +
              `غادي توصلك كل صباح على الساعة ${DIGEST_HOUR}:00 (توقيت المغرب)، ابتداء من غدا.\n\n` +
              `*المواضيع:* ${topics}\n\n` +
              `- بدل المواضيع: /نشرة رياضة وتقنية\n` +
              `- أخبار دابا: /اخبار\n` +
              `- إيقاف: /ايقاف`
          }, { quoted: m })
          continue
        }
        if (UNSUB_CMDS.includes(cmd)) {
          delete subs[jid]
          saveSubs()
          await sock.sendMessage(jid, { text: '🛑 تحيدات النشرة اليومية.' }, { quoted: m })
          continue
        }

        if (limited(senderId || jid)) {
          await sock.sendMessage(jid, { text: 'بشوية شوية 😅 بزاف د الرسائل، عاود من بعد شوية.' }, { quoted: m })
          continue
        }
        if (overDaily(senderId || jid)) {
          await sock.sendMessage(jid, { text: `وصلتي الحد اليومي (${DAILY_LIMIT} رسالة). عاود غدا 🙏` }, { quoted: m })
          continue
        }

        // أخبار دابا
        if (NEWS_CMDS.includes(cmd)) {
          if (!TAVILY_KEY) {
            await sock.sendMessage(jid, { text: 'الأخبار ما مفعلاش بعد (خاص مفتاح البحث).' }, { quoted: m })
            continue
          }
          await sock.sendPresenceUpdate('composing', jid)
          const digest = await buildDigest(jid, arg || subs[jid]?.topics || DEFAULT_TOPICS)
          await sock.sendPresenceUpdate('paused', jid)
          await sendLong(jid, m, digest || 'ما لقيتش أخبار دابا، عاود من بعد شوية.')
          continue
        }

        let userText = clean
        let transcript = null
        const images = []
        const q = ctx?.quotedMessage
        const qKey = ctx?.stanzaId
          ? { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }
          : null

        try {
          if (img) images.push(await getMedia(msg, m.key))
          else if (q?.imageMessage && qKey) images.push(await getMedia(q, qKey))
          if (aud) {
            transcript = await transcribe(await getMedia(msg, m.key))
            if (!transcript) {
              await sock.sendMessage(jid, { text: 'ما قدرتش نسمع الصوتية. كتب لي الرسالة ولا عاود صيفطها.' }, { quoted: m })
              continue
            }
            userText = transcript
          }
        } catch (e) {
          console.log('media failed:', e.message)
        }

        if (!userText && !images.length) continue

        const rawQuery = userText
        const quotedText = q?.conversation || q?.extendedTextMessage?.text
        if (quotedText) userText = `[رسالة مقتبسة: ${quotedText}]\n${userText}`
        if (isGroup) userText = `${name}: ${userText}`

        await sock.sendPresenceUpdate('composing', jid)
        const reply = await askAI(jid, userText, images, rawQuery)
        await sock.sendPresenceUpdate('paused', jid)

        let out = reply || FAIL
        if (transcript) out = `🎙️ سمعت: «${transcript}»\n\n${out}`
        await sendLong(jid, m, out)
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

// ---------- جدولة النشرة اليومية ----------
let digestBusy = false
setInterval(async () => {
  if (digestBusy || !connected || !currentSock || !TAVILY_KEY) return
  const { date, hour } = casa()
  if (hour < DIGEST_HOUR) return
  const now = Date.now()
  const due = Object.entries(subs).filter(
    ([, s]) => s.last !== date && (!s.retryAt || s.retryAt < now)
  )
  if (!due.length) return

  digestBusy = true
  try {
    for (const [jid, s] of due) {
      try {
        const text = await buildDigest(jid, s.topics || DEFAULT_TOPICS)
        if (!text) {
          s.retryAt = Date.now() + 10 * 60 * 1000
          saveSubs()
          continue
        }
        const parts = chunks(`🗞️ *نشرة اليوم*\n\n${text}`)
        for (const part of parts) {
          await currentSock.sendMessage(jid, { text: part })
          await sleep(700)
        }
        s.last = date
        delete s.retryAt
        saveSubs()
      } catch (e) {
        console.log('digest error:', jid, e.message)
        s.retryAt = Date.now() + 10 * 60 * 1000
        saveSubs()
      }
      await sleep(3000)
    }
  } finally {
    digestBusy = false
  }
}, 60 * 1000)

start()
