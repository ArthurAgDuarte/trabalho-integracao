from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Leitura(Base):
    __tablename__ = "leituras"
    __table_args__ = (
        Index("ix_leituras_dispositivo_recebido_em", "dispositivo", "recebido_em"),
        CheckConstraint("leitura BETWEEN 0 AND 4095", name="ck_leituras_leitura"),
        CheckConstraint("status IN ('NORMAL', 'VAZAMENTO')", name="ck_leituras_status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dispositivo: Mapped[str] = mapped_column(String(64))
    comodo: Mapped[str] = mapped_column(String(64))
    leitura: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(10))
    ts_dispositivo: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    recebido_em: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class EventoAlerta(Base):
    __tablename__ = "eventos_alerta"
    __table_args__ = (
        Index("ix_eventos_alerta_dispositivo_criado_em", "dispositivo", "criado_em"),
        CheckConstraint("tipo IN ('INICIO_VAZAMENTO', 'LEMBRETE', 'NORMALIZADO')", name="ck_eventos_alerta_tipo"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dispositivo: Mapped[str] = mapped_column(String(64))
    comodo: Mapped[str] = mapped_column(String(64))
    tipo: Mapped[str] = mapped_column(String(20))
    leitura: Mapped[int] = mapped_column(Integer)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    notificado: Mapped[bool] = mapped_column(Boolean, default=False)
    erro_notificacao: Mapped[str | None] = mapped_column(Text, nullable=True)
