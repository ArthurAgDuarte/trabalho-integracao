# Sistema de Detecção e Alerta de Vazamento de Gás: Backend

Projeto da disciplina **Técnicas de Integração de Sistemas**.

```
ESP32 + MQ-2/MQ-5 ──MQTT──► Mosquitto ──► API (FastAPI) ──► PostgreSQL
 (alarme local)          casa/<comodo>/gas      │
                                                └──► Notificador (log | Telegram)
```

O ESP32 lê o sensor, decide o status (o limiar fica no firmware), aciona o alarme local e publica um JSON via MQTT. Esta parte do projeto recebe essa mensagem, valida, grava o histórico, aplica a lógica de alerta anti-spam e dispara a notificação.

> 📘 **Manual de funcionamento** (ESP32 + servidor + Telegram, passo a passo e solução de problemas): [MANUAL.md](MANUAL.md)

> **Status:** backend, testes e simulador prontos. A parte do **Docker Compose** (Mosquitto, Postgres, Dockerfile da API e `tools/teste_integrado.py`) ainda **não foi implementada**. As seções marcadas com 🚧 vão ser completadas nessa etapa.

## Estrutura

```
api/app/
  main.py              FastAPI + lifespan (cria tabelas, restaura estados, inicia o MQTT)
  config.py            variáveis de ambiente
  mqtt_consumer.py     cliente paho-mqtt (QoS 1, reconexão automática)
  processador.py       valida → grava → alerta → notifica
  alerta.py            máquina de estados do alerta (pura, sem I/O)
  schemas.py           contrato do payload (Pydantic) e modelos de resposta
  models.py, db.py     tabelas (SQLAlchemy 2.0)
  routes.py            endpoints REST
  log.py               logs JSON em stdout
  notificadores/       Notificador (interface), LogNotificador, TelegramNotificador (stub)
tests/                 pytest (payload, alerta, notificação, API)
tools/simulador.py     simula o ESP32 sem hardware
```

---

## Como subir o ambiente

### 🚧 Com Docker Compose

Pendente.

### Localmente, sem Docker

Requer Python 3.12+ e um broker Mosquitto acessível. No Windows há instalador em <https://mosquitto.org/download/>. Sem broker a API sobe do mesmo jeito, mas o `/health` fica em `mqtt: desconectado`.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate      Linux: source .venv/bin/activate
pip install -r requirements-dev.txt

cp .env.example .env     # Windows: copy .env.example .env
# No .env, para rodar local:  MQTT_HOST=localhost   DATABASE_URL=sqlite:///./gas.db

uvicorn app.main:app --app-dir api --host 0.0.0.0 --port 8000
```

Rode o comando **a partir da raiz do projeto**: o `.env` é lido do diretório atual. Documentação interativa em <http://localhost:8000/docs>.

---

## Descobrir o IP do host e liberar a porta 1883

O ESP32 conecta no **IP da máquina que roda o broker**, na rede Wi-Fi local (192.168.1.X).

**Descobrir o IP**

| Sistema | Comando | Onde olhar |
|---|---|---|
| Windows | `ipconfig` | "Endereço IPv4" do adaptador Wi-Fi |
| Linux | `hostname -I` ou `ip -4 addr show` | endereço 192.168.1.X da interface Wi-Fi (ex.: `wlan0`) |

Prefira fixar esse IP (reserva DHCP no roteador). Se ele mudar, o firmware para de achar o broker.

**Liberar a porta no firewall**

Windows (PowerShell **como administrador**):
```powershell
New-NetFirewallRule -DisplayName "MQTT 1883" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "API Gas 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```
A rede Wi-Fi precisa estar como **Rede privada** (Configurações → Rede e Internet → Wi-Fi → propriedades). Para remover depois: `Remove-NetFirewallRule -DisplayName "MQTT 1883"`.

Linux:
```bash
sudo ufw allow 1883/tcp && sudo ufw allow 8000/tcp                 # Ubuntu/Debian (ufw)
sudo firewall-cmd --permanent --add-port=1883/tcp --add-port=8000/tcp && sudo firewall-cmd --reload   # Fedora (firewalld)
```

**Testar de outra máquina da rede:** `python tools/simulador.py normal --host 192.168.1.X`.

---

## Contrato MQTT (para o firmware)

| Item | Valor |
|---|---|
| Broker | `<IP do host>:1883` (TCP, sem TLS) |
| Autenticação | usuário/senha obrigatórios (`MQTT_USER` / `MQTT_PASSWORD` do `.env`). Conexão anônima é recusada. |
| Tópico | `casa/<comodo>/gas` (ex.: `casa/cozinha/gas`, `casa/area-servico/gas`) |
| QoS | 1 recomendado. QoS 0 também funciona (a `PubSubClient` do Arduino só publica em QoS 0). |
| Retain | `false` |
| Client ID | único por placa (ex.: `esp32-cozinha`). Não use `api-gas`, que é o da API. |
| Codificação | JSON UTF-8, um objeto por mensagem |

