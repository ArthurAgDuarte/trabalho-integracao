import { MaquinaAlerta } from './alerta.js';
import { construirApp } from './app.js';
import { carregarConfig, ErroConfig, lerArquivoEnv, type Config } from './config.js';
import { aguardarBanco, criarPool, criarTabelas, RepositorioPostgres } from './db/postgres.js';
import { criarLogger, descreverErro } from './log.js';
import { ConsumidorMqtt } from './mqtt.js';
import { criarNotificador } from './notificadores/index.js';
import { Processador, restaurarEstados } from './processador.js';

const PORTA_HTTP = 8000;
// O Docker espera 30 s (stop_grace_period) antes de matar o container.
const TEMPO_MAX_ENCERRAMENTO_MS = 20_000;

async function main(): Promise<void> {
  lerArquivoEnv();
  let config: Config;
  try {
    config = carregarConfig();
  } catch (erro) {
    const problemas = erro instanceof ErroConfig ? erro.problemas : [descreverErro(erro)];
    criarLogger().fatal({ logger: 'main', acao: 'config_invalida', erro: problemas }, 'Configuração inválida: confira o .env');
    process.exitCode = 1;
    return;
  }

  const log = criarLogger(config.LOG_LEVEL);
  const logMain = log.child({ logger: 'main' });
  process.on('unhandledRejection', (motivo) => {
    logMain.fatal({ acao: 'erro_processamento', erro: descreverErro(motivo) }, 'Promise rejeitada sem tratamento');
    process.exit(1);
  });

  // Antes do banco: NOTIFICADOR=telegram sem token/chat_id falha na hora, sem esperar o banco.
  const notificador = criarNotificador(config.NOTIFICADOR, log, {
    token: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
  });

  const pool = criarPool(config.DATABASE_URL, log);
  await aguardarBanco(pool, log);
  await criarTabelas(pool);
  const repositorio = new RepositorioPostgres(pool);

  const maquina = new MaquinaAlerta(config.ALERTA_COOLDOWN_SEGUNDOS);
  const restaurados = await restaurarEstados(repositorio, maquina);
  const processador = new Processador({ repositorio, maquina, notificador, log });
  const consumidor = new ConsumidorMqtt({
    host: config.MQTT_HOST,
    porta: config.MQTT_PORT,
    usuario: config.MQTT_USER,
    senha: config.MQTT_PASSWORD,
    topico: config.MQTT_TOPICO,
    clientId: config.MQTT_CLIENT_ID,
    aoReceber: (topico, payload) => processador.processarMensagem(topico, payload),
    log,
  });

  const app = await construirApp({ repositorio, mqttConectado: () => consumidor.conectado, log });
  // O consumidor sobe junto com o servidor HTTP (sem esperar o broker) e para antes do banco fechar.
  app.addHook('onReady', async () => {
    consumidor.iniciar();
  });
  app.addHook('onClose', async () => {
    await consumidor.parar(); // para de receber e confirma a mensagem em andamento
    await processador.encerrar(); // espera a fila de notificações esvaziar
    await pool.end();
  });

  await app.listen({ host: config.API_HOST, port: PORTA_HTTP });
  logMain.info(
    { acao: 'inicio' },
    `API iniciada na porta ${PORTA_HTTP} (notificador=${config.NOTIFICADOR}, cooldown=${config.ALERTA_COOLDOWN_SEGUNDOS}s, estados restaurados=${restaurados})`,
  );

  let encerrando = false;
  const encerrar = (sinal: NodeJS.Signals): void => {
    if (encerrando) return;
    encerrando = true;
    logMain.info({ acao: 'fim' }, `${sinal} recebido: encerrando`);
    setTimeout(() => {
      logMain.error({ acao: 'fim' }, `O encerramento passou de ${TEMPO_MAX_ENCERRAMENTO_MS / 1000} s; saindo assim mesmo`);
      process.exit(1);
    }, TEMPO_MAX_ENCERRAMENTO_MS).unref();
    app.close().then(
      () => {
        logMain.info({ acao: 'fim' }, 'API encerrada');
        process.exit(0);
      },
      (erro: unknown) => {
        logMain.error({ acao: 'fim', erro: descreverErro(erro) }, 'Falha ao encerrar a API');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', encerrar);
  process.once('SIGINT', encerrar);
}

main().catch((erro: unknown) => {
  criarLogger().fatal({ logger: 'main', acao: 'erro_inicio', erro: descreverErro(erro) }, 'Falha ao iniciar a API');
  process.exit(1);
});
