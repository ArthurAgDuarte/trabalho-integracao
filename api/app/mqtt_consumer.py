import logging
from typing import Callable

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion

logger = logging.getLogger(__name__)


class ConsumidorMQTT:
    """Assina o tópico com QoS 1 e repassa cada mensagem para `ao_receber(topico, payload)`.

    Roda numa thread própria (loop_start). A thread do paho tenta a primeira conexão
    e as reconexões sozinha, com espera entre 1 e 30 s, então a API sobe mesmo com
    o broker fora do ar.
    """

    def __init__(
        self,
        host: str,
        porta: int,
        usuario: str,
        senha: str,
        topico: str,
        client_id: str,
        ao_receber: Callable[[str, bytes], None],
    ) -> None:
        self._host = host
        self._porta = porta
        self._topico = topico
        self._ao_receber = ao_receber
        self.conectado = False

        self._cliente = mqtt.Client(
            callback_api_version=CallbackAPIVersion.VERSION2,
            client_id=client_id,
            clean_session=False,
            protocol=mqtt.MQTTv311,
        )
        if usuario:
            self._cliente.username_pw_set(usuario, senha)
        self._cliente.reconnect_delay_set(min_delay=1, max_delay=30)
        self._cliente.on_connect = self._on_connect
        self._cliente.on_connect_fail = self._on_connect_fail
        self._cliente.on_disconnect = self._on_disconnect
        self._cliente.on_message = self._on_message

    def iniciar(self) -> None:
        logger.info("Conectando ao broker %s:%d", self._host, self._porta, extra={"acao": "mqtt_conectando"})
        self._cliente.connect_async(self._host, self._porta, keepalive=30)
        self._cliente.loop_start()

    def parar(self) -> None:
        self._cliente.disconnect()
        self._cliente.loop_stop()
        self.conectado = False

    def _on_connect(self, cliente, userdata, flags, reason_code, properties) -> None:
        if reason_code.is_failure:
            logger.error("Broker recusou a conexão: %s", reason_code, extra={"acao": "mqtt_recusado"})
            return
        self.conectado = True
        # Assina a cada (re)conexão: se o broker perdeu a sessão, a assinatura volta.
        cliente.subscribe(self._topico, qos=1)
        logger.info(
            "Conectado ao broker, assinando %s (sessão restaurada: %s)",
            self._topico,
            flags.session_present,
            extra={"acao": "mqtt_conectado", "topico": self._topico},
        )

    def _on_connect_fail(self, cliente, userdata) -> None:
        logger.warning("Broker inacessível, nova tentativa em breve", extra={"acao": "mqtt_reconectando"})

    def _on_disconnect(self, cliente, userdata, flags, reason_code, properties) -> None:
        self.conectado = False
        logger.warning("Desconectado do broker: %s", reason_code, extra={"acao": "mqtt_desconectado"})

    def _on_message(self, cliente, userdata, mensagem: mqtt.MQTTMessage) -> None:
        # Uma exceção aqui mataria a thread do paho: nunca deixar escapar.
        try:
            self._ao_receber(mensagem.topic, mensagem.payload)
        except Exception:
            logger.exception("Erro inesperado ao processar mensagem", extra={"acao": "erro_processamento", "topico": mensagem.topic})
