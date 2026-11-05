import { EventEmitter } from 'node:events';

import { ErrorWithReasonCode, type IClientOptions, type MqttClient } from 'mqtt';
import { describe, expect, it } from 'vitest';

import { ConsumidorMqtt } from '../src/mqtt.js';
import { criarLogMemoria } from './apoio/log-memoria.js';

/** Cliente MQTT falso: o teste dispara os eventos que o MQTT.js dispararia. */
class ClienteFalso extends EventEmitter {
  connected = false;
  readonly assinaturas: Array<{ topico: string; qos: number }> = [];
  encerrado = false;
  // Substituído pelo consumidor (como no MQTT.js, o padrão só chama o callback).
  handleMessage = (_pacote: unknown, callback: () => void): void => callback();

  constructor(readonly options: IClientOptions) {
    super();
  }

  subscribe(topico: string, opcoes: { qos: number }, callback?: (erro: Error | null, concedidas: unknown[]) => void): this {
    this.assinaturas.push({ topico, qos: opcoes.qos });
    callback?.(null, [{ topic: topico, qos: opcoes.qos }]);
    return this;
  }

  async endAsync(): Promise<void> {
    this.encerrado = true;
    this.connected = false;
    this.emit('close');
  }

  conectar(sessionPresent = false): void {
    this.connected = true;
    this.emit('connect', { sessionPresent });
  }

  /** Entrega uma mensagem como o MQTT.js: resolve quando o consumidor chama o callback (= PUBACK). */
  entregar(topico: string, payload: string): { confirmada: Promise<void>; foiConfirmada: () => boolean } {
    let confirmou = false;
    const confirmada = new Promise<void>((resolve) => {
      this.handleMessage({ topic: topico, payload: Buffer.from(payload), qos: 1 }, () => {
        confirmou = true;
        resolve();
      });
    });
    return { confirmada, foiConfirmada: () => confirmou };
  }
}

function montar(aoReceber: (topico: string, payload: Buffer) => Promise<void> = async () => {}) {
  const { log, linhas, comAcao } = criarLogMemoria();
  let cliente: ClienteFalso | undefined;
  const consumidor = new ConsumidorMqtt({
    host: 'broker',
    porta: 1883,
    usuario: 'gas',
    senha: 'segredo',
    topico: 'casa/+/gas',
    clientId: 'api-gas',
    aoReceber,
    log,
    conectar: (opcoes) => {
      cliente = new ClienteFalso(opcoes);
      return cliente as unknown as MqttClient;
    },
  });
  consumidor.iniciar();
  if (cliente === undefined) throw new Error('cliente não criado');
  return { consumidor, cliente, linhas, comAcao };
}

