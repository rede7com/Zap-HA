import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import pino from 'pino'
import QRCode from 'qrcode'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  BufferJSON,
  normalizeMessageContent,
  generateMessageIDV2
} from '@whiskeysockets/baileys'

const AQUI = path.dirname(new URL(import.meta.url).pathname)
const DADOS = process.env.ZAP_DADOS || '/data'
const CONFIG_HA = process.env.ZAP_CONFIG_HA || '/homeassistant'
const INTEGRACAO = process.env.ZAP_INTEGRACAO || '/integracao'
const PORTA_API = Number(process.env.ZAP_PORTA_API || 8066)
const PORTA_PAINEL = Number(process.env.ZAP_PORTA_PAINEL || 8099)
const PAINEL_ABERTO = process.env.ZAP_PAINEL_ABERTO === '1'
const SUPERVISOR = process.env.SUPERVISOR_TOKEN || ''
const AUTH = path.join(DADOS, 'auth')
const MIDIA = path.join(DADOS, 'media')
const ESPERA_CONFIRMACAO = 30000
const MAX_TENTATIVAS = 3

const log = pino({ level: process.env.ZAP_LOG || 'warn' })
const registro = (...a) => console.log(new Date().toISOString(), ...a)

function lerJson(arquivo, padrao, reviver) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'), reviver)
  } catch {
    return padrao
  }
}

function gravarJson(arquivo, valor, replacer) {
  const tmp = arquivo + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(valor, replacer), { mode: 0o600 })
  fs.renameSync(tmp, arquivo)
}

fs.mkdirSync(AUTH, { recursive: true })
fs.mkdirSync(MIDIA, { recursive: true })

const opcoes = lerJson(path.join(DADOS, 'options.json'), {})
const VALIDADE_FILA = Math.max(1, Number(opcoes.validade_fila_horas) || 6) * 3600000
const DIAS_MIDIA = Math.max(1, Number(opcoes.dias_midia) || 7)
const VERSAO = lerJson(path.join(AQUI, 'package.json'), {}).version || ''

const guardado = lerJson(path.join(DADOS, 'estado.json'), {})
const estado = {
  conexao: 'iniciando',
  numero: guardado.numero || '',
  nome: guardado.nome || '',
  qr: '',
  codigo: '',
  ultimoErro: '',
  integracaoAtualizada: false,
  integracaoCarregada: '',
  integracaoVersao: ''
}
const INICIO = Date.now()

let token = ''
try {
  token = fs.readFileSync(path.join(DADOS, 'token'), 'utf8').trim()
} catch {}
if (!token) {
  token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(path.join(DADOS, 'token'), token, { mode: 0o600 })
}

function instalarIntegracao() {
  if (!fs.existsSync(CONFIG_HA) || !fs.existsSync(INTEGRACAO)) return
  gravarJson(path.join(CONFIG_HA, '.zap_ha.json'), { url: 'http://127.0.0.1:' + PORTA_API, token })
  const destino = path.join(CONFIG_HA, 'custom_components', 'whatsapp')
  const novo = fs.readFileSync(path.join(INTEGRACAO, 'manifest.json'), 'utf8')
  estado.integracaoVersao = JSON.parse(novo).version
  let atual = ''
  try {
    atual = fs.readFileSync(path.join(destino, 'manifest.json'), 'utf8')
  } catch {}
  if (atual !== novo) {
    fs.rmSync(destino, { recursive: true, force: true })
    fs.cpSync(INTEGRACAO, destino, { recursive: true })
    registro('integração copiada para', destino)
  }
  const yaml = path.join(CONFIG_HA, 'configuration.yaml')
  let texto = ''
  try {
    texto = fs.readFileSync(yaml, 'utf8')
  } catch {
    return
  }
  if (!/^whatsapp:/m.test(texto)) {
    fs.writeFileSync(yaml, texto + (texto.endsWith('\n') ? '' : '\n') + '\nwhatsapp:\n')
    registro('linha whatsapp: acrescentada ao configuration.yaml')
  }
}

