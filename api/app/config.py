from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuração lida de variáveis de ambiente (ou de um arquivo .env)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://gas:gas@postgres:5432/gas"

    mqtt_host: str = "mosquitto"
    mqtt_port: int = 1883
    mqtt_user: str = ""
    mqtt_password: str = ""
    mqtt_topico: str = "casa/+/gas"
    # client_id fixo + sessão persistente: o broker guarda as mensagens QoS 1
    # enquanto a API estiver fora do ar. Não rode duas APIs com o mesmo id.
    mqtt_client_id: str = "api-gas"

    alerta_cooldown_segundos: int = 300
    notificador: Literal["log", "telegram"] = "log"

    log_level: str = "INFO"
