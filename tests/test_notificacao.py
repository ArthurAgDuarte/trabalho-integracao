import logging

import pytest
from sqlalchemy import select, text

from app.alerta import MaquinaAlerta, TipoEvento
from app.models import EventoAlerta, Leitura
from app.notificadores import LogNotificador, Notificador, TelegramNotificador, criar_notificador
from app.processador import Processador, restaurar_estados

from .conftest import payload

TOPICO = "casa/cozinha/gas"


class NotificadorQueFalha(Notificador):
    def __init__(self) -> None:
        self.chamadas = 0

    def notificar(self, evento) -> None:
        self.chamadas += 1
        raise ConnectionError("Telegram fora do ar")


class NotificadorRegistra(Notificador):
    def __init__(self) -> None:
        self.eventos = []

    def notificar(self, evento) -> None:
        self.eventos.append(evento)


def criar_processador(fabrica_sessao, notificador, relogio, cooldown=300):
    return Processador(fabrica_sessao, MaquinaAlerta(cooldown), notificador, relogio=relogio)


def leituras(fabrica_sessao):
    with fabrica_sessao() as s:
        return s.scalars(select(Leitura).order_by(Leitura.id)).all()


def eventos(fabrica_sessao):
    with fabrica_sessao() as s:
        return s.scalars(select(EventoAlerta).order_by(EventoAlerta.id)).all()


def test_falha_na_notificacao_nao_impede_gravacao(fabrica_sessao, relogio):
    notificador = NotificadorQueFalha()
    p = criar_processador(fabrica_sessao, notificador, relogio)

    p.processar_mensagem(TOPICO, payload("VAZAMENTO", 800))
    relogio.avancar(10)
    p.processar_mensagem(TOPICO, payload("NORMAL", 200))
    p.encerrar()

    assert [(l.status, l.leitura, l.comodo) for l in leituras(fabrica_sessao)] == [("VAZAMENTO", 800, "cozinha"), ("NORMAL", 200, "cozinha")]
    evs = eventos(fabrica_sessao)
    assert [e.tipo for e in evs] == ["INICIO_VAZAMENTO", "NORMALIZADO"]
    assert all(not e.notificado for e in evs)
    assert all(e.erro_notificacao == "ConnectionError: Telegram fora do ar" for e in evs)
    assert notificador.chamadas == 2


def test_falha_na_notificacao_e_logada(fabrica_sessao, relogio, caplog):
    p = criar_processador(fabrica_sessao, NotificadorQueFalha(), relogio)
    with caplog.at_level(logging.INFO):
        p.processar_mensagem(TOPICO, payload("VAZAMENTO", 800))
        p.encerrar()
    falhas = [r for r in caplog.records if getattr(r, "acao", None) == "notificacao_falhou"]
    assert len(falhas) == 1 and falhas[0].levelno == logging.ERROR
    assert {getattr(r, "acao", None) for r in caplog.records} >= {"recebido", "gravado", "alerta_disparado"}


def test_notificacao_com_sucesso_marca_notificado(fabrica_sessao, relogio):
    notificador = NotificadorRegistra()
    p = criar_processador(fabrica_sessao, notificador, relogio)
    p.processar_mensagem(TOPICO, payload("VAZAMENTO", 900))
    p.encerrar()

    [evento] = eventos(fabrica_sessao)
    assert evento.notificado is True and evento.erro_notificacao is None
    [enviado] = notificador.eventos
    assert (enviado.id, enviado.tipo, enviado.comodo, enviado.leitura) == (evento.id, TipoEvento.INICIO_VAZAMENTO, "cozinha", 900)


def test_lembrete_respeita_cooldown_no_fluxo_completo(fabrica_sessao, relogio):
    notificador = NotificadorRegistra()
    p = criar_processador(fabrica_sessao, notificador, relogio, cooldown=300)
    for _ in range(12):  # 12 leituras a cada 60 s = 11 minutos vazando
        p.processar_mensagem(TOPICO, payload("VAZAMENTO", 800))
        relogio.avancar(60)
    p.encerrar()
    assert len(leituras(fabrica_sessao)) == 12
    assert [e.tipo for e in notificador.eventos] == [TipoEvento.INICIO_VAZAMENTO, TipoEvento.LEMBRETE, TipoEvento.LEMBRETE]


