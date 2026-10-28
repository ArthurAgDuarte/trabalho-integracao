"""Simula o ESP32 publicando leituras de gás no broker MQTT (teste sem hardware).

Exemplos:
    python tools/simulador.py normal
    python tools/simulador.py vazamento --comodo sala --quantidade 10
    python tools/simulador.py sequencia --host 192.168.1.10 --intervalo 2
    python tools/simulador.py invalido
    python tools/simulador.py sequencia --dry-run      # só imprime, não conecta

Usuário e senha vêm de --usuario/--senha ou de MQTT_USER/MQTT_PASSWORD (ambiente ou .env).
Requer apenas: pip install paho-mqtt
"""

import argparse
import json
import os
import random
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

PAYLOADS_INVALIDOS = [
    b'{"dispositivo": "esp32-sim", "leitura": 5000, "status": "VAZAMENTO"}',  # leitura > 4095
    b'{"dispositivo": "esp32-sim", "leitura": -3, "status": "NORMAL"}',  # leitura negativa
    b'{"dispositivo": "esp32-sim", "leitura": 742.5, "status": "NORMAL"}',  # leitura não inteira
    b'{"dispositivo": "esp32-sim", "leitura": "742", "status": "NORMAL"}',  # leitura como texto
    b'{"dispositivo": "esp32-sim", "leitura": 742, "status": "ALERTA"}',  # status desconhecido
    b'{"dispositivo": "", "leitura": 742, "status": "NORMAL"}',  # dispositivo vazio
    b'{"leitura": 742, "status": "NORMAL"}',  # dispositivo ausente
    b'{"dispositivo": "esp32-sim", "leitura": 742, "status": "NORMAL", "ts": "ontem"}',  # ts inválido
    b"isto nao e json",
    b"",
]


def carregar_env(caminho: Path) -> None:
    """Lê KEY=VALUE de um .env sem sobrescrever variáveis já definidas."""
    if not caminho.exists():
        return
    for linha in caminho.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        os.environ.setdefault(chave.strip(), valor.strip().strip('"').strip("'"))


def montar_payload(dispositivo: str, status: str, com_ts: bool) -> bytes:
    faixa = (150, 400) if status == "NORMAL" else (700, 1800)
    dados = {"dispositivo": dispositivo, "leitura": random.randint(*faixa), "status": status}
    if com_ts:
        dados["ts"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return json.dumps(dados).encode()


def gerar_mensagens(modo: str, dispositivo: str, quantidade: int, com_ts: bool):
    """Gera os payloads do modo escolhido (gerador: os timestamps saem na hora do envio)."""
    if modo == "invalido":
        yield from PAYLOADS_INVALIDOS
        return
    if modo == "sequencia":
        etapas = ["NORMAL"] * quantidade + ["VAZAMENTO"] * quantidade + ["NORMAL"] * quantidade
    else:
        etapas = [modo.upper()] * quantidade
    for status in etapas:
        yield montar_payload(dispositivo, status, com_ts)


class Publicador:
    def __init__(self, host: str, porta: int, usuario: str, senha: str) -> None:
        import paho.mqtt.client as mqtt
        from paho.mqtt.enums import CallbackAPIVersion

        self._cliente = mqtt.Client(callback_api_version=CallbackAPIVersion.VERSION2, client_id=f"simulador-{random.randint(0, 99999)}")
        if usuario:
            self._cliente.username_pw_set(usuario, senha)
        self._conectou = threading.Event()
        self._motivo = None

        def on_connect(cliente, userdata, flags, reason_code, properties):
            self._motivo = reason_code
            self._conectou.set()

        self._cliente.on_connect = on_connect
        self._cliente.connect(host, porta, keepalive=30)
        self._cliente.loop_start()
        if not self._conectou.wait(timeout=10):
            raise ConnectionError(f"Sem resposta do broker {host}:{porta}")
        if self._motivo.is_failure:
            raise ConnectionError(f"Broker recusou a conexão: {self._motivo} (confira usuário/senha)")

    def publicar(self, topico: str, payload: bytes) -> None:
        info = self._cliente.publish(topico, payload, qos=1)
        info.wait_for_publish(timeout=10)
        if not info.is_published():
            raise ConnectionError(f"Mensagem não confirmada pelo broker (rc={info.rc})")

    def fechar(self) -> None:
        self._cliente.disconnect()
        self._cliente.loop_stop()


def main(argv: list[str] | None = None) -> int:
    carregar_env(Path(__file__).resolve().parent.parent / ".env")

    parser = argparse.ArgumentParser(description="Simulador do ESP32 de detecção de gás")
    parser.add_argument("modo", choices=["normal", "vazamento", "sequencia", "invalido"])
    parser.add_argument("--host", default=os.environ.get("SIMULADOR_HOST", "localhost"))
    parser.add_argument("--porta", type=int, default=int(os.environ.get("MQTT_PORT", "1883")))
    parser.add_argument("--usuario", default=os.environ.get("MQTT_USER", ""))
    parser.add_argument("--senha", default=os.environ.get("MQTT_PASSWORD", ""))
    parser.add_argument("--comodo", default="cozinha")
    parser.add_argument("--dispositivo", help="padrão: esp32-<comodo>")
    parser.add_argument("--quantidade", type=int, default=5, help="mensagens por etapa (padrão 5)")
    parser.add_argument("--intervalo", type=float, default=1.0, help="segundos entre mensagens (padrão 1)")
    parser.add_argument("--sem-ts", action="store_true", help="omite o campo ts (ESP32 sem NTP)")
    parser.add_argument("--dry-run", action="store_true", help="só imprime as mensagens, sem conectar")
    args = parser.parse_args(argv)

    dispositivo = args.dispositivo or f"esp32-{args.comodo}"
    topico = f"casa/{args.comodo}/gas"

    publicador = None
    if not args.dry_run:
        try:
            publicador = Publicador(args.host, args.porta, args.usuario, args.senha)
        except (ConnectionError, OSError) as exc:
            print(f"ERRO: {exc}", file=sys.stderr)
            return 1
        print(f"Conectado a {args.host}:{args.porta}, publicando em {topico}")

    try:
        for i, payload in enumerate(gerar_mensagens(args.modo, dispositivo, args.quantidade, not args.sem_ts)):
            if i and args.intervalo > 0:
                time.sleep(args.intervalo)
            if publicador is not None:
                publicador.publicar(topico, payload)
            print(f"{topico} <- {payload.decode('utf-8', errors='replace') or '(vazio)'}")
    except ConnectionError as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1
    finally:
        if publicador is not None:
            publicador.fechar()
    return 0


if __name__ == "__main__":
    sys.exit(main())
