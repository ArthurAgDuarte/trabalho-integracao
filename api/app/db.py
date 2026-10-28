import logging
import time

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from .models import Base

logger = logging.getLogger(__name__)


def criar_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        # SQLite (testes e desenvolvimento local): conexão compartilhada entre threads.
        kwargs = {"connect_args": {"check_same_thread": False}}
        if url in ("sqlite://", "sqlite:///:memory:"):
            kwargs["poolclass"] = StaticPool
        return create_engine(url, **kwargs)
    return create_engine(url, pool_pre_ping=True)


def criar_fabrica_sessao(engine: Engine) -> sessionmaker:
    return sessionmaker(engine, expire_on_commit=False)


def aguardar_banco(engine: Engine, tentativas: int = 15, intervalo: float = 2.0) -> None:
    """Espera o banco aceitar conexões (o postgres pode estar subindo junto)."""
    for tentativa in range(1, tentativas + 1):
        try:
            with engine.connect() as conexao:
                conexao.execute(text("SELECT 1"))
            return
        except OperationalError as exc:
            if tentativa == tentativas:
                raise
            logger.warning(
                "Banco indisponível (tentativa %d/%d)",
                tentativa,
                tentativas,
                extra={"acao": "banco_aguardando", "erro": str(exc.orig)},
            )
            time.sleep(intervalo)


def criar_tabelas(engine: Engine) -> None:
    Base.metadata.create_all(engine)


def banco_ok(engine: Engine) -> bool:
    try:
        with engine.connect() as conexao:
            conexao.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