def test_leitura_normal_nao_notifica(fabrica_sessao, relogio):
    notificador = NotificadorRegistra()
    p = criar_processador(fabrica_sessao, notificador, relogio)
    p.processar_mensagem(TOPICO, payload("NORMAL", 100))
    p.encerrar()
    assert len(leituras(fabrica_sessao)) == 1
    assert eventos(fabrica_sessao) == [] and notificador.eventos == []


def test_payload_invalido_nao_grava_e_loga_bruto(fabrica_sessao, relogio, caplog):
    p = criar_processador(fabrica_sessao, NotificadorRegistra(), relogio)
    with caplog.at_level(logging.WARNING):
        p.processar_mensagem(TOPICO, b'{"dispositivo": "esp32", "leitura": 9999, "status": "VAZAMENTO"}')
        p.processar_mensagem("casa/cozinha/temperatura", payload("VAZAMENTO"))
        p.processar_mensagem(TOPICO, b"\xff\xfe lixo")
    # O consumidor continua funcionando depois dos inválidos.
    p.processar_mensagem(TOPICO, payload("NORMAL"))
    p.encerrar()

    invalidos = [r for r in caplog.records if getattr(r, "acao", None) == "invalido"]
    assert len(invalidos) == 3 and all(r.levelno == logging.WARNING for r in invalidos)
    assert '"leitura": 9999' in invalidos[0].bruto
    assert len(leituras(fabrica_sessao)) == 1


def test_falha_no_banco_desfaz_estado_do_alerta(engine, fabrica_sessao, relogio):
    notificador = NotificadorRegistra()
    p = criar_processador(fabrica_sessao, notificador, relogio)
    with engine.begin() as c:
        c.execute(text("ALTER TABLE leituras RENAME TO leituras_off"))
    p.processar_mensagem(TOPICO, payload("VAZAMENTO", 800))  # não pode lançar exceção
    with engine.begin() as c:
        c.execute(text("ALTER TABLE leituras_off RENAME TO leituras"))

    # Banco voltou: a próxima leitura ainda deve gerar o INICIO_VAZAMENTO que não foi gravado.
    p.processar_mensagem(TOPICO, payload("VAZAMENTO", 810))
    p.encerrar()
    assert [e.tipo for e in eventos(fabrica_sessao)] == ["INICIO_VAZAMENTO"]
    assert len(notificador.eventos) == 1


def test_restaurar_estados_evita_alerta_duplicado_apos_restart(fabrica_sessao, relogio):
    p = criar_processador(fabrica_sessao, NotificadorRegistra(), relogio)
    p.processar_mensagem(TOPICO, payload("VAZAMENTO", 800))
    p.encerrar()

    # "Reinicia" a API: máquina nova, estado carregado do banco.
    maquina = MaquinaAlerta(300)
    assert restaurar_estados(fabrica_sessao, maquina) == 1
    notificador = NotificadorRegistra()
    p2 = Processador(fabrica_sessao, maquina, notificador, relogio=relogio)
    relogio.avancar(60)
    p2.processar_mensagem(TOPICO, payload("VAZAMENTO", 820))
    relogio.avancar(60)
    p2.processar_mensagem(TOPICO, payload("NORMAL", 200))
    p2.encerrar()
    assert [e.tipo for e in notificador.eventos] == [TipoEvento.NORMALIZADO]


def test_stub_telegram_registra_erro_sem_perder_leitura(fabrica_sessao, relogio):
    p = criar_processador(fabrica_sessao, TelegramNotificador(token="123:abc", chat_id="42"), relogio)
    p.processar_mensagem(TOPICO, payload("VAZAMENTO", 800))
    p.encerrar()
    assert len(leituras(fabrica_sessao)) == 1
    [evento] = eventos(fabrica_sessao)
    assert not evento.notificado
    assert evento.erro_notificacao.startswith("NotImplementedError")


def test_telegram_exige_token_e_chat_id(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    with pytest.raises(ValueError):
        TelegramNotificador()
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    n = TelegramNotificador()
    assert (n.token, n.chat_id) == ("123:abc", "42")


def test_fabrica_de_notificadores(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    assert isinstance(criar_notificador("log"), LogNotificador)
    assert isinstance(criar_notificador("telegram"), TelegramNotificador)
    with pytest.raises(ValueError):
        criar_notificador("email")
