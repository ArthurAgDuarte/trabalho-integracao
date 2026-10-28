"""Fluxo de cada mensagem: valida -> grava leitura (+ evento) -> notifica em segundo plano."""

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Callable

from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from .alerta import MaquinaAlerta, TipoEvento
from .models import EventoAlerta, Leitura
from .notificadores import EventoNotificacao, Notificador
from .schemas import PayloadGas, extrair_comodo

logger = logging.getLogger(__name__)

TAMANHO_MAX_BRUTO = 1000
TAMANHO_MAX_ERRO = 1000


def agora_utc() -> datetime:
    return datetime.now(timezone.utc)


def _texto_bruto(bruto: bytes) -> str:
    return bruto[:TAMANHO_MAX_BRUTO].decode("utf-8", errors="replace")


class Processador:
    def __init__(
        self,
        fabrica_sessao: sessionmaker,
        maquina: MaquinaAlerta,
        notificador: Notificador,
        relogio: Callable[[], datetime] = agora_utc,
    ) -> None:
        self._fabrica_sessao = fabrica_sessao
        self._maquina = maquina
        self._notificador = notificador
        self._relogio = relogio
        # Uma única thread: notificações saem na ordem e uma chamada HTTP lenta
        # não trava a thread do MQTT (o que derrubaria a conexão por keepalive).
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="notificador")

    def processar_mensagem(self, topico: str, bruto: bytes) -> None:
        recebido_em = self._relogio()

        comodo = extrair_comodo(topico)
        if comodo is None:
            logger.warning(
                "Tópico fora do formato casa/<comodo>/gas",
                extra={"acao": "invalido", "topico": topico, "bruto": _texto_bruto(bruto)},
            )
            return

        try:
            payload = PayloadGas.model_validate_json(bruto)
        except ValidationError as exc:
            erros = [{"campo": ".".join(map(str, e["loc"])), "erro": e["msg"]} for e in exc.errors()]
            logger.warning(
                "Payload inválido descartado",
                extra={"acao": "invalido", "topico": topico, "comodo": comodo, "bruto": _texto_bruto(bruto), "erro": erros},
            )
            return

        contexto = {"dispositivo": payload.dispositivo, "comodo": comodo, "status": payload.status, "leitura": payload.leitura}
        logger.info("Leitura recebida", extra={"acao": "recebido", **contexto})

        estado_anterior = self._maquina.estado(payload.dispositivo)
        tipo = self._maquina.processar(payload.dispositivo, payload.status, recebido_em)

        try:
            with self._fabrica_sessao.begin() as sessao:
                sessao.add(
                    Leitura(
                        dispositivo=payload.dispositivo,
                        comodo=comodo,
                        leitura=payload.leitura,
                        status=payload.status,
                        ts_dispositivo=payload.ts,
                        recebido_em=recebido_em,
                    )
                )
                evento = None
                if tipo is not None:
                    evento = EventoAlerta(
                        dispositivo=payload.dispositivo,
                        comodo=comodo,
                        tipo=tipo.value,
                        leitura=payload.leitura,
                        criado_em=recebido_em,
                        notificado=False,
                    )
                    sessao.add(evento)
        except SQLAlchemyError as exc:
            # Leitura não gravada: desfaz a transição para o evento não se perder.
            self._maquina.definir_estado(payload.dispositivo, estado_anterior)
            logger.error("Falha ao gravar leitura", extra={"acao": "erro_gravacao", "erro": str(exc), **contexto})
            return

        logger.info("Leitura gravada", extra={"acao": "gravado", **contexto})

        if evento is not None:
            dados = EventoNotificacao(
                id=evento.id,
                dispositivo=evento.dispositivo,
                comodo=evento.comodo,
                tipo=tipo,
                leitura=evento.leitura,
                criado_em=evento.criado_em,
            )
            nivel = logging.INFO if tipo == TipoEvento.NORMALIZADO else logging.WARNING
            logger.log(nivel, "Alerta disparado: %s", tipo, extra={"acao": "alerta_disparado", "tipo": tipo, "evento_id": evento.id, **contexto})
            self._executor.submit(self._notificar, dados)

    def _notificar(self, evento: EventoNotificacao) -> None:
        erro = None
        try:
            self._notificador.notificar(evento)
        except Exception as exc:
            erro = f"{type(exc).__name__}: {exc}"[:TAMANHO_MAX_ERRO]
            logger.error(
                "Falha ao notificar",
                extra={"acao": "notificacao_falhou", "dispositivo": evento.dispositivo, "tipo": evento.tipo, "evento_id": evento.id, "erro": erro},
            )
        else:
            logger.info(
                "Notificação enviada",
                extra={"acao": "notificacao_enviada", "dispositivo": evento.dispositivo, "tipo": evento.tipo, "evento_id": evento.id},
            )

        try:
            with self._fabrica_sessao.begin() as sessao:
                sessao.execute(
                    update(EventoAlerta)
                    .where(EventoAlerta.id == evento.id)
                    .values(notificado=erro is None, erro_notificacao=erro)
                )
        except Exception as exc:
            logger.error("Falha ao registrar resultado da notificação", extra={"acao": "erro_gravacao", "evento_id": evento.id, "erro": str(exc)})

    def encerrar(self) -> None:
        """Espera as notificações pendentes terminarem."""
        self._executor.shutdown(wait=True)


def restaurar_estados(fabrica_sessao: sessionmaker, maquina: MaquinaAlerta) -> int:
    """Carrega o último evento de cada dispositivo para a máquina de alerta.

    Sem isso, reiniciar a API no meio de um vazamento dispararia um novo
    INICIO_VAZAMENTO e zeraria o cooldown dos lembretes.
    """
    ultimos_ids = select(func.max(EventoAlerta.id)).group_by(EventoAlerta.dispositivo)
    with fabrica_sessao() as sessao:
        eventos = sessao.scalars(select(EventoAlerta).where(EventoAlerta.id.in_(ultimos_ids))).all()
    for evento in eventos:
        maquina.restaurar(evento.dispositivo, TipoEvento(evento.tipo), evento.criado_em)
    return len(eventos)
