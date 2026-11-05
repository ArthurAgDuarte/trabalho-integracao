# Sistema de Detecção e Alerta de Vazamento de Gás: Backend (Node.js)

Projeto da disciplina **Técnicas de Integração de Sistemas**.

```
ESP32 + MQ-2/MQ-5 ──MQTT──► Mosquitto ──► API (Node.js) ──► PostgreSQL
 (alarme local)          casa/<comodo>/gas      │
                                                └──► Notificador (log | Telegram)
```

O ESP32 lê o sensor, decide o status (o limiar fica no firmware), aciona o alarme local e publica um JSON via MQTT. Este backend recebe a mensagem, valida, grava o histórico, aplica a lógica de alerta anti-spam e dispara a notificação.

Esta é a versão em **Node.js + TypeScript**, intercambiável com a versão em Python: mesmo contrato MQTT, mesmo `.env`, mesmas tabelas e mesmos endpoints. O firmware, o `.env` e o banco servem para as duas sem mudança. As poucas diferenças estão em [Diferenças em relação à versão Python](#diferenças-em-relação-à-versão-python).

> 📘 **Manual de funcionamento** (ESP32 + servidor + Telegram, passo a passo e solução de problemas): [MANUAL.md](MANUAL.md)

## Estrutura

```
src/
  main.ts                inicialização: config → log → banco → tabelas → restaura estados → HTTP + MQTT
  app.ts                 Fastify + Swagger (/docs) + formato dos erros
  config.ts              variáveis de ambiente (validadas com Zod)
  log.ts                 logs JSON em stdout (pino)
  schemas.ts             contrato MQTT: tópico, payload (Zod) e datas ISO 8601
  alerta.ts              máquina de estados do alerta (pura, sem I/O)
  processador.ts         valida → grava → alerta → fila de notificações
  mqtt.ts                consumidor MQTT.js (QoS 1, sessão persistente, reconexão)
  rotas.ts               endpoints REST
  db/repositorio.ts      interface do repositório e tipos das linhas
  db/postgres.ts         pool, CREATE TABLE e SQL escrito à mão (pg)
  notificadores/         Notificador (interface), LogNotificador, TelegramNotificador (stub), fábrica
tests/                   Vitest (payload, alerta, processador, notificadores, mqtt, config, api, repositório)
  apoio/                 repositório em memória, log em memória, relógio falso
tools/
  simulador.ts           simula o ESP32 sem hardware
  teste-integrado.ts     sobe o compose e testa o fluxo de ponta a ponta
mosquitto/               mosquitto.conf e entrypoint.sh do serviço do broker
docker-compose.yml       mosquitto + postgres + api
Dockerfile               imagem da API (multi-stage, usuário não-root)
```

---

## Como subir o ambiente

### Com Docker Compose (recomendado)

Requer Docker com o plugin `compose` (Docker Desktop no Windows; Docker Engine e `docker-compose-plugin` no Linux).

> **Mosquitto também instalado na máquina?** No Windows, o instalador cria o serviço "Mosquitto Broker", que ocupa a porta 1883 em `localhost`. Pare-o antes de subir o compose (PowerShell como administrador: `Stop-Service mosquitto; Set-Service mosquitto -StartupType Manual`). Se ele ficar ligado, o compose falha com "port is already allocated", ou as conexões em `localhost` (como as do simulador) vão para o broker errado e nunca chegam à API.

```bash
cp .env.example .env          # Windows: copy .env.example .env
# Edite o .env: troque MQTT_PASSWORD e POSTGRES_PASSWORD
# (a senha do Postgres aparece duas vezes: em POSTGRES_PASSWORD e dentro da DATABASE_URL).

docker compose up -d --build
docker compose ps             # api e postgres devem ficar "healthy"
docker compose logs -f        # acompanha o fluxo (Ctrl+C sai dos logs; os serviços continuam)
```

Confira em <http://localhost:8000/health>. O esperado é `{"api":"ok","banco":"ok","mqtt":"conectado"}`. A documentação interativa fica em <http://localhost:8000/docs>.

| Serviço | Imagem | Porta no host | O que faz |
|---|---|---|---|
| `mosquitto` | `eclipse-mosquitto:2` | 1883 | Broker MQTT. O [entrypoint.sh](mosquitto/entrypoint.sh) gera o arquivo de senhas a partir de `MQTT_USER`/`MQTT_PASSWORD` a cada start. |
| `postgres` | `postgres:16` | nenhuma | Banco. Tem healthcheck com `pg_isready`. |
| `api` | build do [Dockerfile](Dockerfile) (`node:24-slim`, usuário `node`) | 8000 | Esta API. Só sobe depois que o postgres fica saudável; o healthcheck chama `/health`. |

- **Volumes:** `mosquitto-dados` guarda as sessões e as mensagens pendentes, e `postgres-dados` guarda o banco. `docker compose down` mantém os dados; `docker compose down -v` apaga tudo.
- **Alta disponibilidade:** todos os serviços têm `restart: unless-stopped` e voltam sozinhos depois de uma queda (ou de um reboot, se o Docker iniciar com o sistema).
- **Mudou o `.env`?** Rode `docker compose up -d`, que recria os containers afetados. O arquivo de senhas do Mosquitto é gerado de novo.
- **Acesso ao banco:** o Postgres não tem porta publicada, só a API o acessa. Para consultar, use `docker compose exec postgres psql -U gas -d gas`. Para usar uma ferramenta gráfica no host, adicione `ports: ["127.0.0.1:5432:5432"]` ao serviço `postgres`.
- **Senhas com caracteres especiais:** se a senha do Postgres tiver `@ : / ? #`, codifique-os na `DATABASE_URL` (ex.: `@` vira `%40`). Evite `$` nas senhas, porque o Compose trata `$` como variável.

### Sem Docker (Mosquitto e PostgreSQL instalados na máquina)

Requer Node.js 24 ou mais novo, Mosquitto 2.x e PostgreSQL 16 ou mais novo.

**1. Banco.** No `psql` como superusuário (ex.: `psql -U postgres`):

```sql
CREATE USER gas WITH PASSWORD 'uma-senha-forte';
CREATE DATABASE gas OWNER gas;
```

As tabelas são criadas pela API no startup.

**2. Mosquitto com senha.** Crie uma pasta `mosquitto-local/` na raiz do projeto (ela já está no `.gitignore`). Dentro dela, gere o arquivo de senhas com o mesmo usuário e senha do `.env`:

```bash
mosquitto_passwd -c mosquitto-local/passwd gas
```

Em seguida, crie `mosquitto-local/mosquitto.conf` com caminhos absolutos:

```
listener 1883 0.0.0.0
allow_anonymous false
password_file C:\caminho\do\projeto\mosquitto-local\passwd
persistence true
persistence_location C:\caminho\do\projeto\mosquitto-local\
queue_qos0_messages true
```

Inicie com `mosquitto -c mosquitto-local/mosquitto.conf -v`. O `listener 1883 0.0.0.0` é obrigatório: sem ele, o Mosquitto 2.x só aceita conexões da própria máquina e o ESP32 não conecta.

> **Windows:** o instalador do Mosquitto cria o serviço "Mosquitto Broker", que já ocupa a porta 1883 usando `C:\Program Files\mosquitto\mosquitto.conf`. Esse arquivo vem sem listener, então só aceita conexões locais e anônimas. Há duas saídas, ambas no PowerShell **como administrador**:
> - pare o serviço (`Stop-Service mosquitto`, e `Set-Service mosquitto -StartupType Manual` para não voltar no boot) e rode o comando acima;
> - ou coloque as linhas acima naquele arquivo e rode `Restart-Service mosquitto`.

**3. `.env`.** Copie o `.env.example` e aponte para a máquina local:

```ini
MQTT_HOST=localhost
DATABASE_URL=postgresql+psycopg://gas:uma-senha-forte@localhost:5432/gas
```

**4. API.** Na raiz do projeto (o `.env` é lido do diretório atual):

```bash
npm install
npm run dev                    # desenvolvimento: reinicia ao salvar um arquivo
npm run build && npm start     # ou: compila para dist/ e roda como em produção
```

---

## Descobrir o IP do host e liberar a porta 1883

O ESP32 conecta no **IP da máquina que roda o broker**, na rede Wi-Fi local (192.168.1.X).

**Descobrir o IP**

| Sistema | Comando | Onde olhar |
|---|---|---|
| Windows | `ipconfig` | "Endereço IPv4" do adaptador Wi-Fi |
| Linux | `hostname -I` ou `ip -4 addr show` | endereço 192.168.1.X da interface Wi-Fi (ex.: `wlan0`) |

Prefira fixar esse IP com uma reserva de DHCP no roteador. Se ele mudar, o firmware para de achar o broker.

**Liberar a porta no firewall**

Windows (PowerShell **como administrador**):
```powershell
New-NetFirewallRule -DisplayName "MQTT 1883" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "API Gas 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```
A rede Wi-Fi precisa estar como **Rede privada** (Configurações → Rede e Internet → Wi-Fi → propriedades). Com o Docker Desktop, as portas publicadas ficam no IP do próprio Windows, e as regras acima valem do mesmo jeito. Para remover depois: `Remove-NetFirewallRule -DisplayName "MQTT 1883"`.

Linux:
```bash
sudo ufw allow 1883/tcp && sudo ufw allow 8000/tcp                 # Ubuntu/Debian (ufw)
sudo firewall-cmd --permanent --add-port=1883/tcp --add-port=8000/tcp && sudo firewall-cmd --reload   # Fedora (firewalld)
```

**Testar de outra máquina da rede:** `npm run simulador -- normal --host 192.168.1.X`.

---

## Contrato MQTT (para o firmware)

| Item | Valor |
|---|---|
| Broker | `<IP do host>:1883` (TCP, sem TLS) |
| Autenticação | usuário e senha obrigatórios (`MQTT_USER` / `MQTT_PASSWORD` do `.env`); conexão anônima é recusada |
| Tópico | `casa/<comodo>/gas` (ex.: `casa/cozinha/gas`, `casa/area-servico/gas`) |
| QoS | 0 ou 1. A `PubSubClient` do Arduino só publica em QoS 0, e funciona: mesmo em QoS 0, o broker guarda até 1000 mensagens enquanto a API estiver fora (`queue_qos0_messages`). |
| Retain | `false` |
| Client ID | único por placa (ex.: `esp32-cozinha`); não use `api-gas`, que é o da API |
| Codificação | JSON UTF-8 (sem BOM), um objeto por mensagem |

**O cômodo vem do tópico, não do payload.** O tópico precisa ter exatamente 3 níveis (`casa/<comodo>/gas`), e o cômodo não pode ser vazio nem passar de 64 caracteres. Tópico fora desse formato é descartado com WARNING.

### Payload

```json
{ "dispositivo": "esp32-cozinha", "leitura": 742, "status": "VAZAMENTO", "ts": "2026-09-13T14:22:07Z" }
```

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `dispositivo` | string | sim | Os espaços das pontas são removidos; depois disso, de 1 a 64 caracteres. Identifica a placa e deve ser único. |
| `leitura` | inteiro | sim | 0 a 4095 (ADC de 12 bits). `"742"`, `742.5`, `742.0`, `1e3`, `true` e `null` são rejeitados. |
| `status` | string | sim | Exatamente `"NORMAL"` ou `"VAZAMENTO"`, em maiúsculas. |
| `ts` | string | não | ISO 8601. Com fuso é convertido para UTC; sem fuso é tratado como UTC. `null` equivale a omitir. Número (timestamp Unix) é rejeitado. Omita se o ESP32 não tiver NTP. |

- **Formatos de `ts` aceitos** (os mesmos da versão Python):
  - `2026-09-13T14:22:07Z` é o recomendado;
  - `2026-09-13T11:22:07-03:00` e `…+0300` têm fuso;
  - `2026-09-13T14:22:07` não tem fuso;
  - `2026-09-13T14:22:07.123Z` tem fração;
  - `2026-09-13 14:22:07` usa espaço;
  - `2026-09-13T14:22` não tem segundos;
  - `2026-09-13` é só a data (vira meia-noite).
- **Formatos de `ts` rejeitados:** `+03` (fuso só com hora), `24:00`, segundo `60`, data inexistente (`2026-02-30`) e formato sem hífens (`20260913T142207Z`).
- **Campos extras são rejeitados.** Se precisar mandar algo novo (ex.: `rssi`), combine antes para entrar no contrato.
- **Horário do servidor:** o servidor sempre grava `recebido_em` (UTC). Ele é a referência para o histórico e para o cooldown.
- **Mensagem inválida** é **descartada** e logada como WARNING, com o conteúdo bruto (até 1000 caracteres) e a lista de erros por campo. Não derruba nada, mas também não é gravada. Exemplo:
  ```json
  {"nivel":"WARNING","ts":"2026-09-13T14:22:07.120Z","logger":"processador","acao":"invalido","topico":"casa/cozinha/gas","comodo":"cozinha","bruto":"{\"dispositivo\": \"esp32\", \"leitura\": 9999, \"status\": \"VAZAMENTO\"}","erro":[{"campo":"leitura","erro":"deve ser um número inteiro de 0 a 4095"}],"msg":"Payload inválido descartado"}
  ```
- **Frequência:** a sugestão é publicar a cada 1 a 5 s e **imediatamente** quando o status mudar.

### Lógica de alerta (o que acontece com cada status)

Mantida por `dispositivo`:

| Transição | Evento | Notifica? |
|---|---|---|
| NORMAL → VAZAMENTO (ou a primeira leitura já em VAZAMENTO) | `INICIO_VAZAMENTO` | sim |
| VAZAMENTO → VAZAMENTO | `LEMBRETE` | só depois de `ALERTA_COOLDOWN_SEGUNDOS` (padrão 300) desde a última notificação |
| VAZAMENTO → NORMAL | `NORMALIZADO` | sim |
| NORMAL → NORMAL | nenhum | não |

O estado é reconstruído do banco quando a API reinicia. Assim, um restart no meio de um vazamento não gera um `INICIO_VAZAMENTO` duplicado nem zera o cooldown.

---

## Plugar o TelegramNotificador (para as notificações)

Arquivo: [src/notificadores/telegram-notificador.ts](src/notificadores/telegram-notificador.ts). O `TODO` no método `notificar` já traz um exemplo completo com o `fetch` nativo do Node.

**O que já está pronto**
- O construtor lê `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` e **impede a API de subir** se algum faltar.
- O texto da mensagem já vem pronto de `formatarMensagem(evento)`, em [notificador.ts](src/notificadores/notificador.ts).
- A seleção é feita por `NOTIFICADOR=telegram` no `.env`, pela fábrica `criarNotificador` em [index.ts](src/notificadores/index.ts). Nada mais precisa mudar no resto do código.
- O `fetch` e o `AbortSignal.timeout` são nativos do Node 24, então não é preciso instalar nenhum pacote.

**O que falta:** fazer o `POST https://api.telegram.org/bot<TOKEN>/sendMessage` com `{"chat_id": ..., "text": ...}` e remover o `throw new NaoImplementadoError(...)`.

**Regras do contrato `Notificador.notificar(evento): Promise<void>`**
1. **Em caso de falha, rejeite (lance o erro).** Não retorne `false` e não engula o erro.
   - O processador captura a rejeição, grava `eventos_alerta.notificado = false` com o motivo em `erro_notificacao` e loga `notificacao_falhou`.
   - A leitura já foi gravada antes, então uma falha aqui nunca a perde.
2. **Use timeout** (`signal: AbortSignal.timeout(this.timeoutMs)`, 10 s). As notificações saem numa fila, uma por vez, e uma chamada travada atrasa as próximas. Como rede de segurança, o processador desiste de uma notificação depois de 30 s.
3. **Não vaze o token.** A URL contém o token, e a mensagem (ou a causa) do erro do `fetch` pode conter a URL. Relance com uma mensagem própria, como mostra o exemplo do TODO; o texto do erro vai para o log e para o banco. O token fica num campo privado (`#token`) para não aparecer se alguém logar o objeto.
4. **Retentativa e cooldown** não são responsabilidade do notificador: a API já cuida disso.

`evento` é um objeto simples: `{ id, dispositivo, comodo, tipo, leitura, criadoEm }`, com `tipo` = `INICIO_VAZAMENTO` | `LEMBRETE` | `NORMALIZADO` e `criadoEm` como `Date`.

**Como testar**
```bash
# .env: NOTIFICADOR=telegram, TELEGRAM_BOT_TOKEN=..., TELEGRAM_CHAT_ID=...
npm run simulador -- sequencia --intervalo 1
curl http://localhost:8000/eventos      # "notificado": true e "erro_notificacao": null
```
Para um teste unitário sem rede, troque o `fetch` global com o Vitest:
```ts
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))));
```
Veja os testes existentes em [tests/notificadores.test.ts](tests/notificadores.test.ts) e [tests/processador.test.ts](tests/processador.test.ts).

---

## API REST

| Método e rota | Descrição |
|---|---|
| `GET /health` | `{"api","banco","mqtt"}`. HTTP 200 se tudo estiver ok; 503 se o banco ou o MQTT estiverem fora. |
| `GET /leituras?dispositivo=&inicio=&fim=&limite=` | Histórico, mais recentes primeiro. `inicio`/`fim` filtram `recebido_em` (ISO 8601, sem fuso = UTC, limites inclusivos). `limite` vai de 1 a 1000, padrão 100. |
| `GET /leituras/ultimas` | Última leitura de cada dispositivo, ordenada por dispositivo. |
| `GET /eventos?dispositivo=&limite=` | Eventos de alerta, mais recentes primeiro. |
| `GET /docs` | Documentação interativa (Swagger). O OpenAPI fica em `/docs/json`. |

Campos das respostas (os mesmos da versão Python):

- **leituras:** `id`, `dispositivo`, `comodo`, `leitura`, `status`, `ts_dispositivo`, `recebido_em`;
- **eventos:** `id`, `dispositivo`, `comodo`, `tipo`, `leitura`, `criado_em`, `notificado`, `erro_notificacao`.

```bash
curl "http://localhost:8000/leituras?dispositivo=esp32-cozinha&inicio=2026-09-13T00:00:00Z&limite=20"
```

Os erros seguem o formato do FastAPI:

- **parâmetro inválido:** HTTP 422 com `{"detail": [{"loc": ["query", "limite"], "msg": "...", "type": "..."}]}`;
- **`inicio` posterior a `fim`:** 422 com `{"detail": "inicio deve ser anterior a fim"}`;
- **rota inexistente:** 404 com `{"detail": "Not Found"}`.

---

## Testes, simulador e teste integrado

### Testes unitários

```bash
npm test                              # todos (sem broker, Postgres ou Docker)
npm run typecheck                     # checagem de tipos de src, tests e tools
npx vitest run tests/alerta.test.ts   # um arquivo só
```

| Arquivo | O que cobre |
|---|---|
| `payload.test.ts` | Os payloads válidos e cada tipo de inválido do contrato, mais os formatos de data e a extração do cômodo do tópico. |
| `alerta.test.ts` | A máquina de estados e o cooldown com o tempo simulado (sem `sleep`), além de `definirEstado` e `restaurar`. |
| `processador.test.ts` | O isolamento de falhas: notificador que falha, trava ou demora; banco fora do ar; restart; a fila de notificações. |
| `notificadores.test.ts` | O texto das mensagens, o LogNotificador, o stub do Telegram e a fábrica. |
| `mqtt.test.ts` | O consumidor com um cliente MQTT falso: PUBACK só depois do processamento, reassinatura, backoff e logs de recusa. |
| `config.test.ts` | As variáveis obrigatórias, os padrões, a `DATABASE_URL` da versão Python e o próprio `.env.example`. |
| `api.test.ts` | Os endpoints com `inject` do Fastify, os 422/404/500 e o `/docs`. |
| `repositorio.test.ts` | O contrato do repositório: roda contra a implementação em memória e, com `TEST_DATABASE_URL`, também contra o Postgres. |

Nenhum teste unitário precisa de broker, Postgres ou Docker: eles usam um repositório em memória ([tests/apoio/repositorio-memoria.ts](tests/apoio/repositorio-memoria.ts)) com a mesma semântica do Postgres (ordenação, CHECKs e transação). Para garantir que os dois não divergem, rode a suíte de contrato também contra um Postgres de verdade:

```bash
TEST_DATABASE_URL=postgresql://gas:senha@localhost:5432/gas_teste npm test      # Linux/Git Bash
$env:TEST_DATABASE_URL="postgresql://gas:senha@localhost:5432/gas_teste"; npm test   # PowerShell
```

> ⚠️ As tabelas do banco de `TEST_DATABASE_URL` são **apagadas**. Use um banco descartável, nunca o de produção.

### Simulador do ESP32

```bash
npm run simulador -- normal                     # 5 leituras NORMAL
npm run simulador -- vazamento --quantidade 10  # 10 leituras VAZAMENTO
npm run simulador -- sequencia                  # 5 NORMAL → 5 VAZAMENTO → 5 NORMAL
npm run simulador -- invalido                   # 16 payloads inválidos (devem aparecer como WARNING)
```

| Opção | Efeito |
|---|---|
| `--host 192.168.1.X` | broker em outra máquina (padrão: `SIMULADOR_HOST` do `.env`, ou `localhost`) |
| `--porta`, `--usuario`, `--senha` | padrão: `MQTT_PORT`, `MQTT_USER` e `MQTT_PASSWORD` do `.env` |
| `--comodo sala` | publica em `casa/sala/gas` |
| `--dispositivo esp32-teste` | nome do dispositivo (padrão: `esp32-<comodo>`) |
| `--quantidade 10` | mensagens por etapa |
| `--intervalo 0.5` | segundos entre mensagens |
| `--sem-ts` | omite o `ts` (simula ESP32 sem NTP) |
| `--dry-run` | só imprime, sem conectar |

Ele publica com QoS 1 e espera a confirmação do broker. Os códigos de saída são:

- **0:** tudo publicado;
- **1:** não conectou, credenciais recusadas ou mensagem não confirmada;
- **2:** opção inválida.

### Teste integrado

```bash
npm run teste:integrado                    # sobe o compose e testa
npm run teste:integrado -- --sem-compose   # usa um ambiente já rodando (ex.: npm run dev)
```

O teste:

1. roda `docker compose up -d --build`;
2. espera o `/health` responder 200 (até 180 s);
3. roda o simulador em modo `sequencia` com um dispositivo de nome único (`teste-integrado-<timestamp>`);
4. confere pela API as 9 leituras e os eventos `INICIO_VAZAMENTO` e `NORMALIZADO`.

Sai com código 0 se passou e 1 se falhou. Também aceita as opções `--api <url>`, `--quantidade`, `--tempo-limite <s>` e, repassadas ao simulador, `--host`, `--porta`, `--usuario` e `--senha`.

---

## Logs

Saem em JSON, um objeto por linha, em stdout:

```json
{"nivel":"WARNING","ts":"2026-09-13T14:22:07.120Z","logger":"processador","acao":"alerta_disparado","tipo":"INICIO_VAZAMENTO","evento_id":1,"dispositivo":"esp32-cozinha","comodo":"cozinha","status":"VAZAMENTO","leitura":742,"msg":"Alerta disparado: INICIO_VAZAMENTO"}
```

Campos: `ts` (UTC), `nivel` (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`), `msg`, `logger` (módulo) e, conforme o caso, `acao`, `dispositivo`, `comodo`, `status`, `leitura`, `tipo`, `evento_id`, `topico`, `bruto` e `erro`.

| `acao` | Quando |
|---|---|
| `recebido` → `gravado` | mensagem válida chegou e foi salva |
| `invalido` | payload ou tópico rejeitado (WARNING, com `bruto` e `erro`) |
| `erro_gravacao` | falha no banco (ERROR; a leitura se perde, o consumidor continua) |
| `alerta_disparado` | evento criado (WARNING para início e lembrete, INFO para normalizado) |
| `notificacao_enviada` / `notificacao_falhou` | resultado do notificador |
| `notificacao_log` | a mensagem formatada, quando `NOTIFICADOR=log` |
| `mqtt_conectando` / `mqtt_conectado` / `mqtt_desconectado` / `mqtt_reconectando` / `mqtt_recusado` | estado da conexão com o broker (`mqtt_recusado` = credenciais recusadas) |
| `banco_aguardando` | banco ainda não aceita conexões no startup |
| `inicio` / `fim` | API subiu / encerrou |
| `config_invalida` / `erro_inicio` | a API não subiu (o `erro` diz por quê) |
| `erro_processamento` / `erro_http` | erro inesperado (bug); a API continua de pé |

Para acompanhar só a API, use `docker compose logs -f api`. Para filtrar:

- no Linux: `docker compose logs -f --no-log-prefix api | jq -c 'select(.acao == "alerta_disparado")'`;
- no Windows: `docker compose logs -f api | Select-String alerta_disparado`.

Senhas e o token do Telegram nunca são logados.

---

## Decisões e limitações

- **Sessão MQTT persistente.** A API usa `client_id` fixo, `clean=false` e assina com QoS 1; no broker, `queue_qos0_messages true`. Se a API cair, o broker guarda as mensagens (até 1000) e entrega tudo quando ela voltar, inclusive as publicadas em QoS 0 pela PubSubClient.
- **QoS 1 entrega *pelo menos uma vez*.** Em reconexões, pode aparecer uma leitura duplicada no histórico.
- **Não rode duas APIs com o mesmo `MQTT_CLIENT_ID`, nem a versão Python e a Node ao mesmo tempo.**
  - O broker derruba a conexão antiga a cada conexão nova, e as duas ficam se derrubando.
  - Para trocar de versão, pare uma antes de subir a outra. A nova herda a sessão: a assinatura e as mensagens pendentes.
- **A confirmação ao broker (PUBACK) só sai depois da gravação.** As mensagens chegam pelo hook `handleMessage` do MQTT.js, que processa uma por vez e só confirma no fim. Se a API morrer no meio, o broker reentrega a mensagem.
- **Leitura entregue depois de uma queda da API:** `recebido_em` é o horário da entrega, e o horário real fica em `ts_dispositivo`, se o ESP32 tiver NTP. O cooldown também usa o horário da entrega.
- **Notificação fora do caminho da leitura:** uma fila sequencial (uma por vez, em ordem). Um Telegram lento não atrasa a gravação das leituras.
- **Reconexão:** espera de 1 s, 2 s, 4 s… até 30 s, inclusive depois de credenciais recusadas. Sem a opção `reconnectOnConnackError`, o MQTT.js desistiria.
- **O status é decidido pelo ESP32.** A API não recalcula a partir de `leitura`.
- **O cooldown conta desde a última notificação** (início ou lembrete), não desde a última leitura.
- **Tabelas criadas com `CREATE TABLE IF NOT EXISTS` no startup, sem migrações.** O schema é o mesmo que a versão Python cria (inclusive os nomes de índices e constraints), então as duas usam o mesmo banco.
- **`overrides` de `glob` no `package.json`:** força o `glob` 14 dentro do `@fastify/static` (usado pelo `/docs`), porque o `glob` 13 e o `minimatch` 10 têm vulnerabilidades no `npm audit`.

### Diferenças em relação à versão Python

Uma comparação automática passou 99 payloads pelos dois validadores: 97 deram o mesmo resultado. As duas diferenças são as duas primeiras linhas abaixo, de propósito.

| Situação | Versão Python | Esta versão |
|---|---|---|
| `"ts": "1757773327"` (número em texto) | aceita como timestamp Unix | rejeita: o contrato pede ISO 8601 |
| `dispositivo` com o caractere nulo (`\u0000`) | aceita na validação e falha ao gravar (`erro_gravacao`) | rejeita na validação (`invalido`) |
| `leitura` `742.0` ou `1e3` | rejeita | rejeita também. O `JSON.parse` do Node 24 entrega ao reviver o texto original de cada número (`context.source`), então dá para distinguir `742.0` de `742`. |
| precisão das datas | microssegundos | milissegundos (`Date` do JS); valores gravados pela versão Python aparecem truncados |
| datas nas respostas | `2026-09-13T14:22:07Z` | `2026-09-13T14:22:07.000Z` (as duas em ISO 8601, UTC) |
| `DATABASE_URL` | `postgresql+psycopg://` ou `sqlite://` | `postgresql+psycopg://`, `postgresql://` ou `postgres://`; SQLite não é suportado |
| textos dos erros (422 e logs) | inglês (Pydantic) | português, com a mesma estrutura (`detail`, `campo`/`erro`) |
| log por requisição HTTP | sim (uvicorn) | não (o healthcheck a cada 30 s encheria o log) |
| documentação | `/docs`, `/redoc`, `/openapi.json` | `/docs`, `/docs/json`, `/docs/yaml` |
| variável opcional `API_HOST` | não existe | interface onde a API escuta (padrão `0.0.0.0`) |

---

## Status

| Componente | Situação |
|---|---|
| Consumidor MQTT, lógica de alerta, API, simulador e testes | ✅ pronto |
| `mosquitto.conf` | ✅ validado num Mosquitto 2.1.2 real: autenticação, persistência e QoS 0 guardado com a API fora |
| `docker-compose.yml`, `Dockerfile`, `entrypoint.sh` | 🟡 prontos, mas escritos numa máquina sem Docker. Os passos do Dockerfile foram reproduzidos localmente. Falta rodar `npm run teste:integrado` numa máquina com Docker. |
| SQL do PostgreSQL | 🟡 DDL idêntico ao da versão Python. Falta rodar a suíte de contrato contra um Postgres real (`TEST_DATABASE_URL`). |
| Notificador Telegram | 🟡 interface pronta; o envio será implementado pelo colega das notificações |
