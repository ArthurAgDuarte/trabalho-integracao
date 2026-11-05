import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { carregarConfig, ErroConfig } from '../src/config.js';

const MINIMO = {
  DATABASE_URL: 'postgresql://gas:segredo@localhost:5432/gas',
  MQTT_HOST: 'localhost',
  MQTT_USER: 'gas',
  MQTT_PASSWORD: 'senha-mqtt',
};

function problemas(ambiente: Record<string, string | undefined>): string[] {
  try {
    carregarConfig(ambiente);
  } catch (erro) {
    if (erro instanceof ErroConfig) return erro.problemas;
    throw erro;
  }
  throw new Error('esperava ErroConfig');
}

describe('carregarConfig', () => {
  it('aplica os padrões da versão Python', () => {
    expect(carregarConfig(MINIMO)).toEqual({
      ...MINIMO,
      MQTT_PORT: 1883,
      MQTT_TOPICO: 'casa/+/gas',
      MQTT_CLIENT_ID: 'api-gas',
      ALERTA_COOLDOWN_SEGUNDOS: 300,
      NOTIFICADOR: 'log',
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
      LOG_LEVEL: 'INFO',
      API_HOST: '0.0.0.0',
    });
  });

  it('não sobe sem as variáveis obrigatórias e lista todas de uma vez', () => {
    expect(problemas({})).toEqual([
      'DATABASE_URL: variável obrigatória não definida',
      'MQTT_HOST: variável obrigatória não definida',
      'MQTT_USER: variável obrigatória não definida',
      'MQTT_PASSWORD: variável obrigatória não definida',
    ]);
  });

  it('variável vazia (X=) conta como não definida', () => {
    expect(problemas({ ...MINIMO, MQTT_PASSWORD: '', MQTT_HOST: '   ' })).toHaveLength(2);
    expect(carregarConfig({ ...MINIMO, MQTT_TOPICO: '', TELEGRAM_BOT_TOKEN: '' })).toMatchObject({
      MQTT_TOPICO: 'casa/+/gas',
      TELEGRAM_BOT_TOKEN: undefined,
    });
  });

  it.each([
    ['postgresql+psycopg://gas:x@postgres:5432/gas', 'postgresql://gas:x@postgres:5432/gas'],
    ['postgres://gas:x@postgres/gas', 'postgresql://gas:x@postgres/gas'],
    ['postgresql://gas:x@postgres/gas', 'postgresql://gas:x@postgres/gas'],
  ])('aceita a DATABASE_URL da versão Python: %s', (url, esperada) => {
    expect(carregarConfig({ ...MINIMO, DATABASE_URL: url }).DATABASE_URL).toBe(esperada);
  });

  it('rejeita SQLite sem mostrar a URL (que pode ter senha)', () => {
    const lista = problemas({ ...MINIMO, DATABASE_URL: 'sqlite:///./gas.db' });
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatch(/^DATABASE_URL: .*SQLite/);
    expect(lista[0]).not.toContain('gas.db');
  });

  it.each([
    ['NOTIFICADOR', 'email'],
    ['LOG_LEVEL', 'verbose'],
    ['MQTT_PORT', 'abc'],
    ['MQTT_PORT', '70000'],
    ['ALERTA_COOLDOWN_SEGUNDOS', '-1'],
    ['ALERTA_COOLDOWN_SEGUNDOS', '2.5'],
  ])('rejeita %s=%s', (variavel, valor) => {
    const lista = problemas({ ...MINIMO, [variavel]: valor });
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatch(new RegExp(`^${variavel}: `));
  });

  it('converte números e aceita LOG_LEVEL em minúsculas', () => {
    expect(carregarConfig({ ...MINIMO, MQTT_PORT: '18830', ALERTA_COOLDOWN_SEGUNDOS: '60', LOG_LEVEL: 'warning' })).toMatchObject({
      MQTT_PORT: 18830,
      ALERTA_COOLDOWN_SEGUNDOS: 60,
      LOG_LEVEL: 'WARNING',
    });
  });

  it('o .env.example é uma configuração válida', () => {
    const exemplo = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));
    expect(carregarConfig(exemplo)).toMatchObject({
      DATABASE_URL: 'postgresql://gas:troque-esta-senha-postgres@postgres:5432/gas',
      MQTT_HOST: 'mosquitto',
      NOTIFICADOR: 'log',
    });
  });
});
