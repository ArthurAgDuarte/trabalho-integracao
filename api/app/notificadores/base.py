from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime

from ..alerta import TipoEvento


@dataclass(frozen=True)
class EventoNotificacao:
    """Dados do evento entregues ao notificador (desacoplado do ORM)."""

    id: int
    dispositivo: str
    comodo: str
    tipo: TipoEvento
    leitura: int
    criado_em: datetime


class Notificador(ABC):
    @abstractmethod
    def notificar(self, evento: EventoNotificacao) -> None:
        """Envia a notificação. Deve lançar exceção se falhar: o erro é gravado em
        eventos_alerta.erro_notificacao e a leitura continua gravada normalmente."""


_TEXTOS = {
    TipoEvento.INICIO_VAZAMENTO: "🚨 VAZAMENTO DE GÁS detectado em {comodo}!",
    TipoEvento.LEMBRETE: "⚠️ O vazamento de gás em {comodo} continua.",
    TipoEvento.NORMALIZADO: "✅ Nível de gás normalizado em {comodo}.",
}


def formatar_mensagem(evento: EventoNotificacao) -> str:
    titulo = _TEXTOS[evento.tipo].format(comodo=evento.comodo)
    horario = evento.criado_em.strftime("%d/%m/%Y %H:%M:%S UTC")
    return f"{titulo}\nDispositivo: {evento.dispositivo}\nLeitura: {evento.leitura}\nHorário: {horario}"
