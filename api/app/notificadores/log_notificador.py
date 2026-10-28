import logging

from .base import EventoNotificacao, Notificador, formatar_mensagem

logger = logging.getLogger(__name__)


class LogNotificador(Notificador):
    """Notificador padrão: apenas registra a mensagem no log."""

    def notificar(self, evento: EventoNotificacao) -> None:
        logger.info(
            formatar_mensagem(evento),
            extra={"acao": "notificacao_log", "dispositivo": evento.dispositivo, "tipo": evento.tipo, "evento_id": evento.id},
        )
