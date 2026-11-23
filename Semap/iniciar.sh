#!/usr/bin/env bash
# ---------------------------------------------------------------
#  SEMAP - inicia o servidor local (Linux/macOS)
#  Uso:  bash iniciar.sh      (para encerrar: Ctrl+C)
# ---------------------------------------------------------------
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale a versão LTS em https://nodejs.org e tente de novo."
  exit 1
fi

exec node server.js