const pausa = ms => new Promise(r => setTimeout(r, ms))

async function dispararEvento(tipo, dados) {
  if (!SUPERVISOR) return false
  const corpo = JSON.stringify(dados, BufferJSON.replacer)
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch('http://supervisor/core/api/events/' + tipo, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SUPERVISOR, 'Content-Type': 'application/json' },
        body: corpo,
        signal: AbortSignal.timeout(10000)
      })
      if (r.ok) return true
      if (r.status === 400 || r.status === 413) {
        registro('evento recusado pelo HA', tipo, r.status)
        return false
      }
    } catch {}
    await pausa(5000)
  }
  registro('evento não entregue ao HA', tipo)
  return false
}

const historico = []

function anotar(entrada) {
  const antiga = historico.find(h => h.id === entrada.id && h.dir === entrada.dir)
  if (antiga) Object.assign(antiga, entrada)
  else {
    historico.unshift({ hora: Date.now(), ...entrada })
    if (historico.length > 60) historico.length = 60
  }
}

const ARQ_FILA = path.join(DADOS, 'fila.json')
const ARQ_ENVIADAS = path.join(DADOS, 'enviadas.json')
const ARQ_DESTINOS = path.join(DADOS, 'destinos.json')
const fila = lerJson(ARQ_FILA, [])
for (const i of fila) i.estado = 'fila'
const enviadas = new Map(lerJson(ARQ_ENVIADAS, [], BufferJSON.reviver))
const destinos = lerJson(ARQ_DESTINOS, {})
const idsEnviados = new Set(enviadas.keys())
const esperas = new Map()
const resultados = new Map()

const salvarFila = () => gravarJson(ARQ_FILA, fila)

function guardarEnviada(id, mensagem) {
  enviadas.set(id, mensagem)
  while (enviadas.size > 300) enviadas.delete(enviadas.keys().next().value)
  gravarJson(ARQ_ENVIADAS, [...enviadas], BufferJSON.replacer)
}

function marcarId(id) {
  idsEnviados.add(id)
  if (idsEnviados.size > 1000) idsEnviados.delete(idsEnviados.values().next().value)
}

function aguardar(id, ms) {
  return new Promise(resolve => {
    const lista = esperas.get(id) || []
    const fim = () => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(fim, ms)
    lista.push(fim)
    esperas.set(id, lista)
  })
}

function concluir(item, situacao, erro) {
  item.estado = situacao
  const pos = fila.indexOf(item)
  if (pos >= 0) fila.splice(pos, 1)
  salvarFila()
  resultados.set(item.id, { estado: situacao, erro: erro || '' })
  if (resultados.size > 300) resultados.delete(resultados.keys().next().value)
  anotar({ id: item.id, dir: 'saiu', estado: situacao, erro: erro || '' })
  for (const f of esperas.get(item.id) || []) f()
  esperas.delete(item.id)
  const dados = {
    id: item.id,
    target: item.destino,
    to: item.jid || '',
    message: item.texto || '',
    type: item.tipo,
    session_id: 'default'
  }
  if (situacao === 'falhou') {
    registro('envio falhou', item.id, erro)
    dispararEvento('whatsapp_message_failed', { ...dados, error: erro || '' })
  } else {
    dispararEvento('whatsapp_message_sent', dados)
  }
}

class Definitivo extends Error {}

let sock = null
let tentativa = 0
let religar = null
let enviando = false

const soNumero = jid => String(jid || '').split('@')[0].split(':')[0]