O **cômodo vem do tópico**, não do payload. Ele não pode conter `/`, `+` ou `#` e tem no máximo 64 caracteres.

### Payload

```json
{ "dispositivo": "esp32-cozinha", "leitura": 742, "status": "VAZAMENTO", "ts": "2026-09-13T14:22:07Z" }
```

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `dispositivo` | string | sim | não vazio, até 64 caracteres. Identifica a placa e deve ser único. |
| `leitura` | inteiro | sim | 0 a 4095 (ADC de 12 bits). Precisa ser número inteiro: `742.0` e `"742"` são rejeitados. |
| `status` | string | sim | exatamente `"NORMAL"` ou `"VAZAMENTO"` (maiúsculas) |
| `ts` | string | não | ISO 8601. Use UTC com `Z`. Sem fuso, é tratado como UTC. Omita se o ESP32 não tiver NTP. |

- **Campos extras são rejeitados.** Se precisar mandar algo novo (ex.: `rssi`), combine antes para eu incluir no contrato.
- O servidor sempre grava também `recebido_em` (horário do servidor, UTC). Ele é a referência para o histórico e para o cooldown.
- Mensagem inválida é **descartada** e logada como WARNING com o conteúdo bruto. Não derruba nada, mas também não é gravada.
- Sugestão: publicar a cada 1 a 5 s e **imediatamente** quando o status mudar.

### Lógica de alerta (o que acontece com cada status)

Mantida por `dispositivo`:

| Transição | Evento | Notifica? |
|---|---|---|
| NORMAL → VAZAMENTO (ou a primeira leitura já em VAZAMENTO) | `INICIO_VAZAMENTO` | sim |
| VAZAMENTO → VAZAMENTO | `LEMBRETE` | só a cada `ALERTA_COOLDOWN_SEGUNDOS` (padrão 300) desde a última notificação |
| VAZAMENTO → NORMAL | `NORMALIZADO` | sim |
| NORMAL → NORMAL | nenhum | não |

O estado é reconstruído do banco quando a API reinicia. Assim, um restart no meio de um vazamento não gera um `INICIO_VAZAMENTO` duplicado.

---

## Plugar o TelegramNotificador (para as notificações)

Arquivo: [api/app/notificadores/telegram_notificador.py](api/app/notificadores/telegram_notificador.py). O `TODO` no método `notificar` já traz um exemplo de implementação.

**O que já está pronto**
- `__init__` lê `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` do ambiente e falha ao iniciar a API se algum faltar.
- O texto da mensagem já vem formatado por `formatar_mensagem(evento)` em [base.py](api/app/notificadores/base.py).
- A seleção é feita por `NOTIFICADOR=telegram` no `.env`. Nada mais precisa mudar no restante do código.
- O `httpx` já está no `requirements.txt`.

**O que falta:** fazer o `POST https://api.telegram.org/bot<TOKEN>/sendMessage` com `{"chat_id": ..., "text": ...}` e remover o `raise NotImplementedError`.

**Regras do contrato `Notificador.notificar(evento)`**
1. **Em caso de falha, lance uma exceção.** Não retorne `False` e não engula o erro. O processador captura a exceção, grava `eventos_alerta.notificado = false` com a mensagem em `erro_notificacao` e loga `notificacao_falhou`. A leitura já foi gravada antes; uma falha aqui nunca a perde.
2. **Use timeout** (ex.: 10 s). As notificações rodam numa fila de uma thread só, e uma chamada travada atrasa as próximas.
3. **Não vaze o token.** A mensagem de erro do `httpx` inclui a URL, e a URL contém o token. Relance com uma mensagem própria, como mostra o exemplo do TODO.
4. Não é preciso tratar retentativa nem cooldown: isso já é responsabilidade da API.

`evento` é um `EventoNotificacao` com `id`, `dispositivo`, `comodo`, `tipo` (`INICIO_VAZAMENTO` | `LEMBRETE` | `NORMALIZADO`), `leitura` e `criado_em`.

**Como testar**
```bash
# .env: NOTIFICADOR=telegram, TELEGRAM_BOT_TOKEN=..., TELEGRAM_CHAT_ID=...
python tools/simulador.py sequencia --intervalo 1
curl http://localhost:8000/eventos      # "notificado": true e "erro_notificacao": null
```
Para teste unitário sem rede, use `httpx.MockTransport` ou faça `monkeypatch` de `httpx.post`. Veja os testes existentes em [tests/test_notificacao.py](tests/test_notificacao.py).

