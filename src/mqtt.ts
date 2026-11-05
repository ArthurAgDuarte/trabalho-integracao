import { connect, ErrorWithReasonCode, type IClientOptions, type MqttClient } from 'mqtt';

import { descreverErro, type Logger } from './log.js';

type PacotePublicado = Parameters<MqttClient['handleMessage']>[0];

export interface OpcoesConsumidor {
  host: string;
  porta: number;
  usuario: string;
  senha: string;
  topico: string;
  clientId: string;
  /** Processa uma mensagem. Se rejeitar, o consumidor loga e segue para a próxima. */
  aoReceber: (topico: string, payload: Buffer) => Promise<void>;
  log: Logger;
  /** Só para testes: cria o cliente MQTT (padrão: connect do MQTT.js). */
  conectar?: (opcoes: IClientOptions) => MqttClient;
}

// Espera entre tentativas de reconexão: dobra a cada falha, de 1 s até 30 s (como o paho na versão Python).
const ESPERA_MIN_MS = 1_000;
const ESPERA_MAX_MS = 30_000;

/**
 * Assina o tópico com QoS 1 numa sessão persistente e repassa cada mensagem para `aoReceber`.
 *
 * As mensagens chegam pelo hook `handleMessage` do MQTT.js, e não pelo evento `message`: o MQTT.js
 * só envia o PUBACK e só lê o próximo pacote depois do callback desse hook. Assim as mensagens são
 * processadas uma de cada vez, na ordem, e a leitura já está gravada quando o broker recebe a
 * confirmação. Se a API cair no meio, o broker reentrega a mensagem na próxima conexão.
 */
export class ConsumidorMqtt {
  readonly #opcoes: OpcoesConsumidor;
  readonly #log: Logger;
  #cliente: MqttClient | null = null;
  #mensagemAtual: Promise<void> = Promise.resolve();
  #encerrando = false;
  #estavaConectado = false;
  #tentativas = 0;

  constructor(opcoes: OpcoesConsumidor) {
    this.#opcoes = opcoes;
    this.#log = opcoes.log.child({ logger: 'mqtt' });
  }

  get conectado(): boolean {
    return this.#cliente?.connected ?? false;
  }