async function resolverDestino(destino) {
  const d = String(destino).trim()
  if (d.includes('@')) return d
  const n = d.replace(/\D/g, '')
  if (!n) throw new Definitivo('destino inválido')
  if (n.startsWith('120363') && n.length >= 18) return n + '@g.us'
  if (destinos[n]) return destinos[n]
  const candidatos = [n]
  if (/^55\d{10}$/.test(n)) candidatos.push(n.slice(0, 4) + '9' + n.slice(4))
  if (/^55\d{2}9\d{8}$/.test(n)) candidatos.push(n.slice(0, 4) + n.slice(5))
  let lista
  try {
    lista = await sock.onWhatsApp(...candidatos)
  } catch {
    return n + '@s.whatsapp.net'
  }
  const achado = (lista || []).find(r => r && r.exists && r.jid)
  if (!achado) throw new Definitivo('número sem WhatsApp')
  destinos[n] = achado.jid
  gravarJson(ARQ_DESTINOS, destinos)
  return achado.jid
}

async function baixar(url) {
  const u = String(url || '')
  if (u.startsWith('/')) {
    const local = u.startsWith('/config/')
      ? path.join(CONFIG_HA, u.slice(8))
      : u.startsWith('/media/')
        ? path.join(MIDIA, path.basename(u))
        : u
    return { dados: fs.readFileSync(local), tipo: '' }
  }
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error('não baixou o arquivo (' + r.status + ')')
  return { dados: Buffer.from(await r.arrayBuffer()), tipo: (r.headers.get('content-type') || '').split(';')[0] }
}

async function montar(item) {
  if (item.tipo === 'texto') return { text: item.texto, linkPreview: null }
  const { dados, tipo } = await baixar(item.url)
  if (item.tipo === 'audio') {
    return {
      audio: dados,
      mimetype: item.ptt ? 'audio/ogg; codecs=opus' : item.mimetype || tipo || 'audio/mpeg',
      ptt: !!item.ptt
    }
  }
  if (item.tipo === 'imagem') return { image: dados, caption: item.texto || undefined }
  return {
    document: dados,
    fileName: item.nome || path.basename(String(item.url).split('?')[0]) || 'arquivo',
    mimetype: item.mimetype || tipo || 'application/octet-stream',
    caption: item.texto || undefined
  }
}

async function enviarItem(item) {
  if (Date.now() - item.criado > VALIDADE_FILA) return concluir(item, 'falhou', 'expirou na fila')
  try {
    if (!item.jid) item.jid = await resolverDestino(item.destino)
    item.tentativas = (item.tentativas || 0) + 1
    item.enviadoEm = Date.now()
    item.estado = 'aguardando'
    marcarId(item.id)
    salvarFila()
    anotar({ id: item.id, dir: 'saiu', estado: 'aguardando' })
    const pronta = enviadas.get(item.id)
    if (pronta) await sock.relayMessage(item.jid, pronta, { messageId: item.id })
    else {
      const r = await sock.sendMessage(item.jid, await montar(item), { messageId: item.id })
      if (r?.message) guardarEnviada(item.id, r.message)
    }
  } catch (e) {
    const motivo = e?.message || String(e)
    if (e instanceof Definitivo || item.tentativas >= MAX_TENTATIVAS) return concluir(item, 'falhou', motivo)
    registro('envio adiado', item.id, motivo)
    item.estado = 'fila'
    salvarFila()
    await pausa(3000)
  }
}

async function processarFila() {
  if (enviando) return
  enviando = true
  try {
    for (;;) {
      if (estado.conexao !== 'conectado' || !sock) break
      const item = fila.find(i => i.estado === 'fila')
      if (!item) break
      await enviarItem(item)
    }
  } finally {
    enviando = false
  }
}

function confirmar(id, erro) {
  const item = fila.find(i => i.id === id)
  if (!item) return
  if (erro) concluir(item, 'falhou', 'recusada pelo servidor (' + erro + ')')
  else concluir(item, 'enviado')
}

