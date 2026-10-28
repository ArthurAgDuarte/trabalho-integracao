# Manual de Funcionamento: Sistema de Detecção e Alerta de Vazamento de Gás

Este manual explica como o sistema funciona de ponta a ponta: o sensor no ESP32 detecta o gás, o alarme local dispara, o servidor registra a ocorrência e o alerta chega ao Telegram. Ele também mostra como colocar tudo para rodar, como operar e como resolver os problemas mais comuns.

Para detalhes técnicos de desenvolvimento (estrutura do código, testes, contrato completo), consulte o [README.md](README.md).

---

## 1. Visão geral

```
 ┌─────────────────────┐        Wi-Fi local (192.168.1.X)        ┌──────────────────────────────────────┐
 │  ESP32 + MQ-2/MQ-5  │                                         │          Computador servidor         │
 │                     │   MQTT  casa/<comodo>/gas  (porta 1883) │                                      │
 │  lê o gás           │ ──────────────────────────────────────► │  Mosquitto (broker)                  │
 │  compara c/ limiar  │                                         │      │                               │
 │  buzzer + LED       │                                         │      ▼                               │
 └─────────────────────┘                                         │  API (FastAPI) ──► PostgreSQL        │
                                                                 │      │            (histórico)        │
                                                                 │      ▼                               │
                                                                 │  Notificador ──────────────────────────► Telegram
                                                                 └──────────────────────────────────────┘     (celular)
```

| Componente | Função | Responsável |
|---|---|---|
| **ESP32 + sensor MQ-2/MQ-5** | lê a concentração de gás, decide se é vazamento, aciona o buzzer e o LED, publica a leitura via MQTT | colega do firmware |
| **Mosquitto** | broker MQTT: recebe as mensagens do ESP32 e entrega à API | infraestrutura/backend |
| **API** | valida as mensagens, grava o histórico, decide quando alertar, consulta via HTTP | infraestrutura/backend |
| **PostgreSQL** | guarda todas as leituras e todos os eventos de alerta | infraestrutura/backend |
| **Notificador Telegram** | envia a mensagem de alerta para o celular | colega das notificações |

### Status atual dos componentes

| Componente | Situação |
|---|---|
| API, banco, lógica de alerta, simulador, testes | ✅ pronto |
| Notificador de log (padrão) | ✅ pronto |
| Notificador Telegram | 🟡 interface pronta, envio a ser implementado pelo colega das notificações |
| Docker Compose (Mosquitto + Postgres + API) | 🚧 em preparação. Por enquanto o sistema roda localmente (seção 4.2). |
| Firmware do ESP32 | colega do firmware (há um exemplo de referência na seção 4.3) |

---

## 2. Como o sistema funciona

### 2.1 Caminho de uma leitura

1. **Leitura:** a cada poucos segundos, o ESP32 lê o sensor (um valor de 0 a 4095) e compara com o limiar de calibração.
2. **Alarme local:** se passou do limiar, o ESP32 **liga o buzzer e o LED na hora**. Isso não depende de Wi-Fi, servidor nem Telegram.
3. **Publicação:** o ESP32 publica no tópico `casa/<comodo>/gas` um JSON como este:
   ```json
   { "dispositivo": "esp32-cozinha", "leitura": 742, "status": "VAZAMENTO", "ts": "2026-09-13T14:22:07Z" }
   ```
4. **Recebimento:** a API, inscrita em `casa/+/gas`, recebe a mensagem e tira o cômodo do próprio tópico (`cozinha`).
5. **Validação:** a API confere todos os campos. Mensagem inválida é descartada e registrada no log como aviso. O sistema segue funcionando.
6. **Gravação:** a leitura é salva no banco junto com o horário em que o servidor a recebeu.
7. **Decisão de alerta:** a API compara o status atual com o anterior daquele dispositivo e decide se deve notificar (seção 2.2).
8. **Notificação:** se for o caso, a mensagem é enviada ao Telegram em segundo plano, e o resultado (enviado ou erro) fica registrado no evento.

### 2.2 Quando o Telegram é avisado (anti-spam)

O ESP32 manda leituras o tempo todo, mas o celular **não** recebe uma mensagem por leitura. A API só notifica nas mudanças de situação:

