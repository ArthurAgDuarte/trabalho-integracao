import json
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.schemas import PayloadGas, extrair_comodo

BASE = {"dispositivo": "esp32-cozinha", "leitura": 742, "status": "VAZAMENTO"}


def validar(**campos):
    return PayloadGas.model_validate_json(json.dumps({**BASE, **campos}))


def test_payload_do_contrato():
    p = validar(ts="2026-09-13T14:22:07Z")
    assert p.dispositivo == "esp32-cozinha"
    assert p.leitura == 742
    assert p.status == "VAZAMENTO"
    assert p.ts == datetime(2026, 9, 13, 14, 22, 7, tzinfo=timezone.utc)


def test_ts_e_opcional():
    assert PayloadGas.model_validate_json(json.dumps(BASE)).ts is None
    assert validar(ts=None).ts is None


def test_ts_com_fuso_e_convertido_para_utc():
    assert validar(ts="2026-09-13T11:22:07-03:00").ts == datetime(2026, 9, 13, 14, 22, 7, tzinfo=timezone.utc)


def test_ts_sem_fuso_e_assumido_utc():
    assert validar(ts="2026-09-13T14:22:07").ts == datetime(2026, 9, 13, 14, 22, 7, tzinfo=timezone.utc)


@pytest.mark.parametrize("leitura", [0, 4095])
def test_limites_da_leitura(leitura):
    assert validar(leitura=leitura).leitura == leitura


@pytest.mark.parametrize("status", ["NORMAL", "VAZAMENTO"])
def test_status_validos(status):
    assert validar(status=status).status == status


def test_dispositivo_tem_espacos_removidos():
    assert validar(dispositivo="  esp32-sala ").dispositivo == "esp32-sala"


@pytest.mark.parametrize(
    "campos",
    [
        {"leitura": -1},
        {"leitura": 4096},
        {"leitura": 742.5},
        {"leitura": 742.0},
        {"leitura": "742"},
        {"leitura": True},
        {"leitura": None},
        {"status": "normal"},
        {"status": "ALERTA"},
        {"status": ""},
        {"dispositivo": ""},
        {"dispositivo": "   "},
        {"dispositivo": 123},
        {"dispositivo": "x" * 65},
        {"ts": "ontem"},
        {"ts": 1757773327},
        {"ts": ""},
        {"rssi": -60},
    ],
    ids=repr,
)
def test_campos_invalidos(campos):
    with pytest.raises(ValidationError):
        validar(**campos)


@pytest.mark.parametrize("ausente", ["dispositivo", "leitura", "status"])
def test_campo_obrigatorio_ausente(ausente):
    dados = {k: v for k, v in BASE.items() if k != ausente}
    with pytest.raises(ValidationError):
        PayloadGas.model_validate_json(json.dumps(dados))


@pytest.mark.parametrize("bruto", [b"", b"lixo", b"[1, 2]", b'"texto"', b"\xff\xfe", b'{"dispositivo": "a",'])
def test_bruto_nao_e_objeto_json(bruto):
    with pytest.raises(ValidationError):
        PayloadGas.model_validate_json(bruto)


@pytest.mark.parametrize(
    ("topico", "esperado"),
    [
        ("casa/cozinha/gas", "cozinha"),
        ("casa/area-servico/gas", "area-servico"),
        ("casa//gas", None),
        ("casa/cozinha/temperatura", None),
        ("casa/a/b/gas", None),
        ("outra/cozinha/gas", None),
        ("casa/" + "x" * 65 + "/gas", None),
    ],
)
def test_extrair_comodo(topico, esperado):
    assert extrair_comodo(topico) == esperado