setInterval(() => {
  const limite = Date.now() - ESPERA_CONFIRMACAO
  let mudou = false
  for (const item of [...fila]) {
    if (item.estado === 'fila' && Date.now() - item.criado > VALIDADE_FILA) concluir(item, 'falhou', 'expirou na fila')
    else if (item.estado === 'aguardando' && item.enviadoEm < limite) {
      if (item.tentativas >= MAX_TENTATIVAS) concluir(item, 'falhou', 'sem confirmação do servidor')
      else {
        item.estado = 'fila'
        mudou = true
      }
    }
  }
  if (mudou) processarFila()
}, 5000)

function enfileirar(d) {
  const tipo = { texto: 'texto', audio: 'audio', imagem: 'imagem', documento: 'documento' }[d.tipo]
  if (!tipo) throw new Definitivo('tipo inválido')
  const destino = String(d.destino ?? '').trim()
  if (!destino) throw new Definitivo('destino vazio')
  if (tipo === 'texto' && !String(d.texto ?? '').trim()) throw new Definitivo('mensagem vazia')
  if (tipo !== 'texto' && !d.url) throw new Definitivo('url vazia')
  const item = {
    id: generateMessageIDV2(sock?.user?.id),
    tipo,
    destino,
    texto: d.texto == null ? '' : String(d.texto),
    url: d.url || '',
    nome: d.nome || '',
    mimetype: d.mimetype || '',
    ptt: !!d.ptt,
    criado: Date.now(),
    tentativas: 0,
    estado: 'fila'
  }
  fila.push(item)
  salvarFila()
  anotar({ id: item.id, dir: 'saiu', com: destino, texto: tipo === 'texto' ? item.texto : '[' + tipo + '] ' + item.texto, estado: 'fila' })
  processarFila()
  return item
}

async function enviarEEsperar(d) {
  const item = enfileirar(d)
  await aguardar(item.id, 15000)
  const fim = resultados.get(item.id)
  if (fim) return { ok: fim.estado !== 'falhou', id: item.id, estado: fim.estado, erro: fim.erro }
  return { ok: true, id: item.id, estado: 'na fila', erro: '' }
}

const TIPOS_MIDIA = {
  imageMessage: 'image',
  audioMessage: 'audio',
  videoMessage: 'video',
  documentMessage: 'document',
  stickerMessage: 'sticker'
}

function extensao(mimetype, nome) {
  const doNome = path.extname(String(nome || '')).replace(/[^.\w]/g, '')
  if (doNome) return doNome
  const sub = String(mimetype || '').split('/')[1]?.split(';')[0].replace(/[^\w]/g, '') || 'bin'
  return '.' + ({ jpeg: 'jpg', mpeg: 'mp3', plain: 'txt' }[sub] || sub)
}

async function numeroReal(s, jid, alt) {
  if (!jid.endsWith('@lid')) return jid
  if (alt) return alt
  try {
    const pn = await s.signalRepository.lidMapping.getPNForLID(jid)
    if (pn) return soNumero(pn) + '@s.whatsapp.net'
  } catch {}
  return jid
}

