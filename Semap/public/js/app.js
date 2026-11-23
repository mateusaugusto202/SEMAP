/* ==========================================================================
   SEMAP – Mapa de Salas Inteligente
   Lógica da interface (front-end)

   Os dados ficam no servidor local (server.js), que os grava em
   data/semap.json. Este arquivo conversa com ele pela API em /api.
   As regras de negócio são verificadas aqui (para dar resposta rápida)
   e de novo no servidor (que tem a palavra final).

   Sumário
   1. Constantes
   2. Utilitários
   3. Comunicação com o servidor
   4. Estado da sessão
   5. Confirmação de ações
   6. Login e navegação
   7. Agendamento
   8. Administração: usuários
   9. Administração: ambientes (cadastro, edição e manutenção)
   10. Inicialização
   ========================================================================== */

(function () {
  'use strict';


  /* ========================================================================
     1. CONSTANTES
     ======================================================================== */

  /** Primeira hora exibida no calendário (07h). */
  const HORA_INICIO = 7;

  /** Hora de encerramento do calendário (22h). Último início possível: 21h. */
  const HORA_FIM = 22;

  /** Colunas do calendário (segunda a sábado). */
  const DIAS_SEMANA = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  /** Chave onde o token de login fica guardado (apaga ao fechar a aba). */
  const TOKEN_KEY = 'semap-token';

  /** De quanto em quanto tempo a agenda busca novidades no servidor (30 s). */
  const INTERVALO_ATUALIZACAO = 30000;

  /** Tamanho mínimo das senhas (o servidor aplica a mesma regra). */
  const SENHA_MIN = 4;


  /* ========================================================================
     2. UTILITÁRIOS
     ======================================================================== */

  /** Atalho para document.getElementById. */
  const $ = (id) => document.getElementById(id);

  /** Completa com zero à esquerda: 7 -> "07". */
  const pad = (n) => String(n).padStart(2, '0');

  /** Converte uma Date em texto "AAAA-MM-DD" (formato usado nas reservas). */
  const paraISO = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  /** Converte "AAAA-MM-DD" em "DD/MM/AAAA". */
  const dataBR = (iso) => iso.split('-').reverse().join('/');

  /** Retorna a segunda-feira (00h) da semana da data informada. */
  const segundaDe = (data) => {
    const d = new Date(data);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  };

  /**
   * Escapa caracteres especiais de HTML para exibir texto digitado pelo
   * usuário com segurança dentro de innerHTML.
   */
  const escapar = (texto) =>
    String(texto).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

  /**
   * Indica se uma hora de um dia já passou.
   * Regra: a hora só é considerada passada depois que ela termina, então a
   * hora atual ainda pode ser reservada (ex.: às 10h30, a faixa 10h–11h vale).
   * @param {string} dia  Data no formato "AAAA-MM-DD".
   * @param {number} hora Hora inicial da faixa (ex.: 10).
   */
  const horarioPassou = (dia, hora) => {
    const agora = new Date();
    const hoje = paraISO(agora);
    return dia < hoje || (dia === hoje && hora < agora.getHours());
  };

  /** Indica se o ambiente está em manutenção (campo `man`). */
  const emManutencao = (ambiente) => Boolean(ambiente && ambiente.man);

  /** Mostra uma mensagem temporária no rodapé da tela. */
  function toast(texto) {
    // Mostra um aviso por vez (o novo substitui o anterior)
    document.querySelectorAll('.toast').forEach((antigo) => antigo.remove());

    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = texto;
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }


  /* ========================================================================
     3. COMUNICAÇÃO COM O SERVIDOR

     `db` é uma cópia local dos dados, atualizada por carregarEstado():

     users[] : { n: nome, m: matrícula, r: 'admin' | 'user' }   (só para admin)
     rooms[] : { id, n: nome, cap: capacidade, t: tipo, cal: ID Google Agenda,
                 man: true se em manutenção, motivo: texto opcional }
     ev[]    : { id, r: id do ambiente, d: 'AAAA-MM-DD', s: hora inicial,
                 e: hora final, t: turma/atividade, by: matrícula, byN: nome }
     ======================================================================== */

  let db = { users: [], rooms: [], ev: [] };

  /** Token de login da sessão atual. */
  let token = sessionStorage.getItem(TOKEN_KEY);

  /**
   * Faz uma chamada à API e devolve o JSON da resposta.
   * Em caso de erro, lança um Error com a mensagem para o usuário e o
   * código HTTP em `status` (0 = servidor inacessível).
   * @param {string} metodo  GET, POST, PUT ou DELETE.
   * @param {string} caminho Caminho depois de /api (ex.: '/reservas').
   * @param {object} [corpo] Dados enviados em JSON.
   */
  async function api(metodo, caminho, corpo) {
    const opcoes = { method: metodo, headers: {} };

    if (corpo !== undefined) {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }
    if (token) opcoes.headers.Authorization = 'Bearer ' + token;

    let resposta;
    try {
      resposta = await fetch('/api' + caminho, opcoes);
    } catch (e) {
      const erro = new Error('Não foi possível falar com o servidor. Verifique se o SEMAP está em execução.');
      erro.status = 0;
      throw erro;
    }

    let dados = null;
    try {
      dados = await resposta.json();
    } catch (e) {
      /* resposta sem corpo JSON */
    }

    if (!resposta.ok) {
      const erro = new Error((dados && dados.erro) || 'Erro inesperado no servidor.');
      erro.status = resposta.status;
      throw erro;
    }
    return dados;
  }

  /** Baixa do servidor a lista atual de ambientes, reservas e usuários. */
  async function carregarEstado() {
    const estado = await api('GET', '/estado');
    db.rooms = estado.rooms;
    db.ev = estado.ev;
    db.users = estado.users;
  }

  /**
   * Mostra um erro para o usuário: dentro do formulário (se `areaMsg` for
   * informada) ou em um aviso temporário. Sessão expirada volta ao login.
   * @param {Error} erro
   * @param {HTMLElement} [areaMsg] Elemento de mensagem do formulário aberto.
   */
  function tratarErro(erro, areaMsg) {
    if (erro.status === 401 && usuarioLogado) {
      encerrarSessao('Sua sessão expirou. Entre novamente.');
      return;
    }
    if (areaMsg) areaMsg.textContent = erro.message;
    else toast(erro.message);
  }

  /** Procura o nome de um usuário pela matrícula (ou devolve a própria matrícula). */
  function nomeDoUsuario(matricula) {
    const u = db.users.find((x) => x.m === matricula);
    return u ? u.n : matricula;
  }

  /** Conta as reservas de um ambiente que ainda vão acontecer. */
  function contarReservasFuturas(idAmbiente) {
    const agora = new Date();
    const hoje = paraISO(agora);
    return db.ev.filter((e) =>
      e.r === idAmbiente && (e.d > hoje || (e.d === hoje && e.e > agora.getHours()))
    ).length;
  }


  /* ========================================================================
     4. ESTADO DA SESSÃO
     ======================================================================== */

  /** Usuário logado ({ n, m, r }) ou null. */
  let usuarioLogado = null;

  /** Segunda-feira da semana exibida no calendário. */
  let semanaAtual = segundaDe(new Date());

  /** Id do ambiente selecionado na tela de agendamento. */
  let ambienteSelecionado = null;

  /** Dia/hora clicados enquanto o modal de agendamento está aberto. */
  let reservaPendente = null;

  /** Matrícula do usuário que terá a senha trocada. */
  let matriculaSenha = null;

  /** Ambiente em edição no modal de ambiente (null = criando um novo). */
  let ambienteEmEdicao = null;

  /** Último HTML da lista de ambientes (evita redesenhar a lista sem necessidade). */
  let htmlAmbientes = '';


  /* ========================================================================
     5. CONFIRMAÇÃO DE AÇÕES
     ======================================================================== */

  /**
   * Abre uma janela de confirmação e espera a resposta do usuário.
   * Esc, o botão de cancelar ou qualquer fechamento inesperado contam como "não".
   * O foco começa no botão de cancelar, para que um Enter distraído não confirme.
   * @param {object}  opcoes
   * @param {string}  opcoes.titulo           Pergunta curta.
   * @param {string}  opcoes.texto            Explica o que vai acontecer.
   * @param {string}  [opcoes.rotulo]         Texto do botão de confirmar.
   * @param {string}  [opcoes.rotuloCancelar] Texto do botão de voltar.
   * @param {boolean} [opcoes.perigo]         Destaca o botão em vermelho (ações destrutivas).
   * @returns {Promise<boolean>} true se o usuário confirmou.
   */
  function confirmar({ titulo, texto, rotulo = 'Confirmar', rotuloCancelar = 'Cancelar', perigo = false }) {
    return new Promise((resolve) => {
      const dialogo = $('dlgConfirm');

      $('cfTitle').textContent = titulo;
      $('cfText').textContent = texto;
      $('cfOk').textContent = rotulo;
      $('cfOk').classList.toggle('solid-danger', perigo);
      $('cfCancel').textContent = rotuloCancelar;

      dialogo.returnValue = '';
      $('cfOk').onclick = () => dialogo.close('ok');
      $('cfCancel').onclick = () => dialogo.close('nao');
      dialogo.onclose = () => resolve(dialogo.returnValue === 'ok');

      dialogo.showModal();
      $('cfCancel').focus();
    });
  }


  /* ========================================================================
     6. LOGIN E NAVEGAÇÃO
     ======================================================================== */

  /** Valida matrícula/senha no servidor e abre a aplicação. */
  async function entrar() {
    $('loginMsg').textContent = '';

    try {
      const resposta = await api('POST', '/login', {
        matricula: $('mat').value.trim(),
        senha: $('pw').value
      });
      token = resposta.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      $('pw').value = '';
      await abrirApp(resposta.usuario);
    } catch (erro) {
      tratarErro(erro, $('loginMsg'));
    }
  }

  /** Mostra a aplicação para o usuário já autenticado. */
  async function abrirApp(usuario) {
    usuarioLogado = usuario;
    await carregarEstado();

    $('vLogin').classList.add('hide');
    $('vApp').classList.remove('hide');
    $('who').textContent = usuario.n;
    $('navAd').classList.toggle('hide', usuario.r !== 'admin');

    mostrarTela('ag');
    preencherAmbientes();
    renderCalendario();
  }

  /** Se havia um login ativo nesta aba, volta direto para a aplicação. */
  async function retomarSessao() {
    if (!token) return;

    try {
      const resposta = await api('GET', '/sessao');
      await abrirApp(resposta.usuario);
    } catch (erro) {
      token = null;
      sessionStorage.removeItem(TOKEN_KEY);
    }
  }

  /** Pede confirmação e encerra a sessão. */
  async function sair() {
    const ok = await confirmar({
      titulo: 'Sair do SEMAP?',
      texto: 'Você precisará informar matrícula e senha novamente para voltar.',
      rotulo: 'Sair'
    });
    if (!ok) return;

    try {
      await api('POST', '/logout');
    } catch (erro) {
      /* mesmo sem resposta do servidor, a sessão local é encerrada */
    }
    encerrarSessao('');
  }

  /**
   * Limpa a sessão local e volta para a tela de login.
   * @param {string} mensagem Aviso exibido no login (ex.: sessão expirada).
   */
  function encerrarSessao(mensagem) {
    token = null;
    usuarioLogado = null;
    sessionStorage.removeItem(TOKEN_KEY);
    db = { users: [], rooms: [], ev: [] };

    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('pw').value = '';
    $('loginMsg').textContent = mensagem;
    $('vApp').classList.add('hide');
    $('vLogin').classList.remove('hide');
  }

  /**
   * Alterna entre as telas principais.
   * @param {'ag'|'ad'} tela 'ag' = Agendamento, 'ad' = Administração.
   */
  function mostrarTela(tela) {
    $('vAg').classList.toggle('hide', tela !== 'ag');
    $('vAd').classList.toggle('hide', tela !== 'ad');

    marcarAtivo($('navAg'), tela === 'ag');
    marcarAtivo($('navAd'), tela === 'ad');

    if (tela === 'ad') renderAdmin();
  }

  /** Marca (ou desmarca) um botão de menu como página atual. */
  function marcarAtivo(botao, ativo) {
    if (ativo) botao.setAttribute('aria-current', 'page');
    else botao.removeAttribute('aria-current');
  }

  /** Vai para a Agenda ou Administração já com os dados mais recentes. */
  async function irPara(tela) {
    try {
      await carregarEstado();
    } catch (erro) {
      tratarErro(erro);
      return;
    }
    mostrarTela(tela);
    if (tela === 'ag') {
      preencherAmbientes();
      renderCalendario();
    }
  }


  /* ========================================================================
     7. AGENDAMENTO
     ======================================================================== */

  /** Preenche a lista de ambientes (indicando os que estão em manutenção). */
  function preencherAmbientes() {
    const html = db.rooms
      .map((r) => `<option value="${r.id}">${escapar(r.n)}${emManutencao(r) ? ' (em manutenção)' : ''}</option>`)
      .join('');

    // Só mexe na lista quando algo mudou (não fecha a lista aberta pelo usuário)
    if (html !== htmlAmbientes) {
      const anterior = ambienteSelecionado;
      $('roomSel').innerHTML = html;
      htmlAmbientes = html;

      // Mantém a seleção anterior se o ambiente ainda existir
      if (anterior && db.rooms.some((r) => r.id === anterior)) {
        $('roomSel').value = anterior;
      }
    }
    ambienteSelecionado = Number($('roomSel').value) || null;
  }

  /** Desenha o calendário da semana para o ambiente selecionado. */
  function renderCalendario() {
    const ambiente = db.rooms.find((r) => r.id === ambienteSelecionado);
    const cal = $('cal');
    const banner = $('maintBanner');

    // Nenhum ambiente cadastrado
    if (!ambiente) {
      cal.innerHTML = '';
      banner.classList.add('hide');
      $('roomInfo').textContent = 'Nenhum ambiente cadastrado. Peça ao administrador para cadastrar.';
      return;
    }

    const manutencao = emManutencao(ambiente);

    // Linha de informações do ambiente
    $('roomInfo').textContent =
      `${ambiente.t} · ${ambiente.cap} lugares · Google Agenda: ${ambiente.cal || 'não vinculada'}`;

    // Aviso de manutenção
    banner.classList.toggle('hide', !manutencao);
    if (manutencao) {
      banner.textContent =
        'Este ambiente está em manutenção e não pode ser reservado até ser liberado.' +
        (ambiente.motivo ? ` Motivo: ${ambiente.motivo}.` : '');
    }

    // Os 6 dias da semana exibida
    const dias = DIAS_SEMANA.map((_, i) => {
      const d = new Date(semanaAtual);
      d.setDate(d.getDate() + i);
      return d;
    });
    const diaMes = (d) => pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
    const hoje = paraISO(new Date());

    $('weekLbl').textContent = diaMes(dias[0]) + ' a ' + diaMes(dias[5]);

    // Cabeçalho: célula vazia + um título por dia
    let html = '<div class="h"></div>';
    html += dias.map((d, i) =>
      `<div class="h ${paraISO(d) === hoje ? 'today' : ''}">${DIAS_SEMANA[i]}<small>${diaMes(d)}</small></div>`
    ).join('');

    // Corpo: uma linha por hora, uma célula por dia
    for (let hora = HORA_INICIO; hora < HORA_FIM; hora++) {
      html += `<div class="t">${pad(hora)}h</div>`;

      dias.forEach((d, i) => {
        const dia = paraISO(d);
        const passou = horarioPassou(dia, hora);

        // Reservas que começam nesta hora
        const reservas = db.ev.filter((e) => e.r === ambiente.id && e.d === dia && e.s === hora);

        const classes = 'c' + (manutencao ? ' maint' : '') + (passou ? ' past' : '');
        const bloqueada = manutencao || passou;
        const motivoBloqueio = manutencao ? 'Ambiente em manutenção' : 'Horário que já passou';

        html += `<button class="${classes}"` +
          (bloqueada ? ` aria-disabled="true" title="${motivoBloqueio}"` : '') +
          ` data-d="${dia}" data-h="${hora}"` +
          ` aria-label="${DIAS_SEMANA[i]} ${pad(hora)}h${bloqueada ? ' (indisponível)' : ''}">` +
          reservas.map((e) => htmlReserva(e)).join('') +
          '</button>';
      });
    }

    cal.innerHTML = html;

    // Clique em uma célula: abre reserva existente ou novo agendamento
    cal.querySelectorAll('.c').forEach((celula) => {
      celula.onclick = (evento) => {
        // 1) Clique sobre uma reserva: abre os detalhes
        const reserva = evento.target.closest('.ev');
        if (reserva) {
          abrirReserva(reserva.dataset.id);
          return;
        }

        // 2) Ambiente em manutenção: bloqueado
        if (emManutencao(ambiente)) {
          toast('Ambiente em manutenção: não é possível agendar.');
          return;
        }

        // 3) Dia/horário que já passou: bloqueado
        if (horarioPassou(celula.dataset.d, Number(celula.dataset.h))) {
          toast('Não é possível agendar em um dia ou horário que já passou.');
          return;
        }

        // 4) Livre: abre o formulário de agendamento
        abrirAgendamento(celula.dataset.d, Number(celula.dataset.h));
      };
    });
  }

  /** Gera o HTML do bloco de uma reserva dentro da célula. */
  function htmlReserva(e) {
    const altura = `calc(${e.e - e.s} * var(--hora-h) - 5px)`;
    return `<span class="ev" data-id="${escapar(e.id)}" style="top:2px;height:${altura}">` +
      `<b>${pad(e.s)}h–${pad(e.e)}h</b>${escapar(e.t)}<i>${escapar(e.byN || e.by)}</i></span>`;
  }

  /**
   * Verifica se existe conflito com outra reserva no mesmo ambiente e dia.
   * @param {number} idAmbiente
   * @param {string} dia   "AAAA-MM-DD"
   * @param {number} inicio Hora inicial.
   * @param {number} fim    Hora final.
   */
  function haConflito(idAmbiente, dia, inicio, fim) {
    return db.ev.some((x) =>
      x.r === idAmbiente && x.d === dia && inicio < x.e && fim > x.s
    );
  }

  /** Abre o modal de novo agendamento para o dia/hora clicados. */
  function abrirAgendamento(dia, hora) {
    const ambiente = db.rooms.find((r) => r.id === ambienteSelecionado);

    // Segurança extra: nunca abre para ambiente em manutenção ou horário passado
    if (!ambiente || emManutencao(ambiente) || horarioPassou(dia, hora)) return;

    reservaPendente = { dia, hora };

    // Gera as opções de hora (de `a` até 22h)
    const opcoes = (a) => {
      let html = '';
      for (let i = HORA_INICIO; i <= HORA_FIM; i++) {
        if (i >= a) html += `<option value="${i}">${pad(i)}h</option>`;
      }
      return html;
    };

    // No dia de hoje, o início só pode ser a partir da hora atual
    const agora = new Date();
    const horaMinima = dia === paraISO(agora) ? Math.max(HORA_INICIO, agora.getHours()) : HORA_INICIO;

    // O início não pode ser 22h (não haveria hora final possível)
    $('bkS').innerHTML = opcoes(horaMinima).replace(/<option value="22">.*?<\/option>/, '');
    $('bkS').value = hora;

    // O fim depende do início escolhido
    const preencherFim = () => {
      const inicio = Number($('bkS').value);
      $('bkE').innerHTML = opcoes(inicio + 1);
      $('bkE').value = Math.min(inicio + 1, HORA_FIM);
    };
    $('bkS').onchange = preencherFim;
    preencherFim();

    $('bkSub').textContent = `${ambiente.n} · ${dataBR(dia)}`;
    $('bkTitle').value = '';
    $('bkMsg').textContent = '';
    $('dlgBook').showModal();
  }

  /** Valida e envia o novo agendamento ao servidor. */
  async function salvarAgendamento() {
    const ambiente = db.rooms.find((r) => r.id === ambienteSelecionado);
    const titulo = $('bkTitle').value.trim();
    const inicio = Number($('bkS').value);
    const fim = Number($('bkE').value);

    // Verificações rápidas no navegador (o servidor repete todas elas)
    if (!titulo) {
      $('bkMsg').textContent = 'Informe a turma ou atividade.';
      return;
    }
    if (emManutencao(ambiente)) {
      $('bkMsg').textContent = 'Este ambiente entrou em manutenção e não pode ser reservado.';
      return;
    }
    if (horarioPassou(reservaPendente.dia, inicio)) {
      $('bkMsg').textContent = 'Não é possível agendar em um dia ou horário que já passou.';
      return;
    }
    if (haConflito(ambienteSelecionado, reservaPendente.dia, inicio, fim)) {
      $('bkMsg').textContent = 'Esse horário já está reservado neste ambiente.';
      return;
    }

    try {
      await api('POST', '/reservas', {
        r: ambienteSelecionado,
        d: reservaPendente.dia,
        s: inicio,
        e: fim,
        t: titulo
      });
      $('dlgBook').close();
      await carregarEstado();
      renderCalendario();
      toast('Agendamento salvo');
    } catch (erro) {
      tratarErro(erro, $('bkMsg'));
      // Se outra pessoa reservou antes, atualiza a agenda para mostrar
      carregarEstado().then(renderCalendario).catch(() => {});
    }
  }

  /** Abre os detalhes de uma reserva (com opção de cancelar, se permitido). */
  function abrirReserva(id) {
    const e = db.ev.find((x) => x.id === id);
    if (!e) return;

    $('evTitle').textContent = e.t;
    $('evSub').textContent =
      `${dataBR(e.d)} · ${pad(e.s)}h–${pad(e.e)}h · Reservado por ${e.byN || e.by}`;

    // Só o administrador ou quem fez a reserva pode cancelá-la
    const podeCancelar = usuarioLogado.r === 'admin' || e.by === usuarioLogado.m;
    $('evDel').classList.toggle('hide', !podeCancelar);
    $('evDel').onclick = () => cancelarReserva(e);

    $('dlgEv').showModal();
  }

  /** Pede confirmação e cancela uma reserva. */
  async function cancelarReserva(e) {
    const ok = await confirmar({
      titulo: 'Cancelar esta reserva?',
      texto: `"${e.t}" em ${dataBR(e.d)}, das ${pad(e.s)}h às ${pad(e.e)}h, será cancelada e o horário ficará livre.`,
      rotulo: 'Cancelar reserva',
      rotuloCancelar: 'Voltar',
      perigo: true
    });
    if (!ok) return;

    try {
      await api('DELETE', '/reservas/' + encodeURIComponent(e.id));
      $('dlgEv').close();
      await carregarEstado();
      renderCalendario();
      toast('Reserva cancelada');
    } catch (erro) {
      tratarErro(erro);
    }
  }


  /* ========================================================================
     8. ADMINISTRAÇÃO: USUÁRIOS
     ======================================================================== */

  /** Alterna entre as seções "Usuários" e "Ambientes" do menu lateral. */
  function mostrarSecao(secao) {
    $('secUsers').classList.toggle('hide', secao !== 'users');
    $('secRooms').classList.toggle('hide', secao !== 'rooms');
    marcarAtivo($('sbUsers'), secao === 'users');
    marcarAtivo($('sbRooms'), secao === 'rooms');
  }

  /** Redesenha as duas listagens e os contadores do menu lateral. */
  function renderAdmin() {
    $('cntU').textContent = db.users.length;
    $('cntA').textContent = db.rooms.length;

    // --- Lista de usuários ---
    $('uList').innerHTML = db.users.map((u) => `
      <div class="row">
        <div>
          ${escapar(u.n)}<span class="badge">${u.r === 'admin' ? 'Administrador' : 'Usuário'}</span>
          <small>Matrícula ${escapar(u.m)}</small>
        </div>
        <div class="acts">
          <button class="btn ghost sm" data-pw="${escapar(u.m)}">Trocar senha</button>
          ${u.m !== usuarioLogado.m ? `<button class="btn danger sm" data-du="${escapar(u.m)}">Remover</button>` : ''}
        </div>
      </div>`).join('') || '<p class="empty">Nenhum usuário cadastrado.</p>';

    // --- Lista de ambientes ---
    $('aList').innerHTML = db.rooms.map((r) => `
      <div class="row">
        <div>
          ${escapar(r.n)}<span class="badge">${escapar(r.t)}</span>${emManutencao(r) ? '<span class="badge warn">Em manutenção</span>' : ''}
          <small>${r.cap} lugares · Google Agenda: ${escapar(r.cal || 'não vinculada')}${emManutencao(r) && r.motivo ? ` · Motivo: ${escapar(r.motivo)}` : ''}</small>
        </div>
        <div class="acts">
          <button class="btn ghost sm" data-er="${r.id}">Editar</button>
          <button class="btn danger sm" data-dr="${r.id}">Remover</button>
        </div>
      </div>`).join('') || '<p class="empty">Nenhum ambiente cadastrado.</p>';

    // Ligações dos botões de cada linha
    document.querySelectorAll('[data-pw]').forEach((b) => {
      b.onclick = () => abrirTrocaSenha(b.dataset.pw);
    });
    document.querySelectorAll('[data-du]').forEach((b) => {
      b.onclick = () => removerUsuario(b.dataset.du);
    });
    document.querySelectorAll('[data-er]').forEach((b) => {
      b.onclick = () => abrirModalAmbiente(db.rooms.find((r) => r.id === Number(b.dataset.er)));
    });
    document.querySelectorAll('[data-dr]').forEach((b) => {
      b.onclick = () => removerAmbiente(Number(b.dataset.dr));
    });
  }

  /** Abre o modal de cadastro de usuário com o formulário limpo. */
  function abrirModalUsuario() {
    ['uNome', 'uMat', 'uPw'].forEach((id) => { $(id).value = ''; });
    $('uPerfil').value = 'user';
    $('uMsg').textContent = '';
    $('dlgUser').showModal();
    $('uNome').focus();
  }

  /** Valida e cadastra um novo usuário. */
  async function cadastrarUsuario() {
    const nome = $('uNome').value.trim();
    const matricula = $('uMat').value.trim();
    const senha = $('uPw').value;

    if (!nome || !matricula || !senha) {
      $('uMsg').textContent = 'Preencha nome, matrícula e senha inicial.';
      return;
    }
    if (senha.length < SENHA_MIN) {
      $('uMsg').textContent = `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`;
      return;
    }

    try {
      await api('POST', '/usuarios', { n: nome, m: matricula, p: senha, r: $('uPerfil').value });
      $('dlgUser').close();
      await carregarEstado();
      renderAdmin();
      toast('Usuário cadastrado');
    } catch (erro) {
      tratarErro(erro, $('uMsg'));
    }
  }

  /** Pede confirmação e remove um usuário. */
  async function removerUsuario(matricula) {
    const alvo = db.users.find((u) => u.m === matricula);
    if (!alvo) return;

    const ok = await confirmar({
      titulo: 'Remover este usuário?',
      texto: `${alvo.n} (matrícula ${alvo.m}) perderá o acesso ao SEMAP. As reservas já feitas por essa pessoa continuam no calendário.`,
      rotulo: 'Remover usuário',
      perigo: true
    });
    if (!ok) return;

    try {
      await api('DELETE', '/usuarios/' + encodeURIComponent(matricula));
      await carregarEstado();
      renderAdmin();
      toast('Usuário removido');
    } catch (erro) {
      tratarErro(erro);
    }
  }

  /** Abre o modal para trocar a senha de um usuário. */
  function abrirTrocaSenha(matricula) {
    const alvo = db.users.find((u) => u.m === matricula);
    if (!alvo) return;

    matriculaSenha = matricula;
    $('pwSub').textContent = alvo.n;
    $('pwNew').value = '';
    $('pwMsg').textContent = '';
    $('dlgPw').showModal();
    $('pwNew').focus();
  }

  /** Valida, pede confirmação e salva a nova senha. */
  async function salvarSenha() {
    const nova = $('pwNew').value;

    if (nova.length < SENHA_MIN) {
      $('pwMsg').textContent = `A senha deve ter pelo menos ${SENHA_MIN} caracteres.`;
      return;
    }

    const alvo = db.users.find((u) => u.m === matriculaSenha);
    const ok = await confirmar({
      titulo: 'Trocar a senha?',
      texto: `A senha de ${alvo ? alvo.n : 'este usuário'} será substituída pela nova senha.`,
      rotulo: 'Trocar senha'
    });
    if (!ok) return;

    try {
      await api('PUT', '/usuarios/' + encodeURIComponent(matriculaSenha) + '/senha', { senha: nova });
      $('dlgPw').close();
      toast('Senha alterada');
    } catch (erro) {
      tratarErro(erro, $('pwMsg'));
    }
  }


  /* ========================================================================
     9. ADMINISTRAÇÃO: AMBIENTES (CADASTRO, EDIÇÃO E MANUTENÇÃO)
     ======================================================================== */

  /** Mostra/oculta os campos de manutenção conforme a caixa marcada. */
  function atualizarCamposManutencao() {
    const ativa = $('aMan').checked;
    $('maintFields').classList.toggle('hide', !ativa);

    // Avisa quantas reservas futuras já existem (elas são mantidas)
    if (ativa && ambienteEmEdicao) {
      const n = contarReservasFuturas(ambienteEmEdicao.id);
      $('aWarn').textContent = n
        ? `Este ambiente tem ${n} reserva(s) futura(s). Elas serão mantidas, mas avise os responsáveis.`
        : 'Novos agendamentos ficam bloqueados até a manutenção ser encerrada.';
    } else {
      $('aWarn').textContent = 'Novos agendamentos ficam bloqueados até a manutenção ser encerrada.';
    }
  }

  /**
   * Abre o modal de ambiente.
   * @param {object} [ambiente] Ambiente a editar; sem argumento, abre o cadastro de um novo.
   */
  function abrirModalAmbiente(ambiente) {
    ambienteEmEdicao = ambiente || null;
    const editando = Boolean(ambiente);

    $('roomDlgTitle').textContent = editando ? 'Editar ambiente' : 'Novo ambiente';
    $('aAdd').textContent = editando ? 'Salvar alterações' : 'Cadastrar ambiente';

    $('aNome').value = editando ? ambiente.n : '';
    $('aCap').value = editando ? ambiente.cap : '';
    $('aTipo').value = editando ? ambiente.t : 'Sala';
    $('aCal').value = editando ? (ambiente.cal || '') : '';
    $('aMan').checked = editando && emManutencao(ambiente);
    $('aMotivo').value = editando ? (ambiente.motivo || '') : '';
    $('aMsg').textContent = '';

    atualizarCamposManutencao();
    $('dlgRoom').showModal();
    $('aNome').focus();
  }

  /** Valida e salva o ambiente (novo ou editado), confirmando mudanças de manutenção. */
  async function salvarAmbiente() {
    const nome = $('aNome').value.trim();
    const capacidade = Number($('aCap').value);

    if (!nome || !capacidade) {
      $('aMsg').textContent = 'Informe o nome e a capacidade.';
      return;
    }

    const dados = {
      n: nome,
      cap: capacidade,
      t: $('aTipo').value,
      cal: $('aCal').value.trim(),
      man: $('aMan').checked,
      motivo: $('aMan').checked ? $('aMotivo').value.trim() : ''
    };

    const editado = ambienteEmEdicao;

    // Entrar ou sair de manutenção muda quem pode usar o ambiente: pede confirmação
    let estavaEmManutencao = false;
    if (editado) {
      const atual = db.rooms.find((r) => r.id === editado.id) || editado;
      estavaEmManutencao = emManutencao(atual);

      if (dados.man !== estavaEmManutencao) {
        const futuras = contarReservasFuturas(editado.id);
        const ok = await confirmar(dados.man
          ? {
              titulo: 'Colocar em manutenção?',
              texto: `"${dados.n}" ficará indisponível e não aceitará novos agendamentos até ser liberado.` +
                (futuras ? ` As ${futuras} reserva(s) futura(s) serão mantidas.` : ''),
              rotulo: 'Colocar em manutenção'
            }
          : {
              titulo: 'Liberar o ambiente?',
              texto: `"${dados.n}" sairá de manutenção e voltará a aceitar agendamentos.`,
              rotulo: 'Liberar ambiente'
            });
        if (!ok) return;
      }
    }

    try {
      if (editado) await api('PUT', '/ambientes/' + editado.id, dados);
      else await api('POST', '/ambientes', dados);

      $('dlgRoom').close();
      await carregarEstado();
      renderAdmin();

      if (!editado) toast('Ambiente cadastrado');
      else if (dados.man && !estavaEmManutencao) toast('Ambiente colocado em manutenção');
      else if (!dados.man && estavaEmManutencao) toast('Ambiente liberado para uso');
      else toast('Ambiente atualizado');
    } catch (erro) {
      tratarErro(erro, $('aMsg'));
    }
  }

  /** Pede confirmação e remove um ambiente e todas as reservas dele. */
  async function removerAmbiente(id) {
    const alvo = db.rooms.find((r) => r.id === id);
    if (!alvo) return;

    const total = db.ev.filter((e) => e.r === id).length;
    const ok = await confirmar({
      titulo: 'Remover este ambiente?',
      texto: `"${alvo.n}" será apagado` +
        (total ? ` junto com as ${total} reserva(s) dele` : '') +
        '. Essa ação não pode ser desfeita.',
      rotulo: 'Remover ambiente',
      perigo: true
    });
    if (!ok) return;

    try {
      await api('DELETE', '/ambientes/' + id);
      await carregarEstado();
      renderAdmin();
      toast('Ambiente removido');
    } catch (erro) {
      tratarErro(erro);
    }
  }


  /* ========================================================================
     10. INICIALIZAÇÃO: liga os botões às funções
     ======================================================================== */

  // Login
  $('btnLogin').onclick = entrar;
  [$('mat'), $('pw')].forEach((campo) =>
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') entrar(); })
  );
  $('btnOut').onclick = sair;

  // Navegação principal
  $('navAg').onclick = () => irPara('ag');
  $('navAd').onclick = () => irPara('ad');

  // Calendário
  $('roomSel').onchange = () => { ambienteSelecionado = Number($('roomSel').value); renderCalendario(); };
  $('prev').onclick = () => { semanaAtual.setDate(semanaAtual.getDate() - 7); renderCalendario(); };
  $('next').onclick = () => { semanaAtual.setDate(semanaAtual.getDate() + 7); renderCalendario(); };
  $('todayBtn').onclick = () => { semanaAtual = segundaDe(new Date()); renderCalendario(); };

  // Modais de agendamento
  $('bkCancel').onclick = () => $('dlgBook').close();
  $('bkSave').onclick = salvarAgendamento;
  $('evClose').onclick = () => $('dlgEv').close();

  // Administração: menu lateral
  $('sbUsers').onclick = () => mostrarSecao('users');
  $('sbRooms').onclick = () => mostrarSecao('rooms');

  // Administração: usuários
  $('btnNewUser').onclick = abrirModalUsuario;
  $('uCancel').onclick = () => $('dlgUser').close();
  $('uAdd').onclick = cadastrarUsuario;
  ['uNome', 'uMat', 'uPw'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('uAdd').click(); })
  );
  $('pwCancel').onclick = () => $('dlgPw').close();
  $('pwSave').onclick = salvarSenha;
  $('pwNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwSave').click(); });

  // Administração: ambientes
  $('btnNewRoom').onclick = () => abrirModalAmbiente();
  $('aCancel').onclick = () => $('dlgRoom').close();
  $('aAdd').onclick = salvarAmbiente;
  $('aMan').onchange = atualizarCamposManutencao;
  ['aNome', 'aCap', 'aCal', 'aMotivo'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('aAdd').click(); })
  );

  // Enquanto a agenda está aberta, busca novidades no servidor (reservas de outras
  // pessoas, ambientes em manutenção) e redesenha, mantendo os horários passados em dia.
  setInterval(async () => {
    if (!usuarioLogado || document.hidden || $('vAg').classList.contains('hide')) return;

    try {
      await carregarEstado();
      preencherAmbientes();
      renderCalendario();
    } catch (erro) {
      if (erro.status === 401) tratarErro(erro);
    }
  }, INTERVALO_ATUALIZACAO);

  // Se esta aba já tinha um login ativo, volta direto para a aplicação
  retomarSessao();

})();
