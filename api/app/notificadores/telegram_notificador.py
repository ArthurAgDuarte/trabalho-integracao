import os

from .base import EventoNotificacao, Notificador, formatar_mensagem


class TelegramNotificador(Notificador):
    """Envia o alerta para um chat do Telegram. Ativado com NOTIFICADOR=telegram.

    STUB: o envio ainda não foi implementado (ver TODO em notificar).
    """

    URL_API = "https://api.telegram.org/bot{token}/sendMessage"

    def __init__(self, token: str | None = None, chat_id: str | None = None, timeout: float = 10.0) -> None:
        self.token = token or os.environ.get("TELEGRAM_BOT_TOKEN", "")
        self.chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID", "")
        self.timeout = timeout
        if not self.token or not self.chat_id:
            raise ValueError("NOTIFICADOR=telegram exige TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID")

    def notificar(self, evento: EventoNotificacao) -> None:
        texto = formatar_mensagem(evento)

        # TODO(colega das notificações): implementar o envio e remover o raise abaixo.
        # Sugestão (httpx já está no requirements.txt):
        #
        #   import httpx
        #   try:
        #       resposta = httpx.post(
        #           self.URL_API.format(token=self.token),
        #           json={"chat_id": self.chat_id, "text": texto},
        #           timeout=self.timeout,  # obrigatório: sem timeout uma rede travada segura a fila de notificações
        #       )
        #       resposta.raise_for_status()
        #   except httpx.HTTPError as exc:
        #       # A mensagem de erro do httpx contém a URL, que contém o TOKEN. Não propague o texto original,
        #       # senão ele vai parar no log e em eventos_alerta.erro_notificacao.
        #       raise RuntimeError(f"Falha ao enviar ao Telegram: {type(exc).__name__}") from None
        #   if not resposta.json().get("ok"):
        #       raise RuntimeError(f"Telegram recusou: {resposta.json().get('description')}")
        #
        # Regras do contrato: lance exceção em caso de falha (não retorne False) e não capture
        # a exceção aqui só para logar; o Processador já faz isso e grava o erro no banco.
        raise NotImplementedError(f"TelegramNotificador ainda não implementado (mensagem: {texto!r})")