async function tratarRecebida(s, m) {
  const k = m.key || {}
  const chat = k.remoteJid || ''
  if (!chat || chat.endsWith('@broadcast') || chat.endsWith('@newsletter')) return
  if (k.fromMe && idsEnviados.has(k.id)) return
  const c = normalizeMessageContent(m.message)
  if (!c) return
  const tipoMidia = Object.keys(TIPOS_MIDIA).find(t => c[t])
  const midia = tipoMidia ? c[tipoMidia] : null
  const legenda = midia?.caption || ''
  const texto =
    c.conversation ||
    c.extendedTextMessage?.text ||
    legenda ||
    c.buttonsResponseMessage?.selectedDisplayText ||
    c.listResponseMessage?.title ||
    c.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  if (!texto && !midia) return
  let mediaUrl = null
  let mediaPath = null
  if (midia) {
    try {
      const dados = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: s.updateMediaMessage })
      const nome = String(k.id).replace(/[^\w-]/g, '') + extensao(midia.mimetype, midia.fileName)
      mediaPath = path.join(MIDIA, nome)
      fs.writeFileSync(mediaPath, dados)
      mediaUrl = '/media/' + nome
    } catch (e) {
      registro('mídia não baixada', k.id, e?.message || e)
    }
  }
  const grupo = chat.endsWith('@g.us')
  const conversa = grupo ? chat : await numeroReal(s, chat, k.remoteJidAlt)
  const bruto = grupo ? k.participant || '' : chat
  const pessoa = grupo ? await numeroReal(s, bruto, k.participantAlt) : conversa
  const ctx = c.extendedTextMessage?.contextInfo || midia?.contextInfo || {}
  const dados = {
    id: k.id,
    content: texto,
    vote: null,
    sender: pessoa,
    person_jid: pessoa,
    sender_name: m.pushName || '',
    from: conversa,
    sender_number: soNumero(pessoa),
    person_number: soNumero(pessoa),
    raw_sender: bruto,
    is_group: grupo,
    is_forwarded: !!ctx.isForwarded,
    media_url: mediaUrl,
    media_path: mediaPath,
    media_type: tipoMidia ? TIPOS_MIDIA[tipoMidia] : null,
    media_mimetype: midia?.mimetype || null,
    caption: legenda || null,
    raw: m,
    session_id: 'default',
    is_admin: false,
    is_group_admin: false
  }
  if (k.fromMe) {
    Object.assign(dados, {
      from: 'me',
      sender: 'me',
      sender_number: estado.numero,
      person_number: estado.numero,
      recipient: conversa,
      recipient_number: soNumero(conversa)
    })
  }
  anotar({
    id: k.id,
    dir: 'chegou',
    com: k.fromMe ? 'eu → ' + soNumero(conversa) : (m.pushName || soNumero(pessoa)) + (grupo ? ' (grupo)' : ''),
    texto: texto || '[' + TIPOS_MIDIA[tipoMidia] + ']',
    estado: 'recebida'
  })
  const entregue = await dispararEvento('whatsapp_message_received', dados)
  anotar({ id: k.id, dir: 'chegou', estado: entregue ? 'recebida' : SUPERVISOR ? 'não chegou ao HA' : 'recebida' })
}

function apagarSessao() {
  fs.rmSync(AUTH, { recursive: true, force: true })
  fs.mkdirSync(AUTH, { recursive: true })
}

function agendar(ms) {
  clearTimeout(religar)
  religar = setTimeout(() => conectar().catch(e => {
    registro('falha ao conectar', e?.message || e)
    agendar(10000)
  }), ms)
}

