from datetime import datetime, timedelta, timezone

from app.alerta import EstadoDispositivo, MaquinaAlerta, TipoEvento

COOLDOWN = 300
T0 = datetime(2026, 9, 13, 14, 0, tzinfo=timezone.utc)


def em(segundos: float) -> datetime:
    return T0 + timedelta(seconds=segundos)


def test_normal_sem_historico_nao_gera_evento():
    m = MaquinaAlerta(COOLDOWN)
    assert m.processar("d1", "NORMAL", em(0)) is None
    assert m.processar("d1", "NORMAL", em(10)) is None


def test_primeira_leitura_ja_em_vazamento_inicia_alerta():
    assert MaquinaAlerta(COOLDOWN).processar("d1", "VAZAMENTO", em(0)) == TipoEvento.INICIO_VAZAMENTO


def test_transicao_normal_para_vazamento():
    m = MaquinaAlerta(COOLDOWN)
    m.processar("d1", "NORMAL", em(0))
    assert m.processar("d1", "VAZAMENTO", em(5)) == TipoEvento.INICIO_VAZAMENTO


def test_vazamento_continuo_respeita_cooldown():
    m = MaquinaAlerta(COOLDOWN)
    assert m.processar("d1", "VAZAMENTO", em(0)) == TipoEvento.INICIO_VAZAMENTO
    for s in range(1, COOLDOWN):
        assert m.processar("d1", "VAZAMENTO", em(s)) is None, f"lembrete antecipado em t={s}s"
    assert m.processar("d1", "VAZAMENTO", em(COOLDOWN)) == TipoEvento.LEMBRETE


def test_cooldown_conta_a_partir_do_ultimo_lembrete():
    m = MaquinaAlerta(COOLDOWN)
    m.processar("d1", "VAZAMENTO", em(0))
    assert m.processar("d1", "VAZAMENTO", em(310)) == TipoEvento.LEMBRETE
    assert m.processar("d1", "VAZAMENTO", em(600)) is None  # 290 s após o lembrete
    assert m.processar("d1", "VAZAMENTO", em(610)) == TipoEvento.LEMBRETE


def test_lembrete_com_leituras_esparsas():
    # O ESP32 pode ficar minutos sem publicar: um único lembrete, não um por período perdido.
    m = MaquinaAlerta(COOLDOWN)
    m.processar("d1", "VAZAMENTO", em(0))
    assert m.processar("d1", "VAZAMENTO", em(3600)) == TipoEvento.LEMBRETE
    assert m.processar("d1", "VAZAMENTO", em(3601)) is None


def test_vazamento_para_normal_normaliza():
    m = MaquinaAlerta(COOLDOWN)
    m.processar("d1", "VAZAMENTO", em(0))
    assert m.processar("d1", "NORMAL", em(30)) == TipoEvento.NORMALIZADO
    assert m.processar("d1", "NORMAL", em(31)) is None


def test_novo_vazamento_apos_normalizar_e_novo_inicio():
    m = MaquinaAlerta(COOLDOWN)
    m.processar("d1", "VAZAMENTO", em(0))
    m.processar("d1", "NORMAL", em(10))
    assert m.processar("d1", "VAZAMENTO", em(20)) == TipoEvento.INICIO_VAZAMENTO


def test_dispositivos_sao_independentes():
    m = MaquinaAlerta(COOLDOWN)
    assert m.processar("cozinha", "VAZAMENTO", em(0)) == TipoEvento.INICIO_VAZAMENTO
    assert m.processar("sala", "NORMAL", em(1)) is None
    assert m.processar("sala", "VAZAMENTO", em(2)) == TipoEvento.INICIO_VAZAMENTO
    assert m.processar("cozinha", "NORMAL", em(3)) == TipoEvento.NORMALIZADO
    assert m.estado("sala").status == "VAZAMENTO"


def test_sequencia_completa():
    m = MaquinaAlerta(COOLDOWN)
    sequencia = [
        (0, "NORMAL", None),
        (10, "VAZAMENTO", TipoEvento.INICIO_VAZAMENTO),
        (70, "VAZAMENTO", None),
        (310, "VAZAMENTO", TipoEvento.LEMBRETE),
        (400, "VAZAMENTO", None),
        (610, "VAZAMENTO", TipoEvento.LEMBRETE),
        (620, "NORMAL", TipoEvento.NORMALIZADO),
        (700, "NORMAL", None),
    ]
    assert [m.processar("d1", st, em(s)) for s, st, _ in sequencia] == [esperado for *_, esperado in sequencia]


def test_definir_estado_desfaz_transicao():
    m = MaquinaAlerta(COOLDOWN)
    anterior = m.estado("d1")
    assert m.processar("d1", "VAZAMENTO", em(0)) == TipoEvento.INICIO_VAZAMENTO
    m.definir_estado("d1", anterior)
    assert m.estado("d1") is None
    assert m.processar("d1", "VAZAMENTO", em(1)) == TipoEvento.INICIO_VAZAMENTO


def test_restaurar_vazamento_em_andamento_mantem_cooldown():
    m = MaquinaAlerta(COOLDOWN)
    m.restaurar("d1", TipoEvento.LEMBRETE, em(0))
    assert m.processar("d1", "VAZAMENTO", em(100)) is None  # não repete INICIO após restart
    assert m.processar("d1", "VAZAMENTO", em(300)) == TipoEvento.LEMBRETE


def test_restaurar_normalizado():
    m = MaquinaAlerta(COOLDOWN)
    m.restaurar("d1", TipoEvento.NORMALIZADO, em(0))
    assert m.estado("d1") == EstadoDispositivo("NORMAL")
    assert m.processar("d1", "VAZAMENTO", em(1)) == TipoEvento.INICIO_VAZAMENTO


def test_restaurar_aceita_data_sem_fuso():
    # SQLite devolve datetimes sem fuso.
    m = MaquinaAlerta(COOLDOWN)
    m.restaurar("d1", TipoEvento.INICIO_VAZAMENTO, datetime(2026, 9, 13, 14, 0))
    assert m.processar("d1", "VAZAMENTO", em(COOLDOWN)) == TipoEvento.LEMBRETE
