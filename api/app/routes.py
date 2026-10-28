from datetime import datetime, timezone
from typing import Annotated, Iterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import banco_ok
from .models import EventoAlerta, Leitura
from .schemas import EventoOut, LeituraOut

router = APIRouter()

Limite = Annotated[int, Query(ge=1, le=1000, description="Máximo de registros retornados")]


def obter_sessao(request: Request) -> Iterator[Session]:
    with request.app.state.fabrica_sessao() as sessao:
        yield sessao


SessaoDep = Annotated[Session, Depends(obter_sessao)]


def _utc(valor: datetime | None) -> datetime | None:
    if valor is not None and valor.tzinfo is None:
        return valor.replace(tzinfo=timezone.utc)
    return valor


@router.get("/health", summary="Status da API, do banco e da conexão MQTT")
def health(request: Request) -> JSONResponse:
    banco = "ok" if banco_ok(request.app.state.engine) else "erro"
    consumidor = request.app.state.consumidor
    mqtt = "conectado" if consumidor is not None and consumidor.conectado else "desconectado"
    corpo = {"api": "ok", "banco": banco, "mqtt": mqtt}
    saudavel = banco == "ok" and mqtt == "conectado"
    return JSONResponse(corpo, status_code=200 if saudavel else 503)


@router.get("/leituras", response_model=list[LeituraOut], summary="Histórico de leituras (mais recentes primeiro)")
def listar_leituras(
    sessao: SessaoDep,
    dispositivo: str | None = None,
    inicio: Annotated[datetime | None, Query(description="recebido_em >= inicio (ISO 8601; sem fuso = UTC)")] = None,
    fim: Annotated[datetime | None, Query(description="recebido_em <= fim (ISO 8601; sem fuso = UTC)")] = None,
    limite: Limite = 100,
):
    inicio, fim = _utc(inicio), _utc(fim)
    if inicio and fim and inicio > fim:
        raise HTTPException(status_code=422, detail="inicio deve ser anterior a fim")
    consulta = select(Leitura)
    if dispositivo:
        consulta = consulta.where(Leitura.dispositivo == dispositivo)
    if inicio:
        consulta = consulta.where(Leitura.recebido_em >= inicio)
    if fim:
        consulta = consulta.where(Leitura.recebido_em <= fim)
    consulta = consulta.order_by(Leitura.recebido_em.desc(), Leitura.id.desc()).limit(limite)
    return sessao.scalars(consulta).all()


@router.get("/leituras/ultimas", response_model=list[LeituraOut], summary="Última leitura de cada dispositivo")
def ultimas_leituras(sessao: SessaoDep):
    ultimos_ids = select(func.max(Leitura.id)).group_by(Leitura.dispositivo)
    consulta = select(Leitura).where(Leitura.id.in_(ultimos_ids)).order_by(Leitura.dispositivo)
    return sessao.scalars(consulta).all()


@router.get("/eventos", response_model=list[EventoOut], summary="Eventos de alerta (mais recentes primeiro)")
def listar_eventos(sessao: SessaoDep, dispositivo: str | None = None, limite: Limite = 100):
    consulta = select(EventoAlerta)
    if dispositivo:
        consulta = consulta.where(EventoAlerta.dispositivo == dispositivo)
    consulta = consulta.order_by(EventoAlerta.id.desc()).limit(limite)
    return sessao.scalars(consulta).all()