| Situação | O que chega no Telegram |
|---|---|
| O gás **começou** a vazar (NORMAL → VAZAMENTO) | 🚨 alerta de vazamento, imediatamente |
| O vazamento **continua** | ⚠️ lembrete, no máximo **um a cada 5 minutos** (configurável) |
| O gás **voltou ao normal** (VAZAMENTO → NORMAL) | ✅ aviso de normalização |
| Tudo normal | nada |

**Exemplo:** um vazamento de 12 minutos na cozinha, com o ESP32 publicando a cada 2 segundos.

| Horário | Status lido | Mensagens no Telegram |
|---|---|---|
| 14:00:00 | NORMAL | |
| 14:00:02 | VAZAMENTO | 🚨 VAZAMENTO DE GÁS detectado em cozinha! |
| 14:00:04 … 14:04:58 | VAZAMENTO | (nada: cerca de 150 leituras gravadas, sem spam) |
| 14:05:02 | VAZAMENTO | ⚠️ O vazamento de gás em cozinha continua. |
| 14:10:02 | VAZAMENTO | ⚠️ O vazamento de gás em cozinha continua. |
| 14:12:00 | NORMAL | ✅ Nível de gás normalizado em cozinha. |

Todas as leituras ficam no histórico, mesmo as que não geraram mensagem.

Cada dispositivo é acompanhado separadamente. Um vazamento na cozinha não interfere nos alertas da área de serviço.

### 2.3 Formato das mensagens no Telegram

```
🚨 VAZAMENTO DE GÁS detectado em cozinha!
Dispositivo: esp32-cozinha
Leitura: 742
Horário: 13/09/2026 14:22:07 UTC
```

O horário está em **UTC**: no horário de Brasília, subtraia 3 horas.

### 2.4 Comportamento em falhas

O sistema foi feito para continuar funcionando quando uma parte cai:

| O que falhou | O que acontece |
|---|---|
| Wi-Fi ou servidor fora do ar | O **alarme local continua funcionando** no ESP32. As leituras desse período não chegam ao servidor. |
| A API reiniciou | O broker guarda as mensagens enquanto ela estiver fora e entrega tudo quando ela voltar. A API lembra se havia vazamento em andamento e **não repete** o alerta inicial. |
| Mosquitto reiniciou | A API reconecta sozinha (tenta de 1 em 1 s, até a cada 30 s). |
| Telegram fora do ar ou token errado | A leitura **é gravada normalmente**. O evento fica marcado como "não notificado", com o motivo do erro. |
| ESP32 mandou dado com defeito | A mensagem é descartada e aparece no log como aviso (`invalido`), com o conteúdo recebido. As próximas mensagens seguem normalmente. |

> ⚠️ **Segurança:** a notificação no celular é um complemento. A proteção principal é o **alarme local** do ESP32. Em caso de vazamento real: não acione interruptores, feche o registro do gás, ventile o ambiente e saia do local.

---

## 3. Antes de começar

| Item | Observação |
|---|---|
| Computador servidor | Windows ou Linux, ligado na mesma rede Wi-Fi do ESP32 |
| Python 3.12 ou superior | para a API e o simulador |
| Mosquitto | <https://mosquitto.org/download/> (o Docker vai cuidar disso futuramente) |
| ESP32 + sensor MQ-2 ou MQ-5 + buzzer + LED | veja as notas de hardware na seção 4.3 |
| Conta no Telegram | para criar o bot (seção 4.4) |

---

## 4. Colocando para funcionar

Siga esta ordem: **servidor → rede → ESP32 → Telegram → teste**.

### 4.1 Rede: IP do servidor e firewall

O ESP32 precisa do **IP do computador servidor** na rede local.

- **Windows:** rode `ipconfig` e anote o "Endereço IPv4" do adaptador Wi-Fi (ex.: `192.168.1.10`).
- **Linux:** rode `hostname -I`.

Fixe esse IP no roteador (reserva de DHCP). Se ele mudar, o ESP32 deixa de encontrar o servidor.

Libere as portas **1883** (MQTT) e **8000** (API) no firewall do servidor:

```powershell
# Windows, PowerShell como administrador (a rede Wi-Fi deve estar como "Rede privada")
New-NetFirewallRule -DisplayName "MQTT 1883" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "API Gas 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```
```bash
# Linux (Ubuntu/Debian)
sudo ufw allow 1883/tcp && sudo ufw allow 8000/tcp
```

### 4.2 Servidor (modo local, enquanto o Docker não está pronto)