async function conectar() {
  if (sock) {
    try {
      sock.ev.removeAllListeners()
      sock.end(undefined)
    } catch {}
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH)
  let version
  try {
    version = (await fetchLatestBaileysVersion()).version
  } catch {}
  estado.conexao = state.creds.registered || state.creds.me ? 'conectando' : 'aguardando_pareamento'
  const s = makeWASocket({
    auth: state,
    logger: log,
    version,
    markOnlineOnConnect: false,
    getMessage: async chave => enviadas.get(chave.id)
  })
  sock = s
  s.ev.on('creds.update', saveCreds)
  s.ws.on('CB:ack,class:message', no => {
    if (s === sock && no?.attrs?.id) confirmar(no.attrs.id, no.attrs.error)
  })
  s.ev.on('connection.update', async u => {
    if (s !== sock) return
    if (u.qr) {
      estado.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 })
      estado.conexao = 'aguardando_pareamento'
    }
    if (u.connection === 'open') {
      tentativa = 0
      estado.conexao = 'conectado'
      estado.qr = ''
      estado.codigo = ''
      estado.ultimoErro = ''
      estado.numero = soNumero(s.user?.id)
      estado.nome = s.user?.name || estado.nome
      gravarJson(path.join(DADOS, 'estado.json'), { numero: estado.numero, nome: estado.nome })
      registro('conectado')
      for (const i of fila) if (i.estado === 'aguardando') i.estado = 'fila'
      processarFila()
    }
    if (u.connection === 'close') {
      const codigo = u.lastDisconnect?.error?.output?.statusCode
      estado.qr = ''
      estado.codigo = ''
      estado.ultimoErro = (u.lastDisconnect?.error?.message || 'conexão fechada') + (codigo ? ' (' + codigo + ')' : '')
      registro('conexão fechada:', estado.ultimoErro)
      if (codigo === DisconnectReason.loggedOut) {
        apagarSessao()
        estado.conexao = 'aguardando_pareamento'
        agendar(2000)
        return
      }
      estado.conexao = state.creds.registered || state.creds.me ? 'reconectando' : 'aguardando_pareamento'
      if (codigo === DisconnectReason.restartRequired) return agendar(500)
      tentativa++
      agendar(codigo === DisconnectReason.connectionReplaced ? 30000 : tentativa <= 3 ? 3000 : Math.min(30000, 3000 * 2 ** (tentativa - 3)))
    }
  })
  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (s !== sock || type !== 'notify') return
    for (const m of messages) tratarRecebida(s, m).catch(e => registro('erro ao tratar recebida', e?.message || e))
  })
  s.ev.on('messages.update', atualizacoes => {
    if (s !== sock) return
    for (const { key, update } of atualizacoes) {
      if (!key?.fromMe || update?.status == null || !idsEnviados.has(key.id)) continue
      if (update.status === 0) confirmar(key.id, 'erro')
      else if (update.status >= 2) {
        confirmar(key.id)
        if (update.status >= 3) anotar({ id: key.id, dir: 'saiu', estado: update.status >= 4 ? 'lido' : 'entregue' })
      }
    }
  })
}

async function parear(numero) {
  const n = String(numero || '').replace(/\D/g, '')
  if (n.length < 10) throw new Definitivo('número inválido: use DDI + DDD + número')
  if (!sock || estado.conexao === 'conectado' || sock.authState.creds.registered) throw new Definitivo('já está pareado')
  const codigo = await sock.requestPairingCode(n)
  estado.codigo = (codigo.match(/.{1,4}/g) || [codigo]).join('-')
  return estado.codigo
}

async function sair() {
  try {
    await sock?.logout()
  } catch {}
  apagarSessao()
  estado.conexao = 'aguardando_pareamento'
  estado.qr = ''
  estado.codigo = ''
  agendar(1000)
}

function responder(res, codigo, corpo, tipo) {
  const dados = Buffer.isBuffer(corpo) || typeof corpo === 'string' ? corpo : JSON.stringify(corpo)
  res.writeHead(codigo, {
    'Content-Type': tipo || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(dados)
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = []
    let tamanho = 0
    req.on('data', p => {
      tamanho += p.length
      if (tamanho > 1048576) {
        reject(new Definitivo('corpo grande demais'))
        req.destroy()
      } else partes.push(p)
    })
    req.on('end', () => {
      try {
        resolve(partes.length ? JSON.parse(Buffer.concat(partes).toString('utf8')) : {})
      } catch {
        reject(new Definitivo('JSON inválido'))
      }
    })
    req.on('error', reject)
  })
}

function tokenConfere(req) {
  const dado = Buffer.from(String(req.headers['x-zap-token'] || ''))
  const certo = Buffer.from(token)
  return dado.length === certo.length && crypto.timingSafeEqual(dado, certo)
}

const situacao = () => ({
  conectado: estado.conexao === 'conectado',
  estado: estado.conexao,
  numero: estado.numero,
  nome: estado.nome,
  fila: fila.length,
  versao: VERSAO
})

