import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import criar_app

from .conftest import RelogioFalso, payload


@pytest.fixture
def cliente():
    app = criar_app(Settings(database_url="sqlite://", notificador="log", _env_file=None), iniciar_mqtt=False)
    with TestClient(app) as cliente:
        processador = app.state.processador
        processador._relogio = RelogioFalso()
        yield cliente, processador


def publicar(processador, comodo, segundos, *args, **kwargs):
    processador._relogio.avancar(segundos)
    processador.processar_mensagem(f"casa/{comodo}/gas", payload(*args, **kwargs))


@pytest.fixture
def dados(cliente):
    c, p = cliente
    publicar(p, "cozinha", 0, "NORMAL", 200, dispositivo="esp32-cozinha", ts="2026-09-13T14:00:00Z")
    publicar(p, "cozinha", 10, "VAZAMENTO", 800, dispositivo="esp32-cozinha")
    publicar(p, "sala", 10, "NORMAL", 150, dispositivo="esp32-sala")
    publicar(p, "cozinha", 10, "NORMAL", 210, dispositivo="esp32-cozinha")
    p.encerrar()  # espera as notificações em segundo plano
    return c


def test_health_sem_mqtt_retorna_503(cliente):
    c, _ = cliente
    r = c.get("/health")
    assert r.status_code == 503
    assert r.json() == {"api": "ok", "banco": "ok", "mqtt": "desconectado"}


def test_leituras_mais_recentes_primeiro(dados):
    r = dados.get("/leituras")
    assert r.status_code == 200
    assert [l["leitura"] for l in r.json()] == [210, 150, 800, 200]
    assert r.json()[-1]["ts_dispositivo"].startswith("2026-09-13T14:00:00")
    assert r.json()[0]["ts_dispositivo"] is None


def test_leituras_filtros(dados):
    assert [l["leitura"] for l in dados.get("/leituras", params={"dispositivo": "esp32-sala"}).json()] == [150]
    assert len(dados.get("/leituras", params={"limite": 2}).json()) == 2
    janela = {"inicio": "2026-09-13T14:00:05Z", "fim": "2026-09-13T14:00:25Z"}
    assert [l["leitura"] for l in dados.get("/leituras", params=janela).json()] == [150, 800]


def test_leituras_parametros_invalidos(dados):
    assert dados.get("/leituras", params={"limite": 0}).status_code == 422
    assert dados.get("/leituras", params={"limite": 1001}).status_code == 422
    assert dados.get("/leituras", params={"inicio": "2026-09-14", "fim": "2026-09-13"}).status_code == 422


def test_ultimas_leituras_por_dispositivo(dados):
    r = dados.get("/leituras/ultimas").json()
    assert [(l["dispositivo"], l["leitura"], l["status"]) for l in r] == [("esp32-cozinha", 210, "NORMAL"), ("esp32-sala", 150, "NORMAL")]


def test_eventos(dados):
    r = dados.get("/eventos").json()
    assert [(e["tipo"], e["leitura"], e["notificado"]) for e in r] == [("NORMALIZADO", 210, True), ("INICIO_VAZAMENTO", 800, True)]
    assert dados.get("/eventos", params={"dispositivo": "esp32-sala"}).json() == []


def test_docs_disponivel(cliente):
    c, _ = cliente
    assert c.get("/docs").status_code == 200
