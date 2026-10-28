import json
from datetime import datetime, timedelta, timezone

import pytest

from app.db import criar_engine, criar_fabrica_sessao, criar_tabelas

INICIO = datetime(2026, 9, 13, 14, 0, tzinfo=timezone.utc)


class RelogioFalso:
    """Relógio controlado pelo teste: avancar(segundos) simula a passagem do tempo."""

    def __init__(self, inicio: datetime = INICIO) -> None:
        self.agora = inicio

    def __call__(self) -> datetime:
        return self.agora

    def avancar(self, segundos: float) -> datetime:
        self.agora += timedelta(seconds=segundos)
        return self.agora


def payload(status: str = "NORMAL", leitura: int = 200, dispositivo: str = "esp32-cozinha", **extra) -> bytes:
    return json.dumps({"dispositivo": dispositivo, "leitura": leitura, "status": status, **extra}).encode()


@pytest.fixture
def relogio() -> RelogioFalso:
    return RelogioFalso()


@pytest.fixture
def engine():
    engine = criar_engine("sqlite://")
    criar_tabelas(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def fabrica_sessao(engine):
    return criar_fabrica_sessao(engine)
