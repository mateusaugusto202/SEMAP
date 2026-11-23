/* ==========================================================================
   SEMAP – Mapa de Salas Inteligente
   Servidor local

   - Serve os arquivos da pasta public/ (a interface).
   - Expõe uma API REST em /api para usuários, ambientes e reservas.
   - Guarda tudo em data/semap.json (criado automaticamente na 1ª execução).
   - Usa apenas módulos nativos do Node.js: não precisa de `npm install`.

   Executar:  node server.js   (ou: npm start)
   Variáveis opcionais:
     PORT  porta do servidor (padrão 3000)
     HOST  endereço de escuta (padrão 127.0.0.1 = só esta máquina;
           use 0.0.0.0 para liberar o acesso a outros computadores da rede)

   Sumário
   1. Configuração
   2. Utilitários
   3. Persistência (data/semap.json)
   4. Senhas e sessões
   5. Validações
   6. Rotas da API
   7. Arquivos estáticos
   8. Servidor HTTP
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


/* ==========================================================================
   1. CONFIGURAÇÃO
   ========================================================================== */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'semap.json');

/** Faixa de horas do calendário (07h–22h). */
const HORA_INICIO = 7;
const HORA_FIM = 22;

/** Tipos de ambiente aceitos. */
const TIPOS_AMBIENTE = ['Sala', 'Laboratório', 'Oficina', 'Biblioteca'];

/** Duração de uma sessão de login (12 horas). */
const SESSAO_MS = 12 * 60 * 60 * 1000;

/** Tamanho mínimo das senhas. */
const SENHA_MIN = 4;

/** Tipos de arquivo servidos pela interface. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};


/* ==========================================================================
   2. UTILITÁRIOS
   ========================================================================== */

/** Erro com código HTTP, devolvido ao navegador como { erro: mensagem }. */
class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Date -> "AAAA-MM-DD". */
const paraISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

/** Segunda-feira (00h) da semana da data informada. */
function segundaDe(data) {
  const d = new Date(data);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * Indica se uma hora de um dia já passou. A hora só é considerada passada
 * depois que termina (a hora atual ainda pode ser reservada).
 */
function horarioPassou(dia, hora) {
  const agora = new Date();
  const hoje = paraISO(agora);
  return dia < hoje || (dia === hoje && hora < agora.getHours());
}

/** Confere se o texto é uma data real no formato AAAA-MM-DD. */
function dataValida(texto) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const [a, m, d] = texto.split('-').map(Number);
  const data = new Date(a, m - 1, d);
  return data.getFullYear() === a && data.getMonth() === m - 1 && data.getDate() === d;
}

/** Garante que o valor é um texto e limita o tamanho. */
const texto = (valor, max) => String(valor === undefined || valor === null ? '' : valor).trim().slice(0, max);


/* ==========================================================================
   3. PERSISTÊNCIA (data/semap.json)

   Estrutura do arquivo:
   users[] : { n: nome, m: matrícula, p: senha (hash), r: 'admin' | 'user' }
   rooms[] : { id, n: nome, cap: capacidade, t: tipo, cal: ID Google Agenda,
               man: em manutenção (booleano), motivo }
   ev[]    : { id, r: id do ambiente, d: 'AAAA-MM-DD', s: hora inicial,
               e: hora final, t: turma/atividade, by: matrícula de quem reservou }
   ========================================================================== */

let db;

/** Dados de demonstração criados na primeira execução. */
function criarDadosIniciais() {
  const diaDaSemana = (n) => {
    const d = segundaDe(new Date());
    d.setDate(d.getDate() + n);
    return paraISO(d);
  };

  return {
    users: [
      { n: 'Administração SENAC', m: '1000', p: hashSenha('admin'), r: 'admin' },
      { n: 'Prof. Carlos Lima', m: '2024001', p: hashSenha('1234'), r: 'user' }
    ],
    rooms: [
      { id: 1, n: 'Sala 101', cap: 30, t: 'Sala', cal: 'sala101@group.calendar.google.com', man: false, motivo: '' },
      { id: 2, n: 'Laboratório de Informática', cap: 24, t: 'Laboratório', cal: 'labinfo@group.calendar.google.com', man: false, motivo: '' },
      { id: 3, n: 'Oficina de Mecânica', cap: 16, t: 'Oficina', cal: 'mecanica@group.calendar.google.com', man: false, motivo: '' }
    ],
    ev: [
      { id: crypto.randomUUID(), r: 1, d: diaDaSemana(0), s: 8, e: 12, t: 'TI 2025 – Lógica', by: '2024001' },
      { id: crypto.randomUUID(), r: 1, d: diaDaSemana(2), s: 19, e: 22, t: 'Auxiliar Adm. – Noite', by: '1000' },
      { id: crypto.randomUUID(), r: 2, d: diaDaSemana(1), s: 13, e: 17, t: 'Redes – Prática', by: '2024001' },
      { id: crypto.randomUUID(), r: 3, d: diaDaSemana(3), s: 8, e: 12, t: 'Soldagem – T2', by: '1000' }
    ]
  };
}