  /** Conecta em segundo plano: a API sobe mesmo com o broker fora do ar. */
  iniciar(): void {
    const { host, porta, usuario, senha, topico, clientId } = this.#opcoes;
    this.#log.info({ acao: 'mqtt_conectando', topico }, `Conectando ao broker ${host}:${porta}`);
    const cliente = (this.#opcoes.conectar ?? connect)({
      host,
      port: porta,
      username: usuario,
      password: senha,
      clientId,
      protocol: 'mqtt',
      // MQTT 3.1.1: no MQTT 5, clean=false sem sessionExpiryInterval perde a sessão ao desconectar.
      protocolVersion: 4,
      // Sessão persistente: o broker guarda as mensagens QoS 1 enquanto a API estiver fora.
      clean: false,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod: ESPERA_MIN_MS,
      // A assinatura é refeita a cada 'connect' (abaixo); o resubscribe do MQTT.js assinaria duas vezes.
      resubscribe: false,
      // Sem isso, o MQTT.js desiste de reconectar depois de uma recusa de credenciais.
      reconnectOnConnackError: true,
    });
    cliente.handleMessage = (pacote, callback) => this.#receber(pacote, callback);
    cliente.on('connect', (connack) => this.#aoConectar(cliente, connack.sessionPresent));
    cliente.on('reconnect', () => this.#aoReconectar(cliente));
    cliente.on('close', () => this.#aoFechar());
    cliente.on('offline', () => {
      this.#log.warn({ acao: 'mqtt_desconectado' }, 'Broker inacessível; reconexão automática a cada 1 a 30 s');
    });
    cliente.on('error', (erro) => this.#aoErro(erro));
    this.#cliente = cliente;
  }

  /** Para de receber, termina a mensagem em andamento (e confirma ao broker) e desconecta. */
  async parar(): Promise<void> {
    const cliente = this.#cliente;
    if (cliente === null) return;
    this.#encerrando = true;
    await this.#mensagemAtual;
    await cliente.endAsync();
  }

  #receber(pacote: PacotePublicado, callback: () => void): void {
    // Encerrando: não processa nem confirma. O broker guarda a mensagem e reentrega na próxima sessão.
    if (this.#encerrando) return;
    const topico = pacote.topic;
    const payload = typeof pacote.payload === 'string' ? Buffer.from(pacote.payload) : pacote.payload;
    // Nada aqui pode lançar nem rejeitar: o callback é sempre chamado, senão a fila do MQTT.js para.
    this.#mensagemAtual = (async () => {
      try {
        await this.#opcoes.aoReceber(topico, payload);
      } catch (erro) {
        this.#log.error({ acao: 'erro_processamento', topico, erro: descreverErro(erro) }, 'Erro inesperado ao processar mensagem');
      }
      try {
        callback(); // envia o PUBACK e libera o próximo pacote
      } catch (erro) {
        this.#log.error({ acao: 'erro_processamento', topico, erro: descreverErro(erro) }, 'Falha ao confirmar a mensagem ao broker');
      }
    })();
  }

  #aoConectar(cliente: MqttClient, sessaoRestaurada: boolean): void {
    const { topico } = this.#opcoes;
    this.#estavaConectado = true;
    this.#tentativas = 0;
    cliente.options.reconnectPeriod = ESPERA_MIN_MS;
    this.#log.info(
      { acao: 'mqtt_conectado', topico },
      `Conectado ao broker, assinando ${topico} (sessão restaurada: ${sessaoRestaurada})`,
    );
    // Assina a cada (re)conexão: se o broker perdeu a sessão, a assinatura volta.
    cliente.subscribe(topico, { qos: 1 }, (erro, concedidas) => {
      if (erro) {
        this.#log.error({ acao: 'mqtt_recusado', topico, erro: descreverErro(erro) }, `Falha ao assinar ${topico}`);
      } else if (concedidas?.[0]?.qos === 128) {
        this.#log.error({ acao: 'mqtt_recusado', topico }, `O broker recusou a assinatura de ${topico}`);
      }
    });
  }

  #aoReconectar(cliente: MqttClient): void {
    this.#tentativas += 1;
    // O MQTT.js agenda a próxima tentativa com o reconnectPeriod do momento: dobrar aqui vale para
    // o próximo intervalo, se esta tentativa falhar.
    const espera = cliente.options.reconnectPeriod ?? ESPERA_MIN_MS;
    cliente.options.reconnectPeriod = Math.min(espera * 2, ESPERA_MAX_MS);
    this.#log.warn({ acao: 'mqtt_reconectando' }, `Tentando reconectar ao broker (tentativa ${this.#tentativas})`);
  }

  #aoFechar(): void {
    if (!this.#estavaConectado) return; // tentativa que nem chegou a conectar: o 'error' já explicou
    this.#estavaConectado = false;
    if (this.#encerrando) {
      this.#log.info({ acao: 'mqtt_desconectado' }, 'Desconectado do broker (encerramento da API)');
    } else {
      this.#log.warn({ acao: 'mqtt_desconectado' }, 'Conexão com o broker perdida');
    }
  }

  #aoErro(erro: Error): void {
    if (erro instanceof ErrorWithReasonCode) {
      // Recusa no CONNACK (4 = usuário ou senha inválidos, 5 = não autorizado).
      this.#log.error(
        { acao: 'mqtt_recusado', erro: descreverErro(erro) },
        'Broker recusou a conexão: confira MQTT_USER e MQTT_PASSWORD',
      );
    } else {
      this.#log.warn({ acao: 'mqtt_desconectado', erro: descreverErro(erro) }, 'Falha na conexão com o broker');
    }
  }
}