**a) Configuração.** Na pasta do projeto, crie o `.env` a partir do modelo e edite:

```bash
copy .env.example .env        # Linux: cp .env.example .env
```
```ini
MQTT_HOST=localhost
MQTT_USER=gas
MQTT_PASSWORD=uma-senha-forte
DATABASE_URL=sqlite:///./gas.db      # ou o endereço do PostgreSQL
NOTIFICADOR=log                      # troque para telegram na seção 4.4
```

**b) Mosquitto com senha.** Crie o arquivo de senhas usando o mesmo usuário e senha do `.env`:

```bash
mosquitto_passwd -c passwd gas
```

Crie um `mosquitto.conf`:

```
listener 1883 0.0.0.0
allow_anonymous false
password_file passwd
persistence true
```

Inicie o broker com `mosquitto -c mosquitto.conf -v`. O `listener 1883 0.0.0.0` é obrigatório: sem ele, o Mosquitto 2.x só aceita conexões da própria máquina, e o ESP32 não consegue conectar.

**c) API.** Em outro terminal, na raiz do projeto:

```bash
python -m venv .venv
.venv\Scripts\activate               # Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --app-dir api --host 0.0.0.0 --port 8000
```

**d) Conferir.** Abra <http://localhost:8000/health>. O esperado é:

```json
{"api": "ok", "banco": "ok", "mqtt": "conectado"}
```

### 4.3 ESP32 (Arduino)

O firmware precisa seguir o contrato abaixo (a versão completa está no README):

| Item | Valor |
|---|---|
| Broker | IP do servidor (seção 4.1), porta 1883 |
| Usuário e senha MQTT | os mesmos `MQTT_USER` e `MQTT_PASSWORD` do `.env` |
| Tópico | `casa/<comodo>/gas`, ex.: `casa/cozinha/gas` |
| Client ID | único por placa, ex.: `esp32-cozinha` |
| `dispositivo` | texto, único por placa |
| `leitura` | número **inteiro** de 0 a 4095 |
| `status` | `"NORMAL"` ou `"VAZAMENTO"`, em maiúsculas |
| `ts` | opcional: data e hora UTC no formato `2026-09-13T14:22:07Z` |

Campos além desses fazem a mensagem ser rejeitada.

**Exemplo de referência:** um ponto de partida para o colega do firmware. Ele usa a biblioteca **PubSubClient** (Gerenciador de Bibliotecas → "PubSubClient", de Nick O'Leary).

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <time.h>

// ---------- Configuração ----------
const char* WIFI_SSID    = "NomeDaRede";
const char* WIFI_SENHA   = "SenhaDaRede";
const char* MQTT_HOST    = "192.168.1.10";      // IP do servidor (seção 4.1)
const uint16_t MQTT_PORTA = 1883;
const char* MQTT_USUARIO = "gas";
const char* MQTT_SENHA   = "uma-senha-forte";
const char* DISPOSITIVO  = "esp32-cozinha";
const char* TOPICO       = "casa/cozinha/gas";

const int PINO_SENSOR = 34;   // use um pino do ADC1 (32 a 39): o ADC2 não funciona com o Wi-Fi ligado
const int PINO_BUZZER = 25;
const int PINO_LED    = 26;
const int LIMIAR      = 600;  // calibrar com o sensor em ar limpo e com gás
const int HISTERESE   = 50;   // evita o alarme ficar "piscando" perto do limiar
const unsigned long INTERVALO_ENVIO_MS = 2000;

WiFiClient wifi;
PubSubClient mqtt(wifi);
bool vazando = false;
unsigned long ultimoEnvio = 0, ultimaTentativaMqtt = 0;

void publicar(int leitura) {
  char payload[160];
  struct tm agora;
  const char* status = vazando ? "VAZAMENTO" : "NORMAL";
  if (getLocalTime(&agora, 0)) {            // tem hora do NTP: envia ts
    char ts[25];
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%SZ", &agora);
    snprintf(payload, sizeof payload,
             "{\"dispositivo\":\"%s\",\"leitura\":%d,\"status\":\"%s\",\"ts\":\"%s\"}",
             DISPOSITIVO, leitura, status, ts);
  } else {                                  // sem NTP: ts é opcional
    snprintf(payload, sizeof payload,
             "{\"dispositivo\":\"%s\",\"leitura\":%d,\"status\":\"%s\"}",
             DISPOSITIVO, leitura, status);
  }
  mqtt.publish(TOPICO, payload);
}

void setup() {
  pinMode(PINO_BUZZER, OUTPUT);
  pinMode(PINO_LED, OUTPUT);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);
  configTime(0, 0, "pool.ntp.org");         // hora em UTC
  mqtt.setServer(MQTT_HOST, MQTT_PORTA);
}