const MIMES = {
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

function servir(tratador) {
  return (req, res) => {
    tratador(req, res).catch(e => {
      if (res.headersSent) return res.end()
      responder(res, e instanceof Definitivo ? 400 : 500, { ok: false, erro: e?.message || String(e) })
    })
  }
}

http
  .createServer(
    servir(async (req, res) => {
      const rota = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (req.method === 'GET' && rota === '/saude') return responder(res, 200, { ok: true })
      if (req.method === 'GET' && rota.startsWith('/media/')) {
        const nome = rota.slice(7)
        if (!/^[\w][\w.-]*$/.test(nome)) return responder(res, 404, { ok: false })
        let dados
        try {
          dados = fs.readFileSync(path.join(MIDIA, nome))
        } catch {
          return responder(res, 404, { ok: false })
        }
        return responder(res, 200, dados, MIMES[path.extname(nome).toLowerCase()] || 'application/octet-stream')
      }
      if (!tokenConfere(req)) return responder(res, 401, { ok: false, erro: 'token inválido' })
      if (req.method === 'GET' && rota === '/status') {
        estado.integracaoCarregada = String(req.headers['x-zap-integracao'] || '')
        return responder(res, 200, situacao())
      }
      if (req.method === 'POST' && rota === '/enviar') {
        const r = await enviarEEsperar(await lerCorpo(req))
        return responder(res, r.ok ? 200 : 502, r)
      }
      responder(res, 404, { ok: false })
    })
  )
  .listen(PORTA_API, '0.0.0.0')

http
  .createServer(
    servir(async (req, res) => {
      if (!PAINEL_ABERTO && !String(req.socket.remoteAddress).endsWith('172.30.32.2')) return responder(res, 403, { ok: false })
      const rota = new URL(req.url, 'http://x').pathname.replace(/\/+/g, '/')
      if (req.method === 'GET' && (rota === '/' || rota === '/index.html')) {
        return responder(res, 200, fs.readFileSync(path.join(AQUI, 'painel.html')), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && rota === '/api/estado') {
        return responder(res, 200, {
          ...situacao(),
          qr: estado.qr,
          codigo: estado.codigo,
          ultimoErro: estado.ultimoErro,
          integracaoAtualizada: !!estado.integracaoVersao && estado.integracaoCarregada !== estado.integracaoVersao && (!!estado.integracaoCarregada || Date.now() - INICIO > 90000),
          historico
        })
      }
      if (req.method === 'POST' && rota === '/api/parear') {
        return responder(res, 200, { ok: true, codigo: await parear((await lerCorpo(req)).numero) })
      }
      if (req.method === 'POST' && rota === '/api/sair') {
        await sair()
        return responder(res, 200, { ok: true })
      }
      if (req.method === 'POST' && rota === '/api/teste') {
        const d = await lerCorpo(req)
        return responder(res, 200, await enviarEEsperar({ tipo: 'texto', destino: d.destino, texto: d.texto }))
      }
      responder(res, 404, { ok: false })
    })
  )
  .listen(PORTA_PAINEL, '0.0.0.0')

function limparMidia() {
  const limite = Date.now() - DIAS_MIDIA * 86400000
  for (const nome of fs.readdirSync(MIDIA)) {
    const arquivo = path.join(MIDIA, nome)
    try {
      if (fs.statSync(arquivo).mtimeMs < limite) fs.unlinkSync(arquivo)
    } catch {}
  }
}

setInterval(limparMidia, 3600000)
limparMidia()

process.on('uncaughtException', e => registro('erro não tratado', e?.stack || e))
process.on('unhandledRejection', e => registro('promessa rejeitada', e?.stack || e))
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    try {
      salvarFila()
      sock?.end(undefined)
    } catch {}
    process.exit(0)
  })
}

try {
  instalarIntegracao()
} catch (e) {
  registro('integração não instalada', e?.message || e)
}
registro('Zap-HA', VERSAO, 'iniciando')
agendar(0)
