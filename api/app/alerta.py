"""Máquina de estados do alerta (anti-spam). Pura: sem MQTT, sem banco, sem relógio próprio.

Regras por dispositivo:
- NORMAL -> VAZAMENTO: INICIO_VAZAMENTO
- VAZAMENTO contínuo: LEMBRETE só depois de `cooldown` desde a última notificação
- VAZAMENTO -> NORMAL: NORMALIZADO
Dispositivo nunca visto começa como NORMAL.

Não é thread-safe: o paho entrega as mensagens numa única thread.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import StrEnum


class TipoEvento(StrEnum):
    INICIO_VAZAMENTO = "INICIO_VAZAMENTO"
    LEMBRETE = "LEMBRETE"
    NORMALIZADO = "NORMALIZADO"


@dataclass(frozen=True)
class EstadoDispositivo:
    status: str
    ultima_notificacao: datetime | None = None


class MaquinaAlerta:
    def __init__(self, cooldown_segundos: float) -> None:
        self._cooldown = timedelta(seconds=cooldown_segundos)
        self._estados: dict[str, EstadoDispositivo] = {}

    def processar(self, dispositivo: str, status: str, agora: datetime) -> TipoEvento | None:
        """Atualiza o estado do dispositivo e diz qual evento disparar (ou None)."""
        anterior = self._estados.get(dispositivo)
        vazando_antes = anterior is not None and anterior.status == "VAZAMENTO"

        if status == "VAZAMENTO":
            if not vazando_antes:
                self._estados[dispositivo] = EstadoDispositivo("VAZAMENTO", agora)
                return TipoEvento.INICIO_VAZAMENTO
            if anterior.ultima_notificacao is None or agora - anterior.ultima_notificacao >= self._cooldown:
                self._estados[dispositivo] = EstadoDispositivo("VAZAMENTO", agora)
                return TipoEvento.LEMBRETE
            return None

        self._estados[dispositivo] = EstadoDispositivo("NORMAL")
        return TipoEvento.NORMALIZADO if vazando_antes else None

    def estado(self, dispositivo: str) -> EstadoDispositivo | None:
        return self._estados.get(dispositivo)

    def definir_estado(self, dispositivo: str, estado: EstadoDispositivo | None) -> None:
        """Restaura um estado salvo com estado(), ex.: para desfazer se a gravação falhar."""
        if estado is None:
            self._estados.pop(dispositivo, None)
        else:
            self._estados[dispositivo] = estado

    def restaurar(self, dispositivo: str, ultimo_tipo: TipoEvento, criado_em: datetime) -> None:
        """Reconstrói o estado a partir do último evento gravado (usado no startup)."""
        if criado_em.tzinfo is None:
            criado_em = criado_em.replace(tzinfo=timezone.utc)
        if ultimo_tipo == TipoEvento.NORMALIZADO:
            self._estados[dispositivo] = EstadoDispositivo("NORMAL")
        else:
            self._estados[dispositivo] = EstadoDispositivo("VAZAMENTO", criado_em)