void loop() {
  int leitura = analogRead(PINO_SENSOR);    // 0 a 4095

  // 1) Alarme local: decide e aciona SEMPRE, com ou sem rede.
  bool agoraVazando = vazando ? (leitura > LIMIAR - HISTERESE) : (leitura >= LIMIAR);
  bool mudou = (agoraVazando != vazando);
  vazando = agoraVazando;
  digitalWrite(PINO_LED, vazando);
  digitalWrite(PINO_BUZZER, vazando);       // buzzer ativo; para buzzer passivo use tone()

  // 2) Rede: reconecta sem travar o loop (nunca use while bloqueante aqui).
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected() && millis() - ultimaTentativaMqtt > 5000) {
      ultimaTentativaMqtt = millis();
      mqtt.connect(DISPOSITIVO, MQTT_USUARIO, MQTT_SENHA);
    }
    mqtt.loop();
  }

  // 3) Publica periodicamente, e na hora se o status mudou.
  if (mqtt.connected() && (mudou || millis() - ultimoEnvio >= INTERVALO_ENVIO_MS)) {
    publicar(leitura);
    ultimoEnvio = millis();
  }
  delay(100);
}
```

**Notas de hardware:**
- O módulo MQ-2/MQ-5 é alimentado com 5 V, e a saída analógica pode passar de 3,3 V, o que **danifica o pino do ESP32**. Use um divisor de tensão na saída AO (ex.: resistores de 10 kΩ e 20 kΩ).
- Os sensores MQ precisam **aquecer**: de 1 a 2 minutos a cada vez que ligam, e de 24 a 48 horas no primeiro uso para estabilizar. Durante o aquecimento a leitura vem alta e pode gerar falso alarme.
- Calibre o `LIMIAR` medindo o valor em ar limpo e com uma pequena amostra de gás (isqueiro **apagado**).
- A PubSubClient publica em QoS 0, que o servidor aceita normalmente.

### 4.4 Telegram

> O envio pelo Telegram está sendo implementado pelo colega das notificações. A parte de configuração abaixo já vale.

**a) Criar o bot**
1. No Telegram, procure **@BotFather** e envie `/newbot`.
2. Escolha um nome (ex.: "Alerta Gás Casa") e um usuário terminado em `bot` (ex.: `alerta_gas_casa_bot`).
3. O BotFather responde com o **token**, algo como `123456789:AAH...`. Guarde-o em segredo: quem tiver o token controla o bot.

**b) Descobrir o chat_id**
1. Abra a conversa com o seu bot e envie qualquer mensagem (ex.: "oi"). Para alertar um **grupo**, adicione o bot ao grupo e envie uma mensagem lá.
2. No navegador, acesse `https://api.telegram.org/bot<TOKEN>/getUpdates`, trocando `<TOKEN>` pelo token.
3. Procure `"chat":{"id": ...}`. Esse número é o `chat_id`. Em grupos ele é negativo, ex.: `-1001234567890`.

**c) Configurar o servidor.** No `.env`:

```ini
NOTIFICADOR=telegram
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_CHAT_ID=987654321
```

Reinicie a API. Se faltar o token ou o chat_id, a API não inicia e mostra o erro. Nunca commite o `.env`, porque ele contém o token.

### 4.5 Testar tudo (com ou sem o ESP32)

O simulador faz o papel do ESP32. Ele é útil para testar o servidor e o Telegram antes de o hardware estar pronto:

```bash
python tools/simulador.py sequencia --intervalo 1
```

Ele envia 5 leituras normais, 5 de vazamento e 5 normais. O resultado esperado é:
- Telegram: 🚨 um alerta de vazamento e depois ✅ um aviso de normalização.
- <http://localhost:8000/eventos>: dois eventos (`INICIO_VAZAMENTO` e `NORMALIZADO`), com `"notificado": true`.
- <http://localhost:8000/leituras>: 15 leituras.

Outros modos: `normal`, `vazamento --quantidade 20` e `invalido` (manda dados com defeito, que devem aparecer como aviso no log). Use `--host 192.168.1.X` para testar a partir de outra máquina da rede, como o ESP32 faria.

