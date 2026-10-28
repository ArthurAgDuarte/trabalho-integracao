import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .alerta import MaquinaAlerta
from .config import Settings
from .db import aguardar_banco, criar_engine, criar_fabrica_sessao, criar_tabelas
from .log import configurar_logging
from .mqtt_consumer import ConsumidorMQTT
from .notificadores import criar_notificador
from .processador import Processador, restaurar_estados
from .routes import router

logger = logging.getLogger(__name__)


def criar_app(settings: Settings | None = None, iniciar_mqtt: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        cfg = settings or Settings()
        configurar_logging(cfg.log_level)

        engine = criar_engine(cfg.database_url)
        aguardar_banco(engine)
        criar_tabelas(engine)
        fabrica_sessao = criar_fabrica_sessao(engine)

        maquina = MaquinaAlerta(cfg.alerta_cooldown_segundos)
        restaurados = restaurar_estados(fabrica_sessao, maquina)
        notificador = criar_notificador(cfg.notificador)
        processador = Processador(fabrica_sessao, maquina, notificador)
        logger.info(
            "API iniciada (notificador=%s, cooldown=%ss, estados restaurados=%d)",
            cfg.notificador,
            cfg.alerta_cooldown_segundos,
            restaurados,
            extra={"acao": "inicio"},
        )

        consumidor = None
        if iniciar_mqtt:
            consumidor = ConsumidorMQTT(
                host=cfg.mqtt_host,
                porta=cfg.mqtt_port,
                usuario=cfg.mqtt_user,
                senha=cfg.mqtt_password,
                topico=cfg.mqtt_topico,
                client_id=cfg.mqtt_client_id,
                ao_receber=processador.processar_mensagem,
            )
            consumidor.iniciar()

        app.state.engine = engine
        app.state.fabrica_sessao = fabrica_sessao
        app.state.processador = processador
        app.state.consumidor = consumidor
        try:
            yield
        finally:
            if consumidor is not None:
                consumidor.parar()
            processador.encerrar()
            engine.dispose()
            logger.info("API encerrada", extra={"acao": "fim"})

    app = FastAPI(
        title="Detecção de Vazamento de Gás",
        description="Consome leituras do ESP32 via MQTT, grava o histórico e dispara alertas.",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.include_router(router)
    return app


app = criar_app()