describe('ConsumidorMqtt', () => {
  it('conecta com sessão persistente, MQTT 3.1.1 e reconexão mesmo após recusa', () => {
    const { cliente } = montar();
    expect(cliente.options).toMatchObject({
      host: 'broker',
      port: 1883,
      username: 'gas',
      password: 'segredo',
      clientId: 'api-gas',
      clean: false,
      protocolVersion: 4,
      reconnectPeriod: 1000,
      resubscribe: false,
      reconnectOnConnackError: true,
    });
  });

  it('assina com QoS 1 a cada conexão e informa o estado', () => {
    const { consumidor, cliente, comAcao } = montar();
    expect(consumidor.conectado).toBe(false);
    cliente.conectar();
    expect(consumidor.conectado).toBe(true);
    cliente.connected = false;
    cliente.emit('close');
    cliente.conectar(true);
    expect(cliente.assinaturas).toEqual([
      { topico: 'casa/+/gas', qos: 1 },
      { topico: 'casa/+/gas', qos: 1 },
    ]);
    expect(comAcao('mqtt_conectado')).toHaveLength(2);
    expect(comAcao('mqtt_desconectado')[0]).toMatchObject({ nivel: 'WARNING' });
  });

  it('só confirma a mensagem (PUBACK) depois que o processamento termina', async () => {
    let liberar: () => void = () => {};
    const recebidas: Array<[string, string]> = [];
    const { cliente } = montar(async (topico, payload) => {
      recebidas.push([topico, payload.toString()]);
      await new Promise<void>((resolve) => (liberar = resolve));
    });
    const entrega = cliente.entregar('casa/cozinha/gas', '{"x":1}');
    await new Promise((resolve) => setImmediate(resolve));
    expect(recebidas).toEqual([['casa/cozinha/gas', '{"x":1}']]);
    expect(entrega.foiConfirmada()).toBe(false);
    liberar();
    await entrega.confirmada;
    expect(entrega.foiConfirmada()).toBe(true);
  });

  it.each([
    ['rejeita', async () => Promise.reject(new Error('falhou'))],
    [
      'lança',
      () => {
        throw new Error('falhou');
      },
    ],
  ])('quando o processamento %s, loga e confirma mesmo assim (o consumidor não para)', async (_caso, aoReceber) => {
    const { cliente, comAcao } = montar(aoReceber as () => Promise<void>);
    await cliente.entregar('casa/cozinha/gas', '{}').confirmada;
    expect(comAcao('erro_processamento')).toMatchObject([{ nivel: 'ERROR', erro: 'Error: falhou' }]);
    await cliente.entregar('casa/cozinha/gas', '{}').confirmada;
  });

  it('ao parar, espera a mensagem em andamento e não processa nem confirma as seguintes', async () => {
    let liberar: () => void = () => {};
    let processadas = 0;
    const { consumidor, cliente } = montar(async () => {
      processadas += 1;
      await new Promise<void>((resolve) => (liberar = resolve));
    });
    cliente.conectar();
    const emAndamento = cliente.entregar('casa/cozinha/gas', '{}');
    await new Promise((resolve) => setImmediate(resolve));
    const parada = consumidor.parar();
    const depois = cliente.entregar('casa/cozinha/gas', '{}');
    expect(cliente.encerrado).toBe(false); // ainda esperando a mensagem em andamento
    liberar();
    await parada;
    expect(emAndamento.foiConfirmada()).toBe(true);
    expect(cliente.encerrado).toBe(true);
    expect(processadas).toBe(1);
    expect(depois.foiConfirmada()).toBe(false); // o broker reentrega na próxima sessão
  });

  it('dobra a espera entre tentativas até 30 s e volta para 1 s ao conectar', () => {
    const { cliente, comAcao } = montar();
    const esperas = [];
    for (let i = 0; i < 7; i++) {
      cliente.emit('reconnect');
      esperas.push(cliente.options.reconnectPeriod);
    }
    expect(esperas).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(comAcao('mqtt_reconectando')).toHaveLength(7);
    cliente.conectar();
    expect(cliente.options.reconnectPeriod).toBe(1000);
  });

  it('recusa de credenciais vira mqtt_recusado (ERROR); falha de rede vira mqtt_desconectado (WARNING)', () => {
    const { cliente, comAcao } = montar();
    cliente.emit('error', new ErrorWithReasonCode('Connection refused: Not authorized', 5));
    cliente.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1883'), { code: 'ECONNREFUSED' }));
    expect(comAcao('mqtt_recusado')).toMatchObject([{ nivel: 'ERROR', erro: 'ErrorWithReasonCode: Connection refused: Not authorized' }]);
    expect(comAcao('mqtt_desconectado')).toMatchObject([{ nivel: 'WARNING', erro: 'Error: connect ECONNREFUSED 127.0.0.1:1883' }]);
  });

  it('nunca loga a senha', () => {
    const { cliente, linhas } = montar();
    cliente.conectar();
    cliente.emit('error', new ErrorWithReasonCode('Connection refused: Not authorized', 5));
    expect(linhas.length).toBeGreaterThan(0);
    expect(JSON.stringify(linhas)).not.toContain('segredo');
  });
});
