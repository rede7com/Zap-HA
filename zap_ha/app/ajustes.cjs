const fs = require('fs');
const path = require('path');

const patches = [
  {
    nome: 'patch-baileys-presence',
    alvo: path.join(__dirname, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'socket.js'),
    trocas: [['if (creds.me?.name !== name) {', 'if (name && creds.me?.name !== name) {']]
  },
  {
    nome: 'patch-libsignal-log',
    alvo: path.join(__dirname, 'node_modules', 'libsignal', 'src', 'session_record.js'),
    trocas: [
      ['console.warn("Session already closed", session);', 'console.warn("Session already closed");'],
      ['console.info("Closing session:", session);', 'console.info("Closing session");'],
      ['console.info("Opening session:", session);', 'console.info("Opening session");'],
      ['console.info("Removing old closed session:", oldestSession);', 'console.info("Removing old closed session");']
    ]
  }
];

for (const { nome, alvo, trocas } of patches) {
  try {
    let src = fs.readFileSync(alvo, 'utf8');
    const original = src;
    let faltando = 0;
    for (const [antes, depois] of trocas) {
      if (src.includes(depois)) continue;
      if (src.includes(antes)) src = src.replace(antes, depois);
      else faltando++;
    }
    if (src !== original) {
      if (!fs.existsSync(alvo + '.orig-antes-' + nome)) fs.writeFileSync(alvo + '.orig-antes-' + nome, original);
      fs.writeFileSync(alvo, src);
      console.log(nome + ': aplicado em ' + alvo);
    } else if (faltando === 0) {
      console.log(nome + ': já aplicado.');
    }
    if (faltando > 0) console.warn(nome + ': ' + faltando + ' trecho(s) não encontrado(s) em ' + alvo + ' — biblioteca mudou?');
  } catch (e) {
    console.warn(nome + ': não foi possível aplicar (' + e.message + ')');
  }
}