/** Lê o arquivo de dados; se não existir, cria com os dados de demonstração. */
function carregarDados() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    db = criarDadosIniciais();
    salvarDados();
    console.log('Primeira execução: dados de demonstração criados em', DATA_FILE);
    return;
  }

  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

/**
 * Grava os dados no disco. Escreve em um arquivo temporário e renomeia, para
 * que uma queda de energia no meio da gravação não corrompa o arquivo.
 */
function salvarDados() {
  const temporario = DATA_FILE + '.tmp';
  fs.writeFileSync(temporario, JSON.stringify(db, null, 2));
  fs.renameSync(temporario, DATA_FILE);
}

/** Nome do usuário pela matrícula (ou a própria matrícula, se ele foi removido). */
function nomeDe(matricula) {
  const u = db.users.find((x) => x.m === matricula);
  return u ? u.n : matricula;
}


/* ==========================================================================
   4. SENHAS E SESSÕES
   ========================================================================== */

/** Gera "sal:hash" usando scrypt (nativo do Node). */
function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, sal, 32).toString('hex');
  return `${sal}:${hash}`;
}

/** Compara uma senha digitada com o "sal:hash" guardado. */
function senhaConfere(senha, guardada) {
  const [sal, hash] = String(guardada).split(':');
  if (!sal || !hash) return false;
  const calculado = crypto.scryptSync(String(senha), sal, 32);
  const esperado = Buffer.from(hash, 'hex');
  return esperado.length === calculado.length && crypto.timingSafeEqual(calculado, esperado);
}

/** Sessões ativas em memória: token -> { m: matrícula, expira: timestamp }. */
const sessoes = new Map();

/** Cria uma sessão para o usuário e devolve o token. */
function criarSessao(matricula) {
  const token = crypto.randomBytes(24).toString('hex');
  sessoes.set(token, { m: matricula, expira: Date.now() + SESSAO_MS });
  return token;
}

/** Extrai o token do cabeçalho "Authorization: Bearer ...". */
function tokenDaRequisicao(req) {
  const cab = req.headers.authorization || '';
  return cab.startsWith('Bearer ') ? cab.slice(7) : null;
}

/** Devolve o usuário logado (ou null se o token for inválido/expirado). */
function autenticar(req) {
  const token = tokenDaRequisicao(req);
  const sessao = token && sessoes.get(token);
  if (!sessao) return null;

  if (sessao.expira < Date.now()) {
    sessoes.delete(token);
    return null;
  }
  return db.users.find((u) => u.m === sessao.m) || null;
}

/** Dados do usuário que podem ser enviados ao navegador (sem a senha). */
const usuarioPublico = (u) => ({ n: u.n, m: u.m, r: u.r });

/** Exige perfil de administrador. */
function exigirAdmin(usuario) {
  if (usuario.r !== 'admin') {
    throw new ErroHttp(403, 'Apenas administradores podem fazer isso.');
  }
}


/* ==========================================================================
   5. VALIDAÇÕES
   ========================================================================== */

/** Valida e normaliza os dados de um ambiente (cadastro e edição). */
function validarAmbiente(corpo) {
  const n = texto(corpo.n, 80);
  const cap = Number(corpo.cap);
  const t = texto(corpo.t, 30);

  if (!n) throw new ErroHttp(400, 'Informe o nome do ambiente.');
  if (!Number.isInteger(cap) || cap < 1 || cap > 1000) {
    throw new ErroHttp(400, 'A capacidade deve ser um número inteiro entre 1 e 1000.');
  }
  if (!TIPOS_AMBIENTE.includes(t)) throw new ErroHttp(400, 'Tipo de ambiente inválido.');

  const man = corpo.man === true;
  return {
    n,
    cap,
    t,
    cal: texto(corpo.cal, 200),
    man,
    motivo: man ? texto(corpo.motivo, 200) : ''
  };
}

