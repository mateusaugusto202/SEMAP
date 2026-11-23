# SEMAP – Mapa de Salas Inteligente

Sistema de gestão e agendamento de ambientes de aprendizagem do SENAC Ipatinga.
Roda localmente na sua máquina: um pequeno servidor Node.js entrega a interface e guarda
os dados em um arquivo (`data/semap.json`).

## Como executar

**Requisito:** [Node.js](https://nodejs.org) 18 ou mais novo (versão LTS). Não precisa de `npm install`,
o projeto não usa bibliotecas externas.

| Sistema | Como iniciar |
|---------|--------------|
| Windows | Dê dois cliques em `iniciar.bat` (abre o navegador sozinho) |
| Linux / macOS | `bash iniciar.sh` |
| Qualquer um | `npm start` ou `node server.js` |

Depois, abra **http://localhost:3000** no navegador. Para encerrar, feche a janela ou pressione `Ctrl+C`.

Acessos de demonstração (criados na primeira execução):

| Perfil        | Matrícula | Senha   |
|---------------|-----------|---------|
| Administrador | `1000`    | `admin` |
| Professor     | `2024001` | `1234`  |

> Troque essas senhas em **Administração › Usuários** antes de usar de verdade.

### Opções

| Variável | Para que serve | Exemplo |
|----------|----------------|---------|
| `PORT` | Muda a porta (padrão 3000) | `PORT=8080 node server.js` |
| `HOST` | Por padrão, só esta máquina acessa (`127.0.0.1`). Use `0.0.0.0` para liberar o acesso a outros computadores da rede | `HOST=0.0.0.0 node server.js` |

No Windows (PowerShell), defina assim: `$env:PORT=8080; node server.js`.
Com `HOST=0.0.0.0`, os outros computadores acessam por `http://IP-DESTA-MAQUINA:3000`.

## Estrutura

```
semap/
├── server.js          Servidor local: API REST + arquivos da interface
├── package.json       Atalho `npm start`
├── iniciar.bat        Inicia no Windows
├── iniciar.sh         Inicia no Linux/macOS
├── data/              Criada na 1ª execução
│   └── semap.json     Todos os dados (usuários, ambientes, reservas)
└── public/            Interface (o que o navegador carrega)
    ├── index.html     Telas e modais
    ├── css/style.css  Estilos (tema claro/escuro)
    ├── js/app.js      Lógica da interface
    └── assets/logo.png
```

## Funcionalidades

### Agendamento
- Calendário semanal (segunda a sábado, 07h às 22h) por ambiente.
- Clique em um horário livre para agendar; clique em uma reserva para ver os detalhes.
  Só o administrador ou quem fez a reserva pode cancelá-la.
- **Dias e horários que já passaram ficam bloqueados.** A hora atual ainda pode ser reservada
  (a hora só conta como passada depois que termina).
- **Ambientes em manutenção ficam bloqueados** até serem liberados.
- Conflitos de horário no mesmo ambiente são impedidos.
- A agenda busca novidades no servidor a cada 30 segundos, então reservas feitas por outras
  pessoas aparecem sem recarregar a página.

### Administração (somente perfil administrador)
Menu lateral com duas seções:

- **Usuários:** listagem, cadastro, troca de senha e remoção.
- **Ambientes:** listagem, cadastro, **edição** e remoção.
  - Tipos: Sala, Laboratório, Oficina e Biblioteca.
  - Na edição, marque **Ambiente em manutenção** (com motivo opcional) para bloquear o uso.
    Para liberar, edite e desmarque.
  - Reservas futuras de um ambiente que entra em manutenção são mantidas; o formulário
    avisa quantas existem.

### Confirmação de ações
Antes de executar, o sistema pergunta se a pessoa tem certeza:

| Ação | Observação |
|------|------------|
| Remover usuário | Informa nome e matrícula |
| Remover ambiente | Informa quantas reservas serão apagadas junto |
| Cancelar reserva | Mostra título, data e horário |
| Colocar em manutenção / liberar ambiente | Informa as reservas futuras afetadas |
| Trocar senha | Só depois de validar a nova senha |
| Sair | |

O botão "Cancelar/Voltar" já vem com o foco, e `Esc` também cancela, para que um Enter
distraído não confirme nada.

## Regras de negócio e segurança

As regras (horário passado, manutenção, conflito, permissões) são aplicadas **no servidor**, então
valem mesmo que alguém tente burlar a interface.

- Senhas são guardadas com hash (scrypt), nunca em texto simples. Mínimo de 4 caracteres.
- O login gera um token de sessão válido por 12 horas (guardado só na aba do navegador).
  Reiniciar o servidor encerra as sessões; basta entrar de novo.
- Rotas de administração respondem 403 para quem não é administrador.
- O servidor só entrega arquivos da pasta `public/`; `server.js` e `data/` não ficam expostos.
- O horário usado nas regras é o do relógio do computador que roda o servidor.

## Dados

- Tudo fica em `data/semap.json`. **Para fazer backup, copie esse arquivo.**
- Para voltar aos dados de demonstração, pare o servidor e apague `data/semap.json`.
- A gravação é atômica (arquivo temporário + renomear), o que evita corromper o arquivo se a
  energia cair no meio.
- Os dados que estavam salvos no navegador na versão anterior (arquivo único) não são
  importados automaticamente.

Formato do arquivo:

| Coleção | Campos |
|---------|--------|
| `users` | `n` nome, `m` matrícula, `p` senha (hash), `r` perfil (`admin` ou `user`) |
| `rooms` | `id`, `n` nome, `cap` capacidade, `t` tipo, `cal` ID do Google Agenda, `man` em manutenção, `motivo` |
| `ev`    | `id`, `r` id do ambiente, `d` data (`AAAA-MM-DD`), `s` hora inicial, `e` hora final, `t` turma/atividade, `by` matrícula de quem reservou |

## API

Todas as rotas ficam em `/api` e, exceto o login, exigem o cabeçalho `Authorization: Bearer <token>`.

| Método e rota | O que faz | Quem |
|---------------|-----------|------|
| `POST /api/login` | Entra (`matricula`, `senha`) e devolve o token | Todos |
| `POST /api/logout` | Encerra a sessão | Logado |
| `GET /api/sessao` | Usuário da sessão atual | Logado |
| `GET /api/estado` | Ambientes, reservas e (para admin) usuários | Logado |
| `POST /api/reservas` | Cria reserva | Logado |
| `DELETE /api/reservas/:id` | Cancela reserva | Admin ou dono |
| `POST /api/usuarios` | Cadastra usuário | Admin |
| `DELETE /api/usuarios/:matricula` | Remove usuário | Admin |
| `PUT /api/usuarios/:matricula/senha` | Troca senha | Admin |
| `POST /api/ambientes` | Cadastra ambiente | Admin |
| `PUT /api/ambientes/:id` | Edita ambiente / manutenção | Admin |
| `DELETE /api/ambientes/:id` | Remove ambiente e suas reservas | Admin |

Erros voltam como `{ "erro": "mensagem" }` com o código HTTP adequado.

## Organização do código

- `server.js` e `public/js/app.js` são divididos em seções numeradas, com um sumário no topo,
  e cada função tem um comentário explicando o que faz.
- As regras de negócio ficam em `validarReserva()` e `validarAmbiente()` (servidor) e em
  `horarioPassou()` e `emManutencao()` (interface).
- As cores ficam em variáveis no início de `public/css/style.css`.

## Limitações

- O ID do Google Agenda é apenas informativo: ainda não há sincronização com o Google Agenda.
- Não há recuperação de senha: um administrador troca a senha de quem esquecer.
- Pensado para uso interno em rede local. Para expor na internet, coloque atrás de HTTPS
  (proxy reverso) e use um banco de dados em vez de arquivo.
