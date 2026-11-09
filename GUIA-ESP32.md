# Guia de teste com o ESP32

Este guia leva do zero até o teste completo do sistema com o hardware real: o ESP32 lê o sensor de gás, aciona o alarme local e publica as leituras no servidor (Mosquitto + API + PostgreSQL, no Docker).

O servidor pode rodar em dois lugares. Escolha um na seção 0 e siga só a parte correspondente da seção 2. O resto do guia é igual para os dois casos.

> As notificações pelo Telegram **não fazem parte deste teste**. O servidor fica com `NOTIFICADOR=log`: cada alerta aparece como uma linha `notificacao_log` no log da API e como um evento em `/eventos`.

**Duração estimada:** de 1h30 a 2h na primeira vez (instalações, montagem, aquecimento do sensor e testes).

---

## Sumário

0. [Escolha onde o servidor vai rodar](#0-escolha-onde-o-servidor-vai-rodar)
1. [Material necessário](#1-material-necessário)
2. [Preparar o servidor](#2-preparar-o-servidor)
   - [Opção A: no PC do Arthur](#opção-a-servidor-no-pc-do-arthur)
   - [Opção B: no PC do colega](#opção-b-servidor-no-pc-do-colega)
   - [2.3 Deixar o acompanhamento aberto](#23-deixar-o-acompanhamento-aberto-as-duas-opções)
3. [Preparar o Arduino IDE](#3-preparar-o-arduino-ide)
4. [Montar o circuito](#4-montar-o-circuito)
5. [Firmware](#5-firmware)
6. [Gravar e acompanhar no Serial Monitor](#6-gravar-e-acompanhar-no-serial-monitor)
7. [Calibrar o limite](#7-calibrar-o-limite)
8. [Roteiro de testes](#8-roteiro-de-testes)
9. [Problemas comuns](#9-problemas-comuns)
10. [O que enviar no final](#10-o-que-enviar-no-final)
11. [Encerrar](#11-encerrar)

---

## 0. Escolha onde o servidor vai rodar

O ESP32 precisa estar **na mesma rede Wi-Fi** que o computador do servidor, porque ele conecta direto no IP desse computador.

| | Opção A: PC do Arthur | Opção B: PC do colega |
|---|---|---|
| Quando usar | os dois se encontram, com o ESP32 e o notebook do Arthur | o colega testa sozinho, onde estiver |
| O que já está pronto | Docker instalado e servidor testado com o simulador | nada: precisa instalar Git, Node.js e Docker Desktop |
| Senha MQTT | a do `.env` do Arthur (ele informa pessoalmente) | o colega escolhe no `.env` dele |
| Tempo extra de preparo | ~10 min | ~40 min (downloads e reinicialização) |

> **Rede de faculdade, empresa ou "visitantes"** costuma bloquear a comunicação entre aparelhos (isolamento de clientes). Nesse caso, o ESP32 nunca acha o servidor. A saída é usar o **roteador do celular**: conecte o PC do servidor e o ESP32 no mesmo hotspot. O IP do PC muda, então refaça o passo do `ipconfig` e ajuste o firmware.
>
> O ESP32 só conecta em Wi-Fi **2,4 GHz**. Se o roteador tiver duas redes (ex.: "Casa" e "Casa_5G"), use a de 2,4 GHz. No hotspot do celular do iPhone, ative "Maximizar compatibilidade"; no Android, escolha a banda de 2,4 GHz.

---

## 1. Material necessário

**Hardware**

| Item | Observação |
|---|---|
| Placa **ESP32** (ex.: ESP32 DevKit V1) | Um Arduino Uno ou Nano comum **não serve**: não tem Wi-Fi. |
| Cabo USB **de dados** | Cabo só de carga não aparece como porta COM. |
| Módulo sensor **MQ-5** | O módulo com 4 pinos: VCC, GND, DO e AO. Só o AO é usado. |
| 1 resistor de **10 kΩ** e 1 de **20 kΩ** | Divisor de tensão da saída do sensor (seção 4). Sem resistor de 20 kΩ, use dois de 10 kΩ em série. |
| LED + resistor de **220 Ω** a **330 Ω** | É o aviso local de vazamento. |
| Buzzer (aviso sonoro) | **Opcional, ainda não faz parte da montagem.** O firmware já está preparado para ele (seção 5). |
| Protoboard e jumpers | |
| Isqueiro | Só para **soltar o gás sem acender** na calibração. |

**Software** (no PC que vai gravar o ESP32; pode ser o do Arthur ou o do colega)

- [Arduino IDE 2](https://www.arduino.cc/en/software)
- Driver USB da placa, se a porta não aparecer (seção 3)

**Do servidor**

- O **IP** do PC do servidor (seção 2)
- O **usuário** e a **senha MQTT** (`MQTT_USER` e `MQTT_PASSWORD` do `.env` desse PC)

---

## 2. Preparar o servidor

### Opção A: servidor no PC do Arthur

Tudo abaixo é feito **no notebook do Arthur**, com ele já conectado na rede onde o teste vai acontecer.

**A.1. Subir o servidor**

1. Abra o **Docker Desktop** e espere aparecer "Engine running" no canto inferior.
2. Num PowerShell, na pasta do projeto:
   ```powershell
   docker compose up -d
   docker compose ps
   ```
   Os três serviços devem aparecer como `Up`, e `api` e `postgres` como `(healthy)`. A API pode levar até ~40 s para ficar `healthy`.
3. Abra <http://localhost:8000/health> no navegador. O esperado é:
   ```json
   {"api":"ok","banco":"ok","mqtt":"conectado"}
   ```

**A.2. Conferir que o Mosquitto do Windows está parado**

O notebook tem o Mosquitto instalado também como serviço do Windows. Se ele estiver ligado, disputa a porta 1883 com o Docker.

```powershell
Get-Service mosquitto
```

O esperado é `Stopped`. Se aparecer `Running`, abra um PowerShell **como administrador** e rode:

```powershell
Stop-Service mosquitto; Set-Service mosquitto -StartupType Manual
```

**A.3. Marcar a rede como Privada**

Na última verificação, o Wi-Fi deste notebook estava como **Pública**, e nesse modo o Windows bloqueia conexões vindas de outros aparelhos.

1. Configurações → **Rede e Internet** → **Wi-Fi** → clique no nome da rede conectada.
2. Em "Tipo de perfil de rede", escolha **Rede privada**.

Para conferir, num PowerShell:

```powershell
Get-NetConnectionProfile | ForEach-Object { "$($_.InterfaceAlias): $($_.NetworkCategory)" }
```

O esperado é `Wi-Fi: Private`.

> Isso vale para cada rede: se trocar para o hotspot do celular, marque o hotspot como Privada também.

**A.4. Liberar a porta 1883 no firewall** (uma vez só)

Num PowerShell **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "MQTT 1883" -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private
```

Opcional, para o colega abrir a API no navegador dele:

```powershell
New-NetFirewallRule -DisplayName "API Gas 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

**A.5. Anotar o IP**

```powershell
ipconfig
```

Procure o bloco **"Adaptador de Rede sem Fio Wi-Fi"** e anote o **Endereço IPv4**. Na última verificação era `192.168.15.4`, mas ele muda de rede para rede: **confira sempre**.

**A.6. Passar ao colega**

- o IP do passo A.5;
- o usuário MQTT (`gas`) e a senha MQTT (a `MQTT_PASSWORD` do `.env`), **pessoalmente ou por mensagem privada**.

Pule para a [seção 2.3](#23-deixar-o-acompanhamento-aberto-as-duas-opções).

---

### Opção B: servidor no PC do colega

Tudo abaixo é feito **no PC do colega** (Windows 10 ou 11).

**B.1. Instalar os programas**

| Programa | Onde baixar | Observação |
|---|---|---|
| Git | <https://git-scm.com/download/win> | pode avançar com as opções padrão |
| Node.js 24 ou mais novo | <https://nodejs.org> (versão LTS) | usado pelo simulador e pelo teste automático |
| Docker Desktop | <https://www.docker.com/products/docker-desktop/> | deixe marcado "Use WSL 2 instead of Hyper-V" |

Depois do Docker Desktop:

1. Se o instalador pedir para instalar ou atualizar o WSL, aceite. Se aparecer erro de WSL, rode num PowerShell **como administrador**: `wsl --update`.
2. **Reinicie o computador.**
3. Abra o Docker Desktop e espere "Engine running". Se aparecer um erro de **virtualização**, ela precisa ser ativada na BIOS (o nome costuma ser "Intel VT-x", "Intel Virtualization Technology" ou "AMD SVM").
4. Abra um PowerShell **novo** e confira:
   ```powershell
   git --version
   node -v                 # v24 ou mais
   docker version
   docker compose version
   ```

**B.2. Baixar o projeto**

```powershell
cd $HOME\Documents
git clone https://github.com/ArthurAgDuarte/trabalho-integracao.git
cd trabalho-integracao
npm install
```

**B.3. Criar o `.env`**

```powershell
copy .env.example .env
notepad .env
```

Troque **só** estas linhas (os nomes `mosquitto` e `@postgres` devem ficar como estão):

```ini
MQTT_PASSWORD=EscolhaUmaSenhaMqtt
POSTGRES_PASSWORD=EscolhaUmaSenhaBanco
DATABASE_URL=postgresql+psycopg://gas:EscolhaUmaSenhaBanco@postgres:5432/gas
```

- As senhas são escolhidas por você. Use **só letras, números, `-` e `_`**. Outros caracteres (`$ @ : / ? # " \`) quebram o Docker, a URL do banco ou o código do ESP32.
- A senha do banco aparece **duas vezes** e precisa ser igual nas duas.
- Anote a `MQTT_PASSWORD`: ela vai no firmware (seção 5).
- O `.env` nunca deve ir para o git (ele já está no `.gitignore`).

**B.4. Se o Mosquitto também estiver instalado no Windows**

```powershell
Get-Service mosquitto
```

- Se aparecer erro dizendo que o serviço não existe: ótimo, siga em frente.
- Se aparecer `Running`: num PowerShell **como administrador**, rode `Stop-Service mosquitto; Set-Service mosquitto -StartupType Manual`. Sem isso, o simulador publica no broker errado e o teste do passo B.6 falha.

**B.5. Subir o servidor**

```powershell
docker compose up -d --build
```

Na primeira vez, ele baixa as imagens e monta a da API (alguns minutos). Depois:

```powershell
docker compose ps
```

Os três serviços devem aparecer como `Up`, e `api` e `postgres` como `(healthy)`. Abra <http://localhost:8000/health>. O esperado é `{"api":"ok","banco":"ok","mqtt":"conectado"}`.

**B.6. Testar o servidor sem o ESP32**

```powershell
npm run teste:integrado -- --sem-compose
```

O esperado é terminar com `TESTE INTEGRADO PASSOU`. Se falhar, resolva antes de seguir (veja a [seção 9](#9-problemas-comuns)): não adianta testar o ESP32 com o servidor com problema.

**B.7. Rede, firewall e IP**

Siga os passos [A.3](#opção-a-servidor-no-pc-do-arthur) (rede Privada), A.4 (firewall) e A.5 (IP) da opção A, agora no seu PC.

---

### 2.3 Deixar o acompanhamento aberto (as duas opções)

No PC do servidor, abra **dois** PowerShell na pasta do projeto e deixe-os rodando durante todo o teste:

**Terminal 1: conexões no broker**
```powershell
docker compose logs -f --tail 20 mosquitto
```

**Terminal 2: o que a API faz com cada mensagem**
```powershell
docker compose logs -f --tail 20 api
```

Para ver só as linhas importantes no Terminal 2:
```powershell
docker compose logs -f --tail 20 api | Select-String "gravado|invalido|alerta_disparado|notificacao_log|erro"
```

E deixe estas páginas abertas no navegador (atualize com F5):

| Página | O que mostra |
|---|---|
| <http://localhost:8000/health> | se a API, o banco e o MQTT estão ok |
| <http://localhost:8000/leituras/ultimas> | a última leitura de cada sensor |
| <http://localhost:8000/leituras?dispositivo=esp32-cozinha&limite=20> | as últimas 20 leituras do ESP32 |
| <http://localhost:8000/eventos> | os alertas criados |

> Os horários do servidor estão em **UTC** (Brasília = UTC − 3).

**Teste opcional da porta pela rede.** Se houver **outro** computador Windows na mesma rede, rode nele:
```powershell
Test-NetConnection <IP-do-servidor> -Port 1883
```
O esperado é `TcpTestSucceeded : True`. Rodar esse comando no próprio PC do servidor não prova nada, porque o firewall não filtra o tráfego local. Sem outro computador, o teste 1 da seção 8 faz essa verificação.

---

## 3. Preparar o Arduino IDE

1. Instale e abra o **Arduino IDE 2**.
2. **Pacote do ESP32:** menu lateral **Boards Manager** (ícone de placa) → pesquise `esp32` → instale **"esp32 by Espressif Systems"**.
   - Se não aparecer: **File → Preferences → Additional boards manager URLs**, cole `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, confirme e pesquise de novo.
3. **Biblioteca MQTT:** menu lateral **Library Manager** → pesquise `PubSubClient` → instale a de **Nick O'Leary**.
4. Conecte o ESP32 no USB.
5. **Tools → Board → esp32 → ESP32 Dev Module.**
6. **Tools → Port:** escolha a porta COM que apareceu ao conectar a placa.
   - **Nenhuma porta nova?** Primeiro, troque o cabo (muitos cabos são só de carga). Depois, instale o driver do chip USB da placa, que vem escrito perto do conector:
     - **CP2102**: driver "CP210x" da Silicon Labs;
     - **CH340**: driver "CH340" da WCH.

     Desconecte e conecte de novo.

---

## 4. Montar o circuito

> ⚠️ **Monte com a placa desconectada do USB.**

### Ligações

| De | Para | Observação |
|---|---|---|
| Sensor **VCC** | ESP32 **VIN** (ou **5V**) | o aquecedor do sensor precisa de 5 V |
| Sensor **GND** | ESP32 **GND** | |
| Sensor **AO** | divisor de tensão → ESP32 **GPIO 34** | veja abaixo; **nunca** ligue o AO direto |
| Sensor **DO** | (não ligar) | |
| LED **ânodo** (perna longa) | resistor 220 Ω → ESP32 **GPIO 23** | |
| LED **cátodo** (perna curta) | ESP32 **GND** | |
| Buzzer (opcional, futuro) | **+** num GPIO livre (ex.: 25), **−** no GND | ainda não montado |

**Por que o GPIO 34?** Ele é do **ADC1** (pinos 32 a 39). Os pinos do ADC2 não funcionam enquanto o Wi-Fi está ligado.

### Divisor de tensão: confira se existe

O módulo MQ-5 é alimentado com 5 V, e com bastante gás a saída AO pode subir acima de 3,3 V. O pino do ESP32 é feito para no máximo 3,3 V: **acima disso, ele pode ser danificado**. Em ar limpo a tensão é baixa (por isso as leituras de 112 a 128 não dizem nada sobre o divisor). O risco aparece justamente nos testes com gás.

**Como saber se a montagem atual tem o divisor:**

1. **Olhe o fio que sai do pino AO do sensor.**
   - Se ele vai **direto** para o GPIO 34 (um jumper só, sem resistores no caminho), **não há divisor**.
   - Se ele passa por um resistor até o GPIO 34, e desse ponto sai outro resistor para o GND (como no desenho abaixo), **há divisor**.
2. **Com multímetro (opcional):** meça a tensão entre o AO e o GND enquanto solta gás do isqueiro apagado. Se passar de 3,3 V, o divisor é necessário.
3. **Pelo Serial:** se, com gás, a leitura chega a **4095** (o máximo), a tensão no pino chegou ao limite de medição do ESP32 e provavelmente passou de 3,3 V.

**Se não houver divisor, monte assim** (com o USB desconectado):

```
Sensor AO ──[ 10 kΩ ]──┬──► GPIO 34
                       │
                    [ 20 kΩ ]
                       │
                      GND
```

Com 5 V na saída do sensor, chegam ~3,3 V no GPIO 34. Sem resistor de 20 kΩ, use dois de 10 kΩ em série no lugar dele.

> ⚠️ **O divisor muda as leituras.** Todos os valores caem para cerca de 2/3: o ar limpo passa de ~112–128 para ~75–85, e o vazamento que antes passava de 900 passa a ficar por volta de 600. **Depois de montar o divisor, refaça a calibração** (seção 7) antes dos testes; com o `LIMITE` em 900, o alarme pode deixar de disparar.

### Antes de ligar o USB

- [ ] o AO do sensor passa pelo divisor (ou você anotou que ainda não há divisor, para informar no relatório);
- [ ] todos os GND estão ligados entre si;
- [ ] o LED está com o resistor e na posição certa (perna longa no GPIO 23).

---

## 5. Firmware

Este código **substitui o sketch que já funciona na placa**. Ele mantém os mesmos pinos (MQ-5 no P34, LED no P23), o mesmo `LIMITE` (900), a mesma `MARGEM` (15) e a mesma lógica de alerta. A diferença é que acrescenta o Wi-Fi e o envio das leituras ao servidor via MQTT.

1. **Guarde o sketch atual** (File → Save As, com outro nome) para poder voltar a ele se precisar.
2. No Arduino IDE: **File → New Sketch**.
3. Apague o conteúdo, cole o código abaixo e salve como `esp32_gas`.
4. Troque os valores marcados com `TROCAR` no topo:
   - `WIFI_SSID` e `WIFI_SENHA`: a rede 2,4 GHz onde o PC do servidor está;
   - `MQTT_HOST`: o IP anotado no passo A.5;
   - `MQTT_SENHA`: a `MQTT_PASSWORD` do `.env` do servidor.

```cpp
// Sistema de Detecção e Alerta de Vazamento de Gás: firmware do ESP32.
// Bibliotecas: pacote "esp32 by Espressif Systems" e "PubSubClient" (Nick O'Leary).
#include <WiFi.h>
#include <PubSubClient.h>
#include <time.h>

// ================= CONFIGURAÇÃO =================
const char* WIFI_SSID     = "NomeDaRede";        // TROCAR: rede Wi-Fi 2,4 GHz
const char* WIFI_SENHA    = "SenhaDaRede";       // TROCAR
const char* MQTT_HOST     = "192.168.15.4";      // TROCAR: IP do PC do servidor (ipconfig)
const uint16_t MQTT_PORTA = 1883;
const char* MQTT_USUARIO  = "gas";               // MQTT_USER do .env
const char* MQTT_SENHA    = "senha-do-env";      // TROCAR: MQTT_PASSWORD do .env
const char* DISPOSITIVO   = "esp32-cozinha";     // único por placa
const char* TOPICO        = "casa/cozinha/gas";  // casa/<comodo>/gas

const int MQ5_PIN    = 34;   // P34: leitura do MQ-5 (ADC1, 32 a 39: o ADC2 não funciona com o Wi-Fi ligado)
const int LED_PIN    = 23;   // P23: LED externo
const int BUZZER_PIN = -1;   // sem buzzer por enquanto; quando montar, coloque o pino (ex.: 25)

// Calibração com o isqueiro apagado: em ar limpo, leituras entre 112 e 128;
// com gás, passam de 900. Se montar o divisor de tensão, recalibre (seção 7 do guia).
const int LIMITE = 900;      // acima disto: ALERTA (status VAZAMENTO)
const int MARGEM = 15;       // volta ao NORMAL só abaixo de LIMITE - MARGEM (evita pisca-pisca)

const unsigned long AQUECIMENTO_MS     = 60000;  // 1 min sem alerta nem envio: o aquecedor do MQ-5 estabilizando
const unsigned long INTERVALO_ENVIO_MS = 2000;   // publica a cada 2 s (e na hora, se o status mudar)
const unsigned long INTERVALO_LOOP_MS  = 500;    // uma leitura a cada 0,5 s
// ================================================

WiFiClient wifi;
PubSubClient mqtt(wifi);
bool alertaAtivo = false;
bool aquecido = false;
unsigned long ultimoEnvio = 0, ultimaTentativaMqtt = 0;

// Traduz o código de mqtt.state() para facilitar o diagnóstico.
const char* explicarEstadoMqtt(int estado) {
  switch (estado) {
    case -4: return "tempo esgotado";
    case -3: return "conexão perdida";
    case -2: return "servidor inacessível: IP, firewall, rede Pública ou isolamento da rede";
    case -1: return "desconectado";
    case 4:  return "usuário ou senha MQTT incorretos";
    case 5:  return "não autorizado: usuário ou senha MQTT incorretos";
    default: return "ver tabela de códigos da PubSubClient";
  }
}

void publicar(int leitura) {
  char payload[160];
  struct tm agora;
  const char* status = alertaAtivo ? "VAZAMENTO" : "NORMAL";
  if (getLocalTime(&agora, 0)) {             // tem hora do NTP: envia ts em UTC
    char ts[25];
    strftime(ts, sizeof ts, "%Y-%m-%dT%H:%M:%SZ", &agora);
    snprintf(payload, sizeof payload,
             "{\"dispositivo\":\"%s\",\"leitura\":%d,\"status\":\"%s\",\"ts\":\"%s\"}",
             DISPOSITIVO, leitura, status, ts);
  } else {                                   // sem NTP: ts é opcional
    snprintf(payload, sizeof payload,
             "{\"dispositivo\":\"%s\",\"leitura\":%d,\"status\":\"%s\"}",
             DISPOSITIVO, leitura, status);
  }
  bool ok = mqtt.publish(TOPICO, payload);
  Serial.printf("  -> %s %s\n", ok ? "publicado:" : "FALHA ao publicar:", payload);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  if (BUZZER_PIN >= 0) {
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
  }
  analogReadResolution(12);                  // 0 a 4095

  Serial.printf("\nIniciando %s. Wi-Fi: %s. Broker: %s:%u\n", DISPOSITIVO, WIFI_SSID, MQTT_HOST, MQTT_PORTA);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);         // conecta em segundo plano, durante o aquecimento
  configTime(0, 0, "pool.ntp.org");          // hora em UTC
  mqtt.setServer(MQTT_HOST, MQTT_PORTA);

  // Sem delay(60000) aqui: o aquecimento é contado no loop, para o Wi-Fi e o MQTT
  // já irem conectando enquanto o sensor estabiliza.
  Serial.println("Aquecendo o sensor (60 s)...");
}

void loop() {
  int leitura = analogRead(MQ5_PIN);
  bool aquecendo = millis() < AQUECIMENTO_MS;
  if (!aquecendo && !aquecido) {
    aquecido = true;
    Serial.println("Monitoramento iniciado.");
  }

  // 1) Alarme local (mesma lógica do sketch testado): decide e aciona SEMPRE, com ou sem rede.
  bool anterior = alertaAtivo;
  if (aquecendo) {
    alertaAtivo = false;
  } else if (leitura > LIMITE) {
    alertaAtivo = true;
  } else if (leitura < LIMITE - MARGEM) {
    alertaAtivo = false;
  }
  bool mudou = (alertaAtivo != anterior);
  digitalWrite(LED_PIN, alertaAtivo ? HIGH : LOW);
  if (BUZZER_PIN >= 0) {
    digitalWrite(BUZZER_PIN, alertaAtivo ? HIGH : LOW);  // buzzer ativo; passivo: tone()/noTone()
  }

  // 2) Diagnóstico no Serial Monitor (115200 baud), no mesmo formato do sketch anterior.
  Serial.printf("MQ-5: %d | %s | wifi=%s | mqtt=%s%s\n",
                leitura, alertaAtivo ? "ALERTA" : "NORMAL",
                WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "desconectado",
                mqtt.connected() ? "ok" : "desconectado",
                aquecendo ? " | aquecendo" : "");

  // 3) Rede: tenta reconectar a cada 5 s, sem travar o loop com while.
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected() && millis() - ultimaTentativaMqtt > 5000) {
      ultimaTentativaMqtt = millis();
      Serial.printf("MQTT: conectando em %s:%u...\n", MQTT_HOST, MQTT_PORTA);
      if (mqtt.connect(DISPOSITIVO, MQTT_USUARIO, MQTT_SENHA)) {
        Serial.println("MQTT: conectado");
      } else {
        Serial.printf("MQTT: falhou, estado %d (%s)\n", mqtt.state(), explicarEstadoMqtt(mqtt.state()));
      }
    }
    mqtt.loop();
  }

  // 4) Publica periodicamente, e na hora se o status mudou.
  if (!aquecendo && mqtt.connected() && (mudou || millis() - ultimoEnvio >= INTERVALO_ENVIO_MS)) {
    publicar(leitura);
    ultimoEnvio = millis();
  }

  delay(INTERVALO_LOOP_MS);
}
```

**Observações sobre o código**

- **O que mudou em relação ao sketch anterior:** o Wi-Fi, o MQTT e a função `publicar`. O aquecimento continua sendo de 60 s, mas agora é contado no `loop` em vez de um `delay(60000)` no `setup`, para a placa já ir conectando na rede. A lógica do LED (`> LIMITE` liga, `< LIMITE - MARGEM` desliga) é a mesma.
- **Buzzer (quando houver):** troque `BUZZER_PIN = -1` pelo pino usado (ex.: `25`). Buzzer ativo: não precisa mudar mais nada. Buzzer passivo: troque a linha do `digitalWrite(BUZZER_PIN, ...)` por `if (alertaAtivo) tone(BUZZER_PIN, 2000); else noTone(BUZZER_PIN);`.
- **Aquecimento:** no primeiro minuto depois de ligar, o alerta fica desativado e nada é publicado, porque a leitura de um MQ-5 frio vem alta e geraria falso alarme. O Serial mostra `| aquecendo` nesse período e `Monitoramento iniciado.` quando ele termina.
- **`MARGEM` de 15:** é pequena (o LED apaga abaixo de 885). Se nos testes o status ficar alternando entre ALERTA e NORMAL perto do limite, aumente para `50`.
- **`ts` (horário):** o ESP32 busca a hora na internet (NTP). Se a rede não tiver internet, o `ts` é omitido, o que o servidor aceita.
- **Servidor inacessível:** cada tentativa de conexão MQTT pode travar o loop por alguns segundos. O alarme local continua funcionando, mas pode reagir com alguns segundos de atraso enquanto o servidor estiver fora.
- **Um segundo ESP32:** use outro `DISPOSITIVO` e outro `TOPICO` (ex.: `esp32-area-servico` e `casa/area-servico/gas`). O servidor não precisa de mudança.

**Regras do servidor que o código já cumpre** (caso alguém altere o payload): `leitura` precisa ser um número **inteiro** de 0 a 4095; `status` precisa ser exatamente `"NORMAL"` ou `"VAZAMENTO"`; campos além de `dispositivo`, `leitura`, `status` e `ts` fazem a mensagem ser rejeitada.

---

## 6. Gravar e acompanhar no Serial Monitor

1. Clique em **Upload** (seta para a direita). A primeira compilação demora.
2. Se a gravação parar em `Connecting........_____`, **segure o botão BOOT** da placa até a porcentagem começar a subir e solte.
3. Ao terminar (`Hard resetting via RTS pin...`), abra **Tools → Serial Monitor** e ajuste a velocidade para **115200 baud** (canto superior direito).
4. Aperte o botão **EN** (ou **RST**) da placa para reiniciá-la e ver as mensagens desde o início.

O esperado, nos primeiros segundos:

```
Iniciando esp32-cozinha. Wi-Fi: NomeDaRede. Broker: 192.168.15.4:1883
Aquecendo o sensor (60 s)...
MQ-5: 640 | NORMAL | wifi=desconectado | mqtt=desconectado | aquecendo
MQ-5: 590 | NORMAL | wifi=192.168.15.23 | mqtt=desconectado | aquecendo
MQTT: conectando em 192.168.15.4:1883...
MQTT: conectado
MQ-5: 410 | NORMAL | wifi=192.168.15.23 | mqtt=ok | aquecendo
```

Depois de 1 minuto, aparece `Monitoramento iniciado.`, o `| aquecendo` some e começam as publicações (uma a cada ~2 s):

```
Monitoramento iniciado.
MQ-5: 121 | NORMAL | wifi=192.168.15.23 | mqtt=ok
  -> publicado: {"dispositivo":"esp32-cozinha","leitura":121,"status":"NORMAL","ts":"2026-11-07T14:22:07Z"}
MQ-5: 118 | NORMAL | wifi=192.168.15.23 | mqtt=ok
```

Os valores durante o aquecimento são só um exemplo. Em ar limpo, depois de aquecido, o esperado é algo perto de 112 a 128 (sem divisor de tensão).

> **Mantenha a placa ligada no USB** durante todo o teste: ela é alimentada por ele, e o Serial Monitor é a principal ferramenta de diagnóstico.

---

## 7. Calibrar o limite

**Já foi feita uma calibração** com o sketch anterior e o isqueiro apagado:

| Medição | Valor |
|---|---|
| Ar limpo | 112 a 128 |
| Com gás | acima de 900 |
| `LIMITE` | 900 |
| `MARGEM` | 15 (o LED apaga abaixo de 885) |

Esses valores já estão no firmware da seção 5. **Só refaça a calibração** se:
- montar o divisor de tensão (seção 4), porque todas as leituras caem para cerca de 2/3;
- trocar o sensor;
- o alerta disparar sem gás, ou não disparar com gás.

**Como refazer:**

1. **Aqueça o sensor.** Deixe a placa ligada por pelo menos **5 minutos**. No primeiro uso de um sensor novo, a leitura só estabiliza de verdade depois de 24 a 48 horas ligado; para este teste, alguns minutos bastam, mas a leitura em ar limpo pode continuar caindo devagar.
2. **Valor em ar limpo.** Com o ambiente ventilado, observe o `MQ-5:` no Serial Monitor por ~30 s e anote o **maior** valor.
3. **Valor com gás.** ⚠️ Com o **isqueiro apagado**, aperte só o botão do gás, sem girar a pedra, a 2 ou 3 cm do sensor, por 2 a 3 segundos. Anote o **maior** valor.
4. **Escolha o limite** num ponto entre os dois, abaixo do pico com gás, para o alerta disparar com folga. Uma regra simples:
   ```
   LIMITE = ar_limpo + (gas - ar_limpo) / 3
   ```
   Exemplo com divisor: ar limpo `85`, gás `1500` → `85 + (1500 - 85) / 3 ≈ 555`.
5. **Ajuste a margem.** Se no teste o status ficar alternando entre ALERTA e NORMAL, aumente (ex.: `50`).
6. Altere `LIMITE` e `MARGEM` no código e grave de novo (seção 6).
7. **Anote os valores:** ar limpo, gás, `LIMITE` e `MARGEM` (entram no relatório da seção 10).

> ⚠️ **Segurança:** nunca acenda o isqueiro perto do circuito. Use pouco gás, em ambiente ventilado, e espere o cheiro sumir entre os testes.

---

## 8. Roteiro de testes

Faça na ordem. Cada teste diz **o que fazer**, **onde olhar** e **o que é esperado**. Marque o resultado na tabela da [seção 10](#10-o-que-enviar-no-final).

### Teste 1: conexão do ESP32 ao broker

**Fazer:** ligar a placa (ou apertar EN) com o firmware gravado.

**Esperado:**
- **Serial Monitor:** `wifi=<IP da placa>` e depois `MQTT: conectado`.
- **Terminal 1 (mosquitto):**
  ```
  New client connected from 192.168.15.23:xxxxx as esp32-cozinha (p4, c1, k15, u'gas').
  ```

**Se falhar:** o Serial mostra o motivo.

| Serial Monitor | Causa | Solução |
|---|---|---|
| `wifi=desconectado` o tempo todo | nome ou senha do Wi-Fi errados, ou rede de 5 GHz | corrija `WIFI_SSID`/`WIFI_SENHA`; use uma rede 2,4 GHz |
| `estado -2 (servidor inacessível...)` | IP errado, firewall, rede Pública ou isolamento | confira o IP (`ipconfig`), a rede Privada (A.3) e a regra de firewall (A.4); tente o hotspot do celular |
| `estado 4` ou `5`, e o Terminal 1 mostra `not authorised` | senha MQTT diferente da do `.env` | corrija `MQTT_SENHA` no firmware e grave de novo |

### Teste 2: leituras chegando e sendo gravadas

**Fazer:** esperar o fim do aquecimento (1 min após ligar).

**Esperado:**
- **Serial:** uma linha `-> publicado:` a cada ~2 s.
- **Terminal 2 (api):** a cada ~2 s, um par de linhas com `"acao":"recebido"` e `"acao":"gravado"`, com `"dispositivo":"esp32-cozinha"`.
- **<http://localhost:8000/leituras/ultimas>:** o `esp32-cozinha` aparece, e o `recebido_em` muda a cada F5.
- **<http://localhost:8000/leituras?dispositivo=esp32-cozinha&limite=20>:** os valores de `leitura` batem com o Serial. Se a rede tiver internet, `ts_dispositivo` vem preenchido.

**Se falhar:**
- `-> FALHA ao publicar` no Serial: a conexão MQTT caiu. Volte ao teste 1.
- `"acao":"invalido"` no Terminal 2: o campo `erro` diz o que está fora do padrão (o firmware foi alterado?).
- Nada no Terminal 2, mas o Serial mostra `publicado`: o ESP32 está publicando em outro broker. Confira o `MQTT_HOST` e, no PC do servidor, se o Mosquitto do Windows está parado (A.2/B.4).

### Teste 3: conferir a calibração

**Fazer:** com o sensor aquecido, observar o `MQ-5:` no Serial por ~30 s em ar limpo.

**Esperado:** valores perto de 112 a 128 (sem divisor) e `NORMAL`. Se estiverem bem diferentes, ou se o divisor tiver sido montado, refaça a calibração ([seção 7](#7-calibrar-o-limite)) e repita rapidamente os testes 1 e 2.

### Teste 4: detecção de vazamento

**Fazer:** com o **isqueiro apagado**, soltar gás perto do sensor por 2 a 3 segundos.

**Esperado:**
- **Na placa:** o **LED acende na hora**, assim que a leitura passa de 900 (`LIMITE`).
- **Serial:** `| ALERTA` e uma publicação imediata com `"status":"VAZAMENTO"`.
- **Terminal 2:** uma linha `"acao":"alerta_disparado"` com `"tipo":"INICIO_VAZAMENTO"`, seguida de uma linha `"acao":"notificacao_log"` com o texto `🚨 VAZAMENTO DE GÁS detectado em cozinha!`.
- **<http://localhost:8000/eventos>:** um evento novo `INICIO_VAZAMENTO` com `"notificado": true` e `"erro_notificacao": null`.
- Enquanto o gás continuar, as leituras seguem sendo gravadas, mas **não** aparecem novos `INICIO_VAZAMENTO` (anti-spam).

**Se falhar:**
- O LED não acende: veja no Serial se a leitura passou de 900. Se passou e o Serial mostra `ALERTA`, confira a ligação do LED (GPIO 23, resistor, posição das pernas). Se não passou, aproxime mais o gás ou recalibre (seção 7).
- O LED acende, mas não aparece evento: veja o teste 2.

### Teste 5: normalização

**Fazer:** afastar o isqueiro e ventilar (abanar ou esperar). O sensor pode levar de 30 s a alguns minutos para voltar.

**Esperado:**
- **Na placa:** o LED **apaga** quando a leitura cai abaixo de 885 (`LIMITE - MARGEM`). O Serial volta a mostrar `| NORMAL`.
- **Terminal 2:** `"tipo":"NORMALIZADO"` e `notificacao_log` com `✅ Nível de gás normalizado em cozinha.`.
- **/eventos:** um evento `NORMALIZADO`.

**Se falhar:** se aparecerem vários `INICIO_VAZAMENTO` e `NORMALIZADO` seguidos, a leitura está oscilando perto do limite. Aumente a `MARGEM` (ex.: de 15 para 50) e grave de novo.

### Teste 6 (opcional): lembrete de vazamento contínuo

Por padrão, o lembrete sai a cada 5 minutos de vazamento contínuo. Para testar rápido:

1. No `.env` do servidor, mude `ALERTA_COOLDOWN_SEGUNDOS=300` para `ALERTA_COOLDOWN_SEGUNDOS=30`.
2. Rode `docker compose up -d`. A API é recriada com o valor novo. Espere o `/health` voltar a responder ok.
3. Mantenha o sensor em vazamento por ~1 minuto, soltando gás de vez em quando.

**Esperado:** em `/eventos`, um `INICIO_VAZAMENTO` e depois um `LEMBRETE` a cada ~30 s, **não** um por leitura.

4. **Volte** o valor para `300` e rode `docker compose up -d` de novo.

### Teste 7: a API cai durante um vazamento

Mostra que o alarme local não depende do servidor e que nada se perde quando a API volta.

1. Provoque um vazamento (teste 4) e espere o `INICIO_VAZAMENTO` aparecer em `/eventos`.
2. No PC do servidor: `docker compose stop api`.
3. Continue soltando gás por ~20 s.
   - **Esperado:** o **LED continua aceso**. O Serial continua mostrando `mqtt=ok` e `publicado`, porque o broker continua no ar e guarda as mensagens.
4. `docker compose start api` e espere ~20 s.
5. **Esperado:**
   - em `/leituras?dispositivo=esp32-cozinha&limite=50`, as leituras do período em que a API ficou fora aparecem, com `recebido_em` todos próximos do momento em que ela voltou;
   - em `/eventos`, **não** aparece um segundo `INICIO_VAZAMENTO` para o mesmo vazamento. A API lembrou que já havia um vazamento em andamento.
6. Deixe normalizar: deve aparecer o `NORMALIZADO`.

### Teste 8: o broker ou o Wi-Fi caem

**8a. Broker fora**
1. `docker compose stop mosquitto`.
   - **Esperado:** o Serial mostra `mqtt=desconectado` e uma nova tentativa a cada 5 s. Com gás, o **alarme local continua funcionando**.
2. `docker compose start mosquitto`.
   - **Esperado:** em até ~10 s, o Serial mostra `MQTT: conectado` e as publicações voltam. O Terminal 1 mostra a reconexão do `esp32-cozinha`, e o `/health` volta a mostrar `"mqtt":"conectado"`. A API também reconecta sozinha.

**8b. Wi-Fi fora**
1. Desligue o roteador ou o hotspot do celular por ~30 s.
   - **Esperado:** `wifi=desconectado` no Serial, e o alarme local continua funcionando.
2. Ligue de novo.
   - **Esperado:** o ESP32 volta a conectar sozinho, sem precisar apertar EN. Se a rede for o hotspot, confira se o IP do PC do servidor não mudou (`ipconfig`).

> As leituras feitas enquanto o Wi-Fi ou o broker estavam fora **não** são guardadas pelo ESP32. É uma limitação conhecida do projeto.

### Teste 9: reinício da placa

**Fazer:** apertar o botão **EN** da placa.

**Esperado:** a placa reinicia, passa 1 minuto em aquecimento, reconecta sozinha (Terminal 1 mostra a conexão) e volta a publicar.

---

## 9. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| Arduino IDE não mostra porta COM | cabo só de carga ou falta de driver | troque o cabo; instale o driver CP210x ou CH340 (seção 3) |
| Gravação para em `Connecting....____` | a placa não entrou em modo de gravação | segure o botão **BOOT** durante o `Connecting` |
| Serial Monitor mostra caracteres estranhos | velocidade errada | ajuste para **115200 baud** |
| Leitura sempre `0` | AO desligado ou divisor errado | confira as ligações do sensor e do divisor |
| Leitura chega a `4095` com gás | a tensão no pino chegou ao limite; provavelmente não há divisor, ou ele está invertido | **desligue o USB** e confira o divisor (seção 4: 10 kΩ do lado do sensor, 20 kΩ para o GND) |
| Leitura alta logo ao ligar | sensor aquecendo | é normal; espere alguns minutos |
| LED não apaga | a leitura em ar limpo não voltou abaixo de `LIMITE - MARGEM` | ventile e espere; se continuar, recalibre (seção 7) |
| Com o divisor montado, o LED não acende mais com gás | as leituras caíram para ~2/3 e não passam mais de 900 | recalibre (seção 7) |
| `estado -2` no Serial | o ESP32 não alcança o PC do servidor | IP, rede Privada, firewall, mesma rede, rede de visitante (use o hotspot) |
| `not authorised` no log do mosquitto | senha MQTT diferente | a `MQTT_SENHA` do firmware deve ser igual à `MQTT_PASSWORD` do `.env` |
| `docker compose up` falha com "port is already allocated" | Mosquitto do Windows ligado | `Stop-Service mosquitto` como administrador (A.2) |
| `/health` com `"mqtt":"desconectado"` | broker parado ou senha da API errada | `docker compose ps`; `docker compose logs api` (procure `mqtt_recusado`) |
| `/health` com `"banco":"erro"` | banco parado ou senha da `DATABASE_URL` diferente da `POSTGRES_PASSWORD` | `docker compose ps`; confira o `.env` |
| `"acao":"invalido"` no log da API | payload fora do padrão | o campo `erro` diz qual campo; volte ao firmware original da seção 5 |
| Horários com 3 h de diferença | o servidor usa UTC | é o esperado: Brasília = UTC − 3 |
| Duas leituras iguais no histórico | reentrega do MQTT numa reconexão | é esperado e raro; não afeta os alertas |

Para ver o motivo de qualquer erro da API: `docker compose logs --tail 50 api`. A última linha com `"nivel":"ERROR"` ou `"WARNING"` traz o campo `erro`.

---

## 10. O que enviar no final

**Resultado dos testes**

| # | Teste | Passou? | Observação |
|---|---|---|---|
| 1 | Conexão ao broker | ☐ | |
| 2 | Leituras gravadas | ☐ | |
| 3 | Conferência da calibração | ☐ | |
| 4 | Detecção de vazamento (LED + `INICIO_VAZAMENTO`) | ☐ | |
| 5 | Normalização (`NORMALIZADO`) | ☐ | |
| 6 | Lembrete (opcional) | ☐ | |
| 7 | API fora durante vazamento | ☐ | |
| 8a | Broker fora | ☐ | |
| 8b | Wi-Fi fora | ☐ | |
| 9 | Reinício da placa | ☐ | |

**Montagem e calibração** (já preenchido com a calibração anterior; corrija se mudou)
- Sensor: MQ-5 no GPIO 34; LED no GPIO 23; buzzer: não há
- Divisor de tensão: ☐ sim ☐ não ☐ não sei
- Leitura em ar limpo: 112 a 128
- Leitura com gás (pico): ____
- `LIMITE`: 900 e `MARGEM`: 15

**Evidências**
- [ ] print do Serial Monitor mostrando `MQTT: conectado`, algumas publicações e uma linha com `ALERTA`;
- [ ] print de <http://localhost:8000/eventos> com `INICIO_VAZAMENTO` e `NORMALIZADO`;
- [ ] print de <http://localhost:8000/leituras/ultimas>;
- [ ] trecho do log da API com `alerta_disparado` e `notificacao_log` (`docker compose logs api | Select-String "alerta_disparado|notificacao_log"`);
- [ ] foto da montagem, mostrando por onde passa o fio do AO do sensor (para confirmar o divisor de tensão);
- [ ] o código do firmware usado, **sem** a senha do Wi-Fi e a senha MQTT;
- [ ] qualquer erro encontrado, com o trecho do log.

---

## 11. Encerrar

No PC do servidor:

```powershell
docker compose down
```

Os dados (leituras e eventos) ficam guardados para a próxima vez. Para subir de novo: `docker compose up -d`.

- **Não** use `docker compose down -v`: ele apaga o banco inteiro.
- Se mudou o `ALERTA_COOLDOWN_SEGUNDOS` no teste 6, confira se ele voltou para `300`.
- **Opção A:** se não for mais receber conexões da rede, as regras de firewall podem ser removidas (PowerShell como administrador):
  ```powershell
  Remove-NetFirewallRule -DisplayName "MQTT 1883"
  Remove-NetFirewallRule -DisplayName "API Gas 8000"
  ```