/** Valida uma nova reserva aplicando todas as regras de negócio. */
function validarReserva(corpo) {
  const r = Number(corpo.r);
  const s = Number(corpo.s);
  const e = Number(corpo.e);
  const d = texto(corpo.d, 10);
  const t = texto(corpo.t, 120);

  const ambiente = db.rooms.find((x) => x.id === r);
  if (!ambiente) throw new ErroHttp(404, 'Ambiente não encontrado.');
  if (!t) throw new ErroHttp(400, 'Informe a turma ou atividade.');
  if (!dataValida(d)) throw new ErroHttp(400, 'Data inválida.');

  // Calendário vai de segunda a sábado
  const [a, m, dia] = d.split('-').map(Number);
  if (new Date(a, m - 1, dia).getDay() === 0) throw new ErroHttp(400, 'Não há agendamento aos domingos.');

  if (!Number.isInteger(s) || !Number.isInteger(e) || s < HORA_INICIO || e > HORA_FIM || e <= s) {
    throw new ErroHttp(400, 'Horário inválido.');
  }

  // Regras de negócio
  if (ambiente.man) {
    throw new ErroHttp(409, 'Este ambiente está em manutenção e não pode ser reservado.');
  }
  if (horarioPassou(d, s)) {
    throw new ErroHttp(400, 'Não é possível agendar em um dia ou horário que já passou.');
  }
  const conflito = db.ev.some((x) => x.r === r && x.d === d && s < x.e && e > x.s);
  if (conflito) throw new ErroHttp(409, 'Esse horário já está reservado neste ambiente.');

  return { r, d, s, e, t };
}


/* ==========================================================================
   6. ROTAS DA API
   ========================================================================== */

