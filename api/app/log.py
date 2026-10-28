"""Logging estruturado: uma linha JSON por evento em stdout.

Uso: logger.info("mensagem", extra={"acao": "gravado", "dispositivo": "esp32-cozinha"})
"""

import json
import logging
import sys
from datetime import datetime, timezone

CAMPOS_EXTRAS = (
    "acao",
    "dispositivo",
    "comodo",
    "status",
    "leitura",
    "tipo",
    "evento_id",
    "topico",
    "bruto",
    "erro",
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        dados = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "nivel": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for campo in CAMPOS_EXTRAS:
            valor = getattr(record, campo, None)
            if valor is not None:
                dados[campo] = valor
        if record.exc_info:
            dados["exc"] = self.formatException(record.exc_info)
        return json.dumps(dados, ensure_ascii=False, default=str)


def configurar_logging(nivel: str = "INFO") -> None:
    # Consoles Windows usam cp1252 e não conseguem escrever emojis/acentos das mensagens.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    raiz = logging.getLogger()
    raiz.handlers[:] = [handler]
    raiz.setLevel(nivel.upper())
    # Faz os logs do uvicorn saírem no mesmo formato JSON.
    for nome in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(nome)
        logger.handlers[:] = []
        logger.propagate = True