---

## API REST

| Método e rota | Descrição |
|---|---|
| `GET /health` | `{"api","banco","mqtt"}`. HTTP 200 se tudo ok, 503 se o banco ou o MQTT estiverem fora. |
| `GET /leituras?dispositivo=&inicio=&fim=&limite=` | histórico, mais recentes primeiro. `inicio`/`fim` filtram `recebido_em` (ISO 8601). `limite` padrão 100, máximo 1000. |
| `GET /leituras/ultimas` | última leitura de cada dispositivo |
| `GET /eventos?dispositivo=&limite=` | eventos de alerta, mais recentes primeiro |
| `GET /docs` | documentação automática (Swagger) |

```bash
curl "http://localhost:8000/leituras?dispositivo=esp32-cozinha&inicio=2026-09-13T00:00:00Z&limite=20"
```

---

## Testes e simulador

### Testes unitários

```bash
pytest            # na raiz do projeto, com o ambiente virtual ativo
pytest -v tests/test_alerta.py
```

| Arquivo | O que cobre |
|---|---|
| `test_payload.py` | payloads válidos, os limites de `leitura` e cada tipo de payload inválido, além da extração do cômodo do tópico |
| `test_alerta.py` | a máquina de estados e o cooldown, com o tempo simulado (sem `sleep`), além da restauração após restart |
| `test_notificacao.py` | o isolamento de falhas: um notificador que lança exceção não impede a gravação e o erro vai para `eventos_alerta`; banco fora do ar não derruba o consumidor |
| `test_api.py` | os endpoints, com SQLite em memória |

Nenhum teste precisa de broker, Postgres ou Docker.

### Simulador do ESP32

```bash
python tools/simulador.py normal                     # 5 leituras NORMAL
python tools/simulador.py vazamento --quantidade 10  # 10 leituras VAZAMENTO
python tools/simulador.py sequencia                  # 5 NORMAL → 5 VAZAMENTO → 5 NORMAL
python tools/simulador.py invalido                   # 10 payloads inválidos (devem aparecer como WARNING)
```

| Opção | Efeito |
|---|---|
| `--host 192.168.1.X` | broker em outra máquina |
| `--comodo sala` | publica em `casa/sala/gas` |
| `--dispositivo esp32-teste` | nome do dispositivo |
| `--intervalo 0.5` | segundos entre mensagens |
| `--sem-ts` | simula ESP32 sem NTP |
| `--dry-run` | só imprime, sem conectar |

O usuário e a senha vêm do `.env`.

### 🚧 Teste integrado (`tools/teste_integrado.py`)

Pendente. Vai subir o compose, rodar o simulador e conferir na API que as leituras e os eventos foram gravados.

---

## Logs

Os logs saem em JSON, uma linha por evento, em stdout:

```json
{"ts": "2026-09-13T14:22:07.120+00:00", "nivel": "WARNING", "logger": "app.processador", "msg": "Alerta disparado: INICIO_VAZAMENTO", "acao": "alerta_disparado", "dispositivo": "esp32-cozinha", "comodo": "cozinha", "status": "VAZAMENTO", "leitura": 742, "tipo": "INICIO_VAZAMENTO", "evento_id": 1}
```

| `acao` | Quando |
|---|---|
| `recebido` | mensagem válida chegou |
| `gravado` | leitura salva no banco |
| `invalido` | payload ou tópico rejeitado (WARNING, com `bruto` e `erro`) |
| `alerta_disparado` | evento criado (WARNING para início/lembrete, INFO para normalizado) |
| `notificacao_enviada` / `notificacao_falhou` | resultado do notificador |
| `erro_gravacao` | falha no banco (a leitura se perde, o consumidor continua) |
| `mqtt_conectado` / `mqtt_desconectado` / `mqtt_reconectando` / `mqtt_recusado` | estado da conexão com o broker |

---

## Decisões e limitações conhecidas

- **Sessão MQTT persistente** (`client_id` fixo, `clean_session=false`, QoS 1): se a API cair, o broker guarda as mensagens e entrega tudo quando ela voltar. Em contrapartida, o QoS 1 entrega *pelo menos uma vez*, então em reconexões pode aparecer uma leitura duplicada no histórico. Não rode duas instâncias da API com o mesmo `MQTT_CLIENT_ID`.
- **Notificação fora da thread do MQTT:** uma chamada lenta ao Telegram não trava o recebimento de leituras.
- **O status é decidido pelo ESP32.** A API não recalcula a partir de `leitura`.
- **O cooldown conta desde a última notificação** (início ou lembrete), não desde a última leitura.
- **Tabelas criadas com `create_all` no startup, sem Alembic.** Mudanças de schema exigem recriar a tabela ou migrar manualmente.