/** Lê e interpreta o corpo JSON da requisição (limite de 100 KB). */
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (parte) => {
      dados += parte;
      if (dados.length > 100000) {
        reject(new ErroHttp(413, 'Requisição grande demais.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!dados) return resolve({});
      try {
        resolve(JSON.parse(dados));
      } catch (e) {
        reject(new ErroHttp(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

/** Envia uma resposta JSON. */
function responder(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

/**
 * Trata todas as chamadas em /api.
 * Rotas:
 *   POST   /api/login                    entrar
 *   POST   /api/logout                   sair
 *   GET    /api/sessao                   usuário da sessão atual
 *   GET    /api/estado                   ambientes, reservas (e usuários, se admin)
 *   POST   /api/reservas                 criar reserva
 *   DELETE /api/reservas/:id             cancelar reserva (admin ou dono)
 *   POST   /api/usuarios                 cadastrar usuário (admin)
 *   DELETE /api/usuarios/:matricula      remover usuário (admin)
 *   PUT    /api/usuarios/:matricula/senha  trocar senha (admin)
 *   POST   /api/ambientes                cadastrar ambiente (admin)
 *   PUT    /api/ambientes/:id            editar ambiente / manutenção (admin)
 *   DELETE /api/ambientes/:id            remover ambiente (admin)
 */
async function tratarApi(req, res, pathname) {
  const [recurso, id, sub] = pathname.split('/').slice(2).map(decodeURIComponent);
  const metodo = req.method;

  // ---- Rota pública: login ----
  if (recurso === 'login' && metodo === 'POST') {
    const corpo = await lerCorpo(req);
    const usuario = db.users.find((u) => u.m === texto(corpo.matricula, 30));

    if (!usuario || !senhaConfere(corpo.senha, usuario.p)) {
      throw new ErroHttp(401, 'Matrícula ou senha incorretas. Confira os dados e tente de novo.');
    }
    return responder(res, 200, { token: criarSessao(usuario.m), usuario: usuarioPublico(usuario) });
  }

  // ---- Daqui para baixo é preciso estar logado ----
  const usuario = autenticar(req);
  if (!usuario) throw new ErroHttp(401, 'Sessão inválida ou expirada.');

  if (recurso === 'logout' && metodo === 'POST') {
    sessoes.delete(tokenDaRequisicao(req));
    return responder(res, 200, { ok: true });
  }

  if (recurso === 'sessao' && metodo === 'GET') {
    return responder(res, 200, { usuario: usuarioPublico(usuario) });
  }

  if (recurso === 'estado' && metodo === 'GET') {
    return responder(res, 200, {
      rooms: db.rooms,
      ev: db.ev.map((e) => Object.assign({}, e, { byN: nomeDe(e.by) })),
      users: usuario.r === 'admin' ? db.users.map(usuarioPublico) : []
    });
  }

  // ---- Reservas ----
  if (recurso === 'reservas' && !id && metodo === 'POST') {
    const dados = validarReserva(await lerCorpo(req));
    const reserva = Object.assign({ id: crypto.randomUUID() }, dados, { by: usuario.m });
    db.ev.push(reserva);
    salvarDados();
    return responder(res, 201, reserva);
  }

  if (recurso === 'reservas' && id && metodo === 'DELETE') {
    const indice = db.ev.findIndex((e) => e.id === id);
    if (indice < 0) throw new ErroHttp(404, 'Reserva não encontrada.');
    if (usuario.r !== 'admin' && db.ev[indice].by !== usuario.m) {
      throw new ErroHttp(403, 'Você só pode cancelar as suas próprias reservas.');
    }
    db.ev.splice(indice, 1);
    salvarDados();
    return responder(res, 200, { ok: true });
  }

  // ---- Usuários (somente admin) ----
  if (recurso === 'usuarios') {
    exigirAdmin(usuario);

    if (!id && metodo === 'POST') {
      const corpo = await lerCorpo(req);
      const n = texto(corpo.n, 80);
      const m = texto(corpo.m, 30);
      const p = String(corpo.p || '');
      const r = corpo.r === 'admin' ? 'admin' : 'user';

      if (!n || !m || !p) throw new ErroHttp(400, 'Preencha nome, matrícula e senha inicial.');
      if (p.length < SENHA_MIN) throw new ErroHttp(400, `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`);
      if (db.users.some((u) => u.m === m)) throw new ErroHttp(409, 'Essa matrícula já está cadastrada.');

      db.users.push({ n, m, p: hashSenha(p), r });
      salvarDados();
      return responder(res, 201, { ok: true });
    }

    if (id && !sub && metodo === 'DELETE') {
      if (id === usuario.m) throw new ErroHttp(400, 'Você não pode remover o seu próprio acesso.');
      const indice = db.users.findIndex((u) => u.m === id);
      if (indice < 0) throw new ErroHttp(404, 'Usuário não encontrado.');
      db.users.splice(indice, 1);
      salvarDados();
      return responder(res, 200, { ok: true });
    }

    if (id && sub === 'senha' && metodo === 'PUT') {
      const corpo = await lerCorpo(req);
      const alvo = db.users.find((u) => u.m === id);
      const nova = String(corpo.senha || '');

      if (!alvo) throw new ErroHttp(404, 'Usuário não encontrado.');
      if (nova.length < SENHA_MIN) throw new ErroHttp(400, `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`);

      alvo.p = hashSenha(nova);
      salvarDados();
      return responder(res, 200, { ok: true });
    }
  }

  // ---- Ambientes (somente admin) ----
  if (recurso === 'ambientes') {
    exigirAdmin(usuario);

    if (!id && metodo === 'POST') {
      const dados = validarAmbiente(await lerCorpo(req));
      const proximoId = db.rooms.reduce((maior, r) => Math.max(maior, r.id), 0) + 1;
      const ambiente = Object.assign({ id: proximoId }, dados);
      db.rooms.push(ambiente);
      salvarDados();
      return responder(res, 201, ambiente);
    }

    if (id && metodo === 'PUT') {
      const ambiente = db.rooms.find((r) => r.id === Number(id));
      if (!ambiente) throw new ErroHttp(404, 'Ambiente não encontrado.');
      Object.assign(ambiente, validarAmbiente(await lerCorpo(req)));
      salvarDados();
      return responder(res, 200, ambiente);
    }

    if (id && metodo === 'DELETE') {
      const indice = db.rooms.findIndex((r) => r.id === Number(id));
      if (indice < 0) throw new ErroHttp(404, 'Ambiente não encontrado.');
      const removido = db.rooms.splice(indice, 1)[0];
      db.ev = db.ev.filter((e) => e.r !== removido.id); // apaga também as reservas dele
      salvarDados();
      return responder(res, 200, { ok: true });
    }
  }

  throw new ErroHttp(404, 'Rota não encontrada.');
}


/* ==========================================================================
   7. ARQUIVOS ESTÁTICOS
   ========================================================================== */

/** Entrega um arquivo da pasta public/ (com proteção contra "../"). */
function servirEstatico(res, pathname) {
  let relativo;
  try {
    relativo = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch (e) {
    return responder(res, 400, { erro: 'Endereço inválido.' });
  }

  const arquivo = path.normalize(path.join(PUBLIC_DIR, relativo));
  if (!arquivo.startsWith(PUBLIC_DIR + path.sep)) {
    return responder(res, 403, { erro: 'Acesso negado.' });
  }

  fs.readFile(arquivo, (erro, conteudo) => {
    if (erro) return responder(res, 404, { erro: 'Arquivo não encontrado.' });

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(conteudo);
  });
}


/* ==========================================================================
   8. SERVIDOR HTTP
   ========================================================================== */

carregarDados();

const servidor = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    if (pathname.startsWith('/api/')) {
      await tratarApi(req, res, pathname);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      servirEstatico(res, pathname);
    } else {
      responder(res, 405, { erro: 'Método não permitido.' });
    }
  } catch (erro) {
    if (erro instanceof ErroHttp) {
      responder(res, erro.status, { erro: erro.message });
    } else {
      console.error(erro);
      responder(res, 500, { erro: 'Erro interno do servidor.' });
    }
  }
});

servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. Feche o outro programa ou use outra porta (ex.: PORT=3001).`);
  } else {
    console.error(erro);
  }
  process.exit(1);
});

servidor.listen(PORT, HOST, () => {
  console.log('SEMAP em execução.');
  console.log(`Abra no navegador: http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1') console.log(`Escutando em ${HOST} (acessível por outros computadores da rede).`);
  console.log('Para encerrar, pressione Ctrl+C.');
});