---

## 5. Operação e monitoramento

### 5.1 Consultas pelo navegador

| Endereço | O que mostra |
|---|---|
| <http://IP:8000/health> | se a API, o banco e a conexão MQTT estão ok |
| <http://IP:8000/leituras/ultimas> | a última leitura de cada sensor (situação atual da casa) |
| <http://IP:8000/leituras?dispositivo=esp32-cozinha&limite=50> | histórico de um sensor |
| <http://IP:8000/leituras?inicio=2026-09-13T00:00:00Z&fim=2026-09-13T23:59:59Z> | leituras de um período (horários em UTC) |
| <http://IP:8000/eventos> | alertas disparados e se o Telegram recebeu |
| <http://IP:8000/docs> | página interativa para testar todas as consultas |

### 5.2 Lendo os logs

Cada acontecimento vira uma linha no terminal da API. O campo `acao` diz o que houve:

| `acao` | Significado |
|---|---|
| `recebido` → `gravado` | leitura chegou e foi salva (fluxo normal) |
| `alerta_disparado` | um alerta foi criado (início, lembrete ou normalização) |
| `notificacao_enviada` | o Telegram aceitou a mensagem |
| `notificacao_falhou` | o envio falhou; o campo `erro` diz o motivo |
| `invalido` | mensagem rejeitada; `bruto` mostra o que chegou e `erro` mostra o campo com problema |
| `mqtt_desconectado` / `mqtt_reconectando` | perda de conexão com o broker (a API tenta voltar sozinha) |

### 5.3 Ajustes

| Variável no `.env` | Efeito | Padrão |
|---|---|---|
| `ALERTA_COOLDOWN_SEGUNDOS` | intervalo mínimo entre lembretes de um vazamento contínuo | `300` (5 min) |
| `NOTIFICADOR` | `log` (só registra no terminal) ou `telegram` | `log` |
| `LOG_LEVEL` | `DEBUG`, `INFO`, `WARNING` | `INFO` |

Para adicionar um cômodo, grave outro ESP32 com outro `DISPOSITIVO` e outro `TOPICO` (ex.: `casa/area-servico/gas`). O servidor não precisa de nenhuma mudança.

---

## 6. Solução de problemas

| Sintoma | Causa provável | Como resolver |
|---|---|---|
| ESP32 não conecta no broker | IP errado, firewall bloqueando ou Mosquitto sem `listener 1883 0.0.0.0` | confira o IP (4.1), a regra de firewall e o `mosquitto.conf`. Teste com `python tools/simulador.py normal --host <IP>` de outra máquina. |
| Log do Mosquitto mostra "not authorised" | usuário ou senha MQTT diferentes entre o ESP32 e o `passwd` | refaça o `mosquitto_passwd` com a senha do `.env` e regrave o ESP32 |
| `/health` mostra `"mqtt": "desconectado"` | broker parado ou credenciais erradas na API | inicie o Mosquitto e confira `MQTT_HOST`, `MQTT_USER` e `MQTT_PASSWORD` no `.env` |
| `/health` mostra `"banco": "erro"` | banco parado ou `DATABASE_URL` errada | confira o PostgreSQL e a URL. Para testes, use `sqlite:///./gas.db`. |
| Leituras não aparecem e o log mostra `invalido` | o ESP32 está fora do contrato | o campo `erro` diz qual: leitura como texto (`"742"`), status minúsculo, campo extra, etc. |
| Alarme toca, mas nada chega no Telegram | `NOTIFICADOR=log`, token ou chat_id errado, ou bot sem conversa iniciada | veja `/eventos`: o campo `erro_notificacao` diz o motivo. Envie uma mensagem ao bot antes (4.4 b). |
| Erro `NotImplementedError` em `erro_notificacao` | o envio pelo Telegram ainda não foi implementado | use `NOTIFICADOR=log` até o colega concluir |
| Falso alarme logo ao ligar | sensor MQ ainda aquecendo | aguarde de 1 a 2 minutos, ou ignore as leituras desse período no firmware |
| Alerta "piscando" (vários início/normalizado seguidos) | leitura oscilando perto do limiar | aumente a `HISTERESE` no firmware |
| Horário da mensagem com 3 horas de diferença | os horários são em UTC | é o esperado: Brasília = UTC − 3 |
