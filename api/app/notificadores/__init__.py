from .base import EventoNotificacao, Notificador, formatar_mensagem
from .log_notificador import LogNotificador
from .telegram_notificador import TelegramNotificador

__all__ = ["EventoNotificacao", "Notificador", "formatar_mensagem", "LogNotificador", "TelegramNotificador", "criar_notificador"]


def criar_notificador(nome: str) -> Notificador:
    """Escolhe a implementação pela variável NOTIFICADOR (log | telegram)."""
    if nome == "log":
        return LogNotificador()
    if nome == "telegram":
        return TelegramNotificador()
    raise ValueError(f"NOTIFICADOR desconhecido: {nome!r} (use 'log' ou 'telegram')")
