from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, StringConstraints, field_validator

Status = Literal["NORMAL", "VAZAMENTO"]

TAMANHO_MAX_NOME = 64


class PayloadGas(BaseModel):
    """Contrato da mensagem publicada pelo ESP32 em casa/<comodo>/gas."""

    model_config = ConfigDict(extra="forbid")

    dispositivo: Annotated[StrictStr, StringConstraints(strip_whitespace=True, min_length=1, max_length=TAMANHO_MAX_NOME)]
    leitura: Annotated[StrictInt, Field(ge=0, le=4095)]
    status: Status
    ts: datetime | None = None

    @field_validator("ts", mode="before")
    @classmethod
    def _ts_somente_texto(cls, valor):
        # Sem isso o Pydantic aceitaria números como timestamp Unix.
        if valor is not None and not isinstance(valor, str):
            raise ValueError("ts deve ser uma string ISO 8601")
        return valor

    @field_validator("ts")
    @classmethod
    def _ts_em_utc(cls, valor: datetime | None) -> datetime | None:
        if valor is None:
            return None
        if valor.tzinfo is None:
            valor = valor.replace(tzinfo=timezone.utc)
        return valor.astimezone(timezone.utc)


def extrair_comodo(topico: str) -> str | None:
    """Retorna o cômodo de 'casa/<comodo>/gas', ou None se o tópico não seguir o formato."""
    partes = topico.split("/")
    if len(partes) != 3 or partes[0] != "casa" or partes[2] != "gas":
        return None
    comodo = partes[1]
    if not comodo or len(comodo) > TAMANHO_MAX_NOME:
        return None
    return comodo


class LeituraOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dispositivo: str
    comodo: str
    leitura: int
    status: Status
    ts_dispositivo: datetime | None
    recebido_em: datetime


class EventoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dispositivo: str
    comodo: str
    tipo: Literal["INICIO_VAZAMENTO", "LEMBRETE", "NORMALIZADO"]
    leitura: int
    criado_em: datetime
    notificado: bool
    erro_notificacao: str | None
